# Checkpoint capture, artifacts and restore (Phase 06)

Go owns all public `/api/v1/projects/{project_id}/checkpoints` operations.
Current session, active project and membership are checked for every list,
manifest and file request. Owner/editor can capture and retry; all current
members can preview/download; only the current owner can restore. Mutations
require same-origin Origin and CSRF. Downloads are authenticated API responses,
never public bucket objects or presigned links. Lists return the latest 100
checkpoints in descending creation/UUID order, including incomplete states.

Capture takes one PostgreSQL REPEATABLE READ transaction and the project lock
shared by append/tree operations. It persists the complete active tree (folders
included), tree version and each file's immutable document UUID, committed head,
selected snapshot UUID/through sequence/checksum. The selected snapshot is never
beyond the cut. Snapshot bytes and contiguous update rows through the cut remain
retained in v1. Capture and the `checkpoint.materialize` outbox/job commit together.
Capture includes committed server state, never a browser's unreceipted outbox.

The private TS endpoint `POST /internal/checkpoints/materialize` accepts only
project/checkpoint/file UUIDs with the shared internal token. Its restricted DB
login has SELECT on captured input references, not metadata writes or storage
credentials. It verifies snapshot identity/sequence/hash/vector and the contiguous
hash-verified tail, replaying batches of at most 16 updates in the existing bounded
Yjs workers. Only the completed captured cut is projected to plain text. Live
room candidates keep encoded state, without a retained text projection.

The separate Go `jobs` process claims captured/expired materializing rows using
SKIP LOCKED, a monotonic attempt fence and five-minute DB-clock lease. Each task
has a four-minute deadline; polling is one second. No Redis dependency. A crash
or ambiguous database result leaves durable work for lease takeover. An explicit
failed state requires owner/editor `POST .../{checkpoint_id}/retry` (202); only
failed checkpoints can be retried. Attempt fencing prevents stale ready/failed
publication. Every transition records an outbox lifecycle event in its transaction.

Private object keys are `projects/{project_uuid}/checkpoints/{checkpoint_uuid}/files/{file_uuid}`
and `.../manifest.json`; source paths never become storage keys. File objects are
exact UTF-8 text, SHA-256 checked after upload/readback. The `cce-checkpoint-v1`
canonical manifest is compact JSON with the fixed field order defined by
`CheckpointManifest`/`CheckpointFile` in Go, no insignificant whitespace, Go JSON
string escaping, UTC RFC3339Nano capture time and UUID-sorted tree/file arrays.
It includes name, creator, project/checkpoint IDs, captured tree/version, paths,
languages, document IDs, decimal committed/snapshot sequences, input references,
UUID artifact keys, hex checksums and byte lengths. Its SHA-256 is stored in
PostgreSQL. Readers verify both checksum and exact canonical bytes reconstructed
from captured DB metadata; file reads additionally enforce the expected scoped
UUID key, checksum, length, UTF-8 validity and 256 KiB bound.

States are `captured → materializing → ready | failed`; object storage/database
are not globally atomic. Readback succeeds for every file and the manifest before
one fenced transaction publishes all artifact metadata, ready state and outbox
completion. Partial uploads remain private and cannot be previewed/restored.
Retries reconstruct the original cut and write identical keys/bytes. Failed DB
completion either records failure or leaves an expiring claim; it never claims ready.

`GET .../{checkpoint_id}` returns a verified ready manifest (incomplete = 409
CHECKPOINT_NOT_READY); `GET .../{checkpoint_id}/files/{file_id}` returns verified
UTF-8 attachment text. Scope mismatches/missing membership are 404, expired session
401, denied mutations 403, verification/storage failures 503. Neither response
loads a snapshot as live editor authority.

Restore requires decimal `If-Match` (missing/malformed = 428, stale = 409 with
current_version). It verifies ready target scope/manifest/all file bytes under
owner access, then prepares fresh Yjs identities through authenticated private
`POST /internal/checkpoints/prepare` with `{text}`. That endpoint uses the existing
two-second/64 MiB old plus 8 MiB young/four-concurrent-worker limits and the
256 KiB UTF-8/2 MiB state/64 KiB vector caps. It never copies captured CRDT structs.
Preparation failure leaves all current metadata untouched.

After preparation Go rechecks current owner/session/tree version under the project
lock in a REPEATABLE READ replacement transaction. An edit that commits during
preparation is included in the previous-state checkpoint. A concurrent tree
mutation produces a version conflict. The transaction captures the actual latest
previous tree/document cuts and durable materialization job, tombstones current
entries, restores captured stable file IDs/metadata, and assigns fresh document
UUIDs with current generation + 1, snapshot zero and accurate source-size accounting.
It increments the tree version and emits `project_restored` in project_events plus
project.tree outbox, carrying target and previous checkpoint IDs. All effects
commit together; replacement failure rolls them back. The previous checkpoint is
durably captured before replacement and becomes previewable after its independent
materializer succeeds. Retained inputs make it recoverable even if uploads fail.
An ambiguous restore response requires refreshing tree/version before retrying.

Project events refresh connected clients' tree and rebind their existing active
file to its new document/generation. Append/receipt SQL serializes against the
same project lock and rejects all retired generation frames. Queued/offline drafts
stay under their old account/project/file/document/generation key, freeze on
reconnect/rebinding, and remain downloadable separately through Recover drafts.
No old outbox is replayed into restored text. Undo history resets on rebind.

MinIO is built from official release source pinned to
`07c3a429bfed433e49018cb0f78a52145d4bedeb` because the former official container
registries rejected image pulls. Base Compose keeps storage and its console on
the private network, with a persistent artifact volume and no anonymous policy.
The test override exposes only localhost:9000 for acceptance. Development storage
credentials are fixtures; production supplies private S3 credentials and endpoint.
Source reference: [official release](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z).
