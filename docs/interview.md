# Interview notes and resume claims

The project integrates Yjs; it does not invent a CRDT algorithm. WebSockets move
binary updates, Yjs resolves concurrent content, PostgreSQL authorizes and durably
receipts identified inputs, and Monaco renders/binds the editing model. A Yjs
sync response exchanges committed state; it cannot establish that an unsent
browser edit was saved. IndexedDB and the server have separate retention steps.

Go owns authentication/metadata and scopes the gateway. TypeScript validates
Yjs in bounded isolated candidates; append must commit before authoritative
replacement, broadcast or ACK. SQL locks make role removal/delete/restore and
append have a commit order. Unique identities return the original receipt on
replay; mismatching hashes conflict. Ambiguous commit responses are resolved
through receipts/reload, never by assuming failure or appending blindly.

One fenced document owner serializes room work. DB-clock lease expiry and a
new fencing token prevent a stale worker from appending. A random load balancer
does not implement that rule. Snapshot + numeric tail replay preserves CRDT
identities. Plain exported text cannot resume the same history. Restore uses
fresh document generations so an offline old tab cannot merge into replacement
history. Stable file IDs preserve rooms across rename.

Awareness is ephemeral and server-enriched; publishing another client's cursor
is rejected. Undo tracks the pinned Monaco binding origin, excluding remote
provider updates; history resets on switching/reload. File tree transactions
use explicit versions and replayable metadata events, not a second CRDT tree.

Checkpoints capture a repeatable-read tree/head cut before asynchronous
materialization. Object upload and SQL publication are not globally atomic;
checksums, deterministic UUID keys, statuses and claim fencing make incomplete
work retryable. Run drains the initiating user's retained active/closed-file
outboxes before capture, verifies ready immutable source and shows its checkpoint.
Docker limits are measured on a designated host; shared-kernel risk remains.
Search is an authorized versioned projection, never source of truth.

Explain the measured report's typing rate, duration, document sizes, sample counts,
latency definitions, rejections/retries and exact convergence/receipt checks.
The short workloads are not sustained capacity or production SLO evidence. Do
not equate worker heap, encoded state size and whole-process RSS. Telemetry
labels are fixed; source/stdin/stdout/credentials belong outside global logs.

Draft bullets, subject to the [claims ledger](claims-ledger.md) and release gate:

- Built a multi-user Monaco workspace integrating Yjs with authenticated cursors,
  owner/editor/viewer roles and browser-retained reconnect drafts.
- Implemented PostgreSQL durable edit receipts, fenced room ownership,
  snapshot/tail recovery and generation-safe checkpoint restoration.
- Added verified immutable Python/JavaScript runs in a restricted private Docker
  environment, version-aware search and redacted metrics/traces.

Only add latency/concurrency numbers with the report's local environment,
duration and failure scope. No public sandbox, horizontal scale, Kafka,
OpenSearch, Kubernetes, invented algorithm or production-readiness bullet is
supported. Live provider OAuth and off-host disaster recovery need separate
verification before those release claims can be made.
