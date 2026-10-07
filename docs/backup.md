# Backup and recovery

Server receipts establish PostgreSQL commit, not off-host disaster recovery.
Logs, snapshots, sessions, metadata, job inputs/events and checkpoint cuts live
in PostgreSQL. Ready checkpoint file/manifest objects live in private MinIO/S3.
Redis and search projections are disposable; rebuilding projections still needs
valid retained history. Keep secrets/role provisioning separately and encrypted.

For a small local offline maintenance backup, stop API/TS/jobs/runner writers,
take a consistent custom-format `pg_dump`, then stop MinIO and copy its entire
volume with ownership/metadata intact. Restart MinIO before application
consumers. Never copy a running database data directory as a substitute for
`pg_dump`, and never remove/reset source volumes to test recovery. A ready
checkpoint's SQL reference and its verified immutable objects must both survive.
Copying a stopped MinIO volume is specific to this local storage topology;
deployment S3 backups require provider versioning/replication/retention.

For recovery, restore to an isolated PostgreSQL instance of a compatible pinned
version. Provision `cce_collab` and the worker login before restoring ACLs. Use
`pg_restore --exit-on-error`; verify all canonical migration stamps, constraints,
scoped append privileges and current generation pointers. Restore MinIO data to
a new isolated volume. Start private TS/API against only those recovered
endpoints and independent operator credentials. Verify snapshot/tail hashes and
contiguous sequences, independently reconstruct acknowledged text, download a
ready checkpoint through a currently authorized session, and exercise owner
restore into a fresh generation. Do not execute copied pending jobs during the
drill; expired/uncertain execution attempts require explicit user retry.

The reproducible local drill is `npm.cmd run test:backup` with explicit
`TEST_DATABASE_URL` and `CCE_BACKUP_TESTS=1`. It creates its own fixture, captures
a ready checkpoint, briefly quiesces source writers, dumps PostgreSQL and clones
the stopped MinIO volume into uniquely named scratch resources. It restores to
a scratch database/API/TS/MinIO stack, checks exact CRDT replay/download and
fresh-generation restore, then removes only its own scratch containers/volume/
network and restarts source services. Source data/volumes are preserved.
Private database dumps stay ignored in `.tmp/phase09-backup`; do not commit/share
them or treat local disk as off-host backup. See the actual drill result in the
status record; a script's existence is not passing recovery evidence.

For real operations choose and document RPO/RTO, encrypted off-host retention,
database PITR/WAL archiving, object backup/version policy, secret recovery,
restore ownership, monitoring and periodic drills. Those deployment behaviors,
host destruction, off-host retention and natural recovery times remain unverified.
Existing intentionally corrupt fixtures remain fail-closed; this drill must not
silently repair history or claim every retained fixture is healthy.
