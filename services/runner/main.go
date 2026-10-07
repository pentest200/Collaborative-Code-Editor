package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

type inputFile struct {
	Path     string `json:"path"`
	Checksum string `json:"checksum"`
	Data     []byte `json:"data"`
}
type job struct {
	ID           string      `json:"id"`
	Claim        string      `json:"claim"`
	Attempt      int         `json:"attempt"`
	Runtime      string      `json:"runtime"`
	Entrypoint   string      `json:"entrypoint"`
	Stdin        []byte      `json:"stdin"`
	Manifest     []byte      `json:"manifest"`
	ManifestHash string      `json:"manifest_hash"`
	Files        []inputFile `json:"files"`
}
type agent struct {
	origin, token, root, volume string
	images                      map[string]string
	client                      *http.Client
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func safePath(s string) bool {
	if s == "" || len(s) > 1024 || !utf8.ValidString(s) || strings.ContainsAny(s, "\\\x00") || strings.HasPrefix(s, "/") || path.Clean(s) != s {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == ".." || part == "." || part == "" {
			return false
		}
	}
	return true
}
func validate(j job) error {
	if !uuidPattern.MatchString(j.ID) || !uuidPattern.MatchString(j.Claim) || j.Attempt < 1 || len(j.Stdin) > 16384 || len(j.Manifest) > 4<<20 || hash(j.Manifest) != j.ManifestHash || !safePath(j.Entrypoint) || (j.Runtime != "python" && j.Runtime != "javascript") {
		return errors.New("invalid job")
	}
	var manifest struct {
		Format string `json:"format"`
		Files  []struct {
			Path     string `json:"path"`
			Checksum string `json:"checksum"`
			Size     int    `json:"text_bytes"`
		} `json:"files"`
	}
	if json.Unmarshal(j.Manifest, &manifest) != nil || manifest.Format != "cce-checkpoint-v1" || len(manifest.Files) != len(j.Files) || len(j.Files) > 200 {
		return errors.New("invalid manifest")
	}
	expected := map[string]string{}
	sizes := map[string]int{}
	for _, f := range manifest.Files {
		if !safePath(f.Path) || expected[f.Path] != "" {
			return errors.New("duplicate path")
		}
		expected[f.Path] = f.Checksum
		sizes[f.Path] = f.Size
	}
	total := 0
	found := false
	for _, f := range j.Files {
		if !safePath(f.Path) || expected[f.Path] != f.Checksum || sizes[f.Path] != len(f.Data) || hash(f.Data) != f.Checksum || len(f.Data) > 262144 || !utf8.Valid(f.Data) {
			return errors.New("invalid artifact")
		}
		delete(expected, f.Path)
		total += len(f.Data)
		found = found || f.Path == j.Entrypoint
	}
	if total > 10<<20 || !found || len(expected) != 0 {
		return errors.New("invalid source")
	}
	return nil
}
func (a *agent) call(ctx context.Context, endpoint string, input any, output any) (int, error) {
	data, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", a.origin+endpoint, bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := a.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == 204 {
		return 204, nil
	}
	if res.StatusCode != 200 {
		return res.StatusCode, errors.New("control request failed")
	}
	if output != nil {
		err = json.NewDecoder(io.LimitReader(res.Body, 20<<20)).Decode(output)
	}
	return res.StatusCode, err
}
func docker(ctx context.Context, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, "docker", args...).Output()
}
func name(j job) string { return "cce-run-" + j.ID + "-" + strconv.Itoa(j.Attempt) }
func (a *agent) cleanup(ctx context.Context, j job) error {
	if !uuidPattern.MatchString(j.ID) || j.Attempt < 1 {
		return errors.New("invalid cleanup identity")
	}
	if _, err := docker(ctx, "rm", "-f", name(j)); err != nil {
		check, inspect := docker(ctx, "ps", "-aq", "--filter", "name=^/"+name(j)+"$")
		if inspect != nil || len(bytes.TrimSpace(check)) != 0 {
			return errors.New("container cleanup failed")
		}
	}
	return os.RemoveAll(filepath.Join(a.root, name(j)))
}
func (a *agent) reconcile(ctx context.Context) error {
	ids, err := docker(ctx, "ps", "-aq", "--filter", "label=cce.runner=private-demo")
	if err != nil {
		return err
	}
	for _, id := range strings.Fields(string(ids)) {
		if _, err = docker(ctx, "rm", "-f", id); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(a.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "cce-run-") {
			if err = os.RemoveAll(filepath.Join(a.root, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

type chunk struct {
	kind string
	data []byte
}
type capture struct {
	mu        sync.Mutex
	used      int
	truncated bool
	queue     chan chunk
	overflow  chan struct{}
	once      sync.Once
}
type writer struct {
	c    *capture
	kind string
}

func (w writer) Write(data []byte) (int, error) {
	original := len(data)
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	available := 65536 - w.c.used
	if len(data) > available {
		data = data[:available]
		w.c.truncated = true
		w.c.once.Do(func() { close(w.c.overflow) })
	}
	for len(data) > 0 {
		n := min(2048, len(data))
		w.c.queue <- chunk{w.kind, bytes.Clone(data[:n])}
		w.c.used += n
		data = data[n:]
	}
	return original, nil
}
func (a *agent) execute(ctx context.Context, j job) {
	admittedAt := time.Now()
	state := "failed"
	exit := 125
	truncated := false
	request := map[string]any{"claim": j.Claim}
	// Report only after container and source cleanup; cleanup failure stops agent.
	finish := func() {
		cleanCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupAt := time.Now()
		if a.cleanup(cleanCtx, j) != nil {
			slog.Error("runner cleanup failed; stopping")
			os.Exit(1)
		}
		observeStage("cleanup", j.Runtime, cleanupAt)
		observeStage("total", j.Runtime, admittedAt)
		request["state"] = state
		request["exit_code"] = exit
		request["truncated"] = truncated
		for tries := 0; tries < 3; tries++ {
			status, err := a.call(cleanCtx, "/internal/runs/"+j.ID+"/finish", request, nil)
			if err == nil || status == 409 {
				return
			}
		}
	}
	if validate(j) != nil {
		finish()
		return
	}
	image := a.images[j.Runtime]
	if !strings.HasPrefix(image, "sha256:") {
		finish()
		return
	}
	work := filepath.Join(a.root, name(j))
	if os.Mkdir(work, 0755) != nil {
		finish()
		return
	}
	for _, f := range j.Files {
		target := filepath.Join(work, filepath.FromSlash(f.Path))
		if os.MkdirAll(filepath.Dir(target), 0755) != nil || os.WriteFile(target, f.Data, 0444) != nil {
			finish()
			return
		}
	}
	args := []string{"create", "--name", name(j), "--label", "cce.runner=private-demo", "--pull", "never", "--user", "65532:65532", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cpus", "1", "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "32", "--ulimit", "nofile=64:64", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", "--mount", "type=volume,source=" + a.volume + ",target=/source,volume-subpath=" + name(j) + ",readonly", "--workdir", "/source", "--log-driver", "none", "--interactive", image, j.Runtime, "/source/" + j.Entrypoint}
	if _, err := docker(ctx, args...); err != nil {
		finish()
		return
	}
	var heartbeat struct {
		Stop bool `json:"stop"`
	}
	if _, err := a.call(ctx, "/internal/runs/"+j.ID+"/heartbeat", request, &heartbeat); err != nil || heartbeat.Stop {
		state = "cancelled"
		finish()
		return
	}
	c := &capture{queue: make(chan chunk, 32), overflow: make(chan struct{})}
	attachCtx, stopAttach := context.WithTimeout(ctx, 10*time.Second)
	defer stopAttach()
	command := exec.CommandContext(attachCtx, "docker", "start", "--attach", "--interactive", name(j))
	command.Stdin = bytes.NewReader(j.Stdin)
	command.Stdout = writer{c, "stdout"}
	command.Stderr = writer{c, "stderr"}
	if command.Start() != nil {
		finish()
		return
	}
	observeStage("startup", j.Runtime, admittedAt)
	runtimeAt := time.Now()
	done := make(chan error, 1)
	go func() { err := command.Wait(); close(c.queue); done <- err }()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	deadline := time.NewTimer(7 * time.Second)
	defer deadline.Stop()
	sequence := int64(0)
	stopped := false
	kill := func() {
		killAt := time.Now()
		defer observeStage("termination", j.Runtime, killAt)
		if stopped {
			return
		}
		stopped = true
		killCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = docker(killCtx, "kill", name(j))
	}
	outputFailure := false
	overflow := c.overflow
	chunks := c.queue
	for chunks != nil {
		select {
		case ch, open := <-chunks:
			if !open {
				chunks = nil
				continue
			}
			sequence++
			message := map[string]any{"claim": j.Claim, "sequence": strconv.FormatInt(sequence, 10), "kind": ch.kind, "data": ch.data}
			if !outputFailure {
				var err error
				for tries := 0; tries < 3; tries++ {
					_, err = a.call(ctx, "/internal/runs/"+j.ID+"/output", message, nil)
					if err == nil {
						break
					}
				}
				if err != nil {
					outputFailure = true
					kill()
				}
			}
		case <-tick.C:
			if !stopped {
				heartbeat.Stop = false
				if _, err := a.call(ctx, "/internal/runs/"+j.ID+"/heartbeat", request, &heartbeat); err != nil {
					outputFailure = true
					kill()
				} else if heartbeat.Stop {
					state = "cancelled"
					kill()
				}
			}
		case <-overflow:
			truncated = true
			overflow = nil
			kill()
		case <-deadline.C:
			if state != "cancelled" {
				state = "timed_out"
			}
			kill()
		case <-ctx.Done():
			kill()
		}
	}
	<-done
	observeStage("runtime", j.Runtime, runtimeAt)
	c.mu.Lock()
	truncated = truncated || c.truncated
	c.mu.Unlock()
	inspectCtx, stopInspect := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopInspect()
	inspection, err := docker(inspectCtx, "inspect", "--format", "{{.State.ExitCode}}", name(j))
	if err == nil {
		exit, _ = strconv.Atoi(strings.TrimSpace(string(inspection)))
	}
	if state != "cancelled" && state != "timed_out" {
		if outputFailure || truncated {
			state = "failed"
		} else if exit == 124 {
			state = "timed_out"
		} else if exit == 0 {
			state = "succeeded"
		} else {
			state = "failed"
		}
	}
	finish()
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startRunnerMetrics(ctx)
	a := agent{origin: os.Getenv("RUNNER_CONTROL_ORIGIN"), token: os.Getenv("RUNNER_INTERNAL_TOKEN"), root: "/runs", volume: os.Getenv("RUNNER_WORK_VOLUME"), images: map[string]string{"python": os.Getenv("RUNNER_PYTHON_IMAGE"), "javascript": os.Getenv("RUNNER_JAVASCRIPT_IMAGE")}, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if a.origin == "" || a.token == "" || a.volume == "" {
		slog.Error("runner configuration required")
		os.Exit(1)
	}
	info, err := docker(ctx, "info", "--format", "{{json .SecurityOptions}}")
	if err != nil || !bytes.Contains(info, []byte("name=seccomp,profile=builtin")) {
		slog.Error("Docker default seccomp required")
		os.Exit(1)
	}
	for _, image := range a.images {
		if !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(image) {
			slog.Error("prebuilt image IDs required")
			os.Exit(1)
		}
		if _, err = docker(ctx, "image", "inspect", image); err != nil {
			slog.Error("runtime image missing")
			os.Exit(1)
		}
	}
	if err = a.reconcile(ctx); err != nil {
		slog.Error("runner reconciliation failed")
		os.Exit(1)
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var j job
			status, err := a.call(ctx, "/internal/runs/claim", map[string]any{}, &j)
			if err == nil && status == 200 {
				a.execute(ctx, j)
			}
		}
	}
}
