# Separate private-demo execution agent

Build fixed runtime templates on the designated Linux Docker host before starting
the agent. Base images and the Docker CLI are pinned to registry manifest digests.
Set only immutable `sha256:<64 hex>` local template IDs, a private control token,
control origin and staging volume. The API/web/collab/user runtime have no Docker
socket. This agent alone controls Docker; it receives verified immutable inputs
via an authenticated private listener and no application credentials.

From the repository root, PowerShell:

```powershell
docker build -f services/runner/Python.Dockerfile -t cce-runtime-python:phase07 .
docker build -f services/runner/Javascript.Dockerfile -t cce-runtime-javascript:phase07 .
$env:RUNNER_PYTHON_IMAGE=(docker image inspect cce-runtime-python:phase07 --format '{{.Id}}')
$env:RUNNER_JAVASCRIPT_IMAGE=(docker image inspect cce-runtime-javascript:phase07 --format '{{.Id}}')
# Generate/set a private >=32-byte token shared only by API control and agent.
$env:RUNNER_INTERNAL_TOKEN='<your private random token>'
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.runner.yaml up -d --build --wait
```

The execution override is opt-in; base Compose leaves Run/Output unavailable.
The API rejects execution-enabled production mode. Keep private workloads on
this designated environment; a production runner needs a separate host and a
stronger sandbox before public untrusted workloads. One agent is supported;
do not scale it: startup reconciles every `cce.runner=private-demo` container.

Source staging is /runs in `cce-runner-work`; each container sees only its own
UUID/attempt subpath as a read-only /source. The agent builds directories/files
from verified bounded UTF-8 artifacts, never an extracted user archive. Defaults:
nonroot 65532, no network, read-only root/source, 16 MiB scratch, zero capabilities,
no-new-privileges, Docker builtin seccomp (startup checked), 1 CPU, 128 MiB memory
including swap ceiling, 32 PIDs, 64 descriptors, 5s wall, 16 KiB stdin, 64 KiB
combined stdout/stderr. A runtime PID 1 supervisor enforces the wall budget even
after agent SIGKILL. Output flood stops the container with an explicit truncation
status. Docker log driver is none; output only goes to the authorized job stream.

The durable queue is PostgreSQL; Redis is unnecessary. Claims have monotonic
attempts, random per-attempt credentials and a 15s DB-clock lease. An interrupted
attempt fails; it is never re-executed automatically. A new explicit Run is a new
job/key. Startup removes this agent's containers/staging before new claims; cleanup
failure stops the agent. Docker attach/control calls are bounded, and an ambiguous
finish is retried without restarting code. Lease failure resolves incomplete
completion as RUNNER_INTERRUPTED. No package installation or interactive shell.

Run acceptance only on this local designated test stack (it kills/restarts the
runner, and executes bounded loop/flood/PID/memory/network probes):

```powershell
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
$env:CCE_EXECUTION_TESTS='1'
npm.cmd run test:execution
npm.cmd run test:runs
```

Start with compose.test.yaml too to expose the test database on localhost. Keep
the same runner environment settings for test subprocesses. API Phase 06/07 Go
queue tests require real TS/MinIO endpoints and *both jobs and runner stopped*,
then restart them before browser/runner acceptance. Never overlap worker-kill
browser tests with Go materializer tests. See [execution contract](../../contracts/execution.md)
and [verification record](../../docs/implementation-status.md) for measured evidence
and unverified daemon outages/host loss/sustained-hostile/public execution limits.
