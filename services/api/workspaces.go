package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (a *App) workspaceAccess(w http.ResponseWriter, r *http.Request, mutation, owner bool) (Session, string, bool) {
	var session Session
	var ok bool
	if mutation {
		session, ok = a.requireMutation(w, r)
	} else {
		session, ok = a.requireSession(w, r)
	}
	if !ok {
		return session, "", false
	}
	project := r.PathValue("project_id")
	if !validUUID(project) {
		writeError(w, 400, "INVALID_INPUT", "Invalid project")
		return session, project, false
	}
	if a.cfg.WorkspaceToken == "" {
		writeError(w, 503, "WORKSPACE_UNAVAILABLE", "Development workspaces are not configured")
		return session, project, false
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, mutation, owner)
	if err != nil {
		treeTxError(w, err)
		return session, project, false
	}
	_ = tx.Rollback(r.Context())
	return session, project, true
}
func (a *App) workspaceRequest(ctx context.Context, method, endpoint string, body io.Reader) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, a.cfg.WorkspaceOrigin+endpoint, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.WorkspaceToken)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client.Do(request)
}
func workspaceResponse(w http.ResponseWriter, response *http.Response, err error) {
	if err != nil {
		writeError(w, 503, "WORKSPACE_UNAVAILABLE", "Workspace service is unavailable")
		return
	}
	defer response.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 1<<20))
}
func (a *App) workspaceProxy(w http.ResponseWriter, r *http.Request) {
	_, project, ok := a.workspaceAccess(w, r, r.Method != "GET", r.Method == "DELETE")
	if !ok {
		return
	}
	suffix := ""
	if strings.HasSuffix(r.URL.Path, "/tasks") {
		suffix = "/tasks"
	}
	var body io.Reader
	if r.Method != "GET" && r.Method != "DELETE" {
		data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(data) > 8192 {
			writeError(w, 400, "INVALID_INPUT", "Request too large")
			return
		}
		body = bytes.NewReader(data)
	}
	response, err := a.workspaceRequest(r.Context(), r.Method, "/projects/"+project+suffix, body)
	workspaceResponse(w, response, err)
}
func (a *App) workspaceSync(w http.ResponseWriter, r *http.Request) {
	session, project, ok := a.workspaceAccess(w, r, true, false)
	if !ok {
		return
	}
	var input struct {
		CheckpointID string `json:"checkpoint_id"`
	}
	if readJSON(r, &input) != nil || !validUUID(input.CheckpointID) {
		writeError(w, 400, "INVALID_INPUT", "Choose a ready checkpoint")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, true, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	manifest, err := a.verifiedManifest(r.Context(), tx, project, input.CheckpointID)
	if err != nil {
		checkpointError(w, err)
		return
	}
	files := []runnerFile{}
	total := 0
	for _, file := range manifest.Files {
		data, fileErr := a.verifiedFile(r.Context(), project, input.CheckpointID, file)
		if fileErr != nil || !safeRunPath(file.Path) {
			checkpointError(w, errCheckpointCorrupt)
			return
		}
		total += len(data)
		files = append(files, runnerFile{Path: file.Path, Data: data, Checksum: file.Checksum})
	}
	if total > maxWorkspaceBytes {
		writeError(w, 400, "LIMIT_EXCEEDED", "Source exceeds workspace limit")
		return
	}
	// Hold project/session/membership locks until publication so revocation cannot
	// complete before a newly authorized working copy has been delivered.
	encoded, err := json.Marshal(map[string]any{"checkpoint_id": input.CheckpointID, "files": files})
	if err != nil {
		writeError(w, 503, "WORKSPACE_UNAVAILABLE", "Could not prepare source")
		return
	}
	response, err := a.workspaceRequest(r.Context(), "POST", "/projects/"+project+"/sync", bytes.NewReader(encoded))
	workspaceResponse(w, response, err)
}
func (a *App) workspaceTerminal(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		writeError(w, 403, "FORBIDDEN", "Origin is not allowed")
		return
	}
	session, project, ok := a.workspaceAccess(w, r, false, false)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	allowed := func() bool {
		var yes bool
		err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id JOIN sessions s ON s.user_id=m.user_id WHERE p.id=$1 AND m.user_id=$2 AND s.id=$3 AND p.lifecycle_state='active' AND m.role IN ('owner','editor') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())`, project, session.UserID, session.ID).Scan(&yes)
		return err == nil && yes
	}
	if !allowed() {
		writeError(w, 403, "FORBIDDEN", "Editor permission required")
		return
	}
	upstreamURL := "ws" + strings.TrimPrefix(a.cfg.WorkspaceOrigin, "http") + "/projects/" + project + "/terminal"
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+a.cfg.WorkspaceToken)
	upstream, reply, err := (&websocket.Dialer{HandshakeTimeout: 15 * time.Second}).DialContext(ctx, upstreamURL, headers)
	if err != nil {
		if reply != nil && reply.Body != nil {
			reply.Body.Close()
		}
		writeError(w, 409, "TERMINAL_UNAVAILABLE", "Start the workspace and wait for tasks before opening a terminal")
		return
	}
	defer upstream.Close()
	browser, err := browserUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer browser.Close()
	browser.SetReadLimit(8192)
	upstream.SetReadLimit(8192)
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if !allowed() {
					cancel()
					_ = browser.Close()
					_ = upstream.Close()
					return
				}
			}
		}
	}()
	go func() {
		defer cancel()
		defer upstream.Close()
		for {
			kind, data, err := browser.ReadMessage()
			if err != nil {
				return
			}
			_ = upstream.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if upstream.WriteMessage(kind, data) != nil {
				return
			}
		}
	}()
	for {
		kind, data, err := upstream.ReadMessage()
		if err != nil {
			return
		}
		_ = browser.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if browser.WriteMessage(kind, data) != nil {
			return
		}
	}
}
