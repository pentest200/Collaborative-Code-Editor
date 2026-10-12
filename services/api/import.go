package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

type importFile struct {
	Path string  `json:"path"`
	Text *string `json:"text,omitempty"`
	Data *string `json:"data_base64,omitempty"`
}

// Import is one tree transaction: a conflict or failed initializer publishes nothing.
func (a *App) importFiles(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	project, valid := projectID(r)
	expected, matched := parseTreeVersion(r)
	if !valid {
		writeError(w, 400, "INVALID_INPUT", "Invalid project")
		return
	}
	if !matched {
		writeError(w, 428, "VERSION_REQUIRED", "A decimal If-Match tree version is required")
		return
	}
	var input struct {
		ParentID *string      `json:"parent_id"`
		Files    []importFile `json:"files"`
	}
	if readRunJSON(r, &input, 200<<20) != nil || len(input.Files) == 0 || len(input.Files) > 200 || (input.ParentID != nil && !validUUID(*input.ParentID)) {
		writeError(w, 400, "INVALID_IMPORT", "Select 1–200 files")
		return
	}
	total := 0
	textTotal, assetTotal := 0, 0
	decoded := map[string][]byte{}
	seen := map[string]bool{}
	for _, f := range input.Files {
		if !safeRunPath(f.Path) || seen[f.Path] || (f.Text == nil) == (f.Data == nil) {
			writeError(w, 400, "INVALID_IMPORT", "Each file needs a unique relative path and either text or original base64 bytes")
			return
		}
		if f.Text != nil {
			if !utf8.ValidString(*f.Text) || strings.ContainsRune(*f.Text, 0) || len(*f.Text) > 262144 {
				writeError(w, 400, "INVALID_IMPORT", "Collaborative text is limited to 256 KiB; import larger or non-UTF-8 files as original bytes")
				return
			}
			textTotal += len(*f.Text)
			total += len(*f.Text)
		} else {
			if base64.StdEncoding.DecodedLen(len(*f.Data)) > maxAssetBytes+2 {
				writeError(w, 400, "LIMIT_EXCEEDED", "A file exceeds 25 MiB")
				return
			}
			data, err := base64.StdEncoding.Strict().DecodeString(*f.Data)
			if err != nil {
				writeError(w, 400, "INVALID_IMPORT", "Invalid file bytes")
				return
			}
			if len(data) > maxAssetBytes {
				writeError(w, 400, "LIMIT_EXCEEDED", "A file exceeds 25 MiB")
				return
			}
			decoded[f.Path] = data
			assetTotal += len(data)
			total += len(data)
		}
		for _, part := range strings.Split(f.Path, "/") {
			if !validFileName(part) {
				writeError(w, 400, "INVALID_IMPORT", "Unsupported file or folder name")
				return
			}
		}
		seen[f.Path] = true
	}
	if total > maxProjectAssetBytes {
		writeError(w, 400, "LIMIT_EXCEEDED", "Import exceeds 100 MiB")
		return
	}
	tx, version, err := a.beginTreeTx(r.Context(), project, session)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if version != expected {
		treeConflict(w, "TREE_VERSION_CONFLICT", "The file tree changed; refresh and retry", version)
		return
	}
	entries, err := loadEntries(r.Context(), tx, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if input.ParentID != nil {
		parent, found := entries[*input.ParentID]
		if !found || parent.Kind != "folder" {
			writeError(w, 400, "INVALID_IMPORT", "Destination folder does not exist")
			return
		}
	}
	var used, limit, assetsUsed int
	err = tx.QueryRow(r.Context(), `SELECT p.source_bytes_limit,coalesce((SELECT sum(d.committed_text_bytes) FROM files f JOIN documents d ON d.id=f.current_document_id WHERE f.project_id=p.id AND f.tombstoned_at IS NULL),0) FROM projects p WHERE p.id=$1`, project).Scan(&limit, &used)
	if err != nil {
		treeDBError(w, err)
		return
	}
	if used+textTotal > limit {
		writeError(w, 409, "LIMIT_EXCEEDED", "Import exceeds the project's source storage limit")
		return
	}
	if err = tx.QueryRow(r.Context(), `SELECT coalesce(sum(a.byte_size),0) FROM files f JOIN file_assets a ON a.document_id=f.current_document_id WHERE f.project_id=$1 AND f.tombstoned_at IS NULL`, project).Scan(&assetsUsed); err != nil {
		treeDBError(w, err)
		return
	}
	if assetsUsed+assetTotal > maxProjectAssetBytes {
		writeError(w, 409, "LIMIT_EXCEEDED", "Project assets exceed 100 MiB")
		return
	}
	added := []TreeEntry{}
	texts := map[string]string{}
	assets := map[string][]byte{}
	sort.Slice(input.Files, func(i, j int) bool { return input.Files[i].Path < input.Files[j].Path })
	for _, f := range input.Files {
		parent := input.ParentID
		parts := strings.Split(f.Path, "/")
		for i, part := range parts {
			last := i == len(parts)-1
			var existing *TreeEntry
			for _, item := range entries {
				if item.Name == part && sameParent(item.ParentID, parent) {
					copy := item
					existing = &copy
					break
				}
			}
			if existing != nil {
				if last || existing.Kind != "folder" {
					treeConflict(w, "NAME_CONFLICT", "An entry already exists at "+f.Path, version)
					return
				}
				id := existing.ID
				parent = &id
				continue
			}
			item := TreeEntry{ID: uuid.NewString(), ParentID: parent, Name: part, Kind: "folder", Generation: "1"}
			if last {
				item.Kind = "file"
				language := languageForName(part)
				item.Language = &language
				if f.Data != nil {
					data := decoded[f.Path]
					assets[item.ID] = data
					item.StorageKind = "asset"
					item.ByteSize = len(data)
					item.MediaType = http.DetectContentType(data)
				} else {
					texts[item.ID] = *f.Text
				}
			}
			entries[item.ID] = item
			added = append(added, item)
			id := item.ID
			parent = &id
		}
	}
	if reason := validateTree(entries); reason != "" {
		treeValidationError(w, reason, version)
		return
	}
	for index, item := range added {
		var state, vector []byte
		if item.Kind == "file" {
			var output struct {
				State  string `json:"encoded_state"`
				Vector string `json:"state_vector"`
			}
			if a.internalCheckpoint(r.Context(), "prepare", map[string]string{"text": texts[item.ID]}, &output) != nil {
				writeError(w, 503, "COLLAB_UNAVAILABLE", "Document preparation failed; no files were imported")
				return
			}
			var e1, e2 error
			state, e1 = base64.StdEncoding.DecodeString(output.State)
			vector, e2 = base64.StdEncoding.DecodeString(output.Vector)
			if e1 != nil || e2 != nil || len(state) == 0 || len(state) > 2<<20 || len(vector) == 0 || len(vector) > 64<<10 {
				writeError(w, 503, "COLLAB_UNAVAILABLE", "Invalid prepared document; no files were imported")
				return
			}
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO files(id,project_id,parent_id,name,kind,language) VALUES($1,$2,$3,$4,$5,$6)`, item.ID, project, item.ParentID, item.Name, item.Kind, item.Language)
		if err == nil && item.Kind == "file" {
			document := uuid.NewString()
			item.DocumentID = &document
			_, err = tx.Exec(r.Context(), `INSERT INTO documents(id,file_id,generation,committed_text_bytes) VALUES($1,$2,1,$3)`, document, item.ID, len(texts[item.ID]))
			if err == nil {
				sum := sha256.Sum256(state)
				_, err = tx.Exec(r.Context(), `WITH s AS (INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id) UPDATE documents SET snapshot_id=(SELECT id FROM s) WHERE id=$1`, document, state, vector, sum[:])
			}
			if err == nil {
				_, err = tx.Exec(r.Context(), `UPDATE files SET current_document_id=$2 WHERE id=$1`, item.ID, document)
			}
			if err == nil && item.StorageKind == "asset" {
				data := assets[item.ID]
				sum := sha256.Sum256(data)
				_, err = tx.Exec(r.Context(), `INSERT INTO file_assets(document_id,data,media_type,checksum) VALUES($1,$2,$3,$4)`, document, data, item.MediaType, sum[:])
			}
		}
		if err != nil {
			treeDBError(w, err)
			return
		}
		added[index] = item
	}
	version, sequence, err := finishTreeChange(r.Context(), tx, project, "files_imported", map[string]any{"count": len(input.Files)})
	if err != nil {
		treeDBError(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"entries": added, "tree_version": strconv.FormatInt(version, 10), "event_sequence": strconv.FormatInt(sequence, 10)})
}
