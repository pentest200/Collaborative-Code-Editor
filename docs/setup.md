# Local setup and verification

Use repository lockfiles and the Go version in go.mod. The recorded Phase 09
host ran Node 22.15.0/npm 10.9.2, Go 1.27.1, Microsoft Edge 154.0.4258.53
and Docker Desktop Engine 29.7.2. See README for GitHub callback, environment
configuration, canonical migrations and separately pinned runtime builds.

From the repository root in PowerShell:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run check:contracts
docker compose -f infra/compose/compose.yaml config --quiet
docker compose -f infra/compose/compose.yaml up -d --build --wait
```

Configure GitHub credentials through the shell/Compose environment or the
Compose env file; merely creating an unrelated .env file does not configure a
running container. Register the exact localhost callback in README. Without
credentials, use acceptance fixtures for tests and report live login unverified.
Existing volumes need missing canonical migrations in order; never reset them.

For the designated local acceptance stack only, add compose.test.yaml for
localhost database/storage access. For metrics add compose.observability.yaml
and set GRAFANA_ADMIN_PASSWORD. Private execution additionally requires the
runner setup's token and immutable runtime image IDs, compose.runner.yaml and
compose.observability-runner.yaml. Use all selected overrides consistently:

```powershell
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.test.yaml -f infra/compose/compose.runner.yaml -f infra/compose/compose.observability.yaml -f infra/compose/compose.observability-runner.yaml config --quiet
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.test.yaml -f infra/compose/compose.runner.yaml -f infra/compose/compose.observability.yaml -f infra/compose/compose.observability-runner.yaml up -d --build --wait
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
$env:TEST_COLLAB_DATABASE_URL='postgres://cce_worker:cce_worker_dev_only@127.0.0.1:54329/cce?sslmode=disable'
npm.cmd run test
npm.cmd run test:workspace
```

Run isolated Go normal/race/vet integration with jobs and runner stopped, using
the real private PostgreSQL/TS/MinIO endpoints as described in README. Restore
both consumers afterward. Windows race compilation is blocked by this host's
C compiler; recorded Linux race success is separate evidence.

Run the opted-in failure suites from demonstration.md sequentially. Run
test:load and test:measurements separately from service interruption or queue
tests. The backup drill briefly stops source writers and MinIO and requires
CCE_BACKUP_TESTS=1; its scratch resources never replace source volumes.
Missing prerequisites/skips are not passed acceptance. Result JSON is published
under docs/measurements, and the status records scope and intermediate failures.

Application: localhost:3000. Operator Prometheus: localhost:9090. Grafana:
localhost:3001, cce_operator and the configured operator password. Test ports,
development credentials and private execution are not deployment settings.
See deployment.md for preparation and the actual release blockers.
