# Architecture (target and Phase 04 implementation)

The full design authority is `PROJECT_SPEC.md`. Browser traffic uses one origin: Caddy sends `/api/v1/*` and `/ws/*` to Go, and other routes to Next.js. Go owns public auth, metadata, authorization and WebSocket admission. A private TypeScript service owns Yjs decoding, candidate validation and fenced document rooms. PostgreSQL is authoritative for metadata and durable identified Yjs update logs/snapshots. Redis holds expendable hints. MinIO and a separate restricted runner enter in Phases 06 and 07. No hosted collaboration backend is part of this architecture.

Phase 02 added versioned file/folder CRUD and a Next.js Monaco workspace. Go locks the project row for each tree mutation, checks session/role/version, validates the resulting bounded tree, and writes metadata/events/outbox atomically in PostgreSQL. On file creation Go asks the private TypeScript service to construct an empty Yjs document state, then stores that state as a generation-one snapshot in the same transaction as file/document metadata. Phase 03 adds the Go document WebSocket gateway and a replayable project-event stream. Go validates Origin, session, active generation and membership before document upgrade, signs a 30-second scoped one-use assertion, and rechecks write access per update. The project stream reads ordered PostgreSQL events and rechecks membership; browsers refresh the tree/role on events. The private TypeScript worker verifies the document assertion and database scope, serializes room updates, validates candidate Yjs states in bounded worker threads, and broadcasts only committed updates. Monaco binds to Y.Text through y-monaco. Redis remains configured but is not used for authorization. Health responses remain process liveness. Phase 04 uses scoped SQL functions through a limited worker login. The append transaction rechecks current authorization, expected head and DB-clock ownership fence before storing identified bytes and incrementing the contiguous sequence. Room state remains encoded outside bounded Yjs worker threads; hydration restores verified snapshots and retained tails. Automatic snapshots and an account-independent server receipt log preserve committed edits across worker death. The browser tracks receipt identities in memory; account-scoped IndexedDB/reconnect remains Phase 05.

Source boundaries: `apps/web` for browser UI, `services/api` for Go public API/gateway, `services/collab` for private Yjs authority, `packages/protocol` for shared TypeScript framing and fixtures, `contracts` for public and internal contracts, `db/migrations` for canonical SQL, `infra/compose` for local reproducibility. Go frame decoding stays envelope only; it never interprets Yjs payloads.

## Development topology

```mermaid
flowchart LR
  Browser -->|localhost:3000| Edge[Caddy]
  Edge --> Web[Next.js]
  Edge --> API[Go API]
  API -->|signed document gateway and empty-state request| Collab[TypeScript Yjs service]
  API --> PostgreSQL
  Collab -->|fenced append, receipts, snapshots and replay| PostgreSQL
  API -. future hints .-> Redis
```

Dashed links describe planned integration. Local Docker credentials are development only and must be replaced before any deployment. `api` and `collab` are not published to the host by the base Compose file; Caddy is the sole host port. The test-only Compose override publishes PostgreSQL on localhost for integration tests. The initializer is protected by a shared internal token; document rooms use signed one-use scoped assertions. The worker has no direct table writes or session-token access. See contracts/persistence.md for privileges, snapshot cuts and ambiguity handling.
