// The private workspace agent alone has Docker authority. User containers get
// only their project volume, never application credentials or control sockets.
package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const maxLog = 256 << 10

var idPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var languages = map[string]bool{"python": true, "node": true, "typescript": true, "cpp": true, "java": true, "go": true}

type task struct {
	ID       string `json:"id"`
	Action   string `json:"action"`
	State    string `json:"state"`
	Log      string `json:"log"`
	ExitCode int    `json:"exit_code"`
}
type environment struct {
	Language   string    `json:"language"`
	Root       string    `json:"root"`
	Entrypoint string    `json:"entrypoint"`
	State      string    `json:"state"`
	Checkpoint string    `json:"checkpoint_id"`
	LastActive time.Time `json:"last_active"`
	Task       *task     `json:"task"`
	Terminals  int       `json:"terminals"`
	mu         sync.Mutex
}
type manager struct {
	mu                 sync.Mutex
	startMu            sync.Mutex
	projects           map[string]*environment
	root, image, token string
	idle               time.Duration
}
type sourceFile struct {
	Path string `json:"path"`
	Data []byte `json:"data"`
}

func container(id string) string { return "cce-workspace-" + id }
func volume(id string) string    { return "cce-workspace-data-" + id }
func safePath(s string) bool {
	if s == "" || len(s) > 1024 || !utf8.ValidString(s) || path.Clean(s) != s || strings.HasPrefix(s, "/") || strings.ContainsAny(s, "\\\x00") {
		return false
	}
	for _, p := range strings.Split(s, "/") {
		if p == ".." || p == "." || p == "" {
			return false
		}
	}
	return true
}
func docker(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "docker", args...).CombinedOutput()
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"message": message})
}
func (m *manager) persist(id string, e *environment) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	target := filepath.Join(m.root, id+".json")
	if err = os.WriteFile(target+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(target+".tmp", target)
}
func (m *manager) get(id string) *environment {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.projects[id]
}
func (m *manager) status(id string, e *environment) {
	data, err := docker(context.Background(), "inspect", "--format", "{{.State.Status}}", container(id))
	if err != nil {
		e.State = "missing"
	} else {
		e.State = strings.TrimSpace(string(data))
	}
}
func (m *manager) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /projects", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		ids := make([]string, 0, len(m.projects))
		for id := range m.projects {
			ids = append(ids, id)
		}
		m.mu.Unlock()
		respond(w, 200, ids)
	})
	mux.HandleFunc("/projects/{id}", m.lifecycle)
	mux.HandleFunc("POST /projects/{id}/sync", m.syncSource)
	mux.HandleFunc("POST /projects/{id}/tasks", m.startTask)
	mux.HandleFunc("GET /projects/{id}/terminal", m.terminal)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+m.token)) != 1 {
			fail(w, 403, "Forbidden")
			return
		}
		if id := r.PathValue("id"); id != "" && !idPattern.MatchString(id) {
			fail(w, 400, "Invalid project")
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (m *manager) lifecycle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		fail(w, 400, "Invalid project")
		return
	}
	e := m.get(id)
	if r.Method == "PUT" && e == nil {
		data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		var input struct {
			Action     string `json:"action"`
			Language   string `json:"language"`
			Root       string `json:"root"`
			Entrypoint string `json:"entrypoint"`
		}
		if err != nil || len(data) > 8192 || json.Unmarshal(data, &input) != nil || !languages[input.Language] || (input.Root != "." && !safePath(input.Root)) || (input.Entrypoint != "" && !(input.Language == "go" && input.Entrypoint == ".") && !safePath(input.Entrypoint)) {
			fail(w, 400, "Invalid workspace configuration")
			return
		}
		if input.Action != "start" {
			fail(w, 404, "Environment does not exist")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		m.mu.Lock()
		if len(m.projects) >= 20 {
			m.mu.Unlock()
			fail(w, 429, "Maximum 20 workspace environments")
			return
		}
		e = m.projects[id]
		if e == nil {
			e = &environment{Language: "python", Root: ".", State: "missing", LastActive: time.Now()}
			m.projects[id] = e
		}
		m.mu.Unlock()
	}
	if e == nil {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"state": "absent", "language": "python", "root": ".", "entrypoint": "", "terminals": 0})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		fail(w, 404, "Create the environment first")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	switch r.Method {
	case "GET":
		m.status(id, e)
		respond(w, 200, e)
	case "PUT":
		var input struct {
			Language   string `json:"language"`
			Root       string `json:"root"`
			Entrypoint string `json:"entrypoint"`
			Action     string `json:"action"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&input) != nil || !languages[input.Language] || (input.Root != "." && !safePath(input.Root)) || (input.Entrypoint != "" && !(input.Language == "go" && input.Entrypoint == ".") && !safePath(input.Entrypoint)) {
			fail(w, 400, "Choose a supported language, relative project root and entrypoint")
			return
		}
		if input.Action != "stop" && (e.Task != nil && e.Task.State == "running" || e.Terminals > 0) {
			fail(w, 409, "Close terminals and wait for the current task first")
			return
		}
		if input.Action == "stop" {
			if _, err := docker(r.Context(), "stop", "--time", "3", container(id)); err != nil {
				fail(w, 503, "Could not stop workspace")
				return
			}
			e.State = "exited"
		} else if input.Action == "start" {
			if err := m.start(r.Context(), id); err != nil {
				fail(w, 503, err.Error())
				return
			}
			e.State = "running"
		} else {
			fail(w, 400, "Action must be start or stop")
			return
		}
		e.Language = input.Language
		e.Root = input.Root
		e.Entrypoint = input.Entrypoint
		e.LastActive = time.Now()
		if m.persist(id, e) != nil {
			fail(w, 503, "Could not save workspace configuration")
			return
		}
		respond(w, 200, e)
	case "DELETE":
		if e.Terminals > 0 || e.Task != nil && e.Task.State == "running" {
			fail(w, 409, "Close terminals and wait for tasks before deleting")
			return
		}
		m.status(id, e)
		if e.State != "missing" {
			if _, err := docker(r.Context(), "rm", "-f", container(id)); err != nil {
				fail(w, 503, "Could not remove workspace")
				return
			}
		}
		inspection, volumeErr := docker(r.Context(), "volume", "inspect", volume(id))
		if volumeErr == nil {
			if _, err := docker(r.Context(), "volume", "rm", volume(id)); err != nil {
				fail(w, 503, "Could not delete workspace storage")
				return
			}
		} else if !strings.Contains(strings.ToLower(string(inspection)), "no such volume") {
			fail(w, 503, "Could not inspect workspace storage")
			return
		}
		if err := os.Remove(filepath.Join(m.root, id+".json")); err != nil && !os.IsNotExist(err) {
			fail(w, 503, "Could not delete metadata")
			return
		}
		m.mu.Lock()
		delete(m.projects, id)
		m.mu.Unlock()
		w.WriteHeader(204)
	default:
		fail(w, 405, "Method not allowed")
	}
}
func (m *manager) start(ctx context.Context, id string) error {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	data, err := docker(ctx, "inspect", "--format", "{{.State.Status}}", container(id))
	if err == nil {
		if strings.TrimSpace(string(data)) == "running" {
			return nil
		}
		inventory, inventoryErr := docker(ctx, "ps", "-q", "--filter", "label=cce.workspace=private-demo")
		if inventoryErr != nil || len(strings.Fields(string(inventory))) >= 3 {
			return errors.New("Maximum three running workspaces; stop another environment")
		}
		_, err = docker(ctx, "start", container(id))
		return err
	}
	// Inventory is Docker's actual state; stopped containers do not consume slots.
	data, err = docker(ctx, "ps", "-q", "--filter", "label=cce.workspace=private-demo")
	if err != nil {
		return errors.New("Docker unavailable")
	}
	if len(strings.Fields(string(data))) >= 3 {
		return errors.New("Maximum three running workspaces; stop another environment")
	}
	if _, err = docker(ctx, "volume", "create", "--label", "cce.workspace=private-demo", volume(id)); err != nil {
		return err
	}
	if _, err = docker(ctx, "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--mount", "type=volume,source="+volume(id)+",target=/project", m.image, "sh", "-c", "mkdir -p /project/work /project/home /project/deps /project/home/go-tmp && chown 1000:1000 /project/work /project/home /project/deps /project/home/go-tmp"); err != nil {
		return errors.New("Could not initialize project storage")
	}
	_, err = docker(ctx, "create", "--name", container(id), "--label", "cce.workspace=private-demo", "--pull", "never", "--user", "1000:1000", "--network", "bridge", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256", "--ulimit", "nofile=1024:1024", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--mount", "type=volume,source="+volume(id)+",target=/project", "--workdir", "/project/work", "--env", "HOME=/project/home", "--env", "PATH=/project/deps/venv/bin:/project/deps/node/node_modules/.bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin", "--env", "GOPATH=/project/deps/go", "--env", "GOCACHE=/project/deps/go-build", "--env", "GOTMPDIR=/project/home/go-tmp", "--env", "JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=2 -XX:MaxRAMPercentage=65", "--log-driver", "none", m.image, "sleep", "infinity")
	if err != nil {
		return errors.New("Could not create workspace container")
	}
	_, err = docker(ctx, "start", container(id))
	if err != nil {
		return err
	}
	// Give newly opened terminals the same project Python environment used by
	// Install/Run, including before the first requirements.txt installation.
	_, err = docker(ctx, "exec", container(id), "python3", "-m", "venv", "/project/deps/venv")
	return err
}
func (m *manager) syncSource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	e := m.get(id)
	if e == nil {
		fail(w, 404, "Create environment first")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.Terminals > 0 || e.Task != nil && e.Task.State == "running" {
		fail(w, 409, "Close terminals and wait for tasks before replacing the working copy")
		return
	}
	var input struct {
		Checkpoint string       `json:"checkpoint_id"`
		Files      []sourceFile `json:"files"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 160<<20)).Decode(&input) != nil || !idPattern.MatchString(input.Checkpoint) || len(input.Files) > 200 {
		fail(w, 400, "Invalid source snapshot")
		return
	}
	var buffer bytes.Buffer
	tw := tar.NewWriter(&buffer)
	total := 0
	seen := map[string]bool{}
	for _, f := range input.Files {
		total += len(f.Data)
		if !safePath(f.Path) || seen[f.Path] || len(f.Data) > 25<<20 || total > 110<<20 {
			fail(w, 400, "Invalid source files")
			return
		}
		seen[f.Path] = true
		_ = tw.WriteHeader(&tar.Header{Name: f.Path, Mode: 0644, Size: int64(len(f.Data)), Uid: 1000, Gid: 1000})
		_, _ = tw.Write(f.Data)
	}
	_ = tw.Close()
	if err := m.start(r.Context(), id); err != nil {
		fail(w, 503, err.Error())
		return
	}
	staging := "/project/staging-" + uuid.NewString()
	if _, err := docker(r.Context(), "exec", "--user", "0", container(id), "mkdir", staging); err != nil {
		fail(w, 503, "Could not stage source")
		return
	}
	cmd := exec.CommandContext(r.Context(), "docker", "cp", "-", container(id)+":"+staging)
	cmd.Stdin = &buffer
	if cmd.Run() != nil {
		_, _ = docker(r.Context(), "exec", "--user", "0", container(id), "rm", "-rf", staging)
		fail(w, 503, "Could not upload source")
		return
	}
	// All names here are controller-generated absolute paths within this volume.
	// Removal unlinks a user-created work symlink rather than following its target.
	previous := "/project/previous-" + uuid.NewString()
	script := fmt.Sprintf("chown -R 1000:1000 %s && mv /project/work %s && if mv %s /project/work; then rm -rf %s; else mv %s /project/work; exit 1; fi", staging, previous, staging, previous, previous)
	// Ownership changes run in a short-lived networkless controller helper, never
	// by granting extra capabilities to the development/user container.
	if _, err := docker(r.Context(), "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cpus", "1", "--memory", "128m", "--pids-limit", "32", "--mount", "type=volume,source="+volume(id)+",target=/project", m.image, "sh", "-c", script); err != nil {
		fail(w, 503, "Could not publish source")
		return
	}
	e.Checkpoint = input.Checkpoint
	e.State = "running"
	e.LastActive = time.Now()
	// Restore links to retained Node dependencies for the configured package root.
	if e.Language == "node" || e.Language == "typescript" {
		cwd := "/project/work"
		if e.Root != "." {
			cwd += "/" + e.Root
		}
		_, _ = docker(r.Context(), "exec", "--workdir", cwd, container(id), "sh", "-c", "if [ -d /project/deps/node/node_modules ] && [ ! -e node_modules ]; then ln -s /project/deps/node/node_modules node_modules; fi")
	}
	if m.persist(id, e) != nil {
		fail(w, 503, "Could not record synced checkpoint")
		return
	}
	respond(w, 200, e)
}

