# Observability

The optional local stack uses OpenTelemetry SDKs and an OTLP/HTTP collector,
Prometheus and a provisioned Grafana dashboard. Instrumentation is manual; no
automatic HTTP header/body, SQL argument, environment or exception capture is
enabled. [Implementation status](implementation-status.md) records actual checks.

```powershell
$env:GRAFANA_ADMIN_PASSWORD='choose-a-local-operator-password'
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.observability.yaml up -d --build
```

For an already configured private runner, also include `compose.runner.yaml` and
`compose.observability-runner.yaml` with the existing runner variables. Grafana
is localhost:3001, user `cce_operator`; Prometheus is localhost:9090. Application
metrics use separate private port 9091. The edge/public API do not serve metrics
or OTLP. The runner remains on execution-control; Prometheus can scrape that
network without placing the agent on the application data network. Restrict all
operator surfaces and use independent secrets in a real deployment.

| Measurement | Definition |
|---|---|
| `cce_operation_seconds` | Fixed operation/outcome histograms, including failures. Go SQL excludes statements/arguments. HTTP duration includes full WebSocket/SSE lifetime; it is not handshake latency. |
| `document.open`, `document.hydrate`, `document.sync` | Room acquisition/hydration/state response preparation. Client connect/sync additionally includes transport/admission. |
| `document.update`, `document.append`, `document.receipt` | Queued execution, DB append and duplicate-receipt lookup separately. End-to-end peer/ACK latency comes from the workloads. |
| `candidate.total`, `candidate.compute` | Isolated worker startup/validation/encoding total versus worker computation sample. Failures count in total; compute/heap are successful samples only. |
| `cce_candidate_heap_bytes` | Sampled isolated worker heap, not process RSS or peak allocation. |
| `cce_rooms`, `cce_connections` | Live room count; TS document peers; Go admitted document/project peers and pending worker handshakes. |
| `cce_room_queue_items/bytes`, `cce_room_state_bytes` | Aggregate room work queue and encoded live state, not per-room capacity or total memory. |
| `cce_ownership_total`, `cce_rejections_total` | Successful fenced acquisition; bounded typed policy/parser/storage/queue failures. Go gateway rejections appear in client workload counts; they are not all TS failures. |
| `cce_database_errors_total` | Failed Go queries, including policy denials; not exclusively infrastructure outages. |
| `cce_storage_bytes`, `cce_job_queue_items` | Five-second, two-second-deadline DB samples of retained update payload, physical database size and durable checkpoint/search/run backlog. Failed samples retain the last successful value. |
| `cce_runner_seconds` | Per-runtime startup (claim admission to Docker attach command start), attached runtime, Docker kill completion, cleanup, total attempt. Startup is not time to first user instruction. Runtime includes output transport; cleanup excludes terminal receipt retries. |
| `run.admission` | Creation to verified runner admission, including capture/materialization and queue wait. |

The dashboard separates stages, queues, process RSS, errors and storage. Alerts
are provisioned evaluation rules with deliberately conservative initial thresholds;
notification delivery is not configured or tested. A scrape-up target is process
reachability, not product readiness. Prometheus keeps at most seven days/512 MB.
`npm.cmd run test:dashboard` with `GRAFANA_ADMIN_PASSWORD` verifies the actual
authenticated provisioned dashboard and successful datasource queries, then
captures its screenshot. Connection/room and queue selectors preserve distinct
metric names instead of losing identically labeled right-hand `or` series.
The dashboard provider polls every thirty seconds. Its mounted file was correct
while the served dashboard remained stale during acceptance; Docker filesystem
watch limitations are a possible cause. Polling follows
[Grafana's provisioning guidance](https://grafana.com/docs/grafana/latest/administration/provisioning/).

OpenTelemetry correlates API to private TS HTTP/WS work, SQL within Go requests
and jobs, and jobs to TS reconstruction. A document connection carries a parent
trace context, not a per-message identity in the frozen application protocol.
Jobs start independent task traces; no durable browser-to-job trace ancestry is
promised. Runner stage metrics are separate; there is no runner trace exporter.
Only W3C trace context crosses services; baggage is never extracted. Ordinary
SDK root sampling defaults to 10%; the local measurement override uses 100%.
Export queues are bounded (2048 spans) and the collector is memory-limited.
Telemetry export failure must not decide whether an edit is saved.

Collector debug export provides local detailed span review in bounded rotated
logs (three 10 MB files). No long-term trace backend or Grafana trace search is
implemented. Spans contain fixed operation names/safe status codes and
`service.name`; no file/user/message labels, source, stdin, stdout, tokens,
cookies or invitation secrets. Sentinel tests inspect actual application/edge/
collector logs and metric series, as well as SDK exporter tests. Do not enable
automatic SQL/header/body instrumentation or unredacted exception exporters.

Set `sessionStorage['cce-measure']='1'` before opening the workspace to collect
local numeric timing samples in `window.cceMeasurements`. At most 2048 samples
per fixed name remain in memory, with no telemetry network endpoint. Rendering
is keydown to the second animation frame, a paint-opportunity approximation;
it does not measure physical display latency. ACK samples are send to matched
receipt/local acknowledgement handling, distinct from local retention. The
browser measurement test records these definitions and background-tab limits.

Primary integration references: [Go instrumentation](https://opentelemetry.io/docs/languages/go/instrumentation/),
[JS exporters](https://opentelemetry.io/docs/languages/js/exporters/) and
[Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/).
Histogram quantiles are bucket-based estimates; the load report explicitly uses
bucket upper bounds. See [Prometheus histograms](https://prometheus.io/docs/practices/histograms/).
`test:runner-measurements` records two actual cancellation/kill observations and
current-process cumulative stage quantiles; hydration uses a separate rate window.
New lazily created series can have no nonzero rate despite a first observation;
that missing estimate is not reported as measured zero latency.
