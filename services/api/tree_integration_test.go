package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type treeMutation struct {
	Entry         TreeEntry `json:"entry"`
	TreeVersion   string    `json:"tree_version"`
	EventSequence string    `json:"event_sequence"`
}

func treeRequest(browser *testBrowser, method, path, version string, body any) (*http.Response, error) {
	var input io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		input = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, browser.api+path, input)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("X-CSRF-Token", browser.csrf)
	if version != "" {
		request.Header.Set("If-Match", version)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return browser.client.Do(request)
}

func mustTreeRequest(t *testing.T, browser *testBrowser, method, path, version string, body any) *http.Response {
	t.Helper()
	response, err := treeRequest(browser, method, path, version, body)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestPhase02TreeIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for real PostgreSQL integration checks")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	var migrations int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0003_file_tree'`).Scan(&migrations); err != nil || migrations != 1 {
		t.Fatalf("Phase 02 migration missing: %d %v", migrations, err)
	}
	const origin = "http://localhost:3000"
	provider := newFakeProvider(t, origin+"/api/v1/auth/github/callback")
	defer provider.server.Close()
	initializer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/documents/empty" || r.Header.Get("X-Internal-Token") != "fixture-internal" {
			http.Error(w, "forbidden", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"encoded_state":"AAA=","state_vector":"AA=="}`)
	}))
	defer initializer.Close()
	cfg := Config{Environment: "development", PublicOrigin: origin, CallbackURL: origin + "/api/v1/auth/github/callback", ClientID: "fixture-id", ClientSecret: "fixture-secret", GitHubAuthURL: provider.server.URL + "/authorize", GitHubTokenURL: provider.server.URL + "/token", GitHubUserURL: provider.server.URL + "/user", CollabOrigin: initializer.URL, CollabToken: "fixture-internal"}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 5 * time.Second}}
	api := httptest.NewServer(app.routes())
	defer api.Close()
	owner := newBrowser(api.URL)
	owner.login(t, provider, origin)
	var project Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Tree integration"}, owner.csrf, origin), 201, &project)
	base := "/api/v1/projects/" + project.ID + "/tree"
	guest := newBrowser(api.URL)
	responseJSON(t, guest.request(t, "GET", base, nil, "", ""), 401, nil)
	var tree TreeResponse
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)
	if tree.TreeVersion != "0" || len(tree.Entries) != 0 {
		t.Fatalf("unexpected initial tree: %+v", tree)
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, "", map[string]any{"kind": "file", "name": "invalid.ts"}), 428, nil)

	var folder, child, file treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, "0", map[string]any{"kind": "folder", "name": "src"}), 201, &folder)
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, folder.TreeVersion, map[string]any{"kind": "file", "name": "main.ts", "parent_id": folder.Entry.ID}), 201, &child)
	if child.Entry.ID == "" || child.Entry.DocumentID == nil || child.Entry.Language == nil || *child.Entry.Language != "typescript" {
		t.Fatalf("bad created file: %+v", child)
	}
	var encodedState, vector, checksum []byte
	if err := db.QueryRow(ctx, `SELECT encoded_state,state_vector,checksum FROM document_snapshots WHERE document_id=$1 AND through_sequence=0`, *child.Entry.DocumentID).Scan(&encodedState, &vector, &checksum); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(encodedState)
	if !bytes.Equal(encodedState, []byte{0, 0}) || !bytes.Equal(vector, []byte{0}) || !bytes.Equal(checksum, hash[:]) {
		t.Fatal("initial Yjs snapshot was not persisted atomically")
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, child.TreeVersion, map[string]any{"kind": "file", "name": "root.py"}), 201, &file)
	var conflict struct {
		CurrentVersion string `json:"current_version"`
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, "0", map[string]any{"kind": "folder", "name": "late"}), 409, &conflict)
	if conflict.CurrentVersion != file.TreeVersion {
		t.Fatalf("wrong current version: %+v", conflict)
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, file.TreeVersion, map[string]any{"kind": "folder", "name": "src"}), 409, nil)
	for _, name := range []string{"..", "has/slash", "trail ", "bad\tname", "bad:name"} {
		responseJSON(t, mustTreeRequest(t, owner, "POST", base, file.TreeVersion, map[string]any{"kind": "folder", "name": name}), 400, nil)
	}
	var renamed treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/"+child.Entry.ID, file.TreeVersion, map[string]any{"name": "index.js"}), 200, &renamed)
	if renamed.Entry.ID != child.Entry.ID || *renamed.Entry.DocumentID != *child.Entry.DocumentID || *renamed.Entry.Language != "javascript" {
		t.Fatalf("rename changed identity: %+v", renamed)
	}
	var moved treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/"+child.Entry.ID, renamed.TreeVersion, map[string]any{"parent_id": nil}), 200, &moved)
	if moved.Entry.ParentID != nil || *moved.Entry.DocumentID != *child.Entry.DocumentID {
		t.Fatalf("move changed identity: %+v", moved)
	}
	var nested treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, moved.TreeVersion, map[string]any{"kind": "folder", "name": "nested", "parent_id": folder.Entry.ID}), 201, &nested)
	responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/"+folder.Entry.ID, nested.TreeVersion, map[string]any{"parent_id": nested.Entry.ID}), 400, nil)
	var other Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Other parent"}, owner.csrf, origin), 201, &other)
	var otherFolder treeMutation
	otherBase := "/api/v1/projects/" + other.ID + "/tree"
	responseJSON(t, mustTreeRequest(t, owner, "POST", otherBase, "0", map[string]any{"kind": "folder", "name": "foreign"}), 201, &otherFolder)
	responseJSON(t, mustTreeRequest(t, owner, "PATCH", base+"/"+child.Entry.ID, nested.TreeVersion, map[string]any{"parent_id": otherFolder.Entry.ID}), 400, nil)
	if _, err := db.Exec(ctx, `INSERT INTO files(project_id,name,kind) VALUES($1,'src','folder')`, project.ID); err == nil {
		t.Fatal("database accepted duplicate active root sibling")
	}
	if _, err := db.Exec(ctx, `INSERT INTO files(project_id,parent_id,name,kind) VALUES($1,$2,'foreign','folder')`, project.ID, otherFolder.Entry.ID); err == nil {
		t.Fatal("database accepted a cross-project parent")
	}
	if _, err := db.Exec(ctx, `UPDATE files SET parent_id=$2 WHERE id=$1`, folder.Entry.ID, nested.Entry.ID); err == nil {
		t.Fatal("database accepted a folder cycle")
	}
	if _, err := db.Exec(ctx, `INSERT INTO files(project_id,name,kind,language) VALUES($1,'uninitialized.ts','file','typescript')`, project.ID); err == nil {
		t.Fatal("database accepted an active file without a document")
	}

	viewer := newBrowser(api.URL)
	viewer.login(t, provider, origin)
	invite := createTestInvite(t, owner, "/api/v1/projects/"+project.ID, origin, "viewer", 1)
	responseJSON(t, viewer.request(t, "POST", "/api/v1/invites/"+invite.Token+"/accept", nil, viewer.csrf, origin), 200, nil)
	responseJSON(t, viewer.request(t, "GET", base, nil, "", ""), 200, nil)
	responseJSON(t, mustTreeRequest(t, viewer, "POST", base, nested.TreeVersion, map[string]any{"kind": "folder", "name": "denied"}), 403, nil)
	responseJSON(t, owner.request(t, "PATCH", "/api/v1/projects/"+project.ID+"/members/"+viewer.userID, map[string]string{"role": "editor"}, owner.csrf, origin), 200, nil)
	var editorCreate treeMutation
	responseJSON(t, mustTreeRequest(t, viewer, "POST", base, nested.TreeVersion, map[string]any{"kind": "folder", "name": "editor-folder"}), 201, &editorCreate)
	responseJSON(t, owner.request(t, "DELETE", "/api/v1/projects/"+project.ID+"/members/"+viewer.userID, nil, owner.csrf, origin), 204, nil)
	responseJSON(t, mustTreeRequest(t, viewer, "POST", base, editorCreate.TreeVersion, map[string]any{"kind": "folder", "name": "revoked"}), 404, nil)

	var renameMove sync.WaitGroup
	renameMoveResults := make(chan int, 2)
	for _, change := range []map[string]any{{"name": "moved-or-renamed.py"}, {"parent_id": folder.Entry.ID}} {
		renameMove.Add(1)
		go func(body map[string]any) {
			defer renameMove.Done()
			response, err := treeRequest(owner, "PATCH", base+"/"+child.Entry.ID, editorCreate.TreeVersion, body)
			if err != nil {
				renameMoveResults <- 0
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			renameMoveResults <- response.StatusCode
		}(change)
	}
	renameMove.Wait()
	close(renameMoveResults)
	renameMoveCounts := map[int]int{}
	for status := range renameMoveResults {
		renameMoveCounts[status]++
	}
	if renameMoveCounts[200] != 1 || renameMoveCounts[409] != 1 {
		t.Fatalf("rename/move race: %+v", renameMoveCounts)
	}
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)

	// Limits are enforced against the resulting tree, including every descendant on a move.
	currentVersion := tree.TreeVersion
	parentID := ""
	for level := 0; level < 16; level++ {
		var added treeMutation
		responseJSON(t, mustTreeRequest(t, owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": "depth-" + strconv.Itoa(level), "parent_id": nullableID(parentID)}), 201, &added)
		currentVersion, parentID = added.TreeVersion, added.Entry.ID
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": "depth-overflow", "parent_id": parentID}), 400, nil)
	longParent := ""
	longName := strings.Repeat("p", 250)
	for level := 0; level < 4; level++ {
		var added treeMutation
		responseJSON(t, mustTreeRequest(t, owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": longName, "parent_id": nullableID(longParent)}), 201, &added)
		currentVersion, longParent = added.TreeVersion, added.Entry.ID
	}
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": longName, "parent_id": longParent}), 400, nil)
	var disposable treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": "disposable"}), 201, &disposable)
	currentVersion = disposable.TreeVersion
	// Rename/delete race: exactly one transaction applies the shared precondition.
	var renameDelete sync.WaitGroup
	renameDeleteResults := make(chan int, 2)
	for _, operation := range []struct {
		method string
		body   any
	}{{"PATCH", map[string]any{"name": "renamed-disposable"}}, {"DELETE", nil}} {
		renameDelete.Add(1)
		go func(method string, body any) {
			defer renameDelete.Done()
			response, err := treeRequest(owner, method, base+"/"+disposable.Entry.ID, currentVersion, body)
			if err != nil {
				renameDeleteResults <- 0
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			renameDeleteResults <- response.StatusCode
		}(operation.method, operation.body)
	}
	renameDelete.Wait()
	close(renameDeleteResults)
	renameDeleteCounts := map[int]int{}
	for status := range renameDeleteResults {
		renameDeleteCounts[status]++
	}
	if renameDeleteCounts[409] != 1 || renameDeleteCounts[200]+renameDeleteCounts[204] != 1 {
		t.Fatalf("rename/delete race: %+v", renameDeleteCounts)
	}
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)
	currentVersion = tree.TreeVersion

	// Two concurrent writes against the same version must have one winner.
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, name := range []string{"race-a", "race-b"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			response, err := treeRequest(owner, "POST", base, currentVersion, map[string]any{"kind": "folder", "name": name})
			if err != nil {
				statuses <- 0
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			statuses <- response.StatusCode
		}(name)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatalf("tree race statuses: %+v", counts)
	}
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)

	// A failed private initialization must not create metadata or advance the version.
	initializer.Close()
	before := tree.TreeVersion
	responseJSON(t, mustTreeRequest(t, owner, "POST", base, before, map[string]any{"kind": "file", "name": "unavailable.py"}), 503, nil)
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)
	if tree.TreeVersion != before {
		t.Fatal("failed initialization advanced tree")
	}

	responseJSON(t, mustTreeRequest(t, owner, "DELETE", base+"/"+folder.Entry.ID, tree.TreeVersion, nil), 204, nil)
	responseJSON(t, owner.request(t, "GET", base, nil, "", ""), 200, &tree)
	for _, entry := range tree.Entries {
		if entry.ID == folder.Entry.ID || entry.ID == nested.Entry.ID {
			t.Fatal("subtree deletion left an active descendant")
		}
	}
	var deletedCount, eventCount, outboxCount int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM files WHERE id=ANY($1::uuid[]) AND tombstoned_at IS NOT NULL`, []string{folder.Entry.ID, nested.Entry.ID}).Scan(&deletedCount); err != nil || deletedCount != 2 {
		t.Fatalf("atomic subtree tombstone: %d %v", deletedCount, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM project_events WHERE project_id=$1 AND event_type LIKE 'tree_%'`, project.ID).Scan(&eventCount); err != nil || eventCount < 7 {
		t.Fatalf("missing durable tree events: %d %v", eventCount, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE topic='project.tree' AND payload->>'project_id'=$1`, project.ID).Scan(&outboxCount); err != nil || outboxCount != eventCount {
		t.Fatalf("tree outbox mismatch: %d/%d %v", outboxCount, eventCount, err)
	}
}

func nullableID(value string) any {
	if value == "" {
		return nil
	}
	return value
}
