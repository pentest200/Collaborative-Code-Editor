# Implementation status — Phase 01

| Area | Status | Evidence / next gate |
|---|---|---|
| Monorepo and source specification | Implemented | npm workspaces, pinned lockfiles and Go module; original specification retained byte-for-byte |
| GitHub.com OAuth | Implemented and integration tested | One-use database state, PKCE S256, exact callback, server-side code exchange, minimal public identity, provider token discarded. Fake provider fixtures passed; live GitHub credentials were not supplied |
| Sessions and CSRF | Implemented and integration tested | Hashed session tokens, seven-day expiry, logout revocation, HttpOnly/SameSite cookies and production Secure setting; same-origin and CSRF header checks |
| Projects, roles and invitations | Implemented and integration tested | Create/list/read/delete, owner/editor/viewer memberships, owner-only changes, hashed bounded invitations, expiry/use race, revocation, durable membership events and owner-role SQL constraint |
| Frontend | Implemented and built | Sign-in availability reflects API configuration; project list/create, team management and invitation acceptance views. Production build and same-origin HTTP smoke passed; no interactive browser suite yet |
| TypeScript collaboration service | Phase 00 foundation | Private `/internal/healthz` process liveness only; no Yjs rooms yet |
| PostgreSQL/Redis/Compose | Partial runtime verification | PostgreSQL 18.6 container applied both migrations and passed integration tests. Full stack image pulls failed because Docker Hub DNS could not resolve Caddy/Redis; `docker compose config` passed |
| Tree, Monaco, realtime collaboration, receipts, drafts, checkpoints, runs, search | Unfinished | Phases 02–08 |
| Observability, load/failure proof and production release | Unfinished | Phase 09 |

Verification: `go test ./... -count=3` with `TEST_DATABASE_URL` passed against real PostgreSQL, as did `go vet ./...`, npm typecheck/lint/test/build, contract parsing, Compose static validation, and local web/API HTTP smoke. Go's optional `-race` build failed because the installed Windows C compiler lacks 64-bit support; it did not reach the tests. The full Compose stack remains unverified because Docker Hub image authentication DNS failed twice. No production GitHub account or credentials were used. Phase 02 implementation can begin; full container smoke should be repeated when image pulls work.
