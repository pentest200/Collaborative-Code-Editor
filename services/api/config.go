package main

import (
	"errors"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	Environment    string
	ListenAddr     string
	DatabaseURL    string
	PublicOrigin   string
	CallbackURL    string
	ClientID       string
	ClientSecret   string
	GitHubAuthURL  string
	GitHubTokenURL string
	GitHubUserURL  string
	SecureCookies  bool
}

func loadConfig() (Config, error) {
	c := Config{
		Environment:    os.Getenv("APP_ENV"),
		ListenAddr:     envOr("API_LISTEN_ADDR", "127.0.0.1:8080"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		PublicOrigin:   envOr("PUBLIC_ORIGIN", "http://localhost:3000"),
		ClientID:       os.Getenv("GITHUB_CLIENT_ID"),
		ClientSecret:   os.Getenv("GITHUB_CLIENT_SECRET"),
		GitHubAuthURL:  "https://github.com/login/oauth/authorize",
		GitHubTokenURL: "https://github.com/login/oauth/access_token",
		GitHubUserURL:  "https://api.github.com/user",
	}
	if c.Environment != "development" && c.Environment != "production" {
		return c, errors.New("APP_ENV must be development or production")
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	u, err := url.Parse(c.PublicOrigin)
	if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || strings.HasSuffix(c.PublicOrigin, "/") {
		return c, errors.New("PUBLIC_ORIGIN must be an exact scheme and host without a path")
	}
	c.SecureCookies = c.Environment == "production"
	if c.SecureCookies && u.Scheme != "https" {
		return c, errors.New("production requires HTTPS PUBLIC_ORIGIN")
	}
	if c.SecureCookies && os.Getenv("PUBLIC_ORIGIN") == "" {
		return c, errors.New("production requires explicit PUBLIC_ORIGIN")
	}
	if !c.SecureCookies && u.Scheme != "http" && u.Scheme != "https" {
		return c, errors.New("invalid PUBLIC_ORIGIN scheme")
	}
	if !c.SecureCookies && u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return c, errors.New("development HTTP requires localhost origin")
	}
	c.CallbackURL = c.PublicOrigin + "/api/v1/auth/github/callback"
	if explicit := os.Getenv("GITHUB_CALLBACK_URL"); explicit != "" && explicit != c.CallbackURL {
		return c, errors.New("GITHUB_CALLBACK_URL must exactly match the public callback")
	}
	if (c.ClientID == "") != (c.ClientSecret == "") {
		return c, errors.New("GitHub client ID and secret must be configured together")
	}
	if c.SecureCookies && c.ClientID == "" {
		return c, errors.New("production requires GitHub OAuth credentials")
	}
	if os.Getenv("ENABLE_DEV_AUTH") != "" {
		return c, errors.New("development identity bypass is unsupported")
	}
	if os.Getenv("ENABLE_TEST_OAUTH_PROVIDER") == "true" {
		if c.Environment != "development" {
			return c, errors.New("test OAuth provider is forbidden in production")
		}
		c.GitHubAuthURL = os.Getenv("TEST_GITHUB_AUTH_URL")
		c.GitHubTokenURL = os.Getenv("TEST_GITHUB_TOKEN_URL")
		c.GitHubUserURL = os.Getenv("TEST_GITHUB_USER_URL")
		if c.GitHubAuthURL == "" || c.GitHubTokenURL == "" || c.GitHubUserURL == "" {
			return c, errors.New("test OAuth provider URLs are required")
		}
	} else if os.Getenv("TEST_GITHUB_AUTH_URL") != "" || os.Getenv("TEST_GITHUB_TOKEN_URL") != "" || os.Getenv("TEST_GITHUB_USER_URL") != "" {
		return c, errors.New("test OAuth provider URLs require explicit development enablement")
	}
	return c, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
