# Reproducible four-minute demonstration

Use the designated local Compose stack and private runtime setup from README
and services/runner/README.md. Two independent authenticated accounts and a
viewer belong to one project; load `main.js` with a simple bounded console
program. Live GitHub login needs configured credentials; automated acceptance
uses independently seeded sessions and is not evidence of live provider login.
Create one ready named checkpoint before recording. All actors use separate
browser profiles/contexts. Show real Saved/Output/version states, not scripted
fake messages. Keep code simple enough that it can be read while explaining.

| Time | Demonstration and narration |
|---|---|
| 0:00–0:40 | Open the same file as owner/editor. Type on the same line, point to authenticated cursors and identical content. Explain integrated Yjs relative positions; wait for Saved receipts. |
| 0:40–1:00 | Owner makes one local edit, editor types separately, owner uses Ctrl+Z. Peer work remains. Undo is local and history belongs to the current binding. |
| 1:00–1:35 | Disconnect owner transport, edit locally until Offline — draft retained, edit as peer, reconnect. Show Saving then Saved and both texts. Browser retention and server receipts are separate. |
| 1:35–2:00 | Kill/restart only the local collaboration worker; show recovery after its fenced 15-second lease and jittered retry. Previously acknowledged text rehydrates from snapshots/tail. |
| 2:00–2:20 | Viewer sends a raw identified mutating frame; show server FORBIDDEN and unchanged durable head. Read-only Monaco alone is not the policy boundary. |
| 2:20–3:00 | Keep an owner's old tab offline with a retained draft. Restore the ready checkpoint as owner elsewhere. Reconnect old tab; show Version replaced/deleted and export its separate draft. |
| 3:00–3:35 | Start a bounded run after draining receipts; keep peer typing. Output shows the exact immutable checkpoint and earlier captured source, not the later edit. |
| 3:35–4:00 | Run `while (true) {}` in the designated JavaScript template. Show real timed_out and bounded cleanup. State that this is private shared-kernel execution, with no public hostile-code claim. |

Screenshots live in docs/screenshots and are generated from the real workspace
by `test:measurements`, with no fabricated output. Existing checkpoint/run suites
also generate local screenshots of actual immutable-cut UI states.

The automated reproducibility companion runs the same guarantees with controlled
fixtures, raw clients and actual service termination (it takes longer than the
spoken demonstration):

```powershell
$env:TEST_DATABASE_URL='postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
$env:CCE_E2E_RESTART='1'
$env:CCE_E2E_STORAGE_FAILURE='1'
$env:CCE_EXECUTION_TESTS='1'
# Also set the documented runner control token and exact prebuilt runtime IDs.
npm.cmd run test:failure-demo
npm.cmd run test:jobs-death
npm.cmd run test:measurements
```

The runner death/lease/resource suite is bounded and opt-in. Failure-demo refuses
missing prerequisites and any skipped child suite; it writes command/count/time
evidence to docs/measurements, with local detailed output in .tmp. Jobs-death uses
fixture-scoped DB publication barriers and actual SIGKILL, then accelerates
claim expiry; it does not measure the natural checkpoint/search lease delay.
Do not run fault suites concurrently with Go queue or load measurements. The
four-minute table is a recording/runbook script, not a claim that a video has
been recorded or that every real GitHub account flow is credentialed.
