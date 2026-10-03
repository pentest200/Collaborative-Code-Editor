# Browser provider, drafts, awareness and undo (Phase 05)

`DocumentProvider` is an application adapter over public Yjs update/state-vector APIs and the frozen eight-frame codec. It does not patch provider internals. `y-monaco` 0.1.6 binds the single `content` text; PostgreSQL remains authoritative for committed source.

## Retention and receipts

IndexedDB database `cce-drafts-v1` stores one record per authenticated user/project/file/document UUID/generation. State bytes and identified outbox entries are changed in one strict-durability read/modify/write transaction. State merges preserve both tabs' CRDT identities; an ACK removes only the corresponding instance/message with its exact hash. A sync never clears pending entries or proves Saved. SHA-256/identity/update retention completes before a frame can be sent.

State is capped at 2 MiB, identified pending payloads plus frame identities at 8 MiB, and pending entries at 4096 per record. Browser quota/access failures abort the transaction, stop typing/sending, show Storage unavailable and offer the visible draft download. A burst awaiting browser storage is bounded separately at 128 updates/4 MiB. The last visible changes before transaction completion are not crash-proof. Browser eviction, clearing site data, private-profile lifetime and device loss are outside the retention guarantee. Retention is local to this browser profile, not a server backup.

Saving includes browser retention and awaiting server receipts. Offline — draft retained appears only after queued local retention finishes. Synced denotes committed state exchange with no fresh receipt claim; Saved requires matching receipts and no remaining pending work. Server storage failures expose Storage unavailable and retain/retry entries; browser storage failures stop retries until the document is reopened after storage is repaired. Download visible draft remains available in both cases. Recover drafts lists this account/project's retained generations, including removed files and frozen drafts.

## Reconnect and generation boundaries

Every reconnect fetches the current session, project role and file tree with no-store and five-second request deadlines, then uses a newly authenticated same-origin WebSocket. Retry delay starts near 300 ms, doubles to a 10-second base and uses 0.75–1.25 jitter. State exchange and receipt waits have ten-second deadlines. A worker death can delay admission until the actual 15-second owner lease expires.

A separate committed replica is synchronized before replay. Original outbox IDs/hash/bytes are replayed sequentially with approximately 40 ms send spacing. Lost ACKs close/reconnect and resolve the original receipt. Comparing both state-vector structs and delete-set coverage against committed state plus pending entries detects missing retained changes; a bounded reconciliation delta is identified and persisted before submission. Deltas over 512 KiB stop with retained state/export; bytes are never truncated.

Session expiration, role denial and deleted/replaced generations stop replay and freeze the record. Phase 06 restore uses a fresh document/generation key and project event to rebind connected clients. The adapter cannot move an old outbox to that key. Recover drafts exports the old generation separately. Phase 05's synthetic metadata tests established this boundary; Phase 06 adds actual checkpoint restore and offline reconnect acceptance.

## Account privacy and lifecycle

The workspace loads caches using the session's authenticated user ID, never a guessed account. Explicit logout broadcasts account shutdown, closes other tab transports, clears their visible bound text, and deletes that account's cached rows. A failed purge is surfaced with instructions to clear site data on a shared device. Expiration/revocation retain recoverable drafts rather than deleting them. Signing in as another account cannot load the previous account's keys. IndexedDB is not encrypted; use a separate browser profile on shared devices.

One document provider/model is active per workspace tab; inactive model cache size is zero (below the permitted four). On switching/closing, cursor/undo actions and listeners, decorations/style, binding, provider timers/socket/channel, awareness, model and subscriptions are disposed. Already queued local retention drains before the IDB handle closes; transport sends cease immediately. Monaco itself remains one instance while switching files.

## Awareness and selective undo

The AWARENESS body is one y-protocols record per incoming message, with a connection-bound uint32 client ID and clock. Only `selection` is accepted: null or `{anchor,head}` relative positions targeting named root `content`, with bounded client/clock identities and association -1/0/1. User/display/role fields and another connection's ID are rejected. Initial clock is at most 1,000,000, increases at most 1,000 per message, and cannot reach uint32 overflow. Stale clocks are ignored. The service enriches the state with `{user:{id,name,color}}` read from authenticated database metadata; the limited worker login has only `users(id,display_name)` access.

Awareness is scoped to a document room, capped at 2 KiB and ten messages/sec with burst ten. It is dropped when a send buffer exceeds 64 KiB, not queued behind source. y-protocols refreshes active local states; the service removes stale states after 30 seconds (on the two-second reader timer) and emits removal on disconnect. Client reconnect clears old remote awareness. Redis has no awareness authority and is not required for document, event or cursor delivery in this single-worker implementation.

The pinned y-monaco source transacts local model changes with the binding instance as origin. `Y.UndoManager` tracks only that instance plus its own undo origin; remote/cache/sync origins are excluded. Monaco Undo/Redo actions and Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y invoke that manager. Undo history is per active binding and resets on file close/switch/reload. Application-owned relative selection listeners/rendering avoid y-monaco 0.1.6's undisposed awareness selection callback, without modifying library internals.

References: [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager), [Awareness](https://docs.yjs.dev/api/about-awareness), [pinned y-monaco source](https://github.com/yjs/y-monaco/blob/v0.1.6/src/y-monaco.js).
