package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type Project struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	TreeVersion   string `json:"tree_version"`
	EventSequence string `json:"event_sequence"`
}

type Member struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
}

var errProjectMissing = errors.New("project missing")
var errNotOwner = errors.New("owner required")
var errSessionEnded = errors.New("session ended")

func canRead(role string) bool   { return role == "owner" || role == "editor" || role == "viewer" }
func canEdit(role string) bool   { return role == "owner" || role == "editor" }
func canManage(role string) bool { return role == "owner" }

func projectID(r *http.Request) (string, bool) {
	id := r.PathValue("project_id")
	return id, validUUID(id)
}

func validName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 120 {
		return "", false
	}
	for _, character := range name {
		if character < 32 || character == 127 {
			return "", false
		}
	}
	return name, true
}

func (a *App) listProjects(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT p.id::text,p.name,m.role,p.tree_version,p.event_sequence
		FROM projects p JOIN project_members m ON m.project_id=p.id
		WHERE m.user_id=$1 AND p.lifecycle_state='active' ORDER BY p.created_at DESC,p.id`, session.UserID)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load projects")
		return
	}
	defer rows.Close()
	projects := make([]Project, 0)
	for rows.Next() {
		var project Project
		var tree, event int64
		if err := rows.Scan(&project.ID, &project.Name, &project.Role, &tree, &event); err != nil {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load projects")
			return
		}
		project.TreeVersion = strconv.FormatInt(tree, 10)
		project.EventSequence = strconv.FormatInt(event, 10)
		projects = append(projects, project)
	}
	if rows.Err() != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load projects")
		return
	}
	writeJSON(w, 200, projects)
}

func (a *App) createProject(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &input); err != nil {
		writeError(w, 400, "INVALID_INPUT", "Invalid project request")
		return
	}
	name, ok := validName(input.Name)
	if !ok {
		writeError(w, 400, "INVALID_INPUT", "Project name must be 1–120 characters")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not create project")
		return
	}
	defer tx.Rollback(r.Context())
	if err := lockActiveSession(r.Context(), tx, session.ID); err != nil {
		writeError(w, 401, "AUTH_REQUIRED", "Session ended")
		return
	}
	var id string
	err = tx.QueryRow(r.Context(), `INSERT INTO projects(owner_id,name) VALUES($1,$2) RETURNING id::text`, session.UserID, name).Scan(&id)
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')`, id, session.UserID)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not create project")
		return
	}
	writeJSON(w, 201, Project{ID: id, Name: name, Role: "owner", TreeVersion: "0", EventSequence: "0"})
}

func (a *App) membership(ctx context.Context, projectID, userID string) (string, error) {
	var role string
	err := a.db.QueryRow(ctx, `SELECT m.role FROM project_members m JOIN projects p ON p.id=m.project_id
		WHERE m.project_id=$1 AND m.user_id=$2 AND p.lifecycle_state='active'`, projectID, userID).Scan(&role)
	return role, err
}

func (a *App) getProject(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	var project Project
	var tree, event int64
	err := a.db.QueryRow(r.Context(), `SELECT p.id::text,p.name,m.role,p.tree_version,p.event_sequence
		FROM projects p JOIN project_members m ON m.project_id=p.id
		WHERE p.id=$1 AND m.user_id=$2 AND p.lifecycle_state='active'`, id, session.UserID).
		Scan(&project.ID, &project.Name, &project.Role, &tree, &event)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "NOT_FOUND", "Project not found")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load project")
		return
	}
	project.TreeVersion = strconv.FormatInt(tree, 10)
	project.EventSequence = strconv.FormatInt(event, 10)
	writeJSON(w, 200, project)
}

func lockActiveSession(ctx context.Context, tx pgx.Tx, sessionID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, sessionID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errSessionEnded
	}
	return err
}

