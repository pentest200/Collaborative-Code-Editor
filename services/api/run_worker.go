package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Only the private control listener registers these routes. The runner has a
// narrowly scoped control token, no database, session, OAuth or storage secret.
func (a *App) runnerRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/runs/claim", a.claimRun)
	mux.HandleFunc("POST /internal/runs/{run_id}/heartbeat", a.heartbeatRun)
	mux.HandleFunc("POST /internal/runs/{run_id}/output", a.appendRunOutput)
	mux.HandleFunc("POST /internal/runs/{run_id}/finish", a.finishRun)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if a.cfg.RunnerToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.RunnerToken)) != 1 {
			writeError(w, 401, "AUTH_REQUIRED", "Runner authentication required")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// No interrupted attempt is queued again. Reconciliation must remove its
// deterministic container before the agent claims another job.
func (a *App) advanceRuns(ctx context.Context) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT j.id::text,j.state,c.state,j.cancel_requested FROM run_jobs j JOIN checkpoints c ON c.id=j.checkpoint_id WHERE (j.state='capturing' AND c.state IN ('ready','failed')) OR (j.state='running' AND j.lease_expires_at<clock_timestamp()) ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 16`)
	if err != nil {
		return err
	}
	type transition struct {
		id, state, cp string
		cancel        bool
	}
	var jobs []transition
	for rows.Next() {
		var job transition
		if err = rows.Scan(&job.id, &job.state, &job.cp, &job.cancel); err != nil {
			rows.Close()
			return err
		}
		jobs = append(jobs, job)
	}
	rows.Close()
	for _, job := range jobs {
		state, failure := "queued", ""
		if job.cp == "failed" {
			state, failure = "failed", "CHECKPOINT_FAILED"
		}
		if job.state == "running" {
			state, failure = "failed", "RUNNER_INTERRUPTED"
		}
		if job.cancel {
			state, failure = "cancelled", ""
		}
		if err = runStatus(ctx, tx, job.id, state, failure, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type runnerFile struct {
	Path     string `json:"path"`
	Checksum string `json:"checksum"`
	Data     []byte `json:"data"`
}
type runnerInput struct {
	ID           string       `json:"id"`
	Claim        string       `json:"claim"`
	Attempt      int          `json:"attempt"`
	Runtime      string       `json:"runtime"`
	Entrypoint   string       `json:"entrypoint"`
	Stdin        []byte       `json:"stdin"`
	Manifest     []byte       `json:"manifest"`
	ManifestHash string       `json:"manifest_hash"`
	Files        []runnerFile `json:"files"`
}

func (a *App) claimRun(w http.ResponseWriter, r *http.Request) {
	if err := a.advanceRuns(r.Context()); err != nil {
		treeDBError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		treeDBError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var job runnerInput
	var project, checkpoint string
	err = tx.QueryRow(r.Context(), `SELECT id::text,project_id::text,checkpoint_id::text,runtime,entrypoint,stdin,attempt+1 FROM run_jobs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&job.ID, &project, &checkpoint, &job.Runtime, &job.Entrypoint, &job.Stdin, &job.Attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(204)
		return
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	var allowed bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM run_jobs j JOIN projects p ON p.id=j.project_id JOIN project_members m ON m.project_id=p.id AND m.user_id=j.actor_id WHERE j.id=$1 AND p.lifecycle_state='active' AND m.role IN ('owner','editor'))`, job.ID).Scan(&allowed)
	manifest, verifyErr := a.verifiedManifest(r.Context(), tx, project, checkpoint)
	found := false
	total := 0
	if err == nil && !allowed {
		err = errors.New("access changed")
	}
	if err == nil {
		err = verifyErr
	}
	if err == nil {
		job.Manifest, err = json.Marshal(manifest)
		job.ManifestHash = checksum(job.Manifest)
		for _, file := range manifest.Files {
			if !safeRunPath(file.Path) {
				err = errCheckpointCorrupt
				break
			}
			data, fileErr := a.verifiedFile(r.Context(), project, checkpoint, file)
			if fileErr != nil {
				err = fileErr
				break
			}
			total += len(data)
			job.Files = append(job.Files, runnerFile{file.Path, file.Checksum, data})
			if file.Path == job.Entrypoint {
				found = true
			}
		}
	}
	if err == nil && (!found || total > 10<<20 || len(job.Files) > 200) {
		err = errors.New("invalid entrypoint")
	}
	if err != nil {
		if runStatus(r.Context(), tx, job.ID, "failed", "INPUT_VERIFICATION_FAILED", nil) == nil {
			_ = tx.Commit(r.Context())
		}
		writeError(w, 503, "INPUT_VERIFICATION_FAILED", "Run input could not be verified")
		return
	}
	err = runStatus(r.Context(), tx, job.ID, "running", "", nil)
	if err == nil {
		err = tx.QueryRow(r.Context(), `UPDATE run_jobs SET attempt=$2,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=$1 RETURNING claim_token::text`, job.ID, job.Attempt).Scan(&job.Claim)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 200, job)
}

type runnerMessage struct {
	Claim     string `json:"claim"`
	Sequence  string `json:"sequence,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Data      []byte `json:"data,omitempty"`
	State     string `json:"state,omitempty"`
	ExitCode  *int   `json:"exit_code,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

func (a *App) runnerTx(w http.ResponseWriter, r *http.Request) (pgx.Tx, Run, runnerMessage, bool) {
	var input runnerMessage
	id := r.PathValue("run_id")
	if !validUUID(id) || readRunJSON(r, &input, 100000) != nil || !validUUID(input.Claim) {
		writeError(w, 400, "INVALID_REQUEST", "Invalid runner receipt")
		return nil, Run{}, input, false
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		treeDBError(w, err)
		return nil, Run{}, input, false
	}
	run, err := scanRun(tx.QueryRow(r.Context(), `SELECT `+runColumns+` FROM run_jobs WHERE id=$1 AND claim_token=$2 FOR UPDATE`, id, input.Claim))
	if err != nil {
		tx.Rollback(r.Context())
		writeError(w, 409, "CLAIM_REPLACED", "Runner claim is no longer valid")
		return nil, Run{}, input, false
	}
	var live bool
	err = tx.QueryRow(r.Context(), `SELECT state='running' AND lease_expires_at>clock_timestamp() FROM run_jobs WHERE id=$1`, id).Scan(&live)
	if err != nil || (!live && !terminalRun(run.State)) {
		tx.Rollback(r.Context())
		writeError(w, 409, "CLAIM_EXPIRED", "Runner lease expired")
		return nil, Run{}, input, false
	}
	return tx, run, input, true
}
func (a *App) heartbeatRun(w http.ResponseWriter, r *http.Request) {
	tx, run, _, ok := a.runnerTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if run.State != "running" {
		writeJSON(w, 200, map[string]bool{"stop": true})
		return
	}
	_, err := tx.Exec(r.Context(), `UPDATE run_jobs SET lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=$1`, run.ID)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"stop": run.Cancel})
}
func (a *App) appendRunOutput(w http.ResponseWriter, r *http.Request) {
	tx, run, input, ok := a.runnerTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	seq, err := strconv.ParseInt(input.Sequence, 10, 64)
	if err != nil || seq < 1 || (input.Kind != "stdout" && input.Kind != "stderr") || len(input.Data) > 4096 {
		writeError(w, 400, "INVALID_OUTPUT", "Invalid output sequence or chunk")
		return
	}
	var existing []byte
	var kind string
	duplicate := tx.QueryRow(r.Context(), `SELECT kind,payload FROM run_events WHERE job_id=$1 AND runner_sequence=$2`, run.ID, seq).Scan(&kind, &existing)
	if duplicate == nil {
		if kind != input.Kind || !bytes.Equal(existing, input.Data) {
			writeError(w, 409, "OUTPUT_CONFLICT", "Conflicting output receipt")
			return
		}
		writeJSON(w, 200, map[string]string{"sequence": input.Sequence})
		return
	}
	if !errors.Is(duplicate, pgx.ErrNoRows) || run.State != "running" {
		writeError(w, 409, "RUN_FINISHED", "Output no longer accepted")
		return
	}
	var current int64
	var used int
	err = tx.QueryRow(r.Context(), `SELECT output_sequence,output_bytes FROM run_jobs WHERE id=$1`, run.ID).Scan(&current, &used)
	if err != nil || seq != current+1 || used+len(input.Data) > 65536 {
		writeError(w, 409, "OUTPUT_LIMIT", "Output sequence or total limit exceeded")
		return
	}
	var event int64
	err = tx.QueryRow(r.Context(), `UPDATE run_jobs SET output_sequence=$2,output_bytes=output_bytes+$3,event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence`, run.ID, seq, len(input.Data)).Scan(&event)
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO run_events(job_id,sequence,kind,payload,runner_sequence) VALUES($1,$2,$3,$4,$5)`, run.ID, event, input.Kind, input.Data, seq)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "RUN_STORAGE_UNAVAILABLE", "Output persistence failed; retry the same sequence")
		return
	}
	writeJSON(w, 200, map[string]string{"sequence": input.Sequence})
}
func (a *App) finishRun(w http.ResponseWriter, r *http.Request) {
	tx, run, input, ok := a.runnerTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if !terminalRun(input.State) {
		writeError(w, 400, "INVALID_STATE", "Terminal status required")
		return
	}
	if terminalRun(run.State) {
		writeJSON(w, 200, run)
		return
	}
	if run.Cancel {
		input.State = "cancelled"
	}
	_, err := tx.Exec(r.Context(), `UPDATE run_jobs SET truncated=$2 WHERE id=$1`, run.ID, input.Truncated)
	if err == nil {
		err = runStatus(r.Context(), tx, run.ID, input.State, "", input.ExitCode)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"state": input.State})
}
func (a *App) runExecutionJobs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = a.advanceRuns(ctx)
		}
	}
}
