package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
)

const sessionCookieName = "cce_session"
const oauthCookieName = "cce_oauth_flow"
const githubOAuthIssuer = "https://github.com/login/oauth"

// GitHub can include RFC 9207's issuer identifier in its authorization response.
// Validate it against the fixed provider, never use it to choose an endpoint.
func validOAuthCallback(query url.Values) bool {
	for key := range query {
		if key != "state" && key != "code" && key != "iss" {
			return false
		}
	}
	if len(query["state"]) != 1 || len(query["code"]) != 1 || len(query.Get("state")) != 43 || len(query.Get("code")) < 1 || len(query.Get("code")) > 1024 {
		return false
	}
	if issuer, present := query["iss"]; present {
		return len(issuer) == 1 && issuer[0] == githubOAuthIssuer
	}
	return true // Retain compatibility with responses without the optional issuer.
}

type Session struct {
	ID          string
	UserID      string
	DisplayName string
	CSRFHash    []byte
	CSRFToken   string
}

func (a *App) oauthStart(w http.ResponseWriter, r *http.Request) {
	if a.cfg.ClientID == "" {
		writeError(w, 503, "AUTH_UNAVAILABLE", "GitHub login is not configured")
		return
	}
	state, err := randomToken()
	if err != nil {
		writeError(w, 500, "INTERNAL", "Could not begin login")
		return
	}
	binding, err := randomToken()
	if err != nil {
		writeError(w, 500, "INTERNAL", "Could not begin login")
		return
	}
	verifier := oauth2.GenerateVerifier()
	_, err = a.db.Exec(r.Context(), `INSERT INTO oauth_flows(state_hash,binding_hash,code_verifier,expires_at)
		VALUES($1,$2,$3,now()+interval '10 minutes')`, digest(state), digest(binding), verifier)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not begin login")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oauthCookieName, Value: binding, Path: "/api/v1/auth/github/callback", MaxAge: 600, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Cache-Control", "no-store")
	provider := a.oauthConfig()
	http.Redirect(w, r, provider.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

func (a *App) oauthCallback(w http.ResponseWriter, r *http.Request) {
	query, parseError := url.ParseQuery(r.URL.RawQuery)
	if parseError != nil || !validOAuthCallback(query) {
		writeError(w, 400, "OAUTH_INVALID", "Invalid login callback")
		return
	}
	binding, err := r.Cookie(oauthCookieName)
	if err != nil || len(binding.Value) != 43 {
		writeError(w, 400, "OAUTH_INVALID", "Invalid login callback")
		return
	}
	clearOAuthCookie(w, a.cfg.SecureCookies)
	var verifier string
	err = a.db.QueryRow(r.Context(), `DELETE FROM oauth_flows
		WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now()
		RETURNING code_verifier`, digest(query.Get("state")), digest(binding.Value)).Scan(&verifier)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 400, "OAUTH_INVALID", "Login expired or already used")
		} else {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not complete login")
		}
		return
	}
	token, err := a.exchangeCode(r.Context(), query.Get("code"), verifier)
	if err != nil {
		writeError(w, 502, "OAUTH_PROVIDER", "GitHub login failed")
		return
	}
	subject, displayName, err := a.fetchGitHubUser(r.Context(), token)
	if err != nil {
		writeError(w, 502, "OAUTH_PROVIDER", "Could not read GitHub identity")
		return
	}
	appToken, err := randomToken()
	if err != nil {
		writeError(w, 500, "INTERNAL", "Could not create session")
		return
	}
	csrfToken := csrfFor(appToken)
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not create session")
		return
	}
	defer tx.Rollback(r.Context())
	var userID string
	err = tx.QueryRow(r.Context(), `INSERT INTO users(provider,provider_subject,display_name)
		VALUES('github',$1,$2)
		ON CONFLICT(provider,provider_subject) DO UPDATE SET display_name=excluded.display_name
		RETURNING id::text`, subject, displayName).Scan(&userID)
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)
			VALUES($1,$2,$3,now()+interval '7 days')`, userID, digest(appToken), digest(csrfToken))
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not create session")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: appToken, Path: "/", MaxAge: 7 * 24 * 60 * 60, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/", http.StatusFound)
}

func clearOAuthCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: oauthCookieName, Value: "", Path: "/api/v1/auth/github/callback", MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func csrfFor(sessionToken string) string {
	return base64.RawURLEncoding.EncodeToString(digest("cce-csrf-v1:" + sessionToken))
}

func (a *App) oauthConfig() oauth2.Config {
	return oauth2.Config{
		ClientID: a.cfg.ClientID, ClientSecret: a.cfg.ClientSecret, RedirectURL: a.cfg.CallbackURL,
		Endpoint: oauth2.Endpoint{AuthURL: a.cfg.GitHubAuthURL, TokenURL: a.cfg.GitHubTokenURL, AuthStyle: oauth2.AuthStyleInParams},
	}
}

func (a *App) exchangeCode(ctx context.Context, code, verifier string) (string, error) {
	requestContext := context.WithValue(ctx, oauth2.HTTPClient, a.client)
	provider := a.oauthConfig()
	token, err := provider.Exchange(requestContext, code, oauth2.VerifierOption(verifier))
	if err != nil || token == nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") {
		return "", errors.New("invalid token response")
	}
	return token.AccessToken, nil
}

func (a *App) fetchGitHubUser(ctx context.Context, token string) (string, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.GitHubUserURL, nil)
	if err != nil {
		return "", "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "collaborative-code-editor")
	response, err := a.client.Do(request)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", "", errors.New("user response failed")
	}
	var user struct {
		ID    json.Number `json:"id"`
		Login string      `json:"login"`
		Name  string      `json:"name"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8192))
	decoder.UseNumber()
	if err := decoder.Decode(&user); err != nil {
		return "", "", err
	}
	id, err := strconv.ParseInt(user.ID.String(), 10, 64)
	if err != nil || id <= 0 || user.Login == "" {
		return "", "", fmt.Errorf("invalid identity")
	}
	name := strings.TrimSpace(user.Name)
	if name == "" {
		name = user.Login
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return strconv.FormatInt(id, 10), name, nil
}

