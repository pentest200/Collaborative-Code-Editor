package main

import (
	"bytes"
	"crypto/sha256"
	"mime"
	"net/http"
	"strconv"
)

const maxAssetBytes = 25 << 20
const maxProjectAssetBytes = 100 << 20
const maxWorkspaceBytes = (100 + 10) << 20

func imageMediaType(media string) bool {
	return media == "image/png" || media == "image/jpeg" || media == "image/gif" || media == "image/webp"
}
func assetHeaders(w http.ResponseWriter, name, media string, data []byte, preview bool) {
	disposition := "attachment"
	if preview && imageMediaType(media) {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
}
func (a *App) downloadAsset(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	project, file := r.PathValue("project_id"), r.PathValue("file_id")
	if !validUUID(project) || !validUUID(file) {
		writeError(w, 404, "NOT_FOUND", "File not found")
		return
	}
	tx, _, err := a.checkpointTx(r.Context(), project, session, false, false)
	if err != nil {
		treeTxError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var name, media string
	var data, expected []byte
	err = tx.QueryRow(r.Context(), `SELECT f.name,a.media_type,a.data,a.checksum FROM files f JOIN file_assets a ON a.document_id=f.current_document_id WHERE f.id=$1 AND f.project_id=$2 AND f.tombstoned_at IS NULL`, file, project).Scan(&name, &media, &data, &expected)
	if err != nil {
		writeError(w, 404, "NOT_FOUND", "File not found")
		return
	}
	sum := sha256.Sum256(data)
	if !bytes.Equal(sum[:], expected) {
		writeError(w, 503, "FILE_UNAVAILABLE", "File checksum verification failed")
		return
	}
	assetHeaders(w, name, media, data, r.URL.Query().Get("preview") == "1")
	_, _ = w.Write(data)
}
