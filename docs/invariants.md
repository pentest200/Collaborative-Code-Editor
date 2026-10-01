# Invariants and phase gates

1. PostgreSQL owns durable document updates, metadata, sessions, memberships, project events and jobs. Redis/presence/search are disposable. Source text for search/export/run is materialized from an explicit committed Yjs cut.
2. A file UUID survives rename/move. One immutable document UUID and generation identify one Y.Doc with one plain Y.Text named `content`. Restore uses a fresh generation; deleted/old-generation updates cannot be merged into a replacement.
3. Project metadata changes have tree-version preconditions, SQL constraints and durable replayable event sequences. The root sibling uniqueness constraint uses `NULLS NOT DISTINCT`.
4. All content mutation routes, including reconnect deltas, require current editor/owner authorization. Viewer UI restrictions alone are insufficient. Appends verify session, role, generation, project state, document head and owner fence in the commit transaction.
5. A room validates an update on a bounded isolated candidate. It neither mutates committed memory nor broadcasts nor issues `DURABLE_ACK` before the database commit. Identical receipt identity returns original sequence; changed actor/hash conflicts. Ambiguous commits resolve by receipt lookup/reload.
6. `SYNC_STATE` means only synchronization. `Saved` requires receipts for every current local outbox item. Browser drafts use account/project/file/generation scope and retain rejected old-generation items for export.
7. Awareness is ephemeral and server identity derived; local undo tracks local origins. Slow clients reconnect instead of building unlimited queues.
8. Checkpoints capture one consistent metadata/document cut. Run jobs use ready, verified immutable input. Runner has no application secrets or general project access.
9. Logs and traces omit source, stdin/stdout, tokens, cookies and invite secrets. Product claims require corresponding implementation and evidence.

These are target invariants frozen in Phase 00. Their behavioral enforcement belongs to later phases; `docs/implementation-status.md` records which guarantees actually exist.