// Commands never interpolate an entrypoint into a shell string. Project build
// scripts are intentionally user code and execute only inside its own container.
func taskCommand(language, action, entry string) ([]string, error) {
	if action == "install" {
		switch language {
		case "python":
			return []string{"sh", "-c", "python3 -m venv /project/deps/venv && /project/deps/venv/bin/python -m pip install --disable-pip-version-check --no-cache-dir -r requirements.txt"}, nil
		case "node", "typescript":
			return []string{"sh", "-c", "mkdir -p /project/deps/node && if [ -L node_modules ]; then rm node_modules; fi; if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi && rm -rf /project/deps/node/node_modules && mv node_modules /project/deps/node/node_modules && ln -s /project/deps/node/node_modules node_modules"}, nil
		case "go":
			return []string{"go", "mod", "download"}, nil
		case "java":
			return []string{"mvn", "-q", "-B", "-Dmaven.repo.local=/project/deps/maven", "dependency:copy-dependencies", "-DoutputDirectory=/project/deps/java"}, nil
		case "cpp":
			return []string{"sh", "-c", "if [ -f CMakeLists.txt ]; then cmake -S . -B /project/home/cpp-build; else echo 'No CMakeLists.txt: use the terminal for native dependency builds.'; fi"}, nil
		}
	}
	if action == "build" {
		switch language {
		case "python":
			return []string{"python", "-m", "compileall", "-q", "."}, nil
		case "node":
			return []string{"npm", "run", "build", "--if-present"}, nil
		case "typescript":
			return []string{"sh", "-c", "if [ -f package.json ]; then npm run build; else tsc --outDir /project/home/ts-build; fi"}, nil
		case "go":
			return []string{"go", "build", "./..."}, nil
		case "java":
			return []string{"sh", "-c", "if [ -f pom.xml ]; then mvn -q -B -Dmaven.repo.local=/project/deps/maven package -DskipTests; else javac -cp '/project/deps/java/*' -d /project/home/java-build \"$1\"; fi", "build", entry}, nil
		case "cpp":
			if entry == "" {
				return nil, errors.New("Choose the C++ entrypoint")
			}
			return []string{"sh", "-c", "if [ -f CMakeLists.txt ]; then cmake -S . -B /project/home/cpp-build && cmake --build /project/home/cpp-build; else g++ -std=c++20 -O0 \"$1\" -o /project/home/cpp-main; fi", "build", entry}, nil
		}
	}
	if action == "run" {
		if entry == "" {
			return nil, errors.New("Set an entrypoint first")
		}
		switch language {
		case "python":
			return []string{"python", "-u", entry}, nil
		case "node":
			return []string{"node", entry}, nil
		case "typescript":
			return []string{"sh", "-c", "tsc --outDir /project/home/ts-run \"$1\" && node \"/project/home/ts-run/${1%.ts}.js\"", "run", entry}, nil
		case "go":
			return []string{"go", "run", entry}, nil
		case "java":
			return []string{"java", "--class-path", "target/classes:/project/home/java-build:/project/deps/java/*", entry}, nil
		case "cpp":
			return []string{"sh", "-c", "g++ -std=c++20 -O0 \"$1\" -o /project/home/cpp-main && /project/home/cpp-main", "run", entry}, nil
		}
	}
	return nil, errors.New("Unsupported action")
}

