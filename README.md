# Collaborative Code Editor

A local browser workspace integrating Monaco/Yjs collaboration, authenticated
roles/cursors, PostgreSQL durable receipts, reconnect drafts, restorable immutable
checkpoints, version-aware search and opt-in private Python/JavaScript execution.
[PROJECT_SPEC.md](PROJECT_SPEC.md) is authoritative. [Implementation status](docs/implementation-status.md)
separates implementation, current acceptance, historical evidence and limitations.
No optional Phase 10 services are implemented.

The 8 October local acceptance evidence is under
[docs/measurements/local-demo-20261008](docs/measurements/local-demo-20261008).
Live OAuth has configured credentials and a verified authorization redirect;
manual GitHub authentication/callback/session/logout acceptance remains pending.
Do not describe the complete portfolio login demo as verified until that passes.
Neither local checks nor Docker execution establish production readiness or a
public hostile-code sandbox.

## Configure once

Use Docker Desktop with its Linux engine running, npm/Node (tested host Node
22.15.0/npm 10.9.2; containers use Node 24), Go 1.27.1 for backend checks, and
installed Microsoft Edge for Playwright. Run these commands from the repository
root in PowerShell; `npm.cmd` works with PowerShell's npm-script policy.

```powershell
docker info
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci
```

Edit `.env` locally. Supply **GITHUB_CLIENT_ID** and **GITHUB_CLIENT_SECRET** from
the same GitHub.com OAuth App. Its Homepage URL is `http://localhost:3000` and
Authorization callback URL must be exactly
`http://localhost:3000/api/v1/auth/github/callback`. Keep the application origin
as localhost, including during browser checks. No repository scope is requested.
See [GitHub's OAuth App registration instructions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
Never paste secrets into commands, issue bodies, screenshots or chat.

Existing nonempty values in `.env` are preserved. The launcher stores generated
runner credentials, resolved immutable runtime image IDs and operator settings in
ignored `.env.demo.local`; nonempty user settings take precedence. Both files are
excluded from Docker build contexts. Existing Grafana credentials are reused when
available. For operator access, inspect the local file privately instead of
printing it to shared logs. The base stack can run without OAuth credentials,
but login reports unavailable and live OAuth cannot be counted as passed.

## Start the base stack

```powershell
& .\scripts\local-demo.ps1 -Mode Base
Start-Process 'http://localhost:3000'
```

This starts web/edge, Go API, TS collaboration, PostgreSQL, Redis, MinIO and jobs.
Only the edge is published, on **127.0.0.1:3000**. Run is unavailable; switching
from private mode stops the existing private runner. Existing database and artifact
volumes are retained. No reset, volume deletion or auth bypass is performed.

Fresh database volumes apply canonical migrations automatically. Existing volumes
need any missing migrations in order; check before applying them:

```powershell
docker compose --env-file .env -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -c 'SELECT version FROM schema_migrations ORDER BY version'
```

The current database has eight stamps. Apply only missing SQL files from
`db/migrations` via the mounted `/canonical-migrations` path with
`psql -v ON_ERROR_STOP=1 -f ...`; do not replay installed migrations or erase a
volume. The least-privilege development worker login is provisioned by the local
initialization script, separately from canonical migrations.

## Start the private execution demo

```powershell
& .\scripts\local-demo.ps1 -Mode Private -Observability
Start-Process 'http://localhost:3000'
```

Private mode explicitly adds the separate runner/control network. Missing fixed
templates are built from the pinned Python/JavaScript Dockerfiles; existing
immutable local image IDs are reused. Only the runner mounts Docker control.
Application/user containers receive no Docker socket or application credentials.
The base stack does not become execution-enabled merely because templates exist.
Production configuration rejects execution-enabled mode.

Enforced private limits: non-root, no network, read-only source/root, bounded
scratch, dropped capabilities, no-new-privileges/default seccomp, 1 CPU, 128 MiB,
32 PIDs, five-second wall budget, 16 KiB stdin and 64 KiB combined output.
Timeout/cancel/flood terminate the attempt; uncertain interruptions fail without
automatic re-execution. Docker shares kernel risk; see
[runner contract/setup](services/runner/README.md) and [limitations](docs/limitations.md).

`-Observability` is optional: Prometheus binds 127.0.0.1:9090 and authenticated
Grafana binds 127.0.0.1:3001 (`cce_operator`). Metrics/OTLP and runner control stay
private. No monitoring notification or long-term trace backend is claimed.

## Execute acceptance

Acceptance adds **localhost-only** database/storage test ports and intentionally
interrupts local test services. Run it on this designated development stack,
sequentially; leave user work saved before the interruption checks.

```powershell
& .\scripts\local-demo.ps1 -Mode Private -TestPorts -Observability
& .\scripts\check-local-demo.ps1
# Separate, interactive real GitHub check: complete sign-in/consent in Edge.
npm.cmd run test:oauth-live
```

The checker runs typecheck/lint/build/contracts, full TS/protocol tests, isolated
Linux API/runner normal/race/vet, multi-context workspace/realtime/recovery/
checkpoint/search/run checks, actual execution limits, jobs death, local isolated
backup recovery, browser/load measurements, live redaction and Grafana checks,
followed by a configured-secret log scan that withholds all credential values.
It sets the documented test database URLs and required opt-ins, pauses jobs and
runner only during Go queue checks, and restores them in `finally`. Missing
prerequisites, skips, rejected unresolved work or failed child suites are not
passes. Windows's 32-bit MinGW race build limitation stays separate from Linux.

Dated JSON/screenshots go under `docs/measurements/local-demo-*`; detailed local
logs/dumps stay ignored in `.tmp`. An explicit `-ReportDirectory` can choose a
fresh evidence folder. The live OAuth command uses a fresh interactive browser,
verifies GitHub redirect/state/PKCE and the real callback/session/protected read/
logout, and never logs credentials, cookie values, authorization codes or identity.
It does not automate GitHub authentication or consent. Seeded sessions and OAuth
provider fixtures establish other acceptance, not live GitHub login.

## Four-minute demo

Use two independently authenticated accounts plus a viewer in one project:

1. Edit the same file concurrently; show cursors, identical text and Saved receipts.
2. Undo one user's edit while preserving peer work. Disconnect, edit both sides,
   reconnect and wait for Saved.
3. Restart the local collaboration worker and show acknowledged-state recovery
   after its fenced lease/retry delay; demonstrate raw viewer writes are denied.
4. Restore a ready checkpoint while an old tab has pending offline work. Show the
   fresh generation and export the old draft separately; it must not merge back.
5. Run a captured source cut while the peer keeps editing, then show an enforced
   timeout for `while (true) {}` and its bounded Output/cleanup.

See [the detailed demonstration](docs/demonstration.md) for timing and the
automated companion, plus [claims ledger](docs/claims-ledger.md),
[architecture](docs/architecture.md), [observability definitions](docs/observability.md),
[backup](docs/backup.md), [deployment preparation](docs/deployment.md) and
[interview/resume notes](docs/interview.md). No commit, push or deployment is
performed by these commands.

## Product behavior

Open `http://localhost:3000` to sign in, create projects, organize files/folders, edit with teammates, invite members, and manage roles. Synced means committed-state exchange; Saving includes local retention and pending server receipts; Saved requires all matching receipts. Offline edits can continue after the document has initialized. Offline — draft retained appears after the browser transaction finishes. Reconnect refreshes authorization and replays original identities. Recovery after worker death waits for its 15-second lease and retry backoff. Ctrl/Cmd+Z undoes local edits while preserving remote edits; undo history resets on file switch/reload.

Download visible draft exports current text even after a storage failure. Recover drafts exports account/project-scoped generations, including deleted/replaced files. Old-generation or access-denied outboxes stop replay. IndexedDB retention does not cover edits before the transaction completes, browser data eviction, device loss or cleared site data. Storage failure stops typing and exposes export. Explicit logout removes this account's cached drafts and shuts down other tabs; see [provider/privacy contract](contracts/provider.md).

Use Search project for literal, case-insensitive filename/content matching. Results show the indexed sequence and whether it lags the committed file. Content indexing is eventual; Refresh results checks for newer projections. Opening a match opens its current file. Deleted/replaced generations are filtered even while indexing lags, and current membership is checked on every query. Queries are limited to 128 UTF-8 bytes and the first 50 matches. See [search contract](contracts/search.md) and [Phase 08 review](docs/phase08-review.md).

Use Checkpoints in the workspace to capture committed server state; local unreceipted drafts are excluded. Owners/editors can capture and retry failed materializations; current members can preview/download ready checkpoints. Owner restore verifies all artifacts and prepares fresh Yjs documents, then atomically captures the latest previous committed state and replaces the tree/generations. Previous-state preview waits for its independent materializer to succeed. Connected clients rebind; old queued/offline updates remain separate downloadable drafts and never merge into restored text. See [checkpoint contract](contracts/checkpoints.md).
