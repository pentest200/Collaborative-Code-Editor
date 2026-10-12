package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const maxTreeEntries = 200
const maxFolderDepth = 16
const maxPathBytes = 1024

type TreeEntry struct {
	StorageKind string  `json:"storage_kind,omitempty"`
	ByteSize    int     `json:"byte_size,omitempty"`
	MediaType   string  `json:"media_type,omitempty"`
	ID          string  `json:"id"`
	ParentID    *string `json:"parent_id"`
	Name        string  `json:"name"`
	Kind        string  `json:"kind"`
	Language    *string `json:"language"`
	DocumentID  *string `json:"document_id"`
	Generation  string  `json:"generation"`
}

type TreeResponse struct {
	TreeVersion   string      `json:"tree_version"`
	EventSequence string      `json:"event_sequence"`
	Entries       []TreeEntry `json:"entries"`
}

func validFileName(name string) bool {
	if !utf8.ValidString(name) || len(name) < 1 || len(name) > 255 || name != strings.TrimSpace(name) || strings.HasSuffix(name, ".") || name == "." || name == ".." || strings.ContainsAny(name, `\/:*?"<>|`) {
		return false
	}
	for _, character := range name {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func languageForName(name string) string {
	index := strings.LastIndexByte(name, '.')
	if index < 0 {
		return "plaintext"
	}
	switch strings.ToLower(name[index:]) {
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "javascript"
	case ".py":
		return "python"
	case ".go":
		return "go"
	case ".java":
		return "java"
	case ".cpp", ".cc", ".cxx", ".hpp", ".h", ".c":
		return "cpp"
	case ".json":
		return "json"
	case ".css":
		return "css"
	case ".html", ".htm":
		return "html"
	case ".md":
		return "markdown"
	case ".sh":
		return "shell"
	default:
		return "plaintext"
	}
}

func parseTreeVersion(r *http.Request) (int64, bool) {
	raw := r.Header.Get("If-Match")
	value, err := strconv.ParseInt(raw, 10, 64)
	return value, err == nil && value >= 0 && strconv.FormatInt(value, 10) == raw
}

func treeConflict(w http.ResponseWriter, code, message string, version int64) {
	writeJSON(w, 409, map[string]string{"code": code, "message": message, "current_version": strconv.FormatInt(version, 10)})
}

func treeValidationError(w http.ResponseWriter, reason string, version int64) {
	if strings.Contains(reason, "already exists") {
		treeConflict(w, "NAME_CONFLICT", reason, version)
		return
	}
	writeError(w, 400, "INVALID_TREE", reason)
}

func treeDBError(w http.ResponseWriter, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			writeError(w, 409, "NAME_CONFLICT", "An entry with that name already exists")
			return
		case "23514", "P0001":
			writeError(w, 400, "INVALID_TREE", "The tree change violates a constraint")
			return
		}
	}
	writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not update the file tree")
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func loadEntries(ctx context.Context, tx pgx.Tx, projectID string) (map[string]TreeEntry, error) {
	rows, err := tx.Query(ctx, `SELECT f.id::text,f.parent_id::text,f.name,f.kind,f.language,f.current_document_id::text,f.generation,
    CASE WHEN a.document_id IS NULL THEN '' ELSE 'asset' END,coalesce(a.byte_size,0),coalesce(a.media_type,'')
		FROM files f LEFT JOIN file_assets a ON a.document_id=f.current_document_id WHERE f.project_id=$1 AND f.tombstoned_at IS NULL ORDER BY f.name,f.id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make(map[string]TreeEntry)
	for rows.Next() {
		var item TreeEntry
		var parent, language, document sql.NullString
		var generation int64
		if err := rows.Scan(&item.ID, &parent, &item.Name, &item.Kind, &language, &document, &generation, &item.StorageKind, &item.ByteSize, &item.MediaType); err != nil {
			return nil, err
		}
		item.ParentID = nullableString(parent)
		item.Language = nullableString(language)
		item.DocumentID = nullableString(document)
		item.Generation = strconv.FormatInt(generation, 10)
		entries[item.ID] = item
	}
	return entries, rows.Err()
}

func validateTree(entries map[string]TreeEntry) string {
	if len(entries) > maxTreeEntries {
		return "This project has reached its 200-entry limit"
	}
	for id, item := range entries {
		if !validFileName(item.Name) {
			return "Unsupported file or folder name"
		}
		seen := map[string]bool{}
		cursor := id
		pathBytes, folders := 0, 0
		for cursor != "" {
			if seen[cursor] {
				return "A folder cannot contain itself"
			}
			seen[cursor] = true
			part, ok := entries[cursor]
			if !ok {
				return "Parent folder does not exist in this project"
			}
			if cursor != id && part.Kind != "folder" {
				return "Parent must be a folder"
			}
			pathBytes += len(part.Name)
			if cursor != id {
				pathBytes++
			}
			if part.Kind == "folder" {
				folders++
			}
			if pathBytes > maxPathBytes || folders > maxFolderDepth {
				return "Folder depth or path length limit exceeded"
			}
			if part.ParentID == nil {
				cursor = ""
			} else {
				cursor = *part.ParentID
			}
		}
		for otherID, other := range entries {
			if otherID != id && other.Name == item.Name && sameParent(other.ParentID, item.ParentID) {
				return "An entry with that name already exists in this folder"
			}
		}
	}
	return ""
}

func sameParent(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func (a *App) getTree(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	id, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		treeDBError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var treeVersion, eventSequence int64
	err = tx.QueryRow(r.Context(), `SELECT p.tree_version,p.event_sequence FROM projects p
		JOIN project_members m ON m.project_id=p.id WHERE p.id=$1 AND m.user_id=$2 AND p.lifecycle_state='active'`, id, session.UserID).Scan(&treeVersion, &eventSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "NOT_FOUND", "Project not found")
		return
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	entries, err := loadEntries(r.Context(), tx, id)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		treeDBError(w, err)
		return
	}
	result := make([]TreeEntry, 0, len(entries))
	for _, item := range entries {
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].ParentID == nil && result[j].ParentID != nil {
			return true
		}
		if result[i].ParentID != nil && result[j].ParentID == nil {
			return false
		}
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	writeJSON(w, 200, TreeResponse{strconv.FormatInt(treeVersion, 10), strconv.FormatInt(eventSequence, 10), result})
}

func (a *App) beginTreeTx(ctx context.Context, projectID string, session Session) (pgx.Tx, int64, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	var version int64
	var state string
	err = tx.QueryRow(ctx, `SELECT tree_version,lifecycle_state FROM projects WHERE id=$1 FOR UPDATE`, projectID).Scan(&version, &state)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && state != "active") {
		err = errProjectMissing
	}
	if err == nil {
		err = lockActiveSession(ctx, tx, session.ID)
	}
	if err == nil {
		var role string
		err = tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE`, projectID, session.UserID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			err = errProjectMissing
		} else if err == nil && !canEdit(role) {
			err = errNotOwner
		}
	}
	if err != nil {
		_ = tx.Rollback(ctx)
	}
	return tx, version, err
}

