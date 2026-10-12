package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var testIdentityCounter atomic.Int64
var testIdentityBase = time.Now().UnixNano()

type testBrowser struct {
	client     *http.Client
	api        string
	csrf       string
	userID     string
	providerID int64
}

func newBrowser(api string) *testBrowser {
	jar, _ := cookiejar.New(nil)
	return &testBrowser{client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, api: api, providerID: testIdentityBase + testIdentityCounter.Add(1)}
}

func (b *testBrowser) request(t *testing.T, method, path string, body any, csrf, origin string) *http.Response {
	t.Helper()
	var input io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, b.api+path, input)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	response, err := b.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func responseJSON(t *testing.T, response *http.Response, want int, target any) {
	t.Helper()
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != want {
		t.Fatalf("wanted %d, got %d: %s", want, response.StatusCode, data)
	}
	if target != nil && len(data) > 0 {
		if err := json.Unmarshal(data, target); err != nil {
			t.Fatal(err)
		}
	}
}

func (b *testBrowser) login(t *testing.T, provider *fakeProvider, origin string) {
	t.Helper()
	start := b.request(t, "GET", "/api/v1/auth/github/start", nil, "", "")
	if start.StatusCode != 302 {
		responseJSON(t, start, 302, nil)
	}
	location := start.Header.Get("Location")
	if cookie := start.Header.Get("Set-Cookie"); !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "SameSite=Lax") {
		t.Fatalf("insecure OAuth flow cookie: %s", cookie)
	}
	start.Body.Close()
	u, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if u.Query().Get("scope") != "" || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("redirect_uri") != origin+"/api/v1/auth/github/callback" {
		t.Fatalf("invalid OAuth authorization URL: %s", location)
	}
	code := strconv.FormatInt(b.providerID, 10)
	provider.expect(code, u.Query().Get("code_challenge"))
	callback := "/api/v1/auth/github/callback?state=" + url.QueryEscape(u.Query().Get("state")) + "&code=" + code + "&iss=" + url.QueryEscape(githubOAuthIssuer)
	callbackResponse := b.request(t, "GET", callback, nil, "", "")
	foundSessionCookie := false
	for _, cookie := range callbackResponse.Cookies() {
		if cookie.Name == sessionCookieName {
			foundSessionCookie = true
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("insecure session cookie")
			}
		}
	}
	if !foundSessionCookie {
		t.Fatal("session cookie missing")
	}
	responseJSON(t, callbackResponse, 302, nil)
	var session struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		CSRF string `json:"csrf_token"`
	}
	responseJSON(t, b.request(t, "GET", "/api/v1/session", nil, "", ""), 200, &session)
	b.userID = session.User.ID
	b.csrf = session.CSRF
	if b.userID == "" || b.csrf == "" {
		t.Fatal("missing session identity or CSRF token")
	}
}

type fakeProvider struct {
	server     *httptest.Server
	mu         sync.Mutex
	challenges map[string]string
	callback   string
}

func newFakeProvider(t *testing.T, callback string) *fakeProvider {
	t.Helper()
	f := &fakeProvider{challenges: make(map[string]string), callback: callback}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/authorize":
			w.WriteHeader(200)
		case "/token":
			if r.Method != "POST" || r.ParseForm() != nil || r.Form.Get("client_id") != "fixture-id" || r.Form.Get("client_secret") != "fixture-secret" || r.Form.Get("redirect_uri") != callback {
				http.Error(w, "invalid exchange", 400)
				return
			}
			code := r.Form.Get("code")
			f.mu.Lock()
			challenge, ok := f.challenges[code]
			if ok {
				delete(f.challenges, code)
			}
			f.mu.Unlock()
			actual := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if !ok || challenge != base64.RawURLEncoding.EncodeToString(actual[:]) {
				http.Error(w, "bad verifier", 400)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"access_token":"fixture-%s","token_type":"bearer"}`, code)
		case "/user":
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer fixture-")
			id, err := strconv.ParseInt(token, 10, 64)
			if err != nil || id <= 0 {
				http.Error(w, "bad token", 401)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"id":%d,"login":"fixture-%d","name":"User %d"}`, id, id, id)
		default:
			http.NotFound(w, r)
		}
	}))
	return f
}

func (f *fakeProvider) expect(code, challenge string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.challenges[code] = challenge
}

