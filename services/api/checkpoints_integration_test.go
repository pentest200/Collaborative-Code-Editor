package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type failingArtifacts struct {
	artifactStore
	remaining int
}

type checkpointBarrierTransport struct {
	base    http.RoundTripper
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *checkpointBarrierTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Path == "/internal/checkpoints/prepare" {
		b.once.Do(func() {
			close(b.entered)
			select {
			case <-b.release:
			case <-request.Context().Done():
			}
		})
	}
	return b.base.RoundTrip(request)
}

func (s *failingArtifacts) Put(ctx context.Context, key string, data []byte) error {
	s.remaining--
	if s.remaining == 0 {
		return errors.New("injected upload interruption")
	}
	return s.artifactStore.Put(ctx, key, data)
}

func TestPhase06CheckpointsIntegration(t *testing.T) {
	database := os.Getenv("TEST_DATABASE_URL")
	authority := os.Getenv("TEST_COLLAB_ORIGIN")
	endpoint := os.Getenv("TEST_ARTIFACT_ENDPOINT")
	if database == "" || authority == "" || endpoint == "" {
		t.Skip("real PostgreSQL, TS authority and MinIO endpoints required")
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
	cfg := Config{Environment: "development", PublicOrigin: origin, CallbackURL: origin + "/api/v1/auth/github/callback", ClientID: "fixture-id", ClientSecret: "fixture-secret", GitHubAuthURL: provider.server.URL + "/authorize", GitHubTokenURL: provider.server.URL + "/token", GitHubUserURL: provider.server.URL + "/user", CollabOrigin: authority, CollabToken: "cce_dev_internal_only", ArtifactEndpoint: endpoint, ArtifactAccessKey: "cce_local_storage", ArtifactSecretKey: "cce_local_storage_only", ArtifactBucket: "cce-checkpoints"}
	storage, err := newArtifacts(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = storage.ensureBucket(ctx); err != nil {
		t.Fatal(err)
	}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 40 * time.Second}, artifacts: storage}
	api := httptest.NewServer(app.routes())
	defer api.Close()
	owner, editor, viewer := newBrowser(api.URL), newBrowser(api.URL), newBrowser(api.URL)
	for _, browser := range []*testBrowser{owner, editor, viewer} {
		browser.login(t, provider, origin)
	}
	var project Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Checkpoint acceptance"}, owner.csrf, origin), 201, &project)
	base := "/api/v1/projects/" + project.ID
	cpBase := base + "/checkpoints"
	for browser, role := range map[*testBrowser]string{editor: "editor", viewer: "viewer"} {
		invite := createTestInvite(t, owner, base, origin, role, 1)
		responseJSON(t, browser.request(t, "POST", "/api/v1/invites/"+invite.Token+"/accept", nil, browser.csrf, origin), 200, nil)
	}
	var folder, first, second treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base+"/tree", "0", map[string]any{"name": "src", "kind": "folder"}), 201, &folder)
	responseJSON(t, mustTreeRequest(t, owner, "POST", base+"/tree", folder.TreeVersion, map[string]any{"name": "one.ts", "kind": "file", "parent_id": folder.Entry.ID}), 201, &first)
	responseJSON(t, mustTreeRequest(t, editor, "POST", base+"/tree", first.TreeVersion, map[string]any{"name": "two.py", "kind": "file"}), 201, &second)
	workers := map[string]string{}
	for _, entry := range []TreeEntry{first.Entry, second.Entry} {
		worker := uuid.NewString()
		workers[entry.ID] = worker
		var fence int64
		if err = db.QueryRow(ctx, "SELECT cce_acquire_document($1,$2)", entry.DocumentID, worker).Scan(&fence); err != nil {
			t.Fatal(err)
		}
	}
	fixtureAuthority := *app
	prepare := func(text string) ([]byte, []byte) {
		t.Helper()
		var output struct {
			State  string `json:"encoded_state"`
			Vector string `json:"state_vector"`
		}
		if err := fixtureAuthority.internalCheckpoint(ctx, "prepare", map[string]string{"text": text}, &output); err != nil {
			t.Fatal(err)
		}
		state, _ := base64.StdEncoding.DecodeString(output.State)
		vector, _ := base64.StdEncoding.DecodeString(output.Vector)
		return state, vector
	}
	appendText := func(entry TreeEntry, browser *testBrowser, text string) error {
		state, _ := prepare(text)
		var head int64
		var size int
		var sid string
		if err := db.QueryRow(ctx, `SELECT last_committed_sequence,committed_text_bytes FROM documents WHERE id=$1`, entry.DocumentID).Scan(&head, &size); err != nil {
			return err
		}
		if err := db.QueryRow(ctx, `SELECT id::text FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, browser.userID).Scan(&sid); err != nil {
			return err
		}
		var sequence int64
		err := db.QueryRow(ctx, `SELECT cce_append_document($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13)`, project.ID, entry.ID, entry.DocumentID, entry.Generation, browser.userID, sid, workers[entry.ID], head, uuid.NewString(), uuid.NewString(), digest(string(state)), state, size+len(text)).Scan(&sequence)
		return err
	}
	if err = appendText(first.Entry, owner, "captured α\n"); err != nil {
		t.Fatal(err)
	}
	if err = appendText(second.Entry, editor, "captured β\n"); err != nil {
		t.Fatal(err)
	}
	create := func(t *testing.T, browser *testBrowser, name string) Checkpoint {
		t.Helper()
		var cp Checkpoint
		responseJSON(t, browser.request(t, "POST", cpBase, map[string]string{"name": name}, browser.csrf, origin), 202, &cp)
		return cp
	}
	work := func(t *testing.T) {
		t.Helper()
		worked, err := app.materializeNext(ctx)
		if err != nil || !worked {
			t.Fatalf("materializer: %v %v", worked, err)
		}
	}
	readText := func(t *testing.T, browser *testBrowser, cp, file string) string {
		t.Helper()
		response := browser.request(t, "GET", cpBase+"/"+cp+"/files/"+file, nil, "", "")
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		if response.StatusCode != 200 {
			t.Fatalf("download %d %s", response.StatusCode, data)
		}
		return string(data)
	}
	var captured Checkpoint
	t.Run("consistent captured cut while multiple actors continue editing", func(t *testing.T) {
		captured = create(t, editor, "Exact cut")
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+captured.ID, nil, "", ""), 409, nil)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 409, nil)
		failures := make(chan error, 2)
		var wg sync.WaitGroup
		for index, entry := range []TreeEntry{first.Entry, second.Entry} {
			browser := owner
			if index == 1 {
				browser = editor
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 24; i++ {
					if err := appendText(entry, browser, "live"); err != nil {
						failures <- err
						return
					}
				}
			}()
		}
		work(t)
		wg.Wait()
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		if text := readText(t, viewer, captured.ID, first.Entry.ID); text != "captured α\n" {
			t.Fatalf("wrong first cut %q", text)
		}
		if text := readText(t, viewer, captured.ID, second.Entry.ID); text != "captured β\n" {
			t.Fatalf("wrong second cut %q", text)
		}
		var manifest CheckpointManifest
		responseJSON(t, viewer.request(t, "GET", cpBase+"/"+captured.ID, nil, "", ""), 200, &manifest)
		if len(manifest.Tree) != 3 || len(manifest.Files) != 2 || manifest.TreeVersion != second.TreeVersion {
			t.Fatal("tree and document cut differ")
		}
		for _, file := range manifest.Files {
			if file.Sequence != "1" {
				t.Fatalf("wrong captured head %s", file.Sequence)
			}
		}
	})
	t.Run("permissions and cross project artifact reads", func(t *testing.T) {
		anonymous, err := http.Get(endpoint + "/" + cfg.ArtifactBucket + "/" + checkpointKey(project.ID, captured.ID, first.Entry.ID))
		if err != nil {
			t.Fatal(err)
		}
		anonymous.Body.Close()
		if anonymous.StatusCode != 403 {
			t.Fatalf("anonymous bucket read status %d", anonymous.StatusCode)
		}
		responseJSON(t, viewer.request(t, "POST", cpBase, map[string]string{"name": "Denied"}, viewer.csrf, origin), 403, nil)
		responseJSON(t, mustTreeRequest(t, editor, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 403, nil)
		responseJSON(t, mustTreeRequest(t, viewer, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 403, nil)
		var other Project
		responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Foreign checkpoint"}, owner.csrf, origin), 201, &other)
		foreign := "/api/v1/projects/" + other.ID + "/checkpoints/" + captured.ID
		responseJSON(t, owner.request(t, "GET", foreign, nil, "", ""), 404, nil)
		responseJSON(t, owner.request(t, "GET", foreign+"/files/"+first.Entry.ID, nil, "", ""), 404, nil)
		responseJSON(t, mustTreeRequest(t, owner, "POST", foreign+"/restore", "0", nil), 404, nil)
		key := checkpointKey(project.ID, captured.ID, first.Entry.ID)
		_, err = db.Exec(ctx, "UPDATE checkpoint_files SET artifact_key=$3 WHERE checkpoint_id=$1 AND file_id=$2", captured.ID, first.Entry.ID, checkpointKey(other.ID, captured.ID, first.Entry.ID))
		if err != nil {
			t.Fatal(err)
		}
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+captured.ID+"/files/"+first.Entry.ID, nil, "", ""), 503, nil)
		_, err = db.Exec(ctx, "UPDATE checkpoint_files SET artifact_key=$3 WHERE checkpoint_id=$1 AND file_id=$2", captured.ID, first.Entry.ID, key)
		if err != nil {
			t.Fatal(err)
		}
		responseJSON(t, owner.request(t, "DELETE", base+"/members/"+viewer.userID, nil, owner.csrf, origin), 204, nil)
		responseJSON(t, viewer.request(t, "GET", cpBase, nil, "", ""), 404, nil)
		responseJSON(t, viewer.request(t, "GET", cpBase+"/"+captured.ID+"/files/"+first.Entry.ID, nil, "", ""), 404, nil)
	})
	t.Run("partial uploads explicit retry and expired lease recovery", func(t *testing.T) {
		cp := create(t, owner, "Interrupted upload")
		app.artifacts = &failingArtifacts{storage, 2}
		worked, err := app.materializeNext(ctx)
		if !worked || err == nil {
			t.Fatal("interrupted upload succeeded")
		}
		app.artifacts = storage
		var state string
		db.QueryRow(ctx, "SELECT state FROM checkpoints WHERE id=$1", cp.ID).Scan(&state)
		if state != "failed" {
			t.Fatal(state)
		}
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+cp.ID, nil, "", ""), 409, nil)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+cp.ID+"/restore", second.TreeVersion, nil), 409, nil)
		responseJSON(t, editor.request(t, "POST", cpBase+"/"+cp.ID+"/retry", nil, editor.csrf, origin), 202, nil)
		work(t)
		before := readText(t, owner, cp.ID, first.Entry.ID)
		_, err = db.Exec(ctx, "UPDATE checkpoints SET state='materializing',lease_expires_at=now()-interval '1 second' WHERE id=$1", cp.ID)
		if err != nil {
			t.Fatal(err)
		}
		work(t)
		if after := readText(t, owner, cp.ID, first.Entry.ID); after != before {
			t.Fatal("retry changed immutable cut")
		}
		var attempt int64
		db.QueryRow(ctx, "SELECT attempt FROM checkpoints WHERE id=$1", cp.ID).Scan(&attempt)
		if err = app.materializeCheckpoint(ctx, project.ID, cp.ID, attempt-1); err == nil {
			t.Fatal("stale worker published")
		}
	})
	t.Run("database completion failure after uploads remains retryable", func(t *testing.T) {
		cp := create(t, owner, "DB completion failure")
		_, err = db.Exec(ctx, `CREATE FUNCTION checkpoint_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='`+cp.ID+`'::uuid AND NEW.state='ready' THEN RAISE EXCEPTION 'injected ready failure';END IF;RETURN NEW;END $$; CREATE TRIGGER checkpoint_test_failure BEFORE UPDATE ON checkpoints FOR EACH ROW EXECUTE FUNCTION checkpoint_test_failure()`)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Exec(ctx, `DROP TRIGGER IF EXISTS checkpoint_test_failure ON checkpoints;DROP FUNCTION IF EXISTS checkpoint_test_failure()`)
		worked, err := app.materializeNext(ctx)
		if !worked || err == nil {
			t.Fatal("injected DB failure passed")
		}
		var state string
		db.QueryRow(ctx, "SELECT state FROM checkpoints WHERE id=$1", cp.ID).Scan(&state)
		if state != "failed" {
			t.Fatal(state)
		}
		_, err = db.Exec(ctx, `DROP TRIGGER checkpoint_test_failure ON checkpoints;DROP FUNCTION checkpoint_test_failure()`)
		if err != nil {
			t.Fatal(err)
		}
		responseJSON(t, owner.request(t, "POST", cpBase+"/"+cp.ID+"/retry", nil, owner.csrf, origin), 202, nil)
		work(t)
	})
	t.Run("corrupt artifacts and preparation failure leave current intact", func(t *testing.T) {
		key := checkpointKey(project.ID, captured.ID, first.Entry.ID)
		original, err := storage.Get(ctx, key, 262144)
		if err != nil {
			t.Fatal(err)
		}
		if err = storage.Put(ctx, key, []byte("corrupt")); err != nil {
			t.Fatal(err)
		}
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+captured.ID+"/files/"+first.Entry.ID, nil, "", ""), 503, nil)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 503, nil)
		if err = storage.Put(ctx, key, original); err != nil {
			t.Fatal(err)
		}
		mkey := manifestKey(project.ID, captured.ID)
		manifest, err := storage.Get(ctx, mkey, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		storage.Put(ctx, mkey, []byte("corrupt"))
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+captured.ID, nil, "", ""), 503, nil)
		storage.Put(ctx, mkey, manifest)
		current := app.cfg.CollabOrigin
		app.cfg.CollabOrigin = "http://127.0.0.1:1"
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 503, nil)
		app.cfg.CollabOrigin = current
		var tree TreeResponse
		responseJSON(t, owner.request(t, "GET", base+"/tree", nil, "", ""), 200, &tree)
		if tree.TreeVersion != second.TreeVersion {
			t.Fatal("failed restore changed tree")
		}
		for _, entry := range tree.Entries {
			if entry.ID == first.Entry.ID && *entry.DocumentID != *first.Entry.DocumentID {
				t.Fatal("failed restore changed generation")
			}
		}
	})
	var restored struct {
		Version  string `json:"tree_version"`
		Previous string `json:"previous_checkpoint_id"`
	}
	t.Run("restore preserves latest committed state and rejects old writes", func(t *testing.T) {
		// A deleted/moved tree races through the same project/version boundary.
		var rename treeMutation
		responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/tree/"+first.Entry.ID, second.TreeVersion, map[string]any{"name": "renamed.js"}), 200, &rename)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", second.TreeVersion, nil), 409, nil)
		responseJSON(t, mustTreeRequest(t, owner, "DELETE", base+"/tree/"+second.Entry.ID, rename.TreeVersion, nil), 204, nil)
		version, _ := strconv.Atoi(rename.TreeVersion)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", strconv.Itoa(version+1), nil), 200, &restored)
		if restored.Previous == "" {
			t.Fatal("previous cut missing")
		}
		work(t)
		previous := readText(t, owner, restored.Previous, first.Entry.ID)
		if !strings.Contains(previous, "captured α") || strings.Count(previous, "live") != 24 {
			t.Fatalf("prior state lost: %q", previous)
		}
		var prior CheckpointManifest
		responseJSON(t, owner.request(t, "GET", cpBase+"/"+restored.Previous, nil, "", ""), 200, &prior)
		if len(prior.Files) != 1 || prior.Files[0].Path != "src/renamed.js" {
			t.Fatal("pre-restore tree not preserved")
		}
		var tree TreeResponse
		responseJSON(t, owner.request(t, "GET", base+"/tree", nil, "", ""), 200, &tree)
		if len(tree.Entries) != 3 {
			t.Fatal("deleted file not restored")
		}
		for _, entry := range tree.Entries {
			if entry.Kind == "file" {
				if entry.Generation != "2" {
					t.Fatal(entry.Generation)
				}
				if entry.ID == first.Entry.ID && *entry.DocumentID == *first.Entry.DocumentID {
					t.Fatal("reused old document")
				}
			}
		}
		if err = appendText(first.Entry, owner, "stale"); err == nil || !strings.Contains(err.Error(), "STALE_GENERATION") {
			t.Fatalf("old generation accepted: %v", err)
		}
		var events int
		db.QueryRow(ctx, "SELECT count(*) FROM project_events WHERE project_id=$1 AND event_type='project_restored'", project.ID).Scan(&events)
		if events != 1 {
			t.Fatal("restore event missing")
		}
	})
	t.Run("restore rollback on database replacement failure", func(t *testing.T) {
		_, err = db.Exec(ctx, `CREATE FUNCTION restore_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='`+first.Entry.ID+`'::uuid AND NEW.generation>OLD.generation THEN RAISE EXCEPTION 'injected pointer failure';END IF;RETURN NEW;END $$; CREATE TRIGGER restore_test_failure BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION restore_test_failure()`)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Exec(ctx, `DROP TRIGGER IF EXISTS restore_test_failure ON files;DROP FUNCTION IF EXISTS restore_test_failure()`)
		responseJSON(t, mustTreeRequest(t, owner, "POST", cpBase+"/"+captured.ID+"/restore", restored.Version, nil), 503, nil)
		var tree TreeResponse
		responseJSON(t, owner.request(t, "GET", base+"/tree", nil, "", ""), 200, &tree)
		if tree.TreeVersion != restored.Version {
			t.Fatal("rollback changed version")
		}
		var count int
		db.QueryRow(ctx, "SELECT count(*) FROM checkpoints WHERE project_id=$1 AND name LIKE 'Before restore:%'", project.ID).Scan(&count)
		if count != 1 {
			t.Fatal("failed replacement persisted partial prior checkpoint")
		}
	})

	t.Run("edit and delete during restore preparation serialize at replacement", func(t *testing.T) {
		raceRestore := func(version string, mutate func()) *http.Response {
			t.Helper()
			original := app.client
			copyClient := *original
			transport := original.Transport
			if transport == nil {
				transport = http.DefaultTransport
			}
			barrier := &checkpointBarrierTransport{base: transport, entered: make(chan struct{}), release: make(chan struct{})}
			copyClient.Transport = barrier
			app.client = &copyClient
			result := make(chan *http.Response, 1)
			failure := make(chan error, 1)
			go func() {
				response, err := treeRequest(owner, "POST", cpBase+"/"+captured.ID+"/restore", version, nil)
				if err != nil {
					failure <- err
				} else {
					result <- response
				}
			}()
			select {
			case <-barrier.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("preparation barrier not reached")
			}
			mutate()
			close(barrier.release)
			select {
			case response := <-result:
				app.client = original
				return response
			case err := <-failure:
				app.client = original
				t.Fatal(err)
			case <-time.After(10 * time.Second):
				t.Fatal("restore did not finish")
			}
			return nil
		}
		var tree TreeResponse
		responseJSON(t, owner.request(t, "GET", base+"/tree", nil, "", ""), 200, &tree)
		var current TreeEntry
		for _, entry := range tree.Entries {
			if entry.ID == first.Entry.ID {
				current = entry
			}
		}
		worker := uuid.NewString()
		workers[current.ID] = worker
		var fence int64
		if err := db.QueryRow(ctx, "SELECT cce_acquire_document($1,$2)", current.DocumentID, worker).Scan(&fence); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Version  string `json:"tree_version"`
			Previous string `json:"previous_checkpoint_id"`
		}
		responseJSON(t, raceRestore(tree.TreeVersion, func() {
			if err := appendText(current, editor, "racing-edit"); err != nil {
				t.Fatal(err)
			}
		}), 200, &result)
		work(t)
		prior := readText(t, owner, result.Previous, current.ID)
		if !strings.Contains(prior, "racing-edit") {
			t.Fatalf("edit during preparation not preserved: %q", prior)
		}
		responseJSON(t, raceRestore(result.Version, func() {
			responseJSON(t, mustTreeRequest(t, owner, "DELETE", base+"/tree/"+first.Entry.ID, result.Version, nil), 204, nil)
		}), 409, nil)
		responseJSON(t, owner.request(t, "GET", base+"/tree", nil, "", ""), 200, &tree)
		for _, entry := range tree.Entries {
			if entry.ID == first.Entry.ID {
				t.Fatal("failed restore resurrected concurrent deletion")
			}
		}
		var count int
		db.QueryRow(ctx, "SELECT count(*) FROM checkpoints WHERE project_id=$1 AND name LIKE 'Before restore:%'", project.ID).Scan(&count)
		if count != 2 {
			t.Fatal("conflicting restore captured partial previous state")
		}
	})
}
