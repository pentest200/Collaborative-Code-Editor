package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPhase07RunIntegration(t *testing.T) {
	database, authority, endpoint := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_COLLAB_ORIGIN"), os.Getenv("TEST_ARTIFACT_ENDPOINT")
	if database == "" || authority == "" || endpoint == "" {
		t.Skip("real PostgreSQL, TS and MinIO required")
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
	cfg := Config{Environment: "development", PublicOrigin: origin, CallbackURL: origin + "/api/v1/auth/github/callback", ClientID: "fixture-id", ClientSecret: "fixture-secret", GitHubAuthURL: provider.server.URL + "/authorize", GitHubTokenURL: provider.server.URL + "/token", GitHubUserURL: provider.server.URL + "/user", CollabOrigin: authority, CollabToken: "cce_dev_internal_only", ArtifactEndpoint: endpoint, ArtifactAccessKey: "cce_local_storage", ArtifactSecretKey: "cce_local_storage_only", ArtifactBucket: "cce-checkpoints", RunnerToken: "phase07_fixture_private_control_token"}
	storage, err := newArtifacts(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = storage.ensureBucket(ctx); err != nil {
		t.Fatal(err)
	}
	app := &App{db: db, cfg: cfg, artifacts: storage, client: &http.Client{Timeout: 40 * time.Second}}
	api := httptest.NewServer(app.routes())
	defer api.Close()
	control := httptest.NewServer(app.runnerRoutes())
	defer control.Close()
	owner := newBrowser(api.URL)
	owner.login(t, provider, origin)
	var project Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Run API acceptance"}, owner.csrf, origin), 201, &project)
	base := "/api/v1/projects/" + project.ID
	var file treeMutation
	responseJSON(t, mustTreeRequest(t, owner, "POST", base+"/tree", "0", map[string]string{"kind": "file", "name": "main.py"}), 201, &file)
	input := runInput{Runtime: "python", Entrypoint: "main.py"}
	post := func(path, key string, body any) *http.Response {
		t.Helper()
		data, _ := json.Marshal(body)
		r, _ := http.NewRequest("POST", api.URL+path, bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", owner.csrf)
		r.Header.Set("Idempotency-Key", key)
		res, err := owner.client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	worker := func(path string, body any) *http.Response {
		t.Helper()
		data, _ := json.Marshal(body)
		r, _ := http.NewRequest("POST", control.URL+path, bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+cfg.RunnerToken)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	create := func() Run {
		t.Helper()
		var run Run
		responseJSON(t, post(base+"/runs", uuid.NewString(), input), 202, &run)
		return run
	}
	ready := func(run Run) {
		t.Helper()
		_, err := db.Exec(ctx, `UPDATE checkpoints SET state='materializing',attempt=1 WHERE id=$1`, run.CheckpointID)
		if err != nil {
			t.Fatal(err)
		}
		if err = app.materializeCheckpoint(ctx, project.ID, run.CheckpointID, 1); err != nil {
			t.Fatal(err)
		}
	}
	claim := func(run Run) runnerInput {
		t.Helper()
		ready(run)
		var job runnerInput
		responseJSON(t, worker("/internal/runs/claim", map[string]any{}), 200, &job)
		if job.ID != run.ID {
			t.Fatalf("claimed unexpected job: %s", job.ID)
		}
		return job
	}
	finish := func(job runnerInput) {
		t.Helper()
		zero := 0
		responseJSON(t, worker("/internal/runs/"+job.ID+"/finish", runnerMessage{Claim: job.Claim, State: "succeeded", ExitCode: &zero}), 200, nil)
	}
	t.Run("concurrent duplicate capture creates exactly one immutable job", func(t *testing.T) {
		key := uuid.NewString()
		var wg sync.WaitGroup
		responses := make(chan *http.Response, 6)
		for n := 0; n < 6; n++ {
			wg.Add(1)
			go func() { defer wg.Done(); responses <- post(base+"/runs", key, input) }()
		}
		wg.Wait()
		close(responses)
		id := ""
		for res := range responses {
			var run Run
			responseJSON(t, res, 202, &run)
			if id == "" {
				id = run.ID
			}
			if run.ID != id {
				t.Fatal("duplicate capture")
			}
		}
		var count int
		if err = db.QueryRow(ctx, `SELECT count(*) FROM run_jobs WHERE project_id=$1 AND idempotency_key=$2`, project.ID, key).Scan(&count); err != nil || count != 1 {
			t.Fatal(err, count)
		}
		responseJSON(t, owner.request(t, "DELETE", base+"/runs/"+id, nil, owner.csrf, origin), 202, nil)
		// Keep the shared materializer queue clean for the next normal/race suite.
		// Cancellation does not cancel its independent captured checkpoint job.
		cancelled, loadError := scanRun(db.QueryRow(ctx, `SELECT `+runColumns+` FROM run_jobs WHERE id=$1`, id))
		if loadError != nil {
			t.Fatal(loadError)
		}
		ready(cancelled)
	})
	t.Run("private control, sequenced output receipts and terminal immutability", func(t *testing.T) {
		responseJSON(t, owner.request(t, "POST", "/internal/runs/claim", nil, "", ""), 404, nil)
		res, err := http.Post(control.URL+"/internal/runs/claim", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		responseJSON(t, res, 401, nil)
		job := claim(create())
		path := "/internal/runs/" + job.ID
		message := runnerMessage{Claim: job.Claim, Sequence: "1", Kind: "stdout", Data: []byte("receipt")}
		responseJSON(t, worker(path+"/output", message), 200, nil)
		responseJSON(t, worker(path+"/output", message), 200, nil)
		message.Data = []byte("changed")
		responseJSON(t, worker(path+"/output", message), 409, nil)
		message.Sequence = "3"
		responseJSON(t, worker(path+"/output", message), 409, nil)
		message.Claim = uuid.NewString()
		responseJSON(t, worker(path+"/heartbeat", message), 409, nil)
		finish(job)
		finish(job)
		message.Claim = job.Claim
		message.Sequence = "2"
		responseJSON(t, worker(path+"/output", message), 409, nil)
		var count int
		if err = db.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE job_id=$1 AND kind='stdout'`, job.ID).Scan(&count); err != nil || count != 1 {
			t.Fatal(err, count)
		}
		if _, err = db.Exec(ctx, `UPDATE run_jobs SET state='queued' WHERE id=$1`, job.ID); err == nil {
			t.Fatal("terminal job reopened")
		}
		if _, err = db.Exec(ctx, `UPDATE run_jobs SET entrypoint='different.py' WHERE id=$1`, job.ID); err == nil {
			t.Fatal("immutable input changed")
		}
	})
	t.Run("expired attempt fails with stale receipts and no automatic requeue", func(t *testing.T) {
		job := claim(create())
		if _, err = db.Exec(ctx, `UPDATE run_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
			t.Fatal(err)
		}
		responseJSON(t, worker("/internal/runs/"+job.ID+"/output", runnerMessage{Claim: job.Claim, Sequence: "1", Kind: "stdout", Data: []byte("late")}), 409, nil)
		if err = app.advanceRuns(ctx); err != nil {
			t.Fatal(err)
		}
		var state, failure string
		var attempt int
		if err = db.QueryRow(ctx, `SELECT state,failure_code,attempt FROM run_jobs WHERE id=$1`, job.ID).Scan(&state, &failure, &attempt); err != nil || state != "failed" || failure != "RUNNER_INTERRUPTED" || attempt != 1 {
			t.Fatal(err, state, failure, attempt)
		}
	})
	t.Run("failed and corrupt checkpoint inputs never execute", func(t *testing.T) {
		failed := create()
		if _, err = db.Exec(ctx, `UPDATE checkpoints SET state='failed',failure_code='FIXTURE' WHERE id=$1`, failed.CheckpointID); err != nil {
			t.Fatal(err)
		}
		if err = app.advanceRuns(ctx); err != nil {
			t.Fatal(err)
		}
		var state string
		if err = db.QueryRow(ctx, `SELECT state FROM run_jobs WHERE id=$1`, failed.ID).Scan(&state); err != nil || state != "failed" {
			t.Fatal(err, state)
		}
		corrupt := create()
		ready(corrupt)
		if err = storage.Put(ctx, checkpointKey(project.ID, corrupt.CheckpointID, file.Entry.ID), []byte("corrupt")); err != nil {
			t.Fatal(err)
		}
		responseJSON(t, worker("/internal/runs/claim", map[string]any{}), 503, nil)
		if err = db.QueryRow(ctx, `SELECT state FROM run_jobs WHERE id=$1`, corrupt.ID).Scan(&state); err != nil || state != "failed" {
			t.Fatal(err, state)
		}
	})
	t.Run("bounded stdin and malformed entrypoint rejected before capture", func(t *testing.T) {
		for _, invalid := range []runInput{{Runtime: "python", Entrypoint: "../secret"}, {Runtime: "shell", Entrypoint: "main.py"}, {Runtime: "python", Entrypoint: "main.py", Stdin: strings.Repeat("é", 8193)}} {
			responseJSON(t, post(base+"/runs", uuid.NewString(), invalid), 400, nil)
		}
	})
	t.Run("output database failure produces no event and retries original identity", func(t *testing.T) {
		job := claim(create())
		function := "run_output_fault_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		trigger := function + "_trigger"
		sql := `CREATE FUNCTION ` + function + `() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id='` + job.ID + `' AND NEW.kind='stdout' THEN RAISE EXCEPTION 'fixture output failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ` + trigger + ` BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION ` + function + `() `
		if _, err = db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
		defer db.Exec(ctx, `DROP TRIGGER IF EXISTS `+trigger+` ON run_events; DROP FUNCTION IF EXISTS `+function+`() `)
		message := runnerMessage{Claim: job.Claim, Sequence: "1", Kind: "stdout", Data: []byte("retry-original")}
		path := "/internal/runs/" + job.ID + "/output"
		responseJSON(t, worker(path, message), 503, nil)
		var head int64
		if err = db.QueryRow(ctx, `SELECT output_sequence FROM run_jobs WHERE id=$1`, job.ID).Scan(&head); err != nil || head != 0 {
			t.Fatal(err, head)
		}
		if _, err = db.Exec(ctx, `DROP TRIGGER `+trigger+` ON run_events; DROP FUNCTION `+function+`() `); err != nil {
			t.Fatal(err)
		}
		responseJSON(t, worker(path, message), 200, nil)
		finish(job)
	})
	// Verify public event data is read only through the session-scoped route.
	response := owner.request(t, "GET", base+"/runs/"+uuid.NewString()+"/events", nil, "", "")
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal(response.StatusCode)
	}
}
