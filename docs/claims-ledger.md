# Claims ledger

Claims must match the final evidence in implementation-status.md and
docs/measurements. Passing a mock layout check cannot establish persistence or
authorization. Failed/skipped/blocked invocations remain recorded.

| Claim | Implementation | Evidence | Permitted scope |
|---|---|---|---|
| Concurrent editing integrates Yjs/Monaco | Provider/binding; fenced TS rooms | Real realtime/recovery suites; load independently checks replicas against DB | Bounded local functional cases; credit Yjs, no invented algorithm |
| Edits reported Saved are durable | Identified outbox, append transaction and matching receipts | TS process-death/ambiguous-commit tests; raw load contiguous rows/hash/receipt comparison | Acknowledged DB commits; not browser pre-transaction/device loss |
| Server enforces viewer/revocation/generation policies | Go/auth; private assertions; scoped SQL append | Raw viewer tests; real DB lock barriers; checkpoint/offline tests | Commit ordering and bounded two-second readers, not instant source erasure |
| Shared cursors and selective local undo | Authenticated awareness/relative positions; binding-origin undo | Raw awareness and independent browser recovery | Ephemeral; undo resets on switching/reload |
| Restorable immutable project checkpoints | SQL cut, TS reconstruction, MinIO checksums and fresh generations | Checkpoint API/UI races; passing jobs-death and isolated backup drills | Exact committed cuts; incomplete materialization stays unavailable |
| Restricted Python/JS execution | Separate agent, immutable templates, cgroups/seccomp/output/leases | Execution/resource/crash suite and receipt/cut/SSE browser suite | Designated authenticated private demo; no public hostile-code claim |
| Authorized version-aware project search | Durable PostgreSQL tasks/projections and current visibility | Search integration/UI lag/delete/restore/revocation checks | Eventual literal substring search; no freshness SLA/ranking |
| Redacted metrics and traces | Manual SDK/client hooks, private listeners, collector/Grafana | SDK sentinel tests and live source/stdin/stdout/cookie/invite sentinels; scrape/correlation checks | Fixed labels, local sampled spans; no long-term trace backend or notification service |
| Measured 5-editor and expanded-room behavior | Reproducible seeded raw workload and numeric browser samples | phase09-load/browser JSON and measured-release.md | State tested file size/rate/duration/rejections; not sustained capacity/SLO |
| Backup recovery | Consistent dump, cold artifact-volume clone, isolated restore drill | Passing phase09-backup JSON: exact replay, authorized artifact download and fresh-generation restore | Local quiesced recovery; no off-host retention/PITR/host-loss/RPO/RTO claim |
| GitHub OAuth works with fixtures | State/PKCE/exchange/session implementation | OAuth provider fixtures and PostgreSQL integration | Live GitHub credentials are still an unverified release gate |
| Multi-worker/Kafka/OpenSearch/Kubernetes | Optional Phase 10 | None | No implementation, scale or deployment claim |

Resume wording in interview.md is a draft for the implemented bounded features.
Never remove the private execution qualifier or add sustained scale claims from
short tests. Overall portfolio/deployment readiness is a separate conclusion in
implementation status, not an inference from the number of implemented phases.
