package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/kartikeyajay2006/collaborative-code-editor/services/api/protocol"
)

type documentAccess struct {
	ProjectID  string
	FileID     string
	Generation string
	Role       string
}

func (a *App) accessDocument(ctx context.Context, session Session, documentID string) (documentAccess, error) {
	var d documentAccess
	err := a.db.QueryRow(ctx, `SELECT f.project_id::text,f.id::text,f.generation::text,m.role
		FROM documents doc JOIN files f ON f.id=doc.file_id
		JOIN projects p ON p.id=f.project_id AND p.lifecycle_state='active'
		JOIN project_members m ON m.project_id=p.id AND m.user_id=$2
		JOIN sessions s ON s.id=$3 AND s.user_id=m.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
		WHERE doc.id=$1 AND f.current_document_id=doc.id AND f.tombstoned_at IS NULL AND f.kind='file' AND doc.generation=f.generation`,
		documentID, session.UserID, session.ID).Scan(&d.ProjectID, &d.FileID, &d.Generation, &d.Role)
	return d, err
}

func (a *App) socketAssertion(session Session, d documentAccess, documentID string) (string, error) {
	jti, err := randomToken()
	if err != nil {
		return "", err
	}
	claims := map[string]any{"iss": "cce-api", "aud": "cce-collab", "sub": session.UserID, "sid": session.ID,
		"project_id": d.ProjectID, "file_id": d.FileID, "document_id": documentID, "generation": d.Generation,
		"role": d.Role, "connection_id": jti, "exp": time.Now().Add(30 * time.Second).Unix(), "iat": time.Now().Unix()}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := header + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(a.cfg.CollabToken))
	mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func socketFrame(typ byte, body []byte) []byte {
	frame := make([]byte, 6+len(body))
	frame[0] = 1
	frame[1] = typ
	binary.BigEndian.PutUint32(frame[2:6], uint32(len(body)))
	copy(frame[6:], body)
	return frame
}

func socketError(code, message string) []byte {
	body, _ := json.Marshal(map[string]any{"code": code, "retryable": false, "message": message})
	return socketFrame(8, body)
}

var browserUpgrader = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(*http.Request) bool { return true }}

func (a *App) documentSocket(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		writeError(w, 403, "FORBIDDEN", "Origin is not allowed")
		return
	}
	documentID := r.PathValue("document_id")
	if !validUUID(documentID) {
		writeError(w, 400, "FRAME_INVALID", "Invalid document ID")
		return
	}
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	d, err := a.accessDocument(r.Context(), session, documentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "FORBIDDEN", "Document unavailable")
		} else {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Cannot check document")
		}
		return
	}
	release := reserveSocket(session.UserID)
	if release == nil {
		writeError(w, 429, "LIMIT_EXCEEDED", "Too many active workspace connections")
		return
	}
	defer release()
	assertion, err := a.socketAssertion(session, d, documentID)
	if err != nil {
		writeError(w, 500, "STORAGE_UNAVAILABLE", "Cannot open document")
		return
	}
	workerURL, err := url.Parse(a.cfg.CollabOrigin)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Collaboration unavailable")
		return
	}
	workerURL.Scheme = "ws"
	workerURL.Path = "/internal/ws/documents/" + documentID
	headers := http.Header{"Authorization": []string{"Bearer " + assertion}}
	injectTrace(r.Context(), headers)
	worker, resp, err := websocket.DefaultDialer.DialContext(r.Context(), workerURL.String(), headers)
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Collaboration unavailable")
		return
	}
	defer worker.Close()
	browser, err := browserUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer browser.Close()
	browser.SetReadLimit(6 + 524288 + 64)
	worker.SetReadLimit(6 + 2097152 + 65536 + 16)
	var once sync.Once
	closed := make(chan struct{})
	var browserWrite sync.Mutex
	writeBrowser := func(data []byte) error {
		browserWrite.Lock()
		defer browserWrite.Unlock()
		browser.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return browser.WriteMessage(websocket.BinaryMessage, data)
	}
	stop := func() { once.Do(func() { close(closed); browser.Close(); worker.Close() }) }
	done := make(chan struct{}, 3)
	go func() {
		defer func() { stop(); done <- struct{}{} }()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-closed:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				fresh, err := a.accessDocument(ctx, session, documentID)
				cancel()
				if err != nil || fresh.ProjectID != d.ProjectID || fresh.Generation != d.Generation || fresh.Role != d.Role {
					_ = writeBrowser(socketError("FORBIDDEN", "Document access changed"))
					return
				}
			}
		}
	}()
	go func() {
		defer func() { stop(); done <- struct{}{} }()
		for {
			kind, data, e := worker.ReadMessage()
			if e != nil {
				return
			}
			if kind != websocket.BinaryMessage {
				return
			}
			if _, e = protocol.Decode(data, protocol.Server); e != nil {
				return
			}
			if e = writeBrowser(data); e != nil {
				return
			}
		}
	}()
	go func() {
		defer func() { stop(); done <- struct{}{} }()
		messageTokens := 50.0
		byteTokens := float64(4 << 20)
		lastRefill := time.Now()
		for {
			kind, data, e := browser.ReadMessage()
			if e != nil {
				return
			}
			if kind != websocket.BinaryMessage {
				writeBrowser(socketError("FRAME_INVALID", "Binary frame required"))
				return
			}
			frame, e := protocol.Decode(data, protocol.Client)
			if e != nil {
				writeBrowser(socketError("FRAME_INVALID", "Invalid frame"))
				return
			}
			elapsed := time.Since(lastRefill).Seconds()
			lastRefill = time.Now()
			messageTokens = min(50, messageTokens+elapsed*25)
			byteTokens = min(float64(4<<20), byteTokens+elapsed*float64(2<<20))
			messageTokens--
			byteTokens -= float64(len(data))
			if messageTokens < 0 || byteTokens < 0 {
				writeBrowser(socketError("RATE_LIMITED", "Send rate exceeded"))
				return
			}
			if frame.Type == 4 {
				fresh, e := a.accessDocument(context.Background(), session, documentID)
				if e != nil || fresh.Role == "viewer" || fresh.ProjectID != d.ProjectID || fresh.Generation != d.Generation {
					writeBrowser(socketError("FORBIDDEN", "Editing access changed"))
					return
				}
			}
			worker.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if e = worker.WriteMessage(websocket.BinaryMessage, data); e != nil {
				return
			}
		}
	}()
	<-done
}
