package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicAuthConfiguration(t *testing.T) {
	for _, test := range []struct {
		name    string
		client  string
		enabled bool
	}{
		{name: "unconfigured", enabled: false},
		{name: "configured", client: "fixture-id", enabled: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := &App{cfg: Config{ClientID: test.client}}
			response := httptest.NewRecorder()
			app.routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/auth/config", nil))
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d", response.Code)
			}
			var body struct {
				Enabled bool `json:"github_enabled"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Enabled != test.enabled {
				t.Fatalf("auth config = %+v, error = %v", body, err)
			}
		})
	}
}

func TestUnsafeAuthConfigurationRejected(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DATABASE_URL", "postgres://localhost/cce")
	t.Setenv("PUBLIC_ORIGIN", "http://example.com")
	t.Setenv("GITHUB_CLIENT_ID", "id")
	t.Setenv("GITHUB_CLIENT_SECRET", "secret")
	if _, err := loadConfig(); err == nil {
		t.Fatal("production accepted HTTP origin")
	}
	t.Setenv("PUBLIC_ORIGIN", "https://example.com")
	t.Setenv("ENABLE_TEST_OAUTH_PROVIDER", "true")
	t.Setenv("TEST_GITHUB_AUTH_URL", "http://127.0.0.1/authorize")
	t.Setenv("TEST_GITHUB_TOKEN_URL", "http://127.0.0.1/token")
	t.Setenv("TEST_GITHUB_USER_URL", "http://127.0.0.1/user")
	if _, err := loadConfig(); err == nil {
		t.Fatal("production accepted test provider")
	}
	t.Setenv("ENABLE_TEST_OAUTH_PROVIDER", "")
	t.Setenv("TEST_GITHUB_AUTH_URL", "")
	t.Setenv("TEST_GITHUB_TOKEN_URL", "")
	t.Setenv("TEST_GITHUB_USER_URL", "")
	t.Setenv("ENABLE_DEV_AUTH", "true")
	if _, err := loadConfig(); err == nil {
		t.Fatal("production accepted identity bypass")
	}
	t.Setenv("ENABLE_DEV_AUTH", "")
	t.Setenv("GITHUB_CALLBACK_URL", "https://example.com/other")
	if _, err := loadConfig(); err == nil {
		t.Fatal("production accepted mismatched callback")
	}
	t.Setenv("GITHUB_CALLBACK_URL", "")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("safe production configuration rejected: %v", err)
	}
}

func TestDevelopmentTestProviderRequiresExplicitSwitch(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("DATABASE_URL", "postgres://localhost/cce")
	t.Setenv("PUBLIC_ORIGIN", "http://localhost:3000")
	t.Setenv("GITHUB_CLIENT_ID", "fixture-id")
	t.Setenv("GITHUB_CLIENT_SECRET", "fixture-secret")
	t.Setenv("TEST_GITHUB_AUTH_URL", "http://127.0.0.1/authorize")
	t.Setenv("TEST_GITHUB_TOKEN_URL", "http://127.0.0.1/token")
	t.Setenv("TEST_GITHUB_USER_URL", "http://127.0.0.1/user")
	if _, err := loadConfig(); err == nil {
		t.Fatal("test provider allowed without switch")
	}
	t.Setenv("ENABLE_TEST_OAUTH_PROVIDER", "true")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GitHubAuthURL != "http://127.0.0.1/authorize" {
		t.Fatal("test provider not configured")
	}
}
