package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type Checkpoint struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	CreatorID   string    `json:"creator_id"`
	Name        string    `json:"name"`
	State       string    `json:"state"`
	TreeVersion string    `json:"captured_tree_version"`
	CreatedAt   time.Time `json:"created_at"`
	Failure     *string   `json:"failure_code"`
}
type CheckpointFile struct {
	FileID           string  `json:"file_id"`
	Path             string  `json:"path"`
	Language         *string `json:"language"`
	DocumentID       string  `json:"document_id"`
	Sequence         string  `json:"through_sequence"`
	SnapshotID       string  `json:"snapshot_id"`
	SnapshotSequence string  `json:"snapshot_sequence"`
	SnapshotChecksum string  `json:"snapshot_checksum"`
	ArtifactKey      string  `json:"artifact_key"`
	Checksum         string  `json:"checksum"`
	TextBytes        int     `json:"text_bytes"`
}
type CheckpointManifest struct {
	Format       string           `json:"format"`
	ProjectID    string           `json:"project_id"`
	CheckpointID string           `json:"checkpoint_id"`
	TreeVersion  string           `json:"captured_tree_version"`
	Name         string           `json:"name"`
	CreatorID    string           `json:"creator_id"`
	CapturedAt   string           `json:"captured_at"`
	Tree         []TreeEntry      `json:"tree"`
	Files        []CheckpointFile `json:"files"`
}

var errCheckpointNotReady = errors.New("checkpoint not ready")
var errCheckpointCorrupt = errors.New("checkpoint artifact corrupt")

// Fits 200 entries and 1024-byte paths even with worst-case JSON escaping.
const maxCheckpointManifestBytes = 4 << 20

func checkpointKey(project, id, file string) string {
	return "projects/" + project + "/checkpoints/" + id + "/files/" + file
}
func manifestKey(project, id string) string {
	return "projects/" + project + "/checkpoints/" + id + "/manifest.json"
}
func checksum(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// Project lock is shared with append/metadata mutations. RR additionally pins
// every tree row, document head and input reference to this one committed cut.
func (a *App) checkpointTx(ctx context.Context, project string, session Session, mutation bool, owner bool) (pgx.Tx, int64, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, 0, err
	}
	lock := " FOR SHARE"
	if mutation {
		lock = " FOR UPDATE"
	}
	var version int64
	var state string
	err = tx.QueryRow(ctx, `SELECT tree_version,lifecycle_state FROM projects WHERE id=$1`+lock, project).Scan(&version, &state)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && state != "active") {
		err = errProjectMissing
	}
	if err == nil {
		err = lockActiveSession(ctx, tx, session.ID)
	}
	if err == nil {
		var role string
		err = tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE`, project, session.UserID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			err = errProjectMissing
		} else if err == nil && ((mutation && !canEdit(role)) || (owner && !canManage(role))) {
			err = errNotOwner
		}
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, 0, err
	}
	return tx, version, nil
}

func captureCheckpoint(ctx context.Context, tx pgx.Tx, project, creator, name string, version int64) (Checkpoint, error) {
	entries, err := loadEntries(ctx, tx, project)
	if err != nil {
		return Checkpoint{}, err
	}
	tree := make([]TreeEntry, 0, len(entries))
	for _, entry := range entries {
		tree = append(tree, entry)
	}
	sort.Slice(tree, func(i, j int) bool { return tree[i].ID < tree[j].ID })
	encoded, err := json.Marshal(tree)
	if err != nil {
		return Checkpoint{}, err
	}
	cp := Checkpoint{ProjectID: project, CreatorID: creator, Name: name, State: "captured", TreeVersion: strconv.FormatInt(version, 10)}
	err = tx.QueryRow(ctx, `INSERT INTO checkpoints(project_id,creator_id,name,state,captured_tree_version,captured_tree) VALUES($1,$2,$3,'captured',$4,$5) RETURNING id::text,created_at`, project, creator, name, version, encoded).Scan(&cp.ID, &cp.CreatedAt)
	if err != nil {
		return cp, err
	}
	for _, entry := range tree {
		if entry.Kind != "file" {
			continue
		}
		names := []string{entry.Name}
		parent := entry.ParentID
		for parent != nil {
			value, ok := entries[*parent]
			if !ok {
				return cp, errCheckpointCorrupt
			}
			names = append([]string{value.Name}, names...)
			parent = value.ParentID
		}
		tag, err := tx.Exec(ctx, `INSERT INTO checkpoint_files(checkpoint_id,file_id,path,language,document_id,through_sequence,snapshot_id,snapshot_sequence,snapshot_checksum)
   SELECT $1,$2,$3,$4,d.id,d.last_committed_sequence,s.id,s.through_sequence,s.checksum FROM documents d
   JOIN LATERAL (SELECT id,through_sequence,checksum FROM document_snapshots WHERE document_id=d.id AND through_sequence<=d.last_committed_sequence ORDER BY through_sequence DESC LIMIT 1) s ON true
   WHERE d.id=$5 AND d.file_id=$2 AND d.generation=$6`, cp.ID, entry.ID, strings.Join(names, "/"), entry.Language, entry.DocumentID, entry.Generation)
		if err != nil {
			return cp, err
		}
		if tag.RowsAffected() != 1 {
			return cp, errors.New("missing captured snapshot")
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox_events(operation_id,topic,payload) VALUES($1::uuid,'checkpoint.materialize',jsonb_build_object('checkpoint_id',($1::uuid)::text))`, cp.ID)
	return cp, err
}

