# Collaborative Code Editor

A browser workspace with Monaco/Yjs collaboration, authenticated roles and cursors, PostgreSQL durable edit receipts, retained reconnect drafts, generation-safe checkpoints, private immutable Python/JavaScript runs and version-aware search. Phase 09 adds redacted OpenTelemetry, Prometheus/Grafana, reproducible load/failure/recovery checks and release evidence. [The specification](PROJECT_SPEC.md) is authoritative; [implementation status](docs/implementation-status.md) distinguishes verified behavior and remaining gates. Execution stays opt-in on a designated private Docker environment.

[Measurements](docs/measured-release.md) Â· [Claims ledger](docs/claims-ledger.md) Â· [Observability](docs/observability.md) Â· [Deployment preparation](docs/deployment.md) Â· [Backup/recovery](docs/backup.md) Â· [Four-minute demo](docs/demonstration.md) Â· [Interview/resume notes](docs/interview.md)

## Development

The [local setup and verification runbook](docs/setup.md) records the tested toolchains, combined Compose overrides and isolation requirements for checks.

Requirements: Node.js 24 LTS recommended (Node 22.15+ also supported by the manifests), npm, Go 1.27.1, and Docker Compose. Windows PowerShell may require `npm.cmd` rather than `npm` under restrictive execution policy. Copy `.env.example` to `.env` and add GitHub.com OAuth App credentials. Register `http://localhost:3000/api/v1/auth/github/callback` as the exact callback. Login remains unavailable until credentials are configured; no repository scope is requested.

```sh
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run check:contracts
npm run test:workspace # after build; uses installed Microsoft Edge by default
npm run test:realtime # after Compose is running, with TEST_DATABASE_URL set
npm run test:recovery # real browser draft/reconnect/undo/privacy acceptance
npm run test:checkpoints # real PostgreSQL/MinIO capture, preview, restore and offline generation recovery
npm run test:search # real two-account versioned search and lifecycle visibility
cd services/api && go test ./... && go vet ./...
docker compose -f infra/compose/compose.yaml config
docker compose -f infra/compose/compose.yaml up --build
```

Open `http://localhost:3000` to sign in, create projects, organize files/folders, edit with teammates, invite members, and manage roles. Synced means committed-state exchange; Saving includes local retention and pending server receipts; Saved requires all matching receipts. Offline edits can continue after the document has initialized. Offline â€” draft retained appears after the browser transaction finishes. Reconnect refreshes authorization and replays original identities. Recovery after worker death waits for its 15-second lease and retry backoff. Ctrl/Cmd+Z undoes local edits while preserving remote edits; undo history resets on file switch/reload.

Download visible draft exports current text even after a storage failure. Recover drafts exports account/project-scoped generations, including deleted/replaced files. Old-generation or access-denied outboxes stop replay. IndexedDB retention does not cover edits before the transaction completes, browser data eviction, device loss or cleared site data. Storage failure stops typing and exposes export. Explicit logout removes this account's cached drafts and shuts down other tabs; see [provider/privacy contract](contracts/provider.md).

Use Search project for literal, case-insensitive filename/content matching. Results show the indexed sequence and whether it lags the committed file. Content indexing is eventual; Refresh results checks for newer projections. Opening a match opens its current file. Deleted/replaced generations are filtered even while indexing lags, and current membership is checked on every query. Queries are limited to 128 UTF-8 bytes and the first 50 matches. See [search contract](contracts/search.md) and [Phase 08 review](docs/phase08-review.md).

Use Checkpoints in the workspace to capture committed server state; local unreceipted drafts are excluded. Owners/editors can capture and retry failed materializations; current members can preview/download ready checkpoints. Owner restore verifies all artifacts and prepares fresh Yjs documents, then atomically captures the latest previous committed state and replaces the tree/generations. Previous-state preview waits for its independent materializer to succeed. Connected clients rebind; old queued/offline updates remain separate downloadable drafts and never merge into restored text. See [checkpoint contract](contracts/checkpoints.md).

File creation needs the private collaboration process for empty Yjs state initialization. `GET /api/v1/healthz` and the private `/internal/healthz` report process liveness. `docker compose -f infra/compose/compose.yaml down` preserves the database and artifact volumes. Fresh volumes apply all canonical migrations automatically; existing volumes require missing migrations in order. A Phase 07 volume needs 0008; earlier volumes first apply their missing migrations through 0007 and the local worker login:

```sh
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0004_document_durability.sql
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0005_awareness_identity.sql
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0006_checkpoints.sql
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0007_runs.sql
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0008_search.sql
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /local-collab-login.sql
```

Earlier volumes must first apply any missing migrations in order. Fresh volumes run all canonical migrations and the explicitly development-only login script automatically. Production must provision a separate worker login inheriting only `cce_collab`; do not give it API/admin credentials. [Persistence contract](contracts/persistence.md) documents lock order, quotas, snapshots and privilege boundaries.

Real PostgreSQL integration tests use an explicit test-only Compose override that publishes the database on localhost. In PowerShell:

```powershell
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.test.yaml up -d postgres
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
$env:TEST_COLLAB_DATABASE_URL='postgres://cce_worker:cce_worker_dev_only@127.0.0.1:54329/cce?sslmode=disable'
npm.cmd run test
cd services/api
go test ./... -count=1
go vet ./...
```

