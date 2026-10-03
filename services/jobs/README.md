# Checkpoint worker

The `jobs` Compose service runs the Go API codebase with `JOBS_ONLY=true`.
It exposes no HTTP server and receives only the private PostgreSQL, TS authority
and MinIO endpoints. PostgreSQL checkpoints/outbox are the durable queue; Redis
is not involved. Captured and expired materializing claims are polled every second.
A five-minute claim and monotonic attempt fence bound crash recovery; each task
has a four-minute deadline. Failed tasks require an authenticated editor/owner
retry. UUID keys and exact captured inputs make repeated uploads idempotent.

The local bucket is private by default, with no anonymous policy or browser
credentials. Production provisioning must supply private S3 bucket credentials
and TLS storage endpoints; local root credentials are development fixtures.