func (a *App) createCheckpoint(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project := r.PathValue("project_id")
	var input struct {
		Name string `json:"name"`
	}
	if !validUUID(project) || readJSON(r, &input) != nil || strings.TrimSpace(input.Name) == "" || len([]rune(input.Name)) > 120 {
		writeError(w, 400, "INVALID_REQUEST", "A checkpoint name of 1–120 characters is required")
		return
	}
	tx, version, err := a.checkpointTx(r.Context(), project, session, true, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	cp, err := captureCheckpoint(r.Context(), tx, project, session.UserID, input.Name, version)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 202, cp)
}

func loadCheckpoint(ctx context.Context, tx pgx.Tx, project, id string) (Checkpoint, CheckpointManifest, []byte, error) {
	var cp Checkpoint
	var tree []byte
	var manifestChecksum []byte
	err := tx.QueryRow(ctx, `SELECT id::text,project_id::text,creator_id::text,name,state,captured_tree_version::text,created_at,failure_code,captured_tree,manifest_checksum FROM checkpoints WHERE id=$1 AND project_id=$2`, id, project).Scan(&cp.ID, &cp.ProjectID, &cp.CreatorID, &cp.Name, &cp.State, &cp.TreeVersion, &cp.CreatedAt, &cp.Failure, &tree, &manifestChecksum)
	manifest := CheckpointManifest{Format: "cce-checkpoint-v1", ProjectID: project, CheckpointID: id, TreeVersion: cp.TreeVersion, Name: cp.Name, CreatorID: cp.CreatorID, CapturedAt: cp.CreatedAt.UTC().Format(time.RFC3339Nano), Files: []CheckpointFile{}}
	if err != nil {
		return cp, manifest, nil, err
	}
	if err = json.Unmarshal(tree, &manifest.Tree); err != nil {
		return cp, manifest, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT file_id::text,path,language,document_id::text,through_sequence::text,snapshot_id::text,snapshot_sequence::text,encode(snapshot_checksum,'hex'),coalesce(artifact_key,''),coalesce(encode(checksum,'hex'),''),coalesce(text_bytes,0) FROM checkpoint_files WHERE checkpoint_id=$1 ORDER BY file_id`, id)
	if err != nil {
		return cp, manifest, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var file CheckpointFile
		err = rows.Scan(&file.FileID, &file.Path, &file.Language, &file.DocumentID, &file.Sequence, &file.SnapshotID, &file.SnapshotSequence, &file.SnapshotChecksum, &file.ArtifactKey, &file.Checksum, &file.TextBytes)
		if err != nil {
			return cp, manifest, nil, err
		}
		manifest.Files = append(manifest.Files, file)
	}
	return cp, manifest, manifestChecksum, rows.Err()
}

func (a *App) listCheckpoints(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	project := r.PathValue("project_id")
	if !validUUID(project) {
		writeError(w, 404, "NOT_FOUND", "Project not found")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, false, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := tx.Query(r.Context(), `SELECT id::text,project_id::text,creator_id::text,name,state,captured_tree_version::text,created_at,failure_code FROM checkpoints WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	list := []Checkpoint{}
	for rows.Next() {
		var cp Checkpoint
		err = rows.Scan(&cp.ID, &cp.ProjectID, &cp.CreatorID, &cp.Name, &cp.State, &cp.TreeVersion, &cp.CreatedAt, &cp.Failure)
		if err != nil {
			break
		}
		list = append(list, cp)
	}
	rows.Close()
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"checkpoints": list})
}

