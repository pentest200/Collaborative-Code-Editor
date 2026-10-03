# Collaborative Code Editor

Phase 04 adds PostgreSQL-backed edit receipts, automatic Yjs snapshots, fenced room ownership and recovery of committed edits after worker restart. Browser drafts and automatic reconnect are still unfinished. [The specification](PROJECT_SPEC.md) defines the intended release; [implementation status](docs/implementation-status.md) describes what is verified.

## Development

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
cd services/api && go test ./... && go vet ./...
docker compose -f infra/compose/compose.yaml config
docker compose -f infra/compose/compose.yaml up --build
```

Open `http://localhost:3000` to sign in, create projects, organize files/folders, edit live with teammates, invite members, and manage roles. The workspace shows Synced after committed-state exchange, Saving while local identities await receipts, and Saved only after all matching receipts arrive. Server-acknowledged edits survive worker restart. Unacknowledged edits have no browser outbox, export or automatic reconnect yet and can be lost on tab close/reload; keep the tab open. After a worker dies, reload once its 15-second ownership lease has expired. File creation needs the private collaboration process for empty Yjs state initialization. `GET /api/v1/healthz` reports Go process liveness. The private collaboration process responds at `/internal/healthz` inside its Docker network. `docker compose -f infra/compose/compose.yaml down` stops services without deleting the database volume. Migrations in `db/migrations` are applied automatically only when a fresh PostgreSQL volume is initialized; existing volumes require applying new migrations in order. Migrations are mounted at `/canonical-migrations`. An existing Phase 03 volume needs `0004_document_durability.sql` and the local worker login provisioned once:

```sh
docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /canonical-migrations/0004_document_durability.sql
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

For separate local processes, set `APP_ENV=development`, `PUBLIC_ORIGIN=http://localhost:3000`, and GitHub credentials. Give Go its metadata/database login, and give the collaboration process a separate `DATABASE_URL` for the restricted worker login; then run `npm run dev:web`, `npm run dev:collab`, and `go run .` in `services/api`. Go calls `COLLAB_INTERNAL_ORIGIN` (default `http://127.0.0.1:8081`) with the shared `COLLAB_INTERNAL_TOKEN`; production requires an explicit token. The web development server rewrites `/api/v1/*` to Go. Use Caddy in Compose for the same-origin WebSocket route during development.

Frozen contracts live in `contracts/`; code boundaries and current limitations live in `docs/`. Do not treat reserved OpenAPI operations as implemented endpoints.

The raw acceptance suite kills real test subprocesses at database/commit/snapshot/renewal barriers. Run the full-stack two-account worker-restart and storage-failure demonstration only against the designated local test Compose stack (it kills its `collab` service and terminates a scoped blocked database connection):

```powershell
$env:CCE_E2E_RESTART='1'
$env:CCE_E2E_STORAGE_FAILURE='1'
npm.cmd run test:realtime
```

These tests use seeded authenticated sessions rather than live GitHub credentials. Active project source is capped independently at 10 MiB; retained update payloads at 1 GiB. These quotas do not replace backups or disk monitoring. Cursors, offline draft recovery, selective undo, checkpoints, runs and search remain later phases.
