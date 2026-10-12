package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Run struct {
	ID           string  `json:"id"`
	ProjectID    string  `json:"project_id"`
	CheckpointID string  `json:"checkpoint_id"`
	Runtime      string  `json:"runtime"`
	Entrypoint   string  `json:"entrypoint"`
	State        string  `json:"state"`
	Attempt      int     `json:"attempt"`
	Sequence     string  `json:"event_sequence"`
	Cancel       bool    `json:"cancel_requested"`
	Truncated    bool    `json:"truncated"`
	ExitCode     *int    `json:"exit_code"`
	Failure      *string `json:"failure_code"`
}
type runInput struct {
	Runtime    string `json:"runtime"`
	Entrypoint string `json:"entrypoint"`
	Stdin      string `json:"stdin"`
}

const runColumns = `id::text,project_id::text,checkpoint_id::text,runtime,entrypoint,state,attempt,event_sequence::text,cancel_requested,truncated,exit_code,failure_code`

func scanRun(row pgx.Row) (r Run, err error) {
	err = row.Scan(&r.ID, &r.ProjectID, &r.CheckpointID, &r.Runtime, &r.Entrypoint, &r.State, &r.Attempt, &r.Sequence, &r.Cancel, &r.Truncated, &r.ExitCode, &r.Failure)
	return
}
func terminalRun(state string) bool {
	return state == "succeeded" || state == "failed" || state == "timed_out" || state == "cancelled"
}
func safeRunPath(value string) bool {
	if value == "" || len(value) > 1024 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." || part == "" {
			return false
		}
	}
	return true
}
func readRunJSON(r *http.Request, value any, limit int64) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("JSON required")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(data)) > limit || !utf8.Valid(data) {
		return errors.New("invalid body")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func runStatus(ctx context.Context, tx pgx.Tx, id, state, failure string, exit *int) error {
	var seq int64
	err := tx.QueryRow(ctx, `UPDATE run_jobs SET state=$2,failure_code=NULLIF($3,''),exit_code=$4,event_sequence=event_sequence+1,lease_expires_at=NULL,finished_at=CASE WHEN $2 IN ('succeeded','failed','timed_out','cancelled') THEN clock_timestamp() ELSE NULL END WHERE id=$1 RETURNING event_sequence`, id, state, failure, exit).Scan(&seq)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"state": state, "failure_code": failure, "exit_code": exit})
	_, err = tx.Exec(ctx, `INSERT INTO run_events(job_id,sequence,kind,payload) VALUES($1,$2,'status',$3)`, id, seq, payload)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO outbox_events(operation_id,topic,payload) VALUES(gen_random_uuid(),'run.'||$2::text,jsonb_build_object('run_id',$1::text,'state',$2::text))`, id, state)
	}
	return err
}
func (a *App) createRun(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	if a.cfg.RunnerToken == "" {
		writeError(w, 503, "EXECUTION_UNAVAILABLE", "Restricted execution is not configured")
		return
	}
	project, key := r.PathValue("project_id"), r.Header.Get("Idempotency-Key")
	var input runInput
	if !validUUID(project) || !validUUID(key) || readRunJSON(r, &input, 128<<10) != nil || !safeRunPath(input.Entrypoint) || len(input.Stdin) > 16384 || (input.Runtime != "python" && input.Runtime != "javascript") {
		writeError(w, 400, "INVALID_REQUEST", "Choose a Python or JavaScript entrypoint, UUID request key and at most 16 KiB stdin")
		return
	}
	encoded, _ := json.Marshal(input)
	hash := digest(string(encoded))
	var tx pgx.Tx
	var version int64
	var err error
	for retry := 0; retry < 3; retry++ {
		tx, version, err = a.checkpointTx(r.Context(), project, session, true, false)
		var databaseError *pgconn.PgError
		if !errors.As(err, &databaseError) || databaseError.Code != "40001" {
			break
		}
	}
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Global transaction advisory actor lock also serializes cross-project captures.
	_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,7))`, session.UserID)
	if err != nil {
		treeDBError(w, err)
		return
	}
	var previousHash []byte
	existing, lookup := scanRun(tx.QueryRow(r.Context(), `SELECT `+runColumns+` FROM run_jobs WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3`, project, session.UserID, key))
	if lookup == nil {
		err = tx.QueryRow(r.Context(), `SELECT request_hash FROM run_jobs WHERE id=$1`, existing.ID).Scan(&previousHash)
		if err != nil {
			treeDBError(w, err)
			return
		}
		if !bytes.Equal(hash, previousHash) {
			writeError(w, 409, "IDEMPOTENCY_CONFLICT", "Request key was used with different input")
			return
		}
		writeJSON(w, 202, existing)
		return
	}
	if !errors.Is(lookup, pgx.ErrNoRows) {
		treeDBError(w, lookup)
		return
	}
	var active int
	err = tx.QueryRow(r.Context(), `SELECT count(*) FROM run_jobs WHERE (actor_id=$1 OR project_id=$2) AND state IN ('capturing','queued','running')`, session.UserID, project).Scan(&active)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if active > 0 {
		writeError(w, 429, "RUN_QUOTA", "One active run per user and project is allowed")
		return
	}
	var hasAssets bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM files f JOIN file_assets a ON a.document_id=f.current_document_id WHERE f.project_id=$1 AND f.tombstoned_at IS NULL)`, project).Scan(&hasAssets); err != nil {
		treeDBError(w, err)
		return
	}
	if hasAssets {
		writeError(w, 409, "WORKSPACE_REQUIRED", "This project includes binary or large files. Use Run workspace in the development environment.")
		return
	}
	var exists bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM files WHERE project_id=$1 AND tombstoned_at IS NULL AND kind='file')`, project).Scan(&exists)
	if err != nil || !exists {
		writeError(w, 400, "INVALID_ENTRYPOINT", "Project has no executable files")
		return
	}
	cp, err := captureCheckpoint(r.Context(), tx, project, session.UserID, "Run input", version)
	if err != nil {
		treeDBError(w, err)
		return
	}
	var id string
	err = tx.QueryRow(r.Context(), `INSERT INTO run_jobs(project_id,actor_id,checkpoint_id,idempotency_key,runtime,entrypoint,stdin,state,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'capturing',$8) RETURNING id::text`, project, session.UserID, cp.ID, key, input.Runtime, input.Entrypoint, []byte(input.Stdin), hash).Scan(&id)
	if err == nil {
		err = runStatus(r.Context(), tx, id, "capturing", "", nil)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		_ = tx.Rollback(r.Context())
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && (databaseError.Code == "23505" || databaseError.Code == "40001") {
			resolved, _, accessError := a.checkpointTx(r.Context(), project, session, true, false)
			if accessError != nil {
				treeTxError(w, accessError)
				return
			}
			defer resolved.Rollback(r.Context())
			original, lookupError := scanRun(resolved.QueryRow(r.Context(), `SELECT `+runColumns+` FROM run_jobs WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3`, project, session.UserID, key))
			var originalHash []byte
			if lookupError == nil {
				lookupError = resolved.QueryRow(r.Context(), `SELECT request_hash FROM run_jobs WHERE id=$1`, original.ID).Scan(&originalHash)
				if lookupError == nil && bytes.Equal(originalHash, hash) {
					writeJSON(w, 202, original)
					return
				}
				if lookupError == nil {
					writeError(w, 409, "IDEMPOTENCY_CONFLICT", "Request key was used with different input")
					return
				}
			}
			writeError(w, 429, "RUN_QUOTA", "Another run already holds the active quota")
			return
		}
		treeDBError(w, err)
		return
	}
	result, err := scanRun(a.db.QueryRow(r.Context(), `SELECT `+runColumns+` FROM run_jobs WHERE id=$1`, id))
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 202, result)
}
func (a *App) runReadTx(w http.ResponseWriter, r *http.Request, mutation bool) (pgx.Tx, Run, bool) {
	var session Session
	var ok bool
	if mutation {
		session, ok = a.requireMutation(w, r)
	} else {
		session, ok = a.requireSession(w, r)
	}
	if !ok {
		return nil, Run{}, false
	}
	project, id := r.PathValue("project_id"), r.PathValue("run_id")
	if !validUUID(project) || !validUUID(id) {
		writeError(w, 404, "NOT_FOUND", "Run not found")
		return nil, Run{}, false
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, mutation, false)
	if err != nil {
		treeTxError(w, err)
		return nil, Run{}, false
	}
	suffix := ""
	if mutation {
		suffix = " FOR UPDATE"
	}
	run, err := scanRun(tx.QueryRow(r.Context(), `SELECT `+runColumns+` FROM run_jobs WHERE id=$1 AND project_id=$2`+suffix, id, project))
	if err != nil {
		tx.Rollback(r.Context())
		writeError(w, 404, "NOT_FOUND", "Run not found")
		return nil, Run{}, false
	}
	return tx, run, true
}
func (a *App) getRun(w http.ResponseWriter, r *http.Request) {
	tx, run, ok := a.runReadTx(w, r, false)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	writeJSON(w, 200, run)
}
func (a *App) cancelRun(w http.ResponseWriter, r *http.Request) {
	tx, run, ok := a.runReadTx(w, r, true)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	var err error
	if !terminalRun(run.State) {
		_, err = tx.Exec(r.Context(), `UPDATE run_jobs SET cancel_requested=true WHERE id=$1`, run.ID)
		if err == nil && run.State != "running" {
			err = runStatus(r.Context(), tx, run.ID, "cancelled", "", nil)
		}
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 202, map[string]string{"id": run.ID})
}
func (a *App) runEvents(w http.ResponseWriter, r *http.Request) {
	after := int64(0)
	var err error
	value := r.URL.Query().Get("after")
	if value == "" {
		value = r.Header.Get("Last-Event-ID")
	}
	if value != "" {
		after, err = strconv.ParseInt(value, 10, 64)
	}
	if err != nil || after < 0 {
		writeError(w, 400, "INVALID_SEQUENCE", "Use a decimal event sequence")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, "STREAM_UNAVAILABLE", "Streaming unavailable")
		return
	}
	started := false
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		tx, run, ok := a.runReadTx(w, r, false)
		if !ok {
			return
		}
		rows, err := tx.Query(r.Context(), `SELECT sequence,kind,payload FROM run_events WHERE job_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 128`, run.ID, after)
		if err != nil {
			tx.Rollback(r.Context())
			return
		}
		if !started {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-store")
			started = true
		}
		for rows.Next() {
			var seq int64
			var kind string
			var data []byte
			if rows.Scan(&seq, &kind, &data) != nil {
				break
			}
			payload, _ := json.Marshal(map[string]string{"kind": kind, "text": string(data)})
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
			if _, err = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", seq, payload); err != nil {
				rows.Close()
				tx.Rollback(r.Context())
				return
			}
			after = seq
		}
		rows.Close()
		tx.Rollback(r.Context())
		flusher.Flush()
		head, _ := strconv.ParseInt(run.Sequence, 10, 64)
		if terminalRun(run.State) && after >= head {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			return
		case <-ticker.C:
		}
	}
}
