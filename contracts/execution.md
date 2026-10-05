# Restricted private-demo execution (Phase 07)

The public cookie/CSRF API accepts only runtime (python/javascript), a manifest
entrypoint path and UTF-8 stdin (16 KiB). Idempotency-Key is a UUID scoped to
project/actor; identical input returns the original job/checkpoint, conflicting
input returns 409. One capturing/queued/running job per actor and per project.
The browser drains active providers and retained pending drafts from closed files,
waiting for exact durable receipts before POST. Closed-file outboxes drain
sequentially while the bound editor transport pauses, then it resynchronizes;
one document transport remains active per tab. Frozen old generations remain
separate recoverable drafts. A failed receipt/storage/access check prevents Run.

POST captures a full tree/document cut in one repeatable-read transaction with
the job, initial sequenced status and lifecycle outbox. Later edits cannot change
its checkpoint. States: capturing → queued → running → succeeded/failed/timed_out/
cancelled. Failed checkpoint input fails the job. Terminal jobs never restart.
Each state change writes a durable status event and outbox in its transaction.

GET run and GET events require current membership; cancellation requires current
owner/editor. Events are SSE, ordered decimal bigint IDs; `after` resumes, with
bounded batches, 500ms membership/session revalidation, 5s socket-write budget and
30s stream rotation. Output chunks are <=4 KiB; cumulative stdout+stderr <=64 KiB.
Output is rendered as escaped text. It never enters global application logs.

Private API listener 8082 authenticates a dedicated >=32-byte runner token.
It alone registers claim/heartbeat/output/finish routes; public 8080/edge does
not route them. The execution agent receives no DB, OAuth, session, collaboration
or object-store credentials, and no general project API capability. It receives
manifest bytes/hash and verified UTF-8 file bytes/checksums, then independently
verifies bounds, exact file set and entrypoint. No presigned URLs or path keys.

PostgreSQL SKIP LOCKED claims use attempt + unguessable claim UUID + a 15s DB-clock
lease. Heartbeats occur every 500ms. Output has independent monotonic runner
sequence receipts: identical retries deduplicate, changed bytes/order fail.
Cancellation before admission is terminal; during execution it kills the whole
container. Expired running attempts become RUNNER_INTERRUPTED/failed, never queued.
On restart the single designated agent removes all its labeled attempt containers
and staging directories before claiming another job. Uncertain completion is
explicitly failed; a user may submit a new Run key. No automatic re-execution.

Fixed Python 3.14.3/Node 24.14.0 base manifests are digest pinned; rebuilt templates
are prebuilt/prepulled and configured using immutable local sha256 image IDs.
The agent accepts no user image, command string, environment, mount or Docker
options. Exec-form /supervise starts only the fixed Python/Node templates.
UID/GID 65532, network none, read-only root and per-attempt read-only source
subpath, /tmp 16 MiB noexec/nosuid/nodev, drop ALL capabilities, no-new-privileges,
Docker builtin seccomp (agent fails startup if absent), 1 CPU, 128 MiB memory with
no additional swap, 32 PIDs, 64 file descriptors, 5s wall budget, 16 KiB stdin,
64 KiB combined output. Floods truncate and terminate. PID 1 enforces wall time
even after agent death; container exit removes the full PID namespace. Exit 124
is treated as timed_out, including a user program choosing that reserved code.
No pip/npm installation or interactive shell is offered.

The explicit Compose runner override is a local designated execution environment.
Only the separate agent mounts its Docker control socket; API/web/collab and user
containers never mount it. The agent's socket is host-runtime authority. Keep it
on a dedicated execution host for deployment. This implementation rejects
execution-enabled production configuration. Docker shares a host kernel; public
untrusted execution requires a separate gVisor/microVM sandbox release gate.
Daemon loss, backup/recovery and hostile sustained workloads are not established
by bounded acceptance tests.

Docker control references: [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/),
[run flags](https://docs.docker.com/reference/cli/docker/container/run/),
[builtin seccomp](https://docs.docker.com/engine/security/seccomp/).
