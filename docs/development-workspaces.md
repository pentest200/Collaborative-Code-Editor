# Development workspaces

The 13 October 2026 extension adds local private development environments to the
existing collaborative editor. Collaborative source remains authoritative in
PostgreSQL/Yjs. The restricted immutable checkpoint runner remains independent.

## Start

From the project root in PowerShell, run `./scripts/start-workspaces.ps1`.
The launcher builds the toolchain image when missing, resolves its immutable
sha256 ID, generates a separate control token in ignored `.env.demo.local`, and
starts the workspace agent, API and frontend while retaining existing data.
For a fresh complete stack use `./scripts/local-demo.ps1 -Mode Private -Workspaces`.
Keep this execution environment private; production rejects workspace control.

## Import

Explorer has Import files and Import folder. Folder selection preserves the
selected top-level folder. Review the destination and checked files before
importing. All file extensions/formats are accepted, including generated folders,
images, documents, archives, executables and non-UTF-8 files. Likely secrets
are unchecked by default; this is a convenience, not a comprehensive secret scanner.
Imports preserve original bytes and commit the entire selected tree atomically. An
existing file name, invalid path, initialization failure or quota violation aborts
the import. Existing folders may be reused, files are never overwritten.
Small UTF-8 files up to 256 KiB use collaborative Yjs documents. Binary, non-UTF-8
and larger files use immutable asset generations stored transactionally in
PostgreSQL and included in checkpoint artifacts/restores and workspace sync.
PNG/JPEG/GIF/WebP have image previews; other assets have original-file downloads.
HTML/SVG assets and other active formats are never served as inline application
pages. Assets cannot be edited through the text collaboration protocol.
Limits are 25 MiB per asset, 100 MiB per import, 100 MiB active project assets,
10 MiB collaborative source, 200 active entries (including folders), depth 16,
and path 1024 bytes. Oversized files are explicitly reported in the import preview.
Empty local folders are not
represented by browser directory selection.

## Configure, sync, build and run

The workbench uses an activity bar and resizable Explorer/sidebar and bottom
panel. Environment, Task output and Terminal have separate tabs; Captured run
remains a separate mode. Hiding the bottom panel or switching its tabs preserves
open shell sessions. Close a shell's tab to terminate it. Local draft recovery
is in the Explorer footer; file/folder import is in its top toolbar.
On narrow screens the sidebar is a toggleable drawer and closes on file selection.

Keyboard shortcuts: Ctrl+B toggles the sidebar, Ctrl+J toggles the bottom panel,
Ctrl+Shift+E opens Explorer, Ctrl+Shift+F opens search, Ctrl+P focuses file filtering,
and Ctrl+backtick opens Terminal. Both resize handles support arrow keys as well
as pointer dragging. Import and file-action dialogs keep keyboard focus inside.

Open Development workspace. Select Python, Node.js, TypeScript, C++, Java or Go,
the relative project folder (`.` or e.g. `my-codebase`), and the entrypoint.
Create/start/save config persists these choices. Sync saved source drains browser
receipt queues, captures a consistent checkpoint, verifies its materialized files
and replaces `/project/work` in the container. All terminals and tasks must finish
before syncing. Sync explicitly discards terminal edits to the working source;
it never writes back over collaborative documents. Dependencies under
`/project/deps` and terminal files under `/project/home` survive sync and stop/start.
Copy terminal files out through the terminal or retain them under `/project/home`.
Automatic bidirectional terminal/editor synchronization is not implemented.

Install dependencies, Build and Run workspace execute in the configured folder.
Tasks have up to ten minutes and 256 KiB combined logs, with one task per project.
Stop environment cancels processes. Last task/status/logs persist in the agent
state volume; a restarted agent stops environments and marks interrupted tasks
failed instead of re-executing them. Status polling does not keep environments alive.

| Language | Install | Build / run |
|---|---|---|
| Python 3.14 | pip into project venv from requirements.txt | compileall / selected script |
| Node 24 | npm ci with lockfile, npm install otherwise | optional build script / selected JS file |
| TypeScript 5.9 | npm project dependencies | project build script or tsc / compile selected TS and run JS |
| C++ (GCC) | native source dependencies via terminal | CMake or selected C++ file; run compiles the selected file |
| Java 17 | Maven pom.xml dependencies and shared Maven cache | Maven package or javac; run source file or main class |
| Go 1.27 | go mod download | go build ./... / go run selected file |

Gradle wrappers and custom commands can be used from terminals. There is no
automatic Gradle build detection, C++ package manager, universal system-package
installation, or compatibility promise for every imported repository. Containers
are non-root; apt installation is not available inside them. Python dependencies
must support Python 3.14. Pin versions and use lockfiles for reproducibility.

For CPU PyTorch, requirements.txt can contain:

```text
--extra-index-url https://download.pytorch.org/whl/cpu
torch==2.9.1+cpu
numpy==2.4.2
```

Choose Python, Install dependencies, then Run workspace. Installing a package in
the workspace does not alter the older five-second/128-MiB checkpoint runner.
Projects containing assets use Run workspace; the captured-source runner is
text-only and returns a clear WORKSPACE_REQUIRED response for asset projects.
PyTorch's [official version instructions](https://pytorch.org/get-started/previous-versions/)
document the CPU wheel index. GPU/model training is outside this local profile.

## Terminal and lifecycle

Each New terminal creates an independent PTY-backed bash shell for the connecting
teammate. Shell input/output is not broadcast to other teammates. Project storage
and dependencies are shared. New environments initialize the project Python venv;
terminal pip and Python use the same environment as the dependency/run controls.
Terminal access requires current editor/owner access,
strict browser Origin and a valid session; the API rechecks access every two seconds.
Disconnect closes the shell; sessions are not resumable. Up to eight shells per
project, four visible per tab, with a thirty-minute maximum session duration.
Terminal resizing currently adjusts the browser rendering only.

After fifteen minutes without tasks or terminal activity, the environment stops.
An open terminal prevents idle stop until it closes or reaches its session limit.
Start restores the same project volume. Delete environment is owner-only and removes
its container, dependencies and terminal files, retaining collaborative documents.
Stop is available to editors and owners. A maximum of three running environments
and twenty registered environments is enforced. Project deletion triggers eventual
workspace cleanup through a one-minute inventory sweep, with retries on failure.

## Boundary and subsequent work

Only the private workspace agent receives Docker control. User containers have
one project volume, 2 CPU quota, 2 GiB memory/no extra swap, 256 PIDs, read-only
root, no capabilities, no-new-privileges and default seccomp. User code has network
access for downloads, unlike the older runner. It is not connected to application
or control networks; Docker bridge still exposes host/network reachability. There
is no volume byte quota or hostile-code/public isolation claim. Disk consumption
needs operator monitoring, and internet downloads/build scripts can execute code.
See Docker's [resource controls](https://docs.docker.com/engine/containers/resource_constraints/)
and [container security](https://docs.docker.com/engine/security/).

Step 6 (language servers, breakpoint debugging and application preview routing)
is subsequent work. This change does not advertise those features as implemented.
The existing Monaco syntax highlighting remains available for imported source.