func (a *App) beginOwnerTx(ctx context.Context, projectID string, session Session) (pgx.Tx, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	var ownerID, state string
	err = tx.QueryRow(ctx, `SELECT owner_id::text,lifecycle_state FROM projects WHERE id=$1 FOR UPDATE`, projectID).Scan(&ownerID, &state)
	if err == nil && state != "active" {
		err = errProjectMissing
	}
	if err == nil {
		err = lockActiveSession(ctx, tx, session.ID)
	}
	if err == nil {
		var role string
		err = tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE`, projectID, session.UserID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) || !canManage(role) || ownerID != session.UserID {
			err = errNotOwner
		}
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errProjectMissing
		}
		return nil, err
	}
	return tx, nil
}

func ownerTxError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errProjectMissing):
		writeError(w, 404, "NOT_FOUND", "Project not found")
	case errors.Is(err, errSessionEnded):
		writeError(w, 401, "AUTH_REQUIRED", "Session ended")
	case errors.Is(err, errNotOwner):
		writeError(w, 403, "FORBIDDEN", "Owner permission required")
	default:
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Project operation failed")
	}
}

func addProjectEvent(ctx context.Context, tx pgx.Tx, projectID, eventType string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var sequence int64
	err = tx.QueryRow(ctx, `UPDATE projects SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence`, projectID).Scan(&sequence)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO project_events(project_id,sequence,event_type,payload) VALUES($1,$2,$3,$4::jsonb)`, projectID, sequence, eventType, string(encoded))
	return err
}

func (a *App) deleteProject(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	tx, err := a.beginOwnerTx(r.Context(), id, session)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `UPDATE projects SET lifecycle_state='deleted' WHERE id=$1`, id)
	if err == nil {
		err = addProjectEvent(r.Context(), tx, id, "project_deleted", map[string]string{"project_id": id})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not delete project")
		return
	}
	w.WriteHeader(204)
}

func (a *App) listMembers(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT m.user_id::text,u.display_name,m.role FROM project_members m
		JOIN users u ON u.id=m.user_id
		WHERE m.project_id=$1 AND EXISTS (
		  SELECT 1 FROM project_members viewer JOIN projects p ON p.id=viewer.project_id
		  WHERE viewer.project_id=$1 AND viewer.user_id=$2 AND p.lifecycle_state='active'
		) ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,u.display_name`, id, session.UserID)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load members")
		return
	}
	defer rows.Close()
	members := make([]Member, 0)
	for rows.Next() {
		var member Member
		if err := rows.Scan(&member.UserID, &member.DisplayName, &member.Role); err != nil {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load members")
			return
		}
		members = append(members, member)
	}
	if rows.Err() != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not load members")
		return
	}
	if len(members) == 0 {
		writeError(w, 404, "NOT_FOUND", "Project not found")
		return
	}
	writeJSON(w, 200, members)
}

func memberTarget(r *http.Request) (string, bool) {
	id := r.PathValue("user_id")
	return id, validUUID(id)
}

func (a *App) changeMemberRole(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	target, valid := memberTarget(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid user ID")
		return
	}
	var input struct {
		Role string `json:"role"`
	}
	if readJSON(r, &input) != nil || (input.Role != "editor" && input.Role != "viewer") {
		writeError(w, 400, "INVALID_INPUT", "Role must be editor or viewer")
		return
	}
	tx, err := a.beginOwnerTx(r.Context(), id, session)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var prior string
	err = tx.QueryRow(r.Context(), `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, id, target).Scan(&prior)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "NOT_FOUND", "Member not found")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not change role")
		return
	}
	if prior == "owner" {
		writeError(w, 403, "FORBIDDEN", "Owner role cannot be changed")
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2`, id, target, input.Role)
	if err == nil {
		err = addProjectEvent(r.Context(), tx, id, "member_role_changed", map[string]string{"user_id": target, "role": input.Role})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not change role")
		return
	}
	writeJSON(w, 200, map[string]string{"user_id": target, "role": input.Role})
}

func (a *App) revokeMember(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	target, valid := memberTarget(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid user ID")
		return
	}
	tx, err := a.beginOwnerTx(r.Context(), id, session)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var role string
	err = tx.QueryRow(r.Context(), `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, id, target).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "NOT_FOUND", "Member not found")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not revoke member")
		return
	}
	if role == "owner" {
		writeError(w, 403, "FORBIDDEN", "Owner membership cannot be revoked")
		return
	}
	_, err = tx.Exec(r.Context(), `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, id, target)
	if err == nil {
		err = addProjectEvent(r.Context(), tx, id, "member_revoked", map[string]string{"user_id": target})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not revoke member")
		return
	}
	w.WriteHeader(204)
}

func (a *App) createInvite(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	var input struct {
		Role      string `json:"role"`
		ExpiresAt string `json:"expires_at"`
		MaxUses   int    `json:"max_uses"`
	}
	if readJSON(r, &input) != nil || (input.Role != "editor" && input.Role != "viewer") || input.MaxUses < 1 || input.MaxUses > 100 {
		writeError(w, 400, "INVALID_INPUT", "Invalid invitation")
		return
	}
	expires, err := time.Parse(time.RFC3339, input.ExpiresAt)
	if err != nil || expires.Before(time.Now().Add(time.Minute)) || expires.After(time.Now().Add(30*24*time.Hour)) {
		writeError(w, 400, "INVALID_INPUT", "Invitation expiry must be within 1 minute and 30 days")
		return
	}
	token, err := randomToken()
	if err != nil {
		writeError(w, 500, "INTERNAL", "Could not create invitation")
		return
	}
	tx, err := a.beginOwnerTx(r.Context(), id, session)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var inviteID string
	err = tx.QueryRow(r.Context(), `INSERT INTO project_invites(project_id,token_hash,role,expires_at,max_uses)
		VALUES($1,$2,$3,$4,$5) RETURNING id::text`, id, digest(token), input.Role, expires, input.MaxUses).Scan(&inviteID)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not create invitation")
		return
	}
	writeJSON(w, 201, map[string]any{"id": inviteID, "token": token, "role": input.Role, "expires_at": expires.Format(time.RFC3339), "max_uses": input.MaxUses})
}

func (a *App) revokeInvite(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	inviteID := r.PathValue("invite_id")
	if !validUUID(inviteID) {
		writeError(w, 400, "INVALID_INPUT", "Invalid invitation ID")
		return
	}
	tx, err := a.beginOwnerTx(r.Context(), id, session)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM project_invites WHERE id=$1 AND project_id=$2`, inviteID, id)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not revoke invitation")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 404, "NOT_FOUND", "Invitation not found")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not revoke invitation")
		return
	}
	w.WriteHeader(204)
}

