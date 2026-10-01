# Current limitations

Phase 01 supports GitHub.com sign-in and private project/team access. Users cannot create files, edit, collaborate, save code, run code, restore checkpoints or search yet. The UI states that editing is unavailable. Login requires a configured GitHub OAuth App; only fixture provider login was tested here because no live credentials were supplied. An invited user who signs in from an invitation must reopen the invitation link after login.

The Phase 01 migration enforces owner membership/role and stores one-use OAuth flow state. Project, membership and invitation transactions now write PostgreSQL. Document append policy, parent-folder/cycle/path constraints, storage quotas, scoped worker functions, file-tree transactions and job leasing remain later-phase work. No service writes document contents yet.

Compose uses development-only database credentials and localhost HTTP. It is not a deployment setup. MinIO, runner, metrics and scaling services are intentionally absent until later phases. No performance, collaboration durability, failover or production capacity claim follows from this phase.

The PostgreSQL container ran both migrations and real API integration tests. Complete Compose startup was blocked by Docker Hub DNS while pulling Caddy and Redis, so container image builds and Caddy routing were not exercised. A local Next.js/Go same-origin smoke test passed. The TypeScript and Go framing tests cover the envelope and one durable ACK fixture; complete frame-body codecs are Phase 03 work. The optional Go race build could not compile with the installed 32-bit Windows C compiler.
