package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPhase08SearchIntegration(t *testing.T) {
	database, authority := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_COLLAB_ORIGIN")
	if database == "" || authority == "" {
		t.Skip("real PostgreSQL and TS authority required")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const origin = "http://localhost:3000"
	provider := newFakeProvider(t, origin+"/api/v1/auth/github/callback")
	defer provider.server.Close()
	cfg := Config{Environment: "development", PublicOrigin: origin, CallbackURL: origin + "/api/v1/auth/github/callback", ClientID: "fixture-id", ClientSecret: "fixture-secret", GitHubAuthURL: provider.server.URL + "/authorize", GitHubTokenURL: provider.server.URL + "/token", GitHubUserURL: provider.server.URL + "/user", CollabOrigin: authority, CollabToken: "cce_dev_internal_only"}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 40 * time.Second}}
	api := httptest.NewServer(app.routes())
	defer api.Close()
	owner, viewer, outsider := newBrowser(api.URL), newBrowser(api.URL), newBrowser(api.URL)
	for _, b := range []*testBrowser{owner, viewer, outsider} {
		b.login(t, provider, origin)
	}
	var project Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Search acceptance"}, owner.csrf, origin), 201, &project)
	base := "/api/v1/projects/" + project.ID
	invite := createTestInvite(t, owner, base, origin, "viewer", 1)
	responseJSON(t, viewer.request(t, "POST", "/api/v1/invites/"+invite.Token+"/accept", nil, viewer.csrf, origin), 200, nil)
	var folder, file treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base+"/tree", "0", map[string]string{"kind": "folder", "name": "src"}), 201, &folder)
	responseJSON(t, mustTreeRequest(t, owner, "POST", base+"/tree", folder.TreeVersion, map[string]any{"kind": "file", "name": "find.js", "parent_id": folder.Entry.ID}), 201, &file)
	document := *file.Entry.DocumentID
	worker := uuid.NewString()
	var fence int64
	var sid string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `SELECT id::text FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, owner.userID).Scan(&sid))
	must(db.QueryRow(ctx, `SELECT cce_acquire_document($1,$2)`, document, worker).Scan(&fence))
	prepare := func(text string) ([]byte, []byte) {
		t.Helper()
		var output struct {
			State  string `json:"encoded_state"`
			Vector string `json:"state_vector"`
		}
		must(app.internalCheckpoint(ctx, "prepare", map[string]string{"text": text}, &output))
		state, e := base64.StdEncoding.DecodeString(output.State)
		must(e)
		vector, e := base64.StdEncoding.DecodeString(output.Vector)
		must(e)
		return state, vector
	}
	appendText := func(text string) {
		t.Helper()
		bytes, _ := prepare(text)
		var head int64
		var size int
		must(db.QueryRow(ctx, `SELECT last_committed_sequence,committed_text_bytes FROM documents WHERE id=$1`, document).Scan(&head, &size))
		var seq int64
		must(db.QueryRow(ctx, `SELECT cce_append_document($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, project.ID, file.Entry.ID, document, owner.userID, sid, worker, fence, head, uuid.NewString(), uuid.NewString(), digest(string(bytes)), bytes, size+len(text)).Scan(&seq))
	}
	claim := func() searchCut { t.Helper(); cut, e := app.claimSearch(ctx, file.Entry.ID); must(e); return cut }
	materialize := func(cut searchCut) string {
		t.Helper()
		var out struct {
			Text string `json:"text"`
		}
		must(app.internalJSON(ctx, "/internal/search/materialize", cut, &out))
		return out.Text
	}
	search := func(b *testBrowser, q string) []SearchResult {
		t.Helper()
		var out struct {
			Results []SearchResult `json:"results"`
		}
		responseJSON(t, b.request(t, "GET", base+"/search?q="+url.QueryEscape(q), nil, "", ""), 200, &out)
		return out.Results
	}
	t.Run("filename works before indexing and literal inputs are bounded", func(t *testing.T) {
		results := search(viewer, "FIND")
		if len(results) != 1 || results[0].Path != "src/find.js" || results[0].IndexedSequence != nil || !results[0].Stale {
			t.Fatalf("unindexed filename: %+v", results)
		}
		for _, q := range []string{".*", "%", "' OR 1=1 --", "<script>"} {
			if len(search(owner, q)) != 0 {
				t.Fatal("query was interpreted instead of matched literally")
			}
		}
		for _, q := range []string{"", strings.Repeat("x", 129), "a\nb"} {
			responseJSON(t, owner.request(t, "GET", base+"/search?q="+url.QueryEscape(q), nil, "", ""), 400, nil)
		}
		responseJSON(t, owner.request(t, "GET", base+"/search?q=a&q=b", nil, "", ""), 400, nil)
		responseJSON(t, outsider.request(t, "GET", base+"/search?q=find", nil, "", ""), 404, nil)
		responseJSON(t, newBrowser(api.URL).request(t, "GET", base+"/search?q=find", nil, "", ""), 401, nil)
	})
	var old searchCut
	t.Run("committed cut and continued edits preserve eventual freshness", func(t *testing.T) {
		appendText("needle <script>alert('source')</script> Ω\x00boundary")
		old = claim()
		cutText := materialize(old)
		appendText("later-only")
		must(app.publishSearch(ctx, old, cutText))
		result := search(viewer, "needle")
		if len(result) != 1 || result[0].IndexedSequence == nil || *result[0].IndexedSequence != "1" || result[0].CurrentSequence != "2" || !result[0].Stale || result[0].Snippet == nil || !strings.Contains(*result[0].Snippet, "<script>") {
			t.Fatalf("cut result: %+v", result)
		}
		if len(search(viewer, "later-only")) != 0 {
			t.Fatal("later live edit leaked into captured projection")
		}
		if !strings.ContainsRune(*result[0].Snippet, 0) {
			t.Fatal("NUL-bearing committed source lost snippet fidelity")
		}
		next := claim()
		must(app.publishSearch(ctx, next, materialize(next)))
		result = search(owner, "later-only")
		if len(result) != 1 || result[0].Stale || *result[0].IndexedSequence != "2" {
			t.Fatalf("new projection: %+v", result)
		}
		if err := app.publishSearch(ctx, old, "late-task-poison"); err == nil {
			t.Fatal("completed old claim published")
		}
		if len(search(owner, "late-task-poison")) != 0 {
			t.Fatal("late claim replaced latest projection")
		}
	})
	t.Run("rename and move use current paths without reindexing", func(t *testing.T) {
		var rename treeMutation
		responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/tree/"+file.Entry.ID, file.TreeVersion, map[string]any{"name": "renamed.js", "parent_id": nil}), 200, &rename)
		file.TreeVersion = rename.TreeVersion
		result := search(viewer, "needle")
		if len(result) != 1 || result[0].Path != "renamed.js" || result[0].DocumentID != document {
			t.Fatalf("stale path: %+v", result)
		}
		if len(search(owner, "find.js")) != 0 || len(search(owner, "renamed")) != 1 {
			t.Fatal("filename projection lagged metadata")
		}
	})
	t.Run("failed reconstruction and expired claims retry without publication", func(t *testing.T) {
		appendText("retry-cut")
		cut := claim()
		_, err = db.Exec(ctx, `UPDATE search_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE file_id=$1`, file.Entry.ID)
		must(err)
		next := claim()
		if next.Claim == cut.Claim {
			t.Fatal("takeover reused claim")
		}
		if err := app.publishSearch(ctx, cut, "poison"); err == nil {
			t.Fatal("expired claim published")
		}
		bad := next
		bad.SnapshotID = uuid.NewString()
		var out struct {
			Text string `json:"text"`
		}
		if err := app.internalJSON(ctx, "/internal/search/materialize", bad, &out); err == nil {
			t.Fatal("missing snapshot accepted")
		}
		if len(search(owner, "retry-cut")) != 0 {
			t.Fatal("failed cut published")
		}
		unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
		defer unavailable.Close()
		failed := *app
		failed.cfg.CollabOrigin = unavailable.URL
		if err := failed.indexSearchCut(ctx, next); err == nil {
			t.Fatal("unavailable authority reported successful indexing")
		}
		var failure *string
		var claimID *string
		var deferred bool
		must(db.QueryRow(ctx, `SELECT failure_code,claim_id::text,retry_at>clock_timestamp() FROM search_tasks WHERE file_id=$1`, file.Entry.ID).Scan(&failure, &claimID, &deferred))
		if failure == nil || *failure != "PROJECTION_FAILED" || claimID != nil || !deferred {
			t.Fatal("failed task lost its retry state")
		}
		if _, err := app.claimSearch(ctx, file.Entry.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("failed task retried before backoff: %v", err)
		}
		if len(search(owner, "retry-cut")) != 0 {
			t.Fatal("unavailable authority published text")
		}
		_, err = db.Exec(ctx, `UPDATE search_tasks SET retry_at=clock_timestamp()-interval '1 second' WHERE file_id=$1`, file.Entry.ID)
		must(err)
		next = claim()
		must(app.publishSearch(ctx, next, materialize(next)))
		if len(search(owner, "retry-cut")) != 1 {
			t.Fatal("retry cut missing")
		}
	})
	t.Run("generation replacement filters lagged index and rejects old work", func(t *testing.T) {
		appendText("pre-replace")
		prior := claim()
		text := materialize(prior)
		state, vector := prepare("fresh-generation")
		replacement := uuid.NewString()
		tx, e := db.Begin(ctx)
		must(e)
		defer tx.Rollback(ctx)
		_, e = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID)
		must(e)
		_, e = tx.Exec(ctx, `INSERT INTO documents(id,file_id,generation,committed_text_bytes) VALUES($1,$2,2,$3)`, replacement, file.Entry.ID, len("fresh-generation"))
		must(e)
		_, e = tx.Exec(ctx, `WITH s AS (INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id) UPDATE documents SET snapshot_id=(SELECT id FROM s) WHERE id=$1`, replacement, state, vector, digest(string(state)))
		must(e)
		_, e = tx.Exec(ctx, `UPDATE files SET current_document_id=$2,generation=2 WHERE id=$1`, file.Entry.ID, replacement)
		must(e)
		must(tx.Commit(ctx))
		if len(search(owner, "needle")) != 0 {
			t.Fatal("replaced generation snippet leaked")
		}
		must(app.publishSearch(ctx, prior, text))
		next := claim()
		must(app.publishSearch(ctx, next, materialize(next)))
		result := search(owner, "fresh-generation")
		if len(result) != 1 || result[0].DocumentID != replacement || result[0].Generation != "2" {
			t.Fatalf("replacement: %+v", result)
		}
		// An old attempt must also leave an already published new generation intact.
		if err := app.publishSearch(ctx, prior, "old-poison"); err == nil {
			t.Fatal("old claim revived")
		}
		if len(search(owner, "fresh-generation")) != 1 {
			t.Fatal("old task deleted replacement projection")
		}
	})
	t.Run("socket admission bounds one actor and preserves a teammate connection", func(t *testing.T) {
		var sockets []*websocket.Conn
		defer func() {
			for _, conn := range sockets {
				conn.Close()
			}
		}()
		connect := func(b *testBrowser, path string) (*websocket.Conn, *http.Response, error) {
			cookieURL, _ := url.Parse(api.URL)
			headers := http.Header{"Origin": []string{origin}}
			var cookies []string
			for _, cookie := range b.client.Jar.Cookies(cookieURL) {
				cookies = append(cookies, cookie.Name+"="+cookie.Value)
			}
			headers.Set("Cookie", strings.Join(cookies, "; "))
			if path == "" {
				path = "/ws/projects/" + project.ID + "?after=0"
			}
			return websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(api.URL, "http")+path, headers)
		}
		for i := 0; i < 16; i++ {
			conn, response, e := connect(owner, "")
			if response != nil {
				response.Body.Close()
			}
			must(e)
			sockets = append(sockets, conn)
		}
		conn, response, e := connect(owner, "")
		if conn != nil {
			conn.Close()
		}
		if e == nil || response == nil || response.StatusCode != 429 {
			t.Fatal("actor exceeded socket bound")
		}
		response.Body.Close()
		var active string
		must(db.QueryRow(ctx, `SELECT current_document_id::text FROM files WHERE id=$1`, file.Entry.ID).Scan(&active))
		conn, response, e = connect(owner, "/ws/documents/"+active)
		if conn != nil {
			conn.Close()
		}
		if e == nil || response == nil || response.StatusCode != 429 {
			t.Fatal("document endpoint bypassed shared socket budget")
		}
		response.Body.Close()
		conn, response, e = connect(viewer, "")
		if response != nil {
			response.Body.Close()
		}
		must(e)
		sockets = append(sockets, conn)
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatal("teammate stream blocked by another actor", err)
		}
		responseJSON(t, owner.request(t, "GET", base+"/search?q=fresh", nil, "", ""), 200, nil)
	})
	waitBlocked := func(pattern string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var count int
			must(db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1`, pattern).Scan(&count))
			if count > 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("search did not reach project barrier")
	}
	t.Run("revocation commits while query waits on project barrier", func(t *testing.T) {
		tx, e := db.Begin(ctx)
		must(e)
		defer tx.Rollback(ctx)
		_, e = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID)
		must(e)
		response := make(chan *http.Response, 1)
		go func() { response <- viewer.request(t, "GET", base+"/search?q=fresh", nil, "", "") }()
		waitBlocked("SELECT lifecycle_state FROM projects WHERE id=$1 FOR SHARE%")
		_, e = tx.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, viewer.userID)
		must(e)
		must(tx.Commit(ctx))
		responseJSON(t, <-response, 404, nil)
	})
	t.Run("session expiry during project barrier uses database wall clock", func(t *testing.T) {
		_, e := db.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, sid)
		must(e)
		tx, e := db.Begin(ctx)
		must(e)
		defer tx.Rollback(ctx)
		_, e = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID)
		must(e)
		response := make(chan *http.Response, 1)
		go func() { response <- owner.request(t, "GET", base+"/search?q=fresh", nil, "", "") }()
		waitBlocked("SELECT lifecycle_state FROM projects WHERE id=$1 FOR SHARE%")
		mutation := make(chan *http.Response, 1)
		go func() {
			mutation <- mustTreeRequest(t, owner, "POST", base+"/tree", file.TreeVersion, map[string]string{"kind": "folder", "name": "expired-write"})
		}()
		waitBlocked("SELECT tree_version,lifecycle_state FROM projects WHERE id=$1 FOR UPDATE%")
		deadline := time.Now().Add(5 * time.Second)
		for {
			var expired bool
			must(db.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1`, sid).Scan(&expired))
			if expired {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("expiry barrier timed out")
			}
			time.Sleep(10 * time.Millisecond)
		}
		must(tx.Commit(ctx))
		responseJSON(t, <-response, 401, nil)
		responseJSON(t, <-mutation, 401, nil)
		_, e = db.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, sid)
		must(e)
	})
	t.Run("invite expiry while acceptance waits is enforced after lock", func(t *testing.T) {
		invite := createTestInvite(t, owner, base, origin, "viewer", 1)
		_, e := db.Exec(ctx, `UPDATE project_invites SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, invite.ID)
		must(e)
		tx, e := db.Begin(ctx)
		must(e)
		defer tx.Rollback(ctx)
		_, e = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID)
		must(e)
		response := make(chan *http.Response, 1)
		go func() {
			response <- outsider.request(t, "POST", "/api/v1/invites/"+invite.Token+"/accept", nil, outsider.csrf, origin)
		}()
		waitBlocked("SELECT lifecycle_state FROM projects WHERE id=$1 FOR UPDATE%")
		deadline := time.Now().Add(5 * time.Second)
		for {
			var expired bool
			must(db.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM project_invites WHERE id=$1`, invite.ID).Scan(&expired))
			if expired {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("invite expiry barrier timed out")
			}
			time.Sleep(10 * time.Millisecond)
		}
		must(tx.Commit(ctx))
		responseJSON(t, <-response, 409, nil)
		var uses int
		must(db.QueryRow(ctx, `SELECT used_count FROM project_invites WHERE id=$1`, invite.ID).Scan(&uses))
		if uses != 0 {
			t.Fatal("expired invite consumed")
		}
	})
	t.Run("delete filters stale source and project deletion denies all results", func(t *testing.T) {
		responseJSON(t, mustTreeRequest(t, owner, "DELETE", base+"/tree/"+file.Entry.ID, file.TreeVersion, nil), 204, nil)
		if len(search(owner, "fresh-generation")) != 0 || len(search(owner, "renamed")) != 0 {
			t.Fatal("deleted file exposed")
		}
		responseJSON(t, owner.request(t, "DELETE", base, nil, owner.csrf, origin), 204, nil)
		responseJSON(t, owner.request(t, "GET", base+"/search?q=fresh", nil, "", ""), 404, nil)
		if _, err := app.claimSearch(ctx, file.Entry.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("completed queue unexpectedly pending: %v", err)
		}
	})
}
