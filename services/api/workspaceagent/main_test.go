package main

import (
	"strings"
	"testing"
)

func TestEntrypointsNeverBecomeShellCode(t *testing.T) {
	entry := "src/main';touch hacked.cpp"
	for _, language := range []string{"python", "node", "typescript", "cpp", "java", "go"} {
		args, err := taskCommand(language, "run", entry)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for i, arg := range args {
			if arg == entry {
				found = true
			}
			if i > 0 && args[i-1] == "-c" && strings.Contains(arg, entry) {
				t.Fatalf("%s interpolated an entrypoint into shell code", language)
			}
		}
		if !found {
			t.Fatalf("%s did not pass the entrypoint as a separate argument", language)
		}
	}
}
func TestWorkspacePathValidation(t *testing.T) {
	for _, s := range []string{"../escape", "a/../escape", "/etc/passwd", "a\\b", "a\x00b", ".", "a//b"} {
		if safePath(s) {
			t.Fatalf("accepted %q", s)
		}
	}
	for _, s := range []string{"src/Main.java", "com.example.Main", "requirements.txt"} {
		if !safePath(s) {
			t.Fatalf("rejected %q", s)
		}
	}
}
