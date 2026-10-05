# Phase 08 authorization and lifecycle review

Review scope: public REST routes, document and project WebSockets, scoped append/
snapshot SQL, invitation acceptance, checkpoint reads/download/preparation/restore,
run capture/cancel/output/control, internal assertions and browser logout/drafts.
This is a code review plus bounded real integration/browser regressions. It is
not a penetration test, sustained hostile-load proof or production release audit.

## Material triggers fixed

1. A session valid when a metadata transaction began could expire while that
   transaction waited for the project lock. `now()` retained the transaction-start
   timestamp and admitted a later operation. `lockActiveSession` now uses database
   `clock_timestamp()`. A real project-row barrier holds both search and tree-write
   requests until the seeded session expires; both deny without a mutation.
2. Invite acceptance had the same timestamp issue after acquiring the project
   lock. Expiry now uses database wall-clock time. A barrier holds acceptance
   through actual invite expiry, then verifies 409 and an unchanged use count.
3. A valid Yjs cut containing NUL cannot be inserted into a PostgreSQL text column.
   Exact bytes now accompany that disposable matching projection; search snippets
   preserve original text. A real append/reconstruct/publish/query regression
   covers NUL, Unicode and script-shaped source without execution.
4. Frame/room limits did not bound the number of public document/control sockets
   an authenticated actor could hold. Shared per-process admission now allows at
   most 1,024 total and 16 per actor, including worker handshakes. Excess upgrades
   receive 429 LIMIT_EXCEEDED and reservations are released on failure/close.
   Real project sockets fill one actor's budget, both endpoint types reject excess,
   and a teammate's socket plus HTTP search remain available. These are design
   ceilings, not measured capacity or multi-gateway global quotas.

## Boundaries reviewed and exercised

| Surface | Boundary / evidence |
|---|---|
| OAuth/session/CSRF/invites | One-use state/PKCE fixture, hashed HttpOnly sessions, origin+CSRF writes, bounded invite uses, production bypass refusal; existing real API auth suite and new expiry barriers. Live GitHub login remains unverified. |
| Tree/project/membership | Project-before-session-before-membership locks, current roles, stable identity/preconditions, constraints and durable events; tree/API regressions and new search revocation barrier. |
| Document sockets and append | Strict Origin and active document upgrade; signed scoped one-use worker assertion; raw viewer/revoked/stale-generation denial; commit-before-ACK/broadcast, contiguous receipts, current SQL role/generation/fence and expected head. TS raw/crash/ambiguity/corruption tests and browser fault regressions. |
| Reader/project sockets | Periodic DB revalidation and scoped replay, bounded frames/events/backlogs. The existing two-second reader revocation guarantee remains; it cannot erase delivered content. |
| Checkpoints/artifacts/restore | Current session/membership locked reads, project/file UUID keys, checksum/canonical manifest validation, ready-only reads, owner-only atomic replacement with previous cut and fresh generations; existing real checkpoint API and browser suites. |
| Run/output/private control | Immutable verified inputs, role checks and idempotency, current scoped output revalidation, claim/attempt receipts and terminal guards; existing run/API/browser/runtime suites. Only the execution agent mounts Docker; no token on the public listener. |
| Drafts/logout | Account/generation-scoped IndexedDB, exact outbox receipts, retained denied generations, explicit cross-tab logout/purge, transport/model disposal; existing recovery/privacy browser suite. |
| Search | Current membership and generation filters before snippets, project/session/membership read locks, claim/revision/sequence publication guards, exact-cut/hash validation, literal parameterized queries and escaped snippets; new Go/TS/browser acceptance. |

Lock order is project → session → membership → file → document → owner for
authenticated writes. Snapshot/acquire operations lock document then owner without
subsequently requesting project/session/membership. Search claim locks task alone;
its MVCC reads acquire no metadata row locks. Publication locks project → file →
task. Enqueue triggers run after the existing project/document transaction locks.
No reverse task→project lock is introduced. Publication and query recheck current
identity; metadata replacement never lets old tasks reactivate old documents.

Parser/candidate bounds were preserved: exact frame lengths and directions before
dispatch, 512 KiB updates, 64 KiB vectors, 2 MiB state, four isolated candidate
workers with two-second deadlines/64 MiB old heaps, four hydrations/256 resident
rooms, FIFO 128 operations/4 MiB and 100 operations/sec per room, 4 MiB slow-peer
buffer cutoff, lossy awareness and 30-second idle eviction. New search replay uses
these same workers sequentially, with bounded batches/deadlines; malformed/corrupt
replay fails and healthy work remains available in bounded tests. Sustained hostile
fairness, slow-client ceiling/resource enforcement at scale and queue latency
remain unmeasured. No capacity claim follows from these bounds.

Historical public execution, daemon/host failure, live OAuth, long outages,
browser retention/eviction, corrupted-snapshot repair, pruning, quota-scale replay,
storage backup/volume-loss and Windows race compilation gaps remain in
implementation-status.md and limitations.md. Search claim expiry is tested;
actual search-worker process death/takeover is not separately demonstrated.
