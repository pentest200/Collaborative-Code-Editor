package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func validJob() job {
	data := []byte("print('ok')")
	manifest, _ := json.Marshal(map[string]any{"format": "cce-checkpoint-v1", "files": []map[string]any{{"path": "src/main.py", "checksum": hash(data), "text_bytes": len(data)}}})
	return job{ID: "00000000-0000-0000-0000-000000000001", Claim: "00000000-0000-0000-0000-000000000002", Attempt: 1, Runtime: "python", Entrypoint: "src/main.py", Manifest: manifest, ManifestHash: hash(manifest), Files: []inputFile{{"src/main.py", hash(data), data}}}
}
func TestVerifiedInputs(t *testing.T) {
	if err := validate(validJob()); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		mutate func(*job)
	}{
		{"traversal", func(j *job) { j.Files[0].Path = "../secret" }},
		{"backslash", func(j *job) { j.Entrypoint = "src\\main.py" }},
		{"foreign-entrypoint", func(j *job) { j.Entrypoint = "other.py" }},
		{"corrupt-source", func(j *job) { j.Files[0].Data = []byte("corrupt") }},
		{"corrupt-manifest", func(j *job) { j.Manifest = append(j.Manifest, ' ') }},
		{"duplicate-file", func(j *job) { j.Files = append(j.Files, j.Files[0]) }},
		{"oversized-stdin", func(j *job) { j.Stdin = []byte(strings.Repeat("s", 16385)) }},
		{"user-runtime", func(j *job) { j.Runtime = "shell" }},
		{"unsafe-cleanup-id", func(j *job) { j.ID = "../../secret" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			j := validJob()
			test.mutate(&j)
			if validate(j) == nil {
				t.Fatal("unsafe input accepted")
			}
		})
	}
}
