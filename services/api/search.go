package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type SearchResult struct {
	ProjectID       string  `json:"project_id"`
	FileID          string  `json:"file_id"`
	DocumentID      string  `json:"document_id"`
	Generation      string  `json:"generation"`
	Path            string  `json:"path"`
	IndexedSequence *string `json:"indexed_sequence"`
	CurrentSequence string  `json:"current_sequence"`
	Stale           bool    `json:"stale"`
	FilenameMatch   bool    `json:"filename_match"`
	Snippet         *string `json:"snippet"`
}

func (a *App) searchProject(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	project, valid := projectID(r)
	values := r.URL.Query()
	query := strings.TrimSpace(values.Get("q"))
	if !valid || len(values) != 1 || len(values["q"]) != 1 || len(query) == 0 || len(query) > 128 || !utf8.ValidString(query) || strings.ContainsFunc(query, unicode.IsControl) {
		writeError(w, 400, "INVALID_INPUT", "Use a literal search query of 1–128 UTF-8 bytes")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	// READ COMMITTED sees revocations that committed while waiting for the lock.
	// Project -> session -> membership is the same order as metadata and append.
	tx, err := a.db.Begin(ctx)
	if err != nil {
		treeDBError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	var state string
	err = tx.QueryRow(ctx, `SELECT lifecycle_state FROM projects WHERE id=$1 FOR SHARE`, project).Scan(&state)
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
		}
	}
	if err != nil {
		treeTxError(w, err)
		return
	}
	entries, err := loadEntries(ctx, tx, project)
	if err != nil {
		treeDBError(w, err)
		return
	}
	// Parameterized literal substring matching: SQL/regex/HTML are never executed.
	// Ordinary snippets are bounded in SQL; exact-byte snippets are sliced below.
	// No whole source appears in the public response.
	rows, err := tx.Query(ctx, `SELECT f.id::text,d.id::text,f.generation::text,d.last_committed_sequence::text,
  s.through_sequence::text,coalesce(strpos(lower(f.name),lower($2))>0,false),
  CASE WHEN strpos(lower(s.content),lower($2))>0 THEN substring(s.content FROM greatest(1,strpos(lower(s.content),lower($2))-60) FOR 240) END,
  CASE WHEN strpos(lower(s.content),lower($2))>0 THEN s.raw_content END,
  greatest(1,coalesce(strpos(lower(s.content),lower($2)),1)-60)
  FROM files f JOIN documents d ON d.id=f.current_document_id AND d.file_id=f.id AND d.generation=f.generation
  LEFT JOIN search_documents s ON s.file_id=f.id AND s.project_id=f.project_id AND s.document_id=d.id AND s.through_sequence<=d.last_committed_sequence
  WHERE f.project_id=$1 AND f.kind='file' AND f.tombstoned_at IS NULL
  AND (strpos(lower(f.name),lower($2))>0 OR strpos(lower(s.content),lower($2))>0)
  ORDER BY f.name,f.id LIMIT 51`, project, query)
	if err != nil {
		treeDBError(w, err)
		return
	}
	results := []SearchResult{}
	for rows.Next() {
		item := SearchResult{ProjectID: project}
		var raw []byte
		var start int
		err = rows.Scan(&item.FileID, &item.DocumentID, &item.Generation, &item.CurrentSequence, &item.IndexedSequence, &item.FilenameMatch, &item.Snippet, &raw, &start)
		if err != nil {
			break
		}
		if raw != nil && item.Snippet != nil {
			runes := []rune(string(raw))
			offset := min(start-1, len(runes))
			snippet := string(runes[offset:min(offset+240, len(runes))])
			item.Snippet = &snippet
		}
		// Recheck current visible identity before exposing a snippet, under the project
		// lock that excludes delete, restore, rename and membership removal.
		entry, visible := entries[item.FileID]
		if !visible || entry.DocumentID == nil || *entry.DocumentID != item.DocumentID {
			continue
		}
		names := []string{entry.Name}
		parent := entry.ParentID
		for parent != nil {
			ancestor := entries[*parent]
			names = append([]string{ancestor.Name}, names...)
			parent = ancestor.ParentID
		}
		item.Path = strings.Join(names, "/")
		item.Stale = item.IndexedSequence == nil || *item.IndexedSequence != item.CurrentSequence
		results = append(results, item)
	}
	rows.Close()
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		treeDBError(w, err)
		return
	}
	// Keep visibility locks until response bytes have been handed to the writer.
	truncated := len(results) > 50
	if truncated {
		results = results[:50]
	}
	writeJSON(w, 200, map[string]any{"results": results, "truncated": truncated, "freshness": "Content search is eventually indexed from committed edits. Refresh to check newer results."})
}

type searchCut struct {
	FileID     string `json:"file_id"`
	ProjectID  string `json:"project_id"`
	DocumentID string `json:"document_id"`
	Sequence   string `json:"through_sequence"`
	SnapshotID string `json:"snapshot_id"`
	Claim      string `json:"-"`
	Revision   int64  `json:"-"`
}

