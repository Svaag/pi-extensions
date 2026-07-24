# Model Router Observability

Router telemetry is opt-in, metadata-only, asynchronous, and non-fatal. Local SQLite observations are the online learner’s source of truth; Prometheus and Jaeger are for bounded analysis and operational evidence, not request-path queries.

Enable export in `model-router.json`:

```json
{ "telemetry": { "enabled": true } }
```

The default OTLP/HTTP endpoints are loopback collector endpoints. Use the repository's [combined Subagent/Router collector](https://github.com/Svaag/pi-extensions/blob/main/observability/otel-collector.yaml).

## Services and tools

- OTel service: `pi-model-router`
- Independent tool: `analyze_model_router_telemetry`
- Subagent tool: `analyze_subagent_telemetry` with `focus: "routing"`
- Analysis environment:
  - `PI_MODEL_ROUTER_PROMETHEUS_URL` (default `http://127.0.0.1:9090`)
  - `PI_MODEL_ROUTER_JAEGER_URL` (default `http://127.0.0.1:16686`)

Tools accept only window/focus/comparison/trace-count fields. They never accept URLs, PromQL, service names, arbitrary tags, raw logs, or paths.

## Metrics

OTel instruments:

- `pi.model_router.decisions`
- `pi.model_router.observations`
- `pi.model_router.quality`
- `pi.model_router.latency`
- `pi.model_router.first_token`
- `pi.model_router.cost`
- `pi.model_router.fallbacks`
- `pi.model_router.circuit_breakers`
- `pi.model_router.rollout.transitions`
- `pi.model_router.judge.evaluations`
- `pi.model_router.telemetry.dropped`

Bounded metric dimensions include host, granularity, profile, stage, arm, outcome, failure domain, provider/model, thinking level, intent, complexity tier, quality source, fallback, and transition.

Route/project/task/session IDs never become metric labels. Random route IDs and HMAC identifiers are span-only.

Prometheus translation of dots, counters, and units can vary by collector version. Inspect the collector’s `:8889/metrics` after upgrades.

## Data-quality rules

- Every ratio has an explicit denominator query.
- A zero denominator returns `unavailable/zero_denominator`, not 0.
- SLO findings require at least ten eligible samples.
- Rollout readiness reports completed, quality-label, outcome, cost, and latency coverage counts.
- Missing provider usage/cost remains unknown.
- The expected cold-start result is “insufficient data; remain in shadow.”

The original observed approximately 6 ms process failure is a host/process event. It must increment terminal completion/coverage but cannot penalize a model’s quality or reliability.

## Privacy

Never exported:

- prompts, context, summaries, output, or code
- tool arguments/results or commands
- paths, project names, working directories, or batch row data
- environment variables, headers, credentials, or endpoint URLs
- judge inputs
- raw errors or stack traces

A 32-byte HMAC key is stored under the Pi agent directory with mode `0600`. Filesystem failure falls back to a process key and disables stable project correlation rather than blocking work. Collector attribute processors delete common sensitive attributes again as defense in depth.

## Retention

External telemetry is designed for seven-day Prometheus/Jaeger retention. Local learning metadata retains raw rows for 90 days and applies a 30-day half-life to sufficient statistics.

## Troubleshooting

- No metrics: confirm telemetry is enabled, optional OTel dependencies are installed, the collector listens on `4318`, and Prometheus scrapes `8889`.
- Analysis unavailable: configure Prometheus/Jaeger query endpoints, not the collector receiver.
- Zero samples: do not lower SLOs or promote rollout; verify terminal observation wiring first.
- Degraded exporter: routing and SQLite learning continue. Restore the collector and inspect `/router telemetry`.