type taskWriter struct {
	m      *manager
	e      *environment
	id     string
	cancel context.CancelFunc
}

func (t taskWriter) Write(data []byte) (int, error) {
	t.e.mu.Lock()
	defer t.e.mu.Unlock()
	n := len(data)
	data = []byte(strings.ToValidUTF8(string(data), "?"))
	remaining := max(0, maxLog-len(t.e.Task.Log))
	if len(data) > remaining {
		data = data[:remaining]
		t.cancel()
	}
	t.e.Task.Log += string(data)
	return n, nil
}
func (m *manager) startTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	e := m.get(id)
	if e == nil {
		fail(w, 404, "Create environment first")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	var input struct {
		Action string `json:"action"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&input) != nil {
		fail(w, 400, "Invalid task")
		return
	}
	if e.Terminals > 0 || e.Task != nil && e.Task.State == "running" {
		fail(w, 409, "Close terminals and wait for the current task")
		return
	}
	if e.Checkpoint == "" {
		fail(w, 409, "Sync saved source first")
		return
	}
	args, err := taskCommand(e.Language, input.Action, e.Entrypoint)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if err = m.start(r.Context(), id); err != nil {
		fail(w, 503, err.Error())
		return
	}
	cwd := "/project/work"
	if e.Root != "." {
		cwd += "/" + e.Root
	}
	if (e.Language == "node" || e.Language == "typescript") && input.Action != "install" {
		_, err = docker(r.Context(), "exec", "--workdir", cwd, container(id), "sh", "-c", "mkdir -p /project/deps/node/node_modules && if [ ! -e node_modules ]; then ln -s /project/deps/node/node_modules node_modules; fi")
		if err != nil {
			fail(w, 400, "Project root not found")
			return
		}
	}
	current := &task{ID: uuid.NewString(), Action: input.Action, State: "running", ExitCode: -1}
	e.Task = current
	e.LastActive = time.Now()
	if m.persist(id, e) != nil {
		fail(w, 503, "Could not save task")
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "docker", append([]string{"exec", "--workdir", cwd, container(id), "timeout", "--signal=KILL", "600"}, args...)...)
		writer := taskWriter{m, e, id, cancel}
		command.Stdout = writer
		command.Stderr = writer
		err := command.Run()
		e.mu.Lock()
		defer e.mu.Unlock()
		current.State = "succeeded"
		current.ExitCode = 0
		if err != nil {
			current.State = "failed"
			current.ExitCode = -1
			if ex, ok := err.(*exec.ExitError); ok {
				current.ExitCode = ex.ExitCode()
			}
			if ctx.Err() != nil {
				current.Log += "\nTask stopped: time or output limit reached.\n"
				_, _ = docker(context.Background(), "stop", "--time", "1", container(id))
				e.State = "exited"
			}
		}
		e.LastActive = time.Now()
		_ = m.persist(id, e)
	}()
	respond(w, 202, current)
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (m *manager) terminal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	e := m.get(id)
	if e == nil {
		fail(w, 404, "Create environment first")
		return
	}
	e.mu.Lock()
	if e.Terminals >= 8 || e.Task != nil && e.Task.State == "running" {
		e.mu.Unlock()
		fail(w, 409, "Terminal limit reached or a task is running")
		return
	}
	if err := m.start(r.Context(), id); err != nil {
		e.mu.Unlock()
		fail(w, 503, err.Error())
		return
	}
	e.Terminals++
	e.LastActive = time.Now()
	cwd := "/project/work"
	if e.Root != "." {
		cwd += "/" + e.Root
	}
	e.mu.Unlock()
	defer func() { e.mu.Lock(); e.Terminals--; e.LastActive = time.Now(); _ = m.persist(id, e); e.mu.Unlock() }()
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(8192)
	session := uuid.NewString()
	pidFile := "/project/home/terminal-" + session + ".pid"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	script := "echo $$ > " + pidFile + "; exec bash --noprofile --norc"
	command := exec.CommandContext(ctx, "docker", "exec", "-i", "--workdir", cwd, "--env", "TERM=dumb", container(id), "script", "-qefc", script, "/dev/null")
	stdin, err := command.StdinPipe()
	if err != nil {
		return
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return
	}
	command.Stderr = command.Stdout
	if command.Start() != nil {
		return
	}
	// Killing the client alone would leave the docker-exec shell behind.
	defer func() {
		killCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_, _ = docker(killCtx, "exec", container(id), "sh", "-c", "if [ -f \"$1\" ]; then kill -HUP -- -$(cat \"$1\") 2>/dev/null || kill -HUP $(cat \"$1\") 2>/dev/null; rm -f \"$1\"; fi", "close", pidFile)
	}()
	go func() {
		defer cancel()
		defer stdin.Close()
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			e.mu.Lock()
			e.LastActive = time.Now()
			e.mu.Unlock()
			if _, err = stdin.Write(data); err != nil {
				return
			}
		}
	}()
	go func() { <-ctx.Done(); _ = ws.Close() }()
	buffer := make([]byte, 4096)
	for {
		n, err := stdout.Read(buffer)
		if n > 0 {
			_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if ws.WriteMessage(websocket.BinaryMessage, buffer[:n]) != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	cancel()
	_ = command.Wait()
}
func (m *manager) idleLoop() {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for range tick.C {
		m.mu.Lock()
		items := map[string]*environment{}
		for id, e := range m.projects {
			items[id] = e
		}
		m.mu.Unlock()
		for id, e := range items {
			e.mu.Lock()
			if e.Terminals == 0 && (e.Task == nil || e.Task.State != "running") && time.Since(e.LastActive) > m.idle {
				ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
				m.status(id, e)
				if e.State == "running" {
					_, _ = docker(ctx, "stop", "--time", "3", container(id))
					m.status(id, e)
					_ = m.persist(id, e)
				}
				stop()
			}
			e.mu.Unlock()
		}
	}
}
func main() {
	root := "/state"
	_ = os.MkdirAll(root, 0700)
	m := &manager{projects: map[string]*environment{}, root: root, image: os.Getenv("WORKSPACE_IMAGE"), token: os.Getenv("WORKSPACE_INTERNAL_TOKEN"), idle: 15 * time.Minute}
	if !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(m.image) || len(m.token) < 32 {
		panic("immutable workspace image and private control token required")
	}
	if _, err := docker(context.Background(), "image", "inspect", m.image); err != nil {
		panic("workspace image missing")
	}
	security, err := docker(context.Background(), "info", "--format", "{{json .SecurityOptions}}")
	if err != nil || !bytes.Contains(security, []byte("name=seccomp,profile=builtin")) {
		panic("Docker default seccomp required")
	}
	if setting := os.Getenv("WORKSPACE_IDLE_TIMEOUT"); setting != "" {
		duration, err := time.ParseDuration(setting)
		if err != nil || duration < time.Second {
			panic("invalid idle timeout")
		}
		m.idle = duration
	}
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !idPattern.MatchString(id) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, entry.Name()))
		if err != nil {
			panic("workspace state unreadable")
		}
		e := &environment{}
		if json.Unmarshal(data, e) != nil {
			panic("workspace state corrupt")
		}
		e.Terminals = 0
		if e.Task != nil && e.Task.State == "running" {
			e.Task.State = "failed"
			e.Task.Log += "\nWorkspace manager restarted; interrupted task was not rerun.\n"
		}
		m.projects[id] = e
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, _ = docker(ctx, "stop", "--time", "1", container(id))
		cancel()
		e.State = "exited"
		_ = m.persist(id, e)
	}
	go m.idleLoop()
	server := &http.Server{Addr: ":8090", Handler: m.routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	if err := server.ListenAndServe(); err != nil {
		panic("workspace control listener failed")
	}
}