func (a *App) claimSearch(ctx context.Context, file string) (searchCut, error) {
	var cut searchCut
	err := a.db.QueryRow(ctx, `WITH candidate AS (
 SELECT file_id FROM search_tasks WHERE revision>done_revision AND retry_at<=clock_timestamp() AND ($1::text='' OR file_id::text=$1)
 AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) ORDER BY retry_at,file_id FOR UPDATE SKIP LOCKED LIMIT 1),
 claimed AS (UPDATE search_tasks t SET claim_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '45 seconds'
 FROM candidate WHERE t.file_id=candidate.file_id RETURNING t.*)
 SELECT t.file_id::text,t.claim_id::text,t.revision,f.project_id::text,
 coalesce(f.current_document_id::text,''),coalesce(d.last_committed_sequence::text,'0'),coalesce(s.id::text,'')
 FROM claimed t JOIN files f ON f.id=t.file_id LEFT JOIN projects p ON p.id=f.project_id
 LEFT JOIN documents d ON d.id=f.current_document_id AND f.tombstoned_at IS NULL AND p.lifecycle_state='active'
 LEFT JOIN LATERAL (SELECT id FROM document_snapshots WHERE document_id=d.id AND through_sequence<=d.last_committed_sequence ORDER BY through_sequence DESC LIMIT 1) s ON true`, file).Scan(&cut.FileID, &cut.Claim, &cut.Revision, &cut.ProjectID, &cut.DocumentID, &cut.Sequence, &cut.SnapshotID)
	return cut, err
}

func (a *App) publishSearch(ctx context.Context, cut searchCut, text string) error {
	if !utf8.ValidString(text) || len(text) > 262144 {
		return errors.New("invalid projection")
	}
	sequence, err := strconv.ParseInt(cut.Sequence, 10, 64)
	if err != nil || sequence < 0 {
		return errors.New("invalid sequence")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var state string
	if err = tx.QueryRow(ctx, `SELECT lifecycle_state FROM projects WHERE id=$1 FOR SHARE`, cut.ProjectID).Scan(&state); err != nil {
		return err
	}
	var document *string
	var filename string
	if err = tx.QueryRow(ctx, `SELECT CASE WHEN tombstoned_at IS NULL THEN current_document_id::text END,name FROM files WHERE id=$1 AND project_id=$2 FOR SHARE`, cut.FileID, cut.ProjectID).Scan(&document, &filename); err != nil {
		return err
	}
	var claim *string
	var live bool
	err = tx.QueryRow(ctx, `SELECT claim_id::text,lease_expires_at>clock_timestamp() FROM search_tasks WHERE file_id=$1 FOR UPDATE`, cut.FileID).Scan(&claim, &live)
	if err != nil {
		return err
	}
	if claim == nil || *claim != cut.Claim || !live {
		return errors.New("search claim replaced")
	}
	if state == "active" && document != nil && *document == cut.DocumentID && cut.SnapshotID != "" {
		var raw []byte
		if strings.ContainsRune(text, 0) {
			raw = []byte(text)
			text = strings.ReplaceAll(text, "\x00", "\x01")
		}
		_, err = tx.Exec(ctx, `INSERT INTO search_documents(file_id,project_id,document_id,through_sequence,filename,content,raw_content) VALUES($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT(file_id) DO UPDATE SET project_id=EXCLUDED.project_id,document_id=EXCLUDED.document_id,through_sequence=EXCLUDED.through_sequence,filename=EXCLUDED.filename,content=EXCLUDED.content,raw_content=EXCLUDED.raw_content,indexed_at=clock_timestamp()
  WHERE search_documents.document_id<>EXCLUDED.document_id OR search_documents.through_sequence<=EXCLUDED.through_sequence`, cut.FileID, cut.ProjectID, cut.DocumentID, sequence, filename, text, raw)
	} else if state != "active" || document == nil {
		_, err = tx.Exec(ctx, `DELETE FROM search_documents WHERE file_id=$1`, cut.FileID)
	} else if document != nil && *document == cut.DocumentID {
		return errors.New("missing projection snapshot")
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE search_tasks SET done_revision=greatest(done_revision,$2),claim_id=NULL,lease_expires_at=NULL,failure_code=NULL WHERE file_id=$1`, cut.FileID, cut.Revision)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return err
}

func (a *App) indexNext(ctx context.Context) (bool, error) {
	cut, err := a.claimSearch(ctx, "")
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, a.indexSearchCut(ctx, cut)
}

func (a *App) indexSearchCut(ctx context.Context, cut searchCut) (resultErr error) {
	ctx, finish := operation(ctx, "search.materialize")
	defer func() { finish(resultErr) }()
	task, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	var err error
	var output struct {
		Text string `json:"text"`
	}
	if cut.SnapshotID != "" {
		err = a.internalJSON(task, "/internal/search/materialize", cut, &output)
	}
	if err == nil {
		err = a.publishSearch(task, cut, output.Text)
	}
	if err != nil {
		failure, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_, _ = a.db.Exec(failure, `UPDATE search_tasks SET lease_expires_at=NULL,claim_id=NULL,retry_at=clock_timestamp()+interval '5 seconds',failure_code='PROJECTION_FAILED' WHERE file_id=$1 AND claim_id=$2`, cut.FileID, cut.Claim)
	}
	return err
}

func (a *App) runSearchJobs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for n := 0; n < 200 && ctx.Err() == nil; n++ {
				worked, err := a.indexNext(ctx)
				if err != nil || !worked {
					break
				}
			}
		}
	}
}