For separate local processes, set `APP_ENV=development`, `PUBLIC_ORIGIN=http://localhost:3000`, and GitHub credentials. Give Go its metadata/database login, and give the collaboration process a separate `DATABASE_URL` for the restricted worker login; then run `npm run dev:web`, `npm run dev:collab`, and `go run .` in `services/api`. Go calls `COLLAB_INTERNAL_ORIGIN` (default `http://127.0.0.1:8081`) with the shared `COLLAB_INTERNAL_TOKEN`; production requires an explicit token. Configure `ARTIFACT_ENDPOINT`, `ARTIFACT_ACCESS_KEY`, `ARTIFACT_SECRET_KEY` and `ARTIFACT_BUCKET` for private storage. A separate Go process with `JOBS_ONLY=true` runs checkpoint jobs without an HTTP server. Compose wires these automatically. The web development server rewrites `/api/v1/*` to Go. Use Caddy in Compose for the same-origin WebSocket route during development.

MinIO is built from a pinned official source release because pulls from its former official image registries were rejected. The base stack publishes neither storage nor its console; the test override publishes only localhost:9000. The `jobs` service provisions the private local bucket, with no anonymous policy. Its persistent PostgreSQL claims/outbox and deterministic UUID artifacts make upload and database failures retryable. See [worker notes](services/jobs/README.md).

Go's Phase 06 integration test additionally needs `TEST_COLLAB_ORIGIN` and `TEST_ARTIFACT_ENDPOINT` pointing to real services. It controls the materializer queue, so stop both separate `jobs` and `runner` services while running that suite, then restart it before `test:checkpoints`. Linux container tests can use `http://collab:8081`, `http://minio:9000` and the private Compose network. Without these prerequisites the integration test explicitly skips; that is not acceptance evidence.

Frozen contracts live in `contracts/`; code boundaries and current limitations live in `docs/`. Do not treat reserved OpenAPI operations as implemented endpoints.

Private execution requires prebuilt digest-pinned Python/JavaScript templates and the explicit `compose.runner.yaml` override. Follow [runner setup and checks](services/runner/README.md). Run selects a manifest entrypoint and bounded stdin, drains pending edit receipts, captures a committed checkpoint, and shows its exact ID with output/exit status. Only owner/editor can run or cancel; current project members can read job/output. Limits: 1 CPU, 128 MiB, 32 PIDs, 5 seconds, 16 KiB stdin, 64 KiB combined output and one active run per user/project. Output floods truncate and terminate. Interrupted attempts fail without automatic re-execution. The separate agent alone controls Docker and has no application credentials. Docker shares kernel risk; this is not a public hostile-code sandbox or production deployment. The base stack and production auth configuration keep execution disabled.

The raw acceptance suite kills real test subprocesses at database/commit/snapshot/renewal barriers. Run the full-stack two-account worker-restart and storage-failure demonstration only against the designated local test Compose stack (it kills its `collab` service and terminates a scoped blocked database connection):

```powershell
$env:CCE_E2E_RESTART='1'
$env:CCE_E2E_STORAGE_FAILURE='1'
npm.cmd run test:realtime
npm.cmd run test:recovery # same local stack; automatic reconnect + worker/Redis interruption
```

These tests use seeded authenticated sessions rather than live GitHub credentials. The recovery suite routes document WebSockets through Playwright to drop ACKs, duplicate frames and interrupt transport while forwarding accepted traffic to real Go/PostgreSQL. With `CCE_E2E_RESTART=1`, it kills/restarts the local worker and stops/restarts Redis. Run it only against the designated test stack, separately from checkpoint materializer integration tests. Active source is capped independently at 10 MiB; retained update payloads at 1 GiB. Browser state is capped at 2 MiB and outbox at 8 MiB/4096 entries per account/document generation. These quotas do not replace backups or disk monitoring. Phase 09 measurements and release limits are recorded in the linked reports; short local workloads are not sustained capacity evidence.

## Local observability and release checks

Set `GRAFANA_ADMIN_PASSWORD` and add `infra/compose/compose.observability.yaml` to the existing Compose command. With the private runner configured, also include `compose.observability-runner.yaml`. Metrics/OTLP remain private; Prometheus localhost:9090 and authenticated Grafana localhost:3001 are operator tools. The dashboard separates candidate/DB/hydration/queue/storage and runner stages. See observability definitions before interpreting percentiles.

```powershell
# Real local PostgreSQL/Compose and observability must already be healthy.
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
$env:CCE_LOAD_TESTS='1'
npm.cmd run test:load
npm.cmd run test:measurements
# Fault/queue suites run sequentially, separately from load measurements.
$env:CCE_E2E_RESTART='1'
$env:CCE_E2E_STORAGE_FAILURE='1'
$env:CCE_EXECUTION_TESTS='1'
# Also set the documented runner control token and immutable runtime image IDs.
npm.cmd run test:failure-demo
npm.cmd run test:jobs-death
npm.cmd run test:observability
npm.cmd run test:runner-measurements
npm.cmd run test:dashboard # with GRAFANA_ADMIN_PASSWORD configured
$env:CCE_BACKUP_TESTS='1'
npm.cmd run test:backup
```

New drill scripts fail for missing prerequisites and do not count skipped tests as passes. Backup briefly quiesces local writers and restores into uniquely named scratch resources, preserving source volumes. Private dumps/detailed output stay ignored in `.tmp`; JSON reports and synthetic actual-workspace screenshots live in `docs/measurements` and `docs/screenshots`. Read the claims ledger before using resume numbers. No production deployment, public sandbox, sustained scale, horizontal failover or optional Phase 10 feature is claimed.