func TestPhase01Integration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for real PostgreSQL integration checks")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	var migrationCount int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version IN ('0001_foundation','0002_identity_projects')`).Scan(&migrationCount); err != nil || migrationCount != 2 {
		t.Fatalf("migrations missing: count=%d error=%v", migrationCount, err)
	}
	origin := "http://localhost:3000"
	provider := newFakeProvider(t, origin+"/api/v1/auth/github/callback")
	defer provider.server.Close()
	cfg := Config{Environment: "development", DatabaseURL: databaseURL, PublicOrigin: origin, CallbackURL: origin + "/api/v1/auth/github/callback", ClientID: "fixture-id", ClientSecret: "fixture-secret", GitHubAuthURL: provider.server.URL + "/authorize", GitHubTokenURL: provider.server.URL + "/token", GitHubUserURL: provider.server.URL + "/user"}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 5 * time.Second}}
	api := httptest.NewServer(app.routes())
	defer api.Close()
	owner := newBrowser(api.URL)
	responseJSON(t, owner.request(t, "GET", "/api/v1/projects", nil, "", ""), 401, nil)
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "denied"}, "", origin), 401, nil)
	owner.login(t, provider, origin)
	invalidOwnerTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var invalidProjectID string
	if err := invalidOwnerTx.QueryRow(ctx, `INSERT INTO projects(owner_id,name) VALUES($1,'invalid-owner-check') RETURNING id::text`, owner.userID).Scan(&invalidProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := invalidOwnerTx.Exec(ctx, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')`, invalidProjectID, owner.userID); err != nil {
		t.Fatal(err)
	}
	if err := invalidOwnerTx.Commit(ctx); err == nil {
		t.Fatal("database accepted a project owner without owner role")
	}
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "denied"}, "", origin), 403, nil)
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "denied"}, owner.csrf, "https://evil.example"), 403, nil)
	var project Project
	responseJSON(t, owner.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Team A"}, owner.csrf, origin), 201, &project)
	if project.Role != "owner" || project.TreeVersion != "0" {
		t.Fatalf("invalid project: %+v", project)
	}
	var listed []Project
	responseJSON(t, owner.request(t, "GET", "/api/v1/projects", nil, "", ""), 200, &listed)
	if len(listed) == 0 {
		t.Fatal("project not listed")
	}
	viewer := newBrowser(api.URL)
	viewer.login(t, provider, origin)
	projectPath := "/api/v1/projects/" + project.ID
	responseJSON(t, viewer.request(t, "GET", projectPath, nil, "", ""), 404, nil)
	responseJSON(t, viewer.request(t, "POST", projectPath+"/invites", map[string]any{"role": "viewer", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339), "max_uses": 1}, viewer.csrf, origin), 403, nil)
	invite := createTestInvite(t, owner, projectPath, origin, "viewer", 1)
	var accepted struct {
		Role string `json:"role"`
	}
	responseJSON(t, viewer.request(t, "POST", "/api/v1/invites/"+invite.Token+"/accept", nil, viewer.csrf, origin), 200, &accepted)
	if accepted.Role != "viewer" {
		t.Fatal("wrong invited role")
	}
	responseJSON(t, viewer.request(t, "GET", projectPath, nil, "", ""), 200, nil)
	responseJSON(t, viewer.request(t, "PATCH", projectPath+"/members/"+owner.userID, map[string]string{"role": "viewer"}, viewer.csrf, origin), 403, nil)
	responseJSON(t, owner.request(t, "PATCH", projectPath+"/members/"+owner.userID, map[string]string{"role": "viewer"}, owner.csrf, origin), 403, nil)
	responseJSON(t, owner.request(t, "PATCH", projectPath+"/members/"+viewer.userID, map[string]string{"role": "editor"}, owner.csrf, origin), 200, nil)
	var memberList []Member
	responseJSON(t, viewer.request(t, "GET", projectPath+"/members", nil, "", ""), 200, &memberList)
	if len(memberList) != 2 {
		t.Fatalf("expected two members: %+v", memberList)
	}
	responseJSON(t, owner.request(t, "DELETE", projectPath+"/members/"+viewer.userID, nil, owner.csrf, origin), 204, nil)
	var eventCount int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM project_events WHERE project_id=$1`, project.ID).Scan(&eventCount); err != nil || eventCount < 3 {
		t.Fatalf("missing durable membership events: count=%d err=%v", eventCount, err)
	}
	responseJSON(t, viewer.request(t, "GET", projectPath, nil, "", ""), 404, nil)
	other := newBrowser(api.URL)
	other.login(t, provider, origin)
	otherProject := Project{}
	responseJSON(t, other.request(t, "POST", "/api/v1/projects", map[string]string{"name": "Team B"}, other.csrf, origin), 201, &otherProject)
	responseJSON(t, owner.request(t, "GET", "/api/v1/projects/"+otherProject.ID, nil, "", ""), 404, nil)
	responseJSON(t, owner.request(t, "DELETE", "/api/v1/projects/"+otherProject.ID, nil, owner.csrf, origin), 403, nil)

	// One-use OAuth state is consumed before the token exchange.
	replay := newBrowser(api.URL)
	start := replay.request(t, "GET", "/api/v1/auth/github/start", nil, "", "")
	location, _ := url.Parse(start.Header.Get("Location"))
	start.Body.Close()
	state := location.Query().Get("state")
	responseJSON(t, replay.request(t, "GET", "/api/v1/auth/github/callback?state=wrong&code=1", nil, "", ""), 400, nil)
	code := strconv.FormatInt(replay.providerID, 10)
	provider.expect(code, location.Query().Get("code_challenge"))
	path := "/api/v1/auth/github/callback?state=" + state + "&code=" + code
	// Issuer/shape denials must not consume the bound state or call the provider.
	for _, suffix := range []string{
		"&iss=" + url.QueryEscape("https://attacker.example"),
		"&iss=" + url.QueryEscape(githubOAuthIssuer+"/"),
		"&iss=" + url.QueryEscape(githubOAuthIssuer) + "&iss=" + url.QueryEscape(githubOAuthIssuer),
		"&unexpected=value",
	} {
		responseJSON(t, replay.request(t, "GET", path+suffix, nil, "", ""), 400, nil)
	}
	responseJSON(t, replay.request(t, "GET", path, nil, "", ""), 302, nil)
	responseJSON(t, replay.request(t, "GET", path, nil, "", ""), 400, nil)
	staleFlow := newBrowser(api.URL)
	staleStart := staleFlow.request(t, "GET", "/api/v1/auth/github/start", nil, "", "")
	staleLocation, _ := url.Parse(staleStart.Header.Get("Location"))
	staleStart.Body.Close()
	staleState := staleLocation.Query().Get("state")
	if _, err := db.Exec(ctx, `UPDATE oauth_flows SET expires_at=now()-interval '1 second' WHERE state_hash=$1`, digest(staleState)); err != nil {
		t.Fatal(err)
	}
	responseJSON(t, staleFlow.request(t, "GET", "/api/v1/auth/github/callback?state="+staleState+"&code=unused", nil, "", ""), 400, nil)
	responseJSON(t, staleFlow.request(t, "GET", "/api/v1/auth/github/callback?state="+staleState+"&state=other&code=unused", nil, "", ""), 400, nil)

	// Expired sessions cannot be read, and logout revokes a live session.
	expired := newBrowser(api.URL)
	expired.login(t, provider, origin)
	cookieURL, _ := url.Parse(api.URL)
	var token string
	for _, cookie := range expired.client.Jar.Cookies(cookieURL) {
		if cookie.Name == sessionCookieName {
			token = cookie.Value
		}
	}
	if token == "" {
		t.Fatal("missing session cookie")
	}
	if _, err := db.Exec(ctx, `UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, digest(token)); err != nil {
		t.Fatal(err)
	}
	responseJSON(t, expired.request(t, "GET", "/api/v1/session", nil, "", ""), 401, nil)
	responseJSON(t, other.request(t, "DELETE", "/api/v1/session", nil, other.csrf, origin), 204, nil)
	responseJSON(t, other.request(t, "GET", "/api/v1/session", nil, "", ""), 401, nil)

	// Expiry and bounded-use races are enforced by the database transaction.
	expiring := createTestInvite(t, owner, projectPath, origin, "viewer", 1)
	if _, err := db.Exec(ctx, `UPDATE project_invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, digest(expiring.Token)); err != nil {
		t.Fatal(err)
	}
	candidate := newBrowser(api.URL)
	candidate.login(t, provider, origin)
	responseJSON(t, candidate.request(t, "POST", "/api/v1/invites/"+expiring.Token+"/accept", nil, candidate.csrf, origin), 409, nil)
	revoked := createTestInvite(t, owner, projectPath, origin, "viewer", 1)
	responseJSON(t, owner.request(t, "DELETE", projectPath+"/invites/"+revoked.ID, nil, owner.csrf, origin), 204, nil)
	responseJSON(t, candidate.request(t, "POST", "/api/v1/invites/"+revoked.Token+"/accept", nil, candidate.csrf, origin), 404, nil)
	racing := createTestInvite(t, owner, projectPath, origin, "viewer", 1)
	first := newBrowser(api.URL)
	first.login(t, provider, origin)
	second := newBrowser(api.URL)
	second.login(t, provider, origin)
	var waits sync.WaitGroup
	results := make(chan int, 2)
	for _, browser := range []*testBrowser{first, second} {
		waits.Add(1)
		go func(b *testBrowser) {
			defer waits.Done()
			request, err := http.NewRequest("POST", b.api+"/api/v1/invites/"+racing.Token+"/accept", nil)
			if err != nil {
				results <- 0
				return
			}
			request.Header.Set("Origin", origin)
			request.Header.Set("X-CSRF-Token", b.csrf)
			response, err := b.client.Do(request)
			if err != nil {
				results <- 0
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			results <- response.StatusCode
		}(browser)
	}
	waits.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("invite race results: %+v", counts)
	}
	var uses int
	if err := db.QueryRow(ctx, `SELECT used_count FROM project_invites WHERE token_hash=$1`, digest(racing.Token)).Scan(&uses); err != nil || uses != 1 {
		t.Fatalf("invite uses=%d err=%v", uses, err)
	}
	responseJSON(t, owner.request(t, "DELETE", projectPath, nil, owner.csrf, origin), 204, nil)
	responseJSON(t, owner.request(t, "GET", projectPath, nil, "", ""), 404, nil)
}

type testInvite struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

func createTestInvite(t *testing.T, owner *testBrowser, projectPath, origin, role string, uses int) testInvite {
	t.Helper()
	var invite testInvite
	responseJSON(t, owner.request(t, "POST", projectPath+"/invites", map[string]any{"role": role, "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339), "max_uses": uses}, owner.csrf, origin), 201, &invite)
	if invite.Token == "" {
		t.Fatal("missing invite token")
	}
	return invite
}