func treeTxError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errProjectMissing):
		writeError(w, 404, "NOT_FOUND", "Project not found")
	case errors.Is(err, errSessionEnded):
		writeError(w, 401, "AUTH_REQUIRED", "Session ended")
	case errors.Is(err, errNotOwner):
		writeError(w, 403, "FORBIDDEN", "Editor permission required")
	default:
		treeDBError(w, err)
	}
}

func (a *App) emptyDocument(ctx context.Context) ([]byte, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.CollabOrigin+"/internal/documents/empty", nil)
	if err != nil {
		return nil, nil, err
	}
	injectTrace(ctx, request.Header)
	request.Header.Set("X-Internal-Token", a.cfg.CollabToken)
	response, err := a.client.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, nil, errors.New("collaboration service rejected initialization")
	}
	var body struct {
		EncodedState string `json:"encoded_state"`
		StateVector  string `json:"state_vector"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&body); err != nil {
		return nil, nil, err
	}
	state, stateErr := base64.StdEncoding.DecodeString(body.EncodedState)
	vector, vectorErr := base64.StdEncoding.DecodeString(body.StateVector)
	if stateErr != nil || vectorErr != nil || len(state) == 0 || len(state) > 64 || len(vector) == 0 || len(vector) > 64 {
		return nil, nil, errors.New("invalid initial Yjs state")
	}
	return state, vector, nil
}

func addTreeEvent(ctx context.Context, tx pgx.Tx, projectID, kind string, payload map[string]any) error {
	payload["project_id"] = projectID
	if err := addProjectEvent(ctx, tx, projectID, kind, payload); err != nil {
		return err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox_events(operation_id,topic,payload)
		VALUES(gen_random_uuid(),'project.tree',$1::jsonb)`, string(encoded))
	return err
}

