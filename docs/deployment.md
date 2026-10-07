# Deployment preparation

The verified environment is a local single-worker Docker Compose stack, with
optional authenticated private execution. No deployment was performed. This
document is an operator preparation guide; see the release gate and claims ledger
before describing any production service as ready.

Use the versions/lockfiles and canonical migrations in the repository. Build
web, API/jobs and TS authority together; configure one same-origin HTTPS/WSS
reverse proxy for web, `/api/v1/*`, `/ws/documents/*` and `/ws/projects/*`.
Set `APP_ENV=production`, an exact HTTPS `PUBLIC_ORIGIN`, exact GitHub callback,
identity-only OAuth credentials and an explicit private collaboration token.
Production uses Secure/HttpOnly application sessions and existing CSRF checks.
Development identity mode and execution-enabled production configuration are
rejected. Live GitHub OAuth still needs a credentialed acceptance run.

PostgreSQL is authoritative. Provision the metadata/API login and the separate
least-privilege worker login inheriting only `cce_collab`. Apply missing canonical
migrations in order, never reinstall/reset an existing database. Keep fsync and
synchronous_commit enabled. Persist database and MinIO/S3 artifacts separately;
monitor physical database/object growth as quotas exclude table/index/snapshot
overhead. Redis loss must not turn into code loss. The worker uses one static
route, 15-second fenced ownership and bounded reconnect; do not add randomly
balanced replicas. Horizontal owner routing is optional Phase 10.

Only the edge is application-public. Keep database, Redis, TS, storage/admin,
metrics, OTLP and runner control private. Do not publish the test override's
database/MinIO ports. Operator Prometheus/Grafana must require network access
control and separate credentials; localhost Compose bindings are not a remote
authentication solution. Keep SDK/collector payload capture restricted as
documented in observability.md.

Execution remains a designated private authenticated demo on a separate runner
host/process boundary. The current production configuration disables it. Only
the agent controls Docker; no application credentials reach it or user runtimes.
Use the exact prebuilt runtime image IDs and verify the host's resource controls.
Dedicated-host gVisor/microVM isolation and a separate gate are required before
public hostile execution. Do not expose an interactive shell/package installer.

Process liveness is `/api/v1/healthz` and private `/internal/healthz`. Queue
workers have no HTTP readiness route. Use actual DB access, healthy scrape
targets, a private two-user saved-edit check and a checkpoint download check for
operator validation; metrics alone cannot prove these guarantees. Existing
WebSockets may require forced reconnect during maintenance. API HTTP shutdown
and telemetry flush are bounded; complete hijacked-socket drain is not a tested
rolling-upgrade guarantee.

Before any release: exercise credentialed OAuth, exact WSS origin/CSRF behavior,
private-network reachability, backup restoration, monitoring/notification routing,
chosen resource/file limits and the full acceptance matrix on that environment.
Record versions, hardware and results rather than transplanting local latency
figures. Use [backup procedures](backup.md); local process-restart tests do not
establish recovery from host/volume loss.