func (a *App) currentSession(r *http.Request) (Session, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || len(cookie.Value) != 43 {
		return Session{}, pgx.ErrNoRows
	}
	var session Session
	err = a.db.QueryRow(r.Context(), `SELECT s.id::text,s.user_id::text,u.display_name,s.csrf_hash
		FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL`, digest(cookie.Value)).Scan(&session.ID, &session.UserID, &session.DisplayName, &session.CSRFHash)
	if err != nil {
		return Session{}, err
	}
	session.CSRFToken = csrfFor(cookie.Value)
	return session, nil
}

func (a *App) requireSession(w http.ResponseWriter, r *http.Request) (Session, bool) {
	session, err := a.currentSession(r)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 401, "AUTH_REQUIRED", "Sign in to continue")
		} else {
			writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not check session")
		}
		return Session{}, false
	}
	return session, true
}

func (a *App) requireMutation(w http.ResponseWriter, r *http.Request) (Session, bool) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return Session{}, false
	}
	if !a.sameOrigin(r) {
		writeError(w, 403, "CSRF_INVALID", "Request origin is not allowed")
		return Session{}, false
	}
	provided := r.Header.Get("X-CSRF-Token")
	providedHash := sha256.Sum256([]byte(provided))
	if provided == "" || subtle.ConstantTimeCompare(providedHash[:], session.CSRFHash) != 1 {
		writeError(w, 403, "CSRF_INVALID", "Request verification failed")
		return Session{}, false
	}
	return session, true
}

func (a *App) getSession(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireSession(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, map[string]any{"user": map[string]string{"id": session.UserID, "display_name": session.DisplayName}, "csrf_token": session.CSRFToken})
}

func (a *App) deleteSession(w http.ResponseWriter, r *http.Request) {
	session, ok := a.requireMutation(w, r)
	if !ok {
		return
	}
	_, err := a.db.Exec(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, session.ID)
	if err != nil {
		writeError(w, 503, "STORAGE_UNAVAILABLE", "Could not sign out")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(204)
}