func finishTreeChange(ctx context.Context, tx pgx.Tx, projectID, kind string, payload map[string]any) (int64, int64, error) {
	var version, sequence int64
	err := tx.QueryRow(ctx, `UPDATE projects SET tree_version=tree_version+1 WHERE id=$1 RETURNING tree_version`, projectID).Scan(&version)
	if err == nil {
		err = addTreeEvent(ctx, tx, projectID, kind, payload)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT event_sequence FROM projects WHERE id=$1`, projectID).Scan(&sequence)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return version, sequence, err
}

func writeTreeMutation(w http.ResponseWriter, status int, entry TreeEntry, version, sequence int64) {
	w.Header().Set("ETag", strconv.FormatInt(version, 10))
	writeJSON(w, status, map[string]any{"entry": entry, "tree_version": strconv.FormatInt(version, 10), "event_sequence": strconv.FormatInt(sequence, 10)})
}

func (a *App) createTreeEntry(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, valid := projectID(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	expected, valid := parseTreeVersion(r)
	if !valid {
		writeError(w, 428, "VERSION_REQUIRED", "A decimal If-Match tree version is required")
		return
	}
	var input struct {
		Kind     string  `json:"kind"`
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
		Language *string `json:"language"`
	}
	if readJSON(r, &input) != nil || (input.Kind != "file" && input.Kind != "folder") || !validFileName(input.Name) || (input.ParentID != nil && !validUUID(*input.ParentID)) {
		writeError(w, 400, "INVALID_INPUT", "Invalid file or folder")
		return
	}
	var language *string
	if input.Kind == "file" {
		inferred := languageForName(input.Name)
		if input.Language != nil && *input.Language != inferred {
			writeError(w, 400, "INVALID_INPUT", "Language must match the file extension")
			return
		}
		language = &inferred
	} else if input.Language != nil {
		writeError(w, 400, "INVALID_INPUT", "Folders cannot have a language")
		return
	}
	tx, version, err := a.beginTreeTx(r.Context(), project, session)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if expected != version {
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed; refresh and retry", version)
		return
	}
	entries, err := loadEntries(r.Context(), tx, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	item := TreeEntry{ParentID: input.ParentID, Name: input.Name, Kind: input.Kind, Language: language, Generation: "1"}
	// A temporary local key is enough for validation; PostgreSQL creates the stable UUID.
	entries["new"] = item
	if reason := validateTree(entries); reason != "" {
		treeValidationError(w, reason, version)
		return
	}
	var state, vector []byte
	if input.Kind == "file" {
		state, vector, err = a.emptyDocument(r.Context())
		if err != nil {
			writeError(w, 503, "COLLAB_UNAVAILABLE", "Could not initialize the file document")
			return
		}
	}
	err = tx.QueryRow(r.Context(), `INSERT INTO files(project_id,parent_id,name,kind,language)
		VALUES($1,$2,$3,$4,$5) RETURNING id::text`, project, input.ParentID, input.Name, input.Kind, language).Scan(&item.ID)
	if err == nil && input.Kind == "file" {
		var documentID string
		err = tx.QueryRow(r.Context(), `INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text`, item.ID).Scan(&documentID)
		if err == nil {
			checksum := sha256.Sum256(state)
			_, err = tx.Exec(r.Context(), `WITH snapshot AS (
				INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum)
				VALUES($1,0,$2,$3,$4) RETURNING id
			) UPDATE documents SET snapshot_id=(SELECT id FROM snapshot) WHERE id=$1`, documentID, state, vector, checksum[:])
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `UPDATE files SET current_document_id=$2 WHERE id=$1`, item.ID, documentID)
		}
		item.DocumentID = &documentID
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	version, sequence, err := finishTreeChange(r.Context(), tx, project, "tree_entry_created", map[string]any{"file_id": item.ID, "parent_id": item.ParentID, "kind": item.Kind, "name": item.Name})
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeTreeMutation(w, 201, item, version, sequence)
}

func (a *App) updateTreeEntry(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, valid := projectID(r)
	fileID := r.PathValue("file_id")
	if !valid || !validUUID(fileID) {
		writeError(w, 400, "INVALID_INPUT", "Invalid project or file ID")
		return
	}
	expected, valid := parseTreeVersion(r)
	if !valid {
		writeError(w, 428, "VERSION_REQUIRED", "A decimal If-Match tree version is required")
		return
	}
	var input struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	// A raw map distinguishes omitted parent_id from an explicit null move to root.
	var raw map[string]json.RawMessage
	if readJSON(r, &raw) != nil || len(raw) == 0 || len(raw) > 2 {
		writeError(w, 400, "INVALID_INPUT", "Invalid tree change")
		return
	}
	for key := range raw {
		if key != "name" && key != "parent_id" {
			writeError(w, 400, "INVALID_INPUT", "Invalid tree change")
			return
		}
	}
	encoded, _ := json.Marshal(raw)
	if json.Unmarshal(encoded, &input) != nil || (input.Name != nil && !validFileName(*input.Name)) || (input.ParentID != nil && !validUUID(*input.ParentID)) || (raw["name"] != nil && input.Name == nil) {
		writeError(w, 400, "INVALID_INPUT", "Invalid tree change")
		return
	}
	tx, version, err := a.beginTreeTx(r.Context(), project, session)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if expected != version {
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed; refresh and retry", version)
		return
	}
	entries, err := loadEntries(r.Context(), tx, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	item, found := entries[fileID]
	if !found {
		writeError(w, 404, "NOT_FOUND", "File or folder not found")
		return
	}
	if input.Name != nil {
		item.Name = *input.Name
	}
	if _, present := raw["parent_id"]; present {
		item.ParentID = input.ParentID
	}
	if item.Kind == "file" {
		language := languageForName(item.Name)
		item.Language = &language
	}
	entries[fileID] = item
	if reason := validateTree(entries); reason != "" {
		treeValidationError(w, reason, version)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE files SET name=$3,parent_id=$4,language=$5 WHERE id=$1 AND project_id=$2`, fileID, project, item.Name, item.ParentID, item.Language)
	if err != nil {
		treeDBError(w, err)
		return
	}
	version, sequence, err := finishTreeChange(r.Context(), tx, project, "tree_entry_updated", map[string]any{"file_id": fileID, "parent_id": item.ParentID, "name": item.Name})
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeTreeMutation(w, 200, item, version, sequence)
}

