# Collaborative Code Editor

Phase 03 adds authenticated live Yjs editing to the project workspace. Edits currently live in collaboration-worker memory and are **not saved**. [The specification](PROJECT_SPEC.md) defines the intended release; [implementation status](docs/implementation-status.md) describes what is verified.

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

Open `http://localhost:3000` to sign in, create projects, organize files/folders, edit live with teammates, invite members, and manage roles. The workspace labels edits as pending because there is no durable update append or browser outbox yet. Refresh, tab close, disconnect, and worker restart can lose unsaved work. File creation needs the private collaboration process for empty Yjs state initialization. `GET /api/v1/healthz` reports Go process liveness. The private collaboration process responds at `/internal/healthz` inside its Docker network. `docker compose -f infra/compose/compose.yaml down` stops services without deleting the database volume. Migrations in `db/migrations` are applied automatically only when a fresh PostgreSQL volume is initialized; existing volumes require applying new migrations in order. To upgrade an existing local volume after Phase 01, run `docker compose -f infra/compose/compose.yaml exec -T postgres psql -U cce -d cce -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/0003_file_tree.sql` once.

Real PostgreSQL integration tests use an explicit test-only Compose override that publishes the database on localhost. In PowerShell:

```powershell
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.test.yaml up -d postgres
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
cd services/api
go test ./... -count=1
go vet ./...
```

For separate local processes, set `APP_ENV=development`, `DATABASE_URL`, `PUBLIC_ORIGIN=http://localhost:3000`, and GitHub credentials; then run `npm run dev:web`, `npm run dev:collab`, and `go run .` in `services/api`. Go calls `COLLAB_INTERNAL_ORIGIN` (default `http://127.0.0.1:8081`) with the shared `COLLAB_INTERNAL_TOKEN`; production requires an explicit token. The web development server rewrites `/api/v1/*` to Go. Use Caddy in Compose for the same-origin WebSocket route during development.

Frozen contracts live in `contracts/`; code boundaries and current limitations live in `docs/`. Do not treat reserved OpenAPI operations as implemented endpoints.
