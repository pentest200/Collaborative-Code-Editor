package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	db     *pgxpool.Pool
	cfg    Config
	client *http.Client
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/healthz", healthHandler)
	mux.HandleFunc("GET /api/v1/auth/config", a.authConfig)
	mux.HandleFunc("GET /api/v1/auth/github/start", a.oauthStart)
	mux.HandleFunc("GET /api/v1/auth/github/callback", a.oauthCallback)
	mux.HandleFunc("GET /api/v1/session", a.getSession)
	mux.HandleFunc("DELETE /api/v1/session", a.deleteSession)
	mux.HandleFunc("GET /api/v1/projects", a.listProjects)
	mux.HandleFunc("POST /api/v1/projects", a.createProject)
	mux.HandleFunc("GET /api/v1/projects/{project_id}", a.getProject)
	mux.HandleFunc("DELETE /api/v1/projects/{project_id}", a.deleteProject)
	mux.HandleFunc("GET /api/v1/projects/{project_id}/members", a.listMembers)
	mux.HandleFunc("PATCH /api/v1/projects/{project_id}/members/{user_id}", a.changeMemberRole)
	mux.HandleFunc("DELETE /api/v1/projects/{project_id}/members/{user_id}", a.revokeMember)
	mux.HandleFunc("POST /api/v1/projects/{project_id}/invites", a.createInvite)
	mux.HandleFunc("DELETE /api/v1/projects/{project_id}/invites/{invite_id}", a.revokeInvite)
	mux.HandleFunc("POST /api/v1/invites/{token}/accept", a.acceptInvite)
	mux.HandleFunc("GET /api/v1/projects/{project_id}/tree", a.getTree)
	mux.HandleFunc("POST /api/v1/projects/{project_id}/tree", a.createTreeEntry)
	mux.HandleFunc("PATCH /api/v1/projects/{project_id}/tree/{file_id}", a.updateTreeEntry)
	mux.HandleFunc("DELETE /api/v1/projects/{project_id}/tree/{file_id}", a.deleteTreeEntry)
	return mux
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]string{"status": "ok", "service": "api", "phase": "02"})
}

func (a *App) authConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]bool{"github_enabled": a.cfg.ClientID != ""})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

func readJSON(r *http.Request, value any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("application/json required")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil || len(data) > 8192 {
		return errors.New("body too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON or body too large")
	}
	return nil
}

func randomToken() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
}

func digest(value string) []byte {
	hash := sha256.Sum256([]byte(value))
	return hash[:]
}

func validUUID(value string) bool { return uuidPattern.MatchString(value) }

func (a *App) sameOrigin(r *http.Request) bool { return r.Header.Get("Origin") == a.cfg.PublicOrigin }