func (a *App) deleteTreeEntry(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, valid := projectID(r)
	fileID := r.PathValue("file_id")
	if !valid || !validUUID(fileID) {
		writeError(w, 400, "INVALID_INPUT", "Invalid project or file ID")
		return
	}
	expected, valid := parseTreeVersion(r)
	if !valid {
		writeError(w, 428, "VERSION_REQUIRED", "A decimal If-Match tree version is required")
		return
	}
	tx, version, err := a.beginTreeTx(r.Context(), project, session)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if expected != version {
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed; refresh and retry", version)
		return
	}
	entries, err := loadEntries(r.Context(), tx, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if _, found := entries[fileID]; !found {
		writeError(w, 404, "NOT_FOUND", "File or folder not found")
		return
	}
	deleted := []string{fileID}
	for index := 0; index < len(deleted); index++ {
		for _, item := range entries {
			if item.ParentID != nil && *item.ParentID == deleted[index] {
				deleted = append(deleted, item.ID)
			}
		}
	}
	_, err = tx.Exec(r.Context(), `UPDATE files SET tombstoned_at=now() WHERE project_id=$1 AND id=ANY($2::uuid[])`, project, deleted)
	if err != nil {
		treeDBError(w, err)
		return
	}
	version, _, err = finishTreeChange(r.Context(), tx, project, "tree_subtree_deleted", map[string]any{"file_id": fileID, "deleted_ids": deleted})
	if err != nil {
		treeDBError(w, err)
		return
	}
	w.Header().Set("ETag", strconv.FormatInt(version, 10))
	w.WriteHeader(204)
}