func checkpointError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, 404, "NOT_FOUND", "Checkpoint not found")
	case errors.Is(err, errCheckpointNotReady):
		writeError(w, 409, "CHECKPOINT_NOT_READY", "Only a ready checkpoint can be previewed or restored")
	default:
		writeError(w, 503, "ARTIFACT_UNAVAILABLE", "Checkpoint verification or storage failed")
	}
}

func (a *App) verifiedManifest(ctx context.Context, tx pgx.Tx, project, id string) (CheckpointManifest, error) {
	cp, manifest, hash, err := loadCheckpoint(ctx, tx, project, id)
	if err != nil {
		return manifest, err
	}
	if cp.State != "ready" {
		return manifest, errCheckpointNotReady
	}
	if a.artifacts == nil {
		return manifest, errors.New("artifact storage not configured")
	}
	expected, err := json.Marshal(manifest)
	if err != nil {
		return manifest, err
	}
	data, err := a.artifacts.Get(ctx, manifestKey(project, id), maxCheckpointManifestBytes)
	if err != nil {
		return manifest, err
	}
	sum := sha256.Sum256(data)
	if len(hash) != 32 || !bytes.Equal(hash, sum[:]) || !bytes.Equal(data, expected) {
		return manifest, errCheckpointCorrupt
	}
	for _, file := range manifest.Files {
		if file.ArtifactKey != checkpointKey(project, id, file.FileID) || len(file.Checksum) != 64 {
			return manifest, errCheckpointCorrupt
		}
	}
	return manifest, nil
}
func (a *App) verifiedFile(ctx context.Context, project, id string, file CheckpointFile) ([]byte, error) {
	if file.ArtifactKey != checkpointKey(project, id, file.FileID) {
		return nil, errCheckpointCorrupt
	}
	data, err := a.artifacts.Get(ctx, file.ArtifactKey, 262144)
	if err != nil {
		return nil, err
	}
	if checksum(data) != file.Checksum || len(data) != file.TextBytes || !utf8.Valid(data) {
		return nil, errCheckpointCorrupt
	}
	return data, nil
}