func (a *App) acceptInvite(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	token := r.PathValue("token")
	if len(token) != 43 {
		writeError(w, 400, "INVALID_INPUT", "Invalid invitation token")
		return
	}
	var projectID string
	err := a.db.QueryRow(r.Context(), `SELECT project_id::text FROM project_invites WHERE token_hash=$1`, digest(token)).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "NOT_FOUND", "Invitation not found")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not accept invitation")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not accept invitation")
		return
	}
	defer tx.Rollback(r.Context())
	var state string
	err = tx.QueryRow(r.Context(), `SELECT lifecycle_state FROM projects WHERE id=$1 FOR UPDATE`, projectID).Scan(&state)
	if err != nil || state != "active" {
		writeError(w, 409, "INVITE_UNAVAILABLE", "Invitation is unavailable")
		return
	}
	if err = lockActiveSession(r.Context(), tx, session.ID); err != nil {
		writeError(w, 401, "AUTH_REQUIRED", "Session ended")
		return
	}
	var inviteID, role string
	err = tx.QueryRow(r.Context(), `SELECT id::text,role FROM project_invites
		WHERE project_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() AND used_count<max_uses FOR UPDATE`, projectID, digest(token)).Scan(&inviteID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 409, "INVITE_UNAVAILABLE", "Invitation expired or exhausted")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not accept invitation")
		return
	}
	var acceptedRole string
	err = tx.QueryRow(r.Context(), `INSERT INTO project_members(project_id,user_id,role)
		VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO NOTHING RETURNING role`, projectID, session.UserID, role).Scan(&acceptedRole)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 409, "ALREADY_MEMBER", "Already a project member")
		return
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not accept invitation")
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE project_invites SET used_count=used_count+1 WHERE id=$1`, inviteID)
	if err == nil {
		err = addProjectEvent(r.Context(), tx, projectID, "member_added", map[string]string{"user_id": session.UserID, "role": role})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not accept invitation")
		return
	}
	writeJSON(w, 200, map[string]string{"project_id": projectID, "role": role})
}
