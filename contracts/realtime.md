# Realtime protocol v1 (frozen for Phase 00)

All browser endpoints share the web origin. `/ws/documents/{document_id}` carries binary document frames; `/ws/projects/{project_id}?after={event_sequence}` carries replayable metadata events. Go authenticates the cookie, verifies the exact Origin and current membership/generation, bounds frames and routes to one private TypeScript room owner. The worker accepts only a short lived, one use, signed internal assertion with issuer, audience, session, user, project, document, generation and gateway connection claims. Browser credentials and assertions never appear in query strings. A connection cannot change document scope.

## Binary envelope and types

Every WebSocket message contains exactly `version:uint8=1 | type:uint8 | payload_length:uint32 BE | payload`. Reject nonbinary messages, any length mismatch or trailing bytes, unknown versions/types, disallowed direction, invalid UTF-8/JSON, oversized payloads and malformed nested lengths before dispatch. `uint64` sequences are big endian and restricted to `0..9223372036854775807`; JSON carries them as canonical decimal strings. UUIDs are 16 raw bytes, SHA-256 hashes are 32 raw bytes. No normal edit frame contains whole source text in JSON.

| Type | ID | Direction | Body and maximum |
|---|---:|---|---|
| HELLO | 1 | server → client | Strict JSON `{protocol:1,file_id,document_id,generation,committed_sequence}`; 4 KiB. Generation is positive integer; sequence is decimal string. |
| SYNC_REQUEST | 2 | client → server | Raw Yjs state vector; 64 KiB. Read only: never apply client state as an update. |
| SYNC_STATE | 3 | server → client | `sequence:uint64, vector_length:uint32, vector, update_length:uint32, committed_state_update`; vector ≤64 KiB, update ≤2 MiB. Exact nested lengths. |
| DURABLE_UPDATE | 4 | client → server | `client_instance_uuid:16, message_uuid:16, SHA256(update):32, Yjs_update`; update 1..512 KiB. |
| UPDATE_COMMITTED | 5 | server → client peers | `sequence:uint64, client_instance_uuid:16, message_uuid:16, hash:32, committed_update`; update 1..512 KiB. |
| DURABLE_ACK | 6 | server → sender | `sequence:uint64, client_instance_uuid:16, message_uuid:16, hash:32`; exactly 72 bytes. |
| AWARENESS | 7 | both | y-protocols awareness update ≤2 KiB, with client ID bound to connection and server supplied identity; lossy. |
| ERROR | 8 | server → client | Strict JSON `{code,retryable,message?,client_instance_id?,message_id?}` ≤4 KiB; safe bounded message. |

Phase 04 loads a checksum-verified encoded snapshot plus its retained contiguous update tail. SYNC_STATE carries only committed state and its actual sequence. Identified DURABLE_UPDATE submissions produce UPDATE_COMMITTED and matching DURABLE_ACK only after transactional commit. The temporary Phase 03 type 9 is no longer accepted by either codec. See persistence.md for SQL privileges, ownership, snapshot publication and ambiguity handling.

Strict JSON means unique known keys only, required keys present, no duplicate keys, no prototype pollution keys, UUIDs in canonical lowercase form, and no extra values. HELLO's identifiers are lowercase UUID strings. Valid error codes: `AUTH_REQUIRED`, `FORBIDDEN`, `STALE_GENERATION`, `ROOM_MOVED`, `STORAGE_UNAVAILABLE`, `FRAME_INVALID`, `LIMIT_EXCEEDED`, `RATE_LIMITED`, `RECEIPT_MISMATCH`, `HEAD_CHANGED`. `ERROR` message is at most 256 UTF-8 bytes and contains no source or secrets.

## Receipt and sync semantics

Identity is `(document_id, client_instance_id, message_id)`, bound to authenticated actor and SHA-256 of exact update bytes. The database enforces unique identity and unique `(document_id, sequence)`. The same identity, actor and hash returns its original sequence/ACK; a different actor/hash is `RECEIPT_MISMATCH`. The document row counter allocates contiguous sequence inside the append transaction. Do not call `SYNC_STATE` or a WebSocket send a durability receipt. Send `DURABLE_ACK` and peer `UPDATE_COMMITTED` only after successful commit. Ambiguous commit results require receipt lookup or room reload. Server storage failure yields no ACK and no precommit broadcast. The browser retains an unacknowledged item with its original identity for replay. A delta larger than 512 KiB is retained/exported or replayed as identified smaller outbox entries; it is never truncated.

Room queue is FIFO, one active fenced owner per document. Candidate Yjs updates are applied to bounded isolated state and validated before append. Only root `Y.Text('content')` with plain string inserts is valid. Restored rooms load encoded snapshot plus contiguous log tail. The append transaction rechecks current session, role, active generation, project state, expected head and database-clock owner fence. Lease is 15 seconds, renewed every 5 seconds; failure stops writes. A gateway routes to the designated owner. One worker is configured in v1.

## Fixed initial limits

| Resource | Limit / response |
|---|---|
| Incoming update | 512 KiB encoded; `LIMIT_EXCEEDED` |
| State vector / encoded state | 64 KiB / 2 MiB; `LIMIT_EXCEEDED` |
| Plain UTF-8 text | 256 KiB; `LIMIT_EXCEEDED` |
| Awareness | 2 KiB, 10 events/sec/client; excess dropped or `RATE_LIMITED` |
| Client update rate | 25/sec + burst 50; 2 MiB/sec + burst 4 MiB; `RATE_LIMITED` |
| Room ingress | 100 updates/sec, FIFO 128 messages; `RATE_LIMITED` |
| Client send queue | 128 messages or 4 MiB; disconnect and resync |
| Local outbox | 8 MiB/account-document; stop sending and expose draft export |
| Project update log | 1 GiB; reject writes visibly before quota is exceeded |
| Candidate validation | 2 seconds wall time and 64 MiB worker heap budget; fail closed |
| Connected tabs / inactive models | 1 active document/tab, 4 inactive models/tab |
| Read revalidation | Every 2 seconds plus durable revocation event |

Limits are design ceilings and have not been load validated. Parser work is additionally bounded by exact envelope lengths before Yjs decode.

## Metadata stream

The project stream resumes at canonical decimal `after` sequence. Go reads durable `project_events` in sequence order; Redis can only hint that new rows exist. This server-only WebSocket carries JSON text objects `{type:"EVENT",sequence:"decimal",event_type:"string",payload:{...}}`. A gap, future `after`, or backlog exceeding 1,000 events sends `{type:"RESYNC_REQUIRED",tree_version:"decimal",event_sequence:"decimal"}` and closes; the client refetches. Authorization loss sends `{type:"ACCESS_CHANGED"}` and closes. Go rechecks the session, project and membership on every poll. A client does not publish metadata frames. Tree mutations require `If-Match` with a decimal tree version; a stale version returns typed HTTP 409 and current version. Redis loss cannot lose metadata events.