func (a *App) previewCheckpoint(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	project, id := r.PathValue("project_id"), r.PathValue("checkpoint_id")
	if !validUUID(project) || !validUUID(id) {
		writeError(w, 404, "NOT_FOUND", "Checkpoint not found")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, false, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	manifest, err := a.verifiedManifest(r.Context(), tx, project, id)
	if err != nil {
		checkpointError(w, err)
		return
	}
	writeJSON(w, 200, manifest)
}
func (a *App) downloadCheckpointFile(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	project, id, fileID := r.PathValue("project_id"), r.PathValue("checkpoint_id"), r.PathValue("file_id")
	if !validUUID(project) || !validUUID(id) || !validUUID(fileID) {
		writeError(w, 404, "NOT_FOUND", "Checkpoint file not found")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, false, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	manifest, err := a.verifiedManifest(r.Context(), tx, project, id)
	if err != nil {
		checkpointError(w, err)
		return
	}
	for _, file := range manifest.Files {
		if file.FileID == fileID {
			data, err := a.verifiedFile(r.Context(), project, id, file)
			if err != nil {
				checkpointError(w, err)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Disposition", `attachment; filename="`+fileID+`.txt"`)
			w.WriteHeader(200)
			_, _ = w.Write(data)
			return
		}
	}
	writeError(w, 404, "NOT_FOUND", "Checkpoint file not found")
}
func (a *App) retryCheckpoint(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, id := r.PathValue("project_id"), r.PathValue("checkpoint_id")
	if !validUUID(project) || !validUUID(id) {
		writeError(w, 404, "NOT_FOUND", "Checkpoint not found")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, true, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var state string
	err = tx.QueryRow(r.Context(), `SELECT state FROM checkpoints WHERE id=$1 AND project_id=$2 FOR UPDATE`, id, project).Scan(&state)
	if err != nil {
		checkpointError(w, err)
		return
	}
	if state != "failed" {
		writeError(w, 409, "CHECKPOINT_STATE", "Only failed checkpoints can be retried")
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE checkpoints SET state='captured',failure_code=NULL,lease_expires_at=NULL WHERE id=$1`, id)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE outbox_events SET state='pending' WHERE operation_id=$1 AND topic='checkpoint.materialize'`, id)
	}
	if err == nil {
		err = addCheckpointLifecycle(r.Context(), tx, project, id, "checkpoint.retry", 0)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 202, map[string]string{"id": id, "state": "captured"})
}

func addCheckpointLifecycle(ctx context.Context, tx pgx.Tx, project, id, topic string, attempt int64) error {
	payload, _ := json.Marshal(map[string]any{"project_id": project, "checkpoint_id": id, "attempt": attempt})
	_, err := tx.Exec(ctx, `INSERT INTO outbox_events(operation_id,topic,payload) VALUES(gen_random_uuid(),$1,$2)`, topic, payload)
	return err
}

func (a *App) internalCheckpoint(ctx context.Context, path string, input, output any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, "POST", a.cfg.CollabOrigin+"/internal/checkpoints/"+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("X-Internal-Token", a.cfg.CollabToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("checkpoint authority status %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}

type preparedDocument struct {
	state, vector []byte
	size          int
}

func (a *App) restoreCheckpoint(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, id := r.PathValue("project_id"), r.PathValue("checkpoint_id")
	if !validUUID(project) || !validUUID(id) {
		writeError(w, 404, "NOT_FOUND", "Checkpoint not found")
		return
	}
	expected, valid := parseTreeVersion(r)
	if !valid {
		writeError(w, 428, "PRECONDITION_REQUIRED", "Decimal If-Match tree version required")
		return
	}
	// Verify all private objects under current owner access. Preparation occurs
	// before the replacement transaction and never changes active pointers.
	tx, version, err := a.checkpointTx(r.Context(), project, session, false, true)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	if version != expected {
		_ = tx.Rollback(r.Context())
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed", version)
		return
	}
	manifest, err := a.verifiedManifest(r.Context(), tx, project, id)
	texts := map[string][]byte{}
	if err == nil {
		for _, file := range manifest.Files {
			texts[file.FileID], err = a.verifiedFile(r.Context(), project, id, file)
			if err != nil {
				break
			}
		}
	}
	_ = tx.Rollback(r.Context())
	if err != nil {
		checkpointError(w, err)
		return
	}
	entries := map[string]TreeEntry{}
	for _, entry := range manifest.Tree {
		entries[entry.ID] = entry
	}
	if len(entries) != len(manifest.Tree) || validateTree(entries) != "" {
		checkpointError(w, errCheckpointCorrupt)
		return
	}
	prepared := map[string]preparedDocument{}
	total := 0
	for _, entry := range manifest.Tree {
		if entry.Kind != "file" {
			continue
		}
		text, found := texts[entry.ID]
		if !found {
			checkpointError(w, errCheckpointCorrupt)
			return
		}
		var output struct {
			State  string `json:"encoded_state"`
			Vector string `json:"state_vector"`
		}
		err = a.internalCheckpoint(r.Context(), "prepare", map[string]string{"text": string(text)}, &output)
		state, e1 := base64.StdEncoding.DecodeString(output.State)
		vector, e2 := base64.StdEncoding.DecodeString(output.Vector)
		if err != nil || e1 != nil || e2 != nil || len(state) == 0 || len(state) > 2<<20 || len(vector) == 0 || len(vector) > 64<<10 {
			writeError(w, 503, "RESTORE_PREPARATION_FAILED", "Fresh document preparation failed; current project is unchanged")
			return
		}
		prepared[entry.ID] = preparedDocument{state, vector, len(text)}
		total += len(text)
	}
	tx, version, err = a.checkpointTx(r.Context(), project, session, true, true)
	if err != nil {
		ownerTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if version != expected {
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed", version)
		return
	}
	var sourceLimit int
	err = tx.QueryRow(r.Context(), `SELECT source_bytes_limit FROM projects WHERE id=$1`, project).Scan(&sourceLimit)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if total > sourceLimit {
		writeError(w, 409, "LIMIT_EXCEEDED", "Captured source exceeds current project limit")
		return
	}
	// Capture the actual latest heads inside the replacement transaction, after
	// acquiring the same project lock as append. Durable inputs remain retained.
	previousName := []rune("Before restore: " + manifest.Name)
	if len(previousName) > 120 {
		previousName = previousName[:120]
	}
	previous, err := captureCheckpoint(r.Context(), tx, project, session.UserID, string(previousName), version)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE files SET tombstoned_at=clock_timestamp() WHERE project_id=$1 AND tombstoned_at IS NULL`, project)
	}
	for _, entry := range manifest.Tree {
		if err != nil {
			break
		}
		var kind string
		var generation int64
		err = tx.QueryRow(r.Context(), `SELECT kind,generation FROM files WHERE id=$1 AND project_id=$2 FOR UPDATE`, entry.ID, project).Scan(&kind, &generation)
		if err != nil {
			break
		}
		if kind != entry.Kind {
			err = errCheckpointCorrupt
			break
		}
		var documentID *string
		if kind == "file" {
			value := prepared[entry.ID]
			var document string
			err = tx.QueryRow(r.Context(), `INSERT INTO documents(file_id,generation,committed_text_bytes) VALUES($1,$2,$3) RETURNING id::text`, entry.ID, generation+1, value.size).Scan(&document)
			if err != nil {
				break
			}
			sum := sha256.Sum256(value.state)
			_, err = tx.Exec(r.Context(), `WITH snapshot AS (INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id) UPDATE documents SET snapshot_id=(SELECT id FROM snapshot) WHERE id=$1`, document, value.state, value.vector, sum[:])
			documentID = &document
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `UPDATE files SET parent_id=$3,name=$4,language=$5,current_document_id=$6,generation=$7,tombstoned_at=NULL WHERE id=$1 AND project_id=$2`, entry.ID, project, entry.ParentID, entry.Name, entry.Language, documentID, generation+1)
		}
	}
	if err == nil {
		_, _, err = finishTreeChange(r.Context(), tx, project, "project_restored", map[string]any{"checkpoint_id": id, "previous_checkpoint_id": previous.ID})
	}
	if err != nil {
		writeError(w, 503, "RESTORE_FAILED", "Restore completion could not be confirmed; refresh the project before retrying")
		return
	}
	writeJSON(w, 200, map[string]string{"tree_version": strconv.FormatInt(version+1, 10), "previous_checkpoint_id": previous.ID, "previous_checkpoint_name": previous.Name, "checkpoint_id": id})
}
