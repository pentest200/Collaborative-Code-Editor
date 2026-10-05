# Project search (Phase 08)

`GET /api/v1/projects/{project_id}/search?q=...` requires a current application
session and current owner/editor/viewer membership. Queries are trimmed,
case-insensitive literal substrings of filenames or committed projected content.
They must contain 1–128 UTF-8 bytes and no control characters. Exactly one `q`
parameter is accepted; regex, SQL and HTML have no executable meaning.

The response is `{results, truncated, freshness}`. Results are ordered by current
filename then file UUID, capped at 50; an additional match sets `truncated`.
Each result includes project/file/document UUIDs, generation, current path,
nullable `indexed_sequence`, `current_sequence`, `stale`, `filename_match`, and
nullable plain-text `snippet` (at most 240 Unicode characters). Sequences are
canonical decimal strings. A filename match works before content is indexed;
its indexed sequence/snippet are null. Paths come from current SQL metadata.
Content results can lag committed edits. Opening a result opens the current
file, without applying old text or claiming the snippet is the live buffer.

The query uses a three-second deadline and READ COMMITTED transaction. It locks
project → current session → membership, reads current file identities, joins only
active current generations, and rechecks identity before emitting snippets.
Visibility locks remain held through response serialization. Removal/delete/
restore that commits before lock acquisition is observed or denied; responses
already delivered cannot be erased. Errors clear browser results. Metadata events
rerun an open search; explicit Refresh handles content changes without tree events.
Responses use no-store and React renders snippets as escaped text.

Canonical 0008 adds a coalesced PostgreSQL task per stable file. Triggers enqueue
on committed document-head changes and generation-pointer changes in the same
transaction. Existing active files are backfilled. No Redis notification is
needed. A revision advanced while a claim is running remains pending after that
cut completes. Jobs polls every second, at most 200 tasks per polling batch, with
one search reconstruction in flight. Claims use SKIP LOCKED, random UUIDs and a
45-second DB-clock lease; tasks have a 35-second deadline, failed tasks retain
pending revision with safe PROJECTION_FAILED and retry after five seconds.

The claim captures document/head and a snapshot at or before that head in one
statement snapshot. The token-protected private `/internal/search/materialize`
checks project/file/document/snapshot scope, checksum/vector, contiguous numeric
tail sequences and update hashes. It uses the existing isolated Yjs worker with
two-second/64 MiB old-heap limits, batches of 16 and a 30-second replay deadline.
Only a completed cut yields searchable text. The worker has no search-table write
or task-queue privileges. Go publication locks project → file → task, verifies live
claim/current generation and never moves a same-document projection backward.
A stale-generation claim completes only its captured revision and cannot remove
or overwrite a newer generation's projection. Failure never publishes partial text.

PostgreSQL text excludes NUL, although Yjs permits it. For such cuts the matching
projection substitutes an unqueryable control separator and `raw_content` retains
exact UTF-8 bytes. Snippets slice those original bytes by Unicode character position.
Queries cannot contain either control character, so normalization creates no
queryable false match or cross-NUL match. Both representations are disposable
versioned projections, never an authoritative file content store.

This is bounded PostgreSQL substring search over at most 200 project entries /
10 MiB current source. There is no regex language, relevance ranking, path search,
pagination, OpenSearch, freshness SLA or measured capacity claim. Old projections
and task rows remain retained; deleted/replaced source is filtered immediately by
current metadata even while indexing lags. Corrupt histories fail closed and need
operator repair. Production disk monitoring, backup and indexing latency under
sustained load remain release measurement/operations gates.
