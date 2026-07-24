# Pi Subagent OpenTelemetry

The subagent extension can emit metadata-only traces, metrics, and structured logs through OTLP/HTTP. Telemetry is disabled by default and does not reuse Pi's unrelated `PI_TELEMETRY` setting.

## Install

Install runtime dependencies beside the extension entrypoint:

```bash
npm install --prefix subagent
```

For a copied extension, run `npm install` inside the copied `subagent/` directory. Reload Pi after installing.

## Quick start

1. Start an OpenTelemetry Collector using [`../observability/otel-collector.yaml`](../observability/otel-collector.yaml).
2. Set `JAEGER_OTLP_ENDPOINT` for the collector, for example `localhost:4317`.
3. Configure Prometheus to scrape the collector's `:8889/metrics` endpoint.
4. Enable the extension exporter:

```bash
export PI_SUBAGENT_OTEL_ENABLED=1
export PI_SUBAGENT_OTEL_ENDPOINT=http://127.0.0.1:4318
pi
```

5. Inspect `/subagents telemetry` in Pi.
6. Search Jaeger for service `pi-subagent-extension` and use the `analyze_subagent_telemetry` tool for a bounded summary.

The repository intentionally does not bundle Jaeger, Prometheus, Grafana, Loki, or Docker Compose.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_SUBAGENT_OTEL_ENABLED` | `0` | Explicitly enable telemetry |
| `PI_SUBAGENT_OTEL_ENDPOINT` | `http://127.0.0.1:4318` | OTLP/HTTP base endpoint |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | derived | Optional final trace endpoint |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | derived | Optional final metric endpoint |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | derived | Optional final log endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Shared comma-delimited exporter headers |
| `OTEL_EXPORTER_OTLP_*_HEADERS` | shared headers | Per-signal exporter headers |
| `PI_SUBAGENT_OTEL_SERVICE_NAME` | `pi-subagent-extension` | OTel service name |
| `PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO` | `1.0` | Root trace sampling ratio from 0 through 1 |
| `PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS` | `10000` | Metric export interval, 1–300 seconds |
| `PI_SUBAGENT_OTEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `PI_SUBAGENT_OTEL_ALLOW_REMOTE` | `0` | Permit explicitly configured remote HTTPS endpoints |
| `PI_SUBAGENT_PROMETHEUS_URL` | `http://127.0.0.1:9090` | Read-only analysis endpoint |
| `PI_SUBAGENT_JAEGER_URL` | `http://127.0.0.1:16686` | Read-only Jaeger query/UI endpoint |
| `PI_SUBAGENT_OTEL_QUERY_HEADERS` | unset | JSON object of read-only query headers |

Per-signal endpoint variables take precedence over the Pi-specific base endpoint, followed by standard `OTEL_EXPORTER_OTLP_ENDPOINT`, then the loopback default. `/v1/traces`, `/v1/metrics`, and `/v1/logs` are appended only to base endpoints.

Loopback HTTP is accepted. Non-loopback endpoints require both HTTPS and `PI_SUBAGENT_OTEL_ALLOW_REMOTE=1`. URL credentials are rejected; use headers. Header values are never displayed or persisted.

Invalid requested telemetry configuration fails closed and leaves agent work operational.

## Signals

### Trace hierarchy

```text
pi.subagent.session
├── pi.subagent.batch
│   └── pi.subagent.process
│       └── pi.subagent.turn
│           ├── pi.subagent.rpc
│           └── pi.subagent.tool
└── pi.subagent.process
    └── pi.subagent.turn
        └── pi.subagent.context_recovery
```

Useful Jaeger searches:

- Service: `pi-subagent-extension`
- Operation: `pi.subagent.process`, `pi.subagent.turn`, or `pi.subagent.context_recovery`
- Tag: `outcome=failed`, `outcome=timeout`, or `error_category=context_window`
- Tag: `complexity_tier=critical` or `routing_mode=auto`

### Metric catalog

Prometheus normalizes OTel dots to underscores, counters to `_total`, and time histograms to `_seconds`. Exact unit suffix behavior can differ by collector version; inspect `:8889/metrics` after upgrading the collector.

| OTel metric | Purpose |
|---|---|
| `pi.subagent.agent.started` | Started turns/workers |
| `pi.subagent.agent.completed` | Outcomes by model/routing metadata |
| `pi.subagent.agent.duration` | Completed turn duration |
| `pi.subagent.agent.queue.duration` | Queue latency |
| `pi.subagent.agent.startup.duration` | Process startup latency |
| `pi.subagent.agent.first_progress.duration` | Time to first model text |
| `pi.subagent.agent.active` | Current agent states |
| `pi.subagent.process.active` | Spawned child processes |
| `pi.subagent.queue.depth` | Current queue depth |
| `pi.subagent.rpc.requests` / `.duration` | RPC reliability and latency |
| `pi.subagent.tool.executions` / `.duration` | Child tool reliability and latency |
| `pi.subagent.output.size` | Output characters |
| `pi.subagent.tokens` | Input/output/cache token deltas |
| `pi.subagent.cost` | Provider-reported cost in USD |
| `pi.subagent.context_recovery` | Compaction/overflow/timeout recovery |
| `pi.subagent.messages` | Steering and follow-up delivery |
| `pi.subagent.batch.jobs` / `.items` / `.duration` | Batch lifecycle |
| `pi.subagent.telemetry.export.errors` | Export failures |
| `pi.subagent.telemetry.dropped` | Records dropped after failed exports |

