package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestOAuthCallbackIssuerValidation(t *testing.T) {
	base := "state=" + strings.Repeat("a", 43) + "&code=fixture-code"
	for _, test := range []struct {
		name, query string
		valid       bool
	}{
		{"legacy response", base, true},
		{"GitHub issuer response", base + "&iss=" + url.QueryEscape(githubOAuthIssuer), true},
		{"wrong issuer origin", base + "&iss=" + url.QueryEscape("https://attacker.example/login/oauth"), false},
		{"wrong issuer path", base + "&iss=" + url.QueryEscape("https://github.com"), false},
		{"issuer suffix attack", base + "&iss=" + url.QueryEscape(githubOAuthIssuer+".attacker.example"), false},
		{"duplicate issuer", base + "&iss=" + url.QueryEscape(githubOAuthIssuer) + "&iss=" + url.QueryEscape(githubOAuthIssuer), false},
		{"empty issuer", base + "&iss=", false},
		{"unknown parameter", base + "&scope=user", false},
		{"duplicate state", base + "&state=other", false},
		{"duplicate code", base + "&code=other", false},
		{"missing state", "code=fixture&iss=" + url.QueryEscape(githubOAuthIssuer), false},
		{"malformed encoding", base + "&iss=%zz", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, err := url.ParseQuery(test.query)
			valid := err == nil && validOAuthCallback(query)
			if valid != test.valid {
				t.Fatalf("callback validation = %v, want %v", valid, test.valid)
			}
		})
	}
}
