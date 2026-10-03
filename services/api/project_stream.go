package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *App) projectStreamHead(ctx context.Context, session Session, projectID string) (int64, int64, error) {
	var tree, head int64
	err := a.db.QueryRow(ctx, `SELECT p.tree_version,p.event_sequence FROM projects p
		JOIN project_members m ON m.project_id=p.id AND m.user_id=$2
		JOIN sessions s ON s.id=$3 AND s.user_id=m.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
		WHERE p.id=$1 AND p.lifecycle_state='active'`, projectID, session.UserID, session.ID).Scan(&tree, &head)
	return tree, head, err
}

func (a *App) projectSocket(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		writeError(w, 403, "FORBIDDEN", "Origin is not allowed")
		return
	}
	projectID := r.PathValue("project_id")
	if !validUUID(projectID) {
		writeError(w, 400, "INVALID_INPUT", "Invalid project ID")
		return
	}
	query := r.URL.Query()
	if len(query) > 1 || len(query["after"]) != 1 {
		writeError(w, 400, "INVALID_INPUT", "One after sequence is required")
		return
	}
	afterText := query.Get("after")
	after, err := strconv.ParseInt(afterText, 10, 64)
	if err != nil || after < 0 || strconv.FormatInt(after, 10) != afterText {
		writeError(w, 400, "INVALID_INPUT", "Invalid event sequence")
		return
	}
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	treeVersion, head, err := a.projectStreamHead(r.Context(), session, projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "FORBIDDEN", "Project unavailable")
		} else {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Project unavailable")
		}
		return
	}
	conn, err := browserUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(1)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			if _, _, e := conn.ReadMessage(); e != nil {
				return
			}
			return
		}
	}()
	send := func(value any) bool {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(value) == nil
	}
	if after > head {
		send(map[string]string{"type": "RESYNC_REQUIRED", "tree_version": strconv.FormatInt(treeVersion, 10), "event_sequence": strconv.FormatInt(head, 10)})
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		tree, current, checkErr := a.projectStreamHead(ctx, session, projectID)
		if checkErr != nil {
			cancel()
			send(map[string]string{"type": "ACCESS_CHANGED"})
			return
		}
		if current-after > 1000 || after > current {
			cancel()
			send(map[string]string{"type": "RESYNC_REQUIRED", "tree_version": strconv.FormatInt(tree, 10), "event_sequence": strconv.FormatInt(current, 10)})
			return
		}
		rows, queryErr := a.db.Query(ctx, `SELECT sequence,event_type,payload FROM project_events WHERE project_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 101`, projectID, after)
		if queryErr != nil {
			cancel()
			return
		}
		type event struct {
			sequence int64
			kind     string
			payload  []byte
		}
		batch := make([]event, 0, 101)
		for rows.Next() {
			var item event
			if rows.Scan(&item.sequence, &item.kind, &item.payload) != nil {
				rows.Close()
				cancel()
				return
			}
			batch = append(batch, item)
		}
		readErr := rows.Err()
		rows.Close()
		cancel()
		if readErr != nil {
			return
		}
		for _, item := range batch {
			if item.sequence != after+1 {
				send(map[string]string{"type": "RESYNC_REQUIRED", "tree_version": strconv.FormatInt(tree, 10), "event_sequence": strconv.FormatInt(current, 10)})
				return
			}
			if !json.Valid(item.payload) || len(item.payload) > 65536 {
				return
			}
			if !send(map[string]any{"type": "EVENT", "sequence": strconv.FormatInt(item.sequence, 10), "event_type": item.kind, "payload": json.RawMessage(item.payload)}) {
				return
			}
			after = item.sequence
		}
		select {
		case <-closed:
			return
		case <-ticker.C:
		}
	}
}