## Fixed analysis query catalog

`analyze_subagent_telemetry` accepts only a time window, focus, comparison flag, and trace count. It does not accept URLs, PromQL, service names, or Jaeger tag expressions.

Current query IDs:

- Reliability: `completed_total`, `success_rate`, `timeout_lost_rate`, `rpc_failure_rate`, `recovery_success_rate`
- Cost: `cost_total`, `tokens_total`, `cost_per_success`
- UX: `agent_duration_p95`, `queue_duration_p95`, `first_progress_p95`, `steering_delivery_rate`

Example direct PromQL:

```promql
sum(increase(pi_subagent_agent_completed_total{outcome="succeeded"}[24h]))
/
clamp_min(sum(increase(pi_subagent_agent_completed_total[24h])), 1)
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(pi_subagent_agent_queue_duration_seconds_bucket[24h]))
)
```

```promql
sum(increase(pi_subagent_cost_USD_total[24h]))
/
clamp_min(sum(increase(pi_subagent_agent_completed_total{outcome="succeeded"}[24h])), 1)
```

## Initial SLOs and alerts

These are analysis targets, not execution gates:

| Signal | Target |
|---|---|
| Successful turns | at least 95% |
| Timed-out plus lost turns | at most 1% |
| RPC failure rate | below 0.5% |
| Recovery success | at least 90% |
| Interactive p95 queue time | below 5 seconds |
| Batch p95 queue time | below 30 seconds |
| p95 first progress | below 10 seconds |
| Live steering delivery | at least 99% |
| Cost per successful turn | no >20% comparable-period regression with at least 10 turns |

Example alert rules can directly reuse the fixed query catalog. Require a sustained `for:` interval, such as 15 minutes, to avoid alerts from tiny samples. Group cost and quality alerts by bounded `provider`, `model`, `intent`, and `complexity_tier` labels only when each cohort has at least ten completed turns.

## Retention

Use seven days for the initial local improvement loop.

Prometheus example:

```bash
prometheus --storage.tsdb.retention.time=7d
```

Jaeger retention depends on storage:

- Badger: configure `--badger.ephemeral=false` and its maintenance/TTL settings.
- Elasticsearch/OpenSearch: apply a seven-day index lifecycle policy.
- Cassandra: configure an appropriate trace TTL.
- Jaeger all-in-one memory storage is not durable and is unsuitable for seven-day comparisons.

The analysis tool will not request a previous period for a `7d` window because it would exceed the intended retention.

## Logs

The sample collector sends structured metadata logs to the `debug` exporter. For durable logs, replace `debug/logs` with an OTLP log exporter or a Loki-compatible collector exporter and update the logs pipeline. Automated Pi analysis does not query logs in this phase because no backend-neutral log query API was selected.

## Privacy

The extension never exports:

- prompts or inherited context
- summaries or final output
- tool arguments, shell commands, or tool results
- source code, paths, or working directories
- environment variables, headers, or credentials
- raw error messages or stack traces
- batch row data or agent definitions

Project, session, task, batch, item, and error-message values are HMAC-SHA256 identifiers. A 32-byte key is created at `~/.pi/agent/subagent-telemetry-key` with mode `0600`. Filesystem failure falls back to a process-scoped random key.

Metric label keys are allowlisted and values are normalized/capped. The collector deletes common unsafe attributes again as defense in depth.

## Troubleshooting

### `/subagents telemetry` says disabled

- Confirm `PI_SUBAGENT_OTEL_ENABLED=1` was present when Pi started.
- Run `npm install --prefix subagent`.
- Check `configIssues` in `/subagents telemetry`.
- Remote HTTP is intentionally rejected.

### No traces

- Verify collector health at `http://127.0.0.1:13133`.
- Verify `JAEGER_OTLP_ENDPOINT` in the collector environment.
- Search Jaeger for the configured service name.
- Check trace sampling; `0` disables trace recording while metrics/logs remain enabled.

### No metrics

- Verify Prometheus scrapes the collector's port `8889`.
- Inspect `http://127.0.0.1:8889/metrics` for actual translated names.
- Wait at least one metric export interval.

### Degraded exporter

`/subagents telemetry` shows last success, error category, and dropped-record count. Agent execution continues even when all exporters are unavailable. Restore the collector and wait for another export, or restart Pi after correcting endpoint configuration.

### Analysis unavailable

The analysis tool queries Prometheus and Jaeger, not the collector receiver. Configure `PI_SUBAGENT_PROMETHEUS_URL` and `PI_SUBAGENT_JAEGER_URL` to their query endpoints. Remote query endpoints also require HTTPS and explicit remote opt-in.
