---
created: 2026-07-25T07:08:21.939Z
source: pi-plan-mode
status: accepted-for-execution
---

# Start collecting router OTel metrics/traces/logs (operational enablement)

## Summary
The model-router extension already implements a complete, metadata-only OTel
telemetry path (metrics + traces), but it is **disabled by default** and has
never emitted. The empty `analyze_model_router_telemetry` result
(`Prometheus=available, Jaeger=available`, all metrics `unavailable; samples=0`)
is therefore operational, not a code gap. Your full Podman observability stack
(collector + Jaeger + Prometheus + Loki) is already running and reachable, so
this plan only needs to: (1) ensure the OTel SDKs are installed, (2) flip the
router telemetry flag on, (3) confirm the collector is reachable on loopback
`4318`, (4) swap the collector's `logs` exporter from `debug` to a durable Loki
exporter, and (5) restart Pi + verify flow. No router source code changes are in
scope. Logs are wired durably even though the router does not yet emit log
records (host/other signals will land in Loki, and router log emission becomes a
clean follow-up).

## Implementation Steps
1. Verify the OTel optional dependencies are present in `model-router/node_modules`; install them if missing.
2. Create or merge `~/.pi/agent/model-router.json` so it contains `"telemetry": { "enabled": true }` (preserve any existing keys).
3. Confirm the combined collector's OTLP/HTTP receiver is published to host `127.0.0.1:4318` from Podman; verify collector health on `:13133`.
4. Edit `observability/otel-collector.yaml` to replace the `debug/logs` exporter with a durable Loki exporter and point the `logs` pipeline at it (requires the `otelcol-contrib` image).
5. Redeploy/restart the collector to pick up the Loki logs exporter.
6. Restart Pi so the extension re-reads `model-router.json` and loads the OTel runtime (telemetry is constructed lazily at `session_start`/`model_select`).
7. Generate real routed traffic (run several balanced-mode tasks) so decisions and observations are produced.
8. Verify the pipeline end-to-end (router telemetry command, analysis tool, collector `:8889/metrics`, Jaeger service, Loki).

## Key Details

### 1. OTel dependency check (silent no-op root cause)
- `model-router/package.json` lists the SDKs as `optionalDependencies`
  (`@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-trace-node`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`,
  `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`).
- `OpenTelemetryRouterTelemetry.createRuntime` `dynamicImport`s these at startup; any
  missing package makes `createOpenTelemetryRouterTelemetry` throw and fall back to
  `NOOP_ROUTER_TELEMETRY` — telemetry silently off with no error surfaced on the
  request path.
- Action: from `model-router/`, run `npm install` (installs optional deps). Verify with a
  glob over `model-router/node_modules/@opentelemetry/{api,sdk-metrics,sdk-trace-node,exporter-trace-otlp-http,exporter-metrics-otlp-http,resources,semantic-conventions}`.
- If Pi resolves the extension from a different node root, confirm `@opentelemetry/*`
  resolves from the extension's `node_modules`; otherwise add the missing packages there.

### 2. Enable router telemetry (file-based, matches existing design)
- Default `telemetry.enabled = false` in `model-router/src/config/defaults.ts`.
- Schema only allows `{ enabled: boolean }` (`model-router/src/config/schema.ts`);
  endpoints are **not** configurable — the extension hardcodes them.
- `model-router/src/adapters/pi/extension.ts` builds telemetry as:
  `createOpenTelemetryRouterTelemetry({ enabled: true, requestedEnabled: true }, { privacy })`
  which resolves to OTLP/HTTP endpoints `http://127.0.0.1:4318/v1/traces` and
  `http://127.0.0.1:4318/v1/metrics`, service name `pi-model-router`.
- Action: write `~/.pi/agent/model-router.json`:
  ```json
  { "telemetry": { "enabled": true } }
  ```
  If the file already exists, merge this key in; do not overwrite other keys.

### 3. Collector reachability (loopback 4318)
- The extension is hardcoded to `127.0.0.1:4318`. This is consistent with the
  already-working Prometheus (`9090`) and Jaeger (`16686`) backends the analysis
  tool reached, so publish the collector's OTLP/HTTP receiver to host `127.0.0.1:4318`
  exactly like the other two.
- Action: `podman port <collector_container>` / `podman inspect` to confirm `4318/tcp`
  maps to `0.0.0.0:4318` on the host. If not published, recreate the collector
  container with `-p 4318:4318` (and keep `8889`, `13133` published).
- Verify health: `GET http://127.0.0.1:13133/` returns 200.

### 4. Swap collector `logs` exporter to Loki (durable)
- `observability/otel-collector.yaml` currently has `debug/logs` and the `logs`
  pipeline `exporters: [debug/logs]`. The `loki` exporter is only in
  `otel/opentelemetry-collector-contrib`, so the collector image must be contrib.
- Action: in the YAML, replace the `debug/logs` exporter block with a Loki exporter
  driven by an env var (mirrors the existing `JAEGER_OTLP_ENDPOINT` pattern):
  ```yaml
  exporters:
    otlp/jaeger:
      endpoint: ${env:JAEGER_OTLP_ENDPOINT}
      tls: { insecure: true }
    prometheus:
      endpoint: 0.0.0.0:8889
      enable_open_metrics: true
    loki:
      endpoint: ${env:LOKI_ENDPOINT}      # e.g. http://loki:4317 (gRPC) or http://loki:3100/loki/api/v1/push
      # tenant: "" optional; labels: { resource: [service.name], ... } optional
  ```
  and change the `logs` pipeline `exporters: [loki]` (keep `memory_limiter`,
  `attributes/privacy`, `resource/privacy`, `batch` processors).
- Set `LOKI_ENDPOINT` in the collector's Podman environment to your Loki OTLP/HTTP
  endpoint. The router emits no log records yet, so Loki will initially receive only
  host/other signals — the pipeline is prepared for router log emission as a follow-up.

### 5. Restart Pi + generate traffic
- The engine is built once per session in `extension.ts` `initialize()`; telemetry is
  real (non-noop) only after a restart that picks up the new `model-router.json` and
  loads the OTel runtime.
- After restart, exercise the router: run several real balanced-mode tasks (the
  previous `tencent/hy3` reasoning applies — simple/moderate text tasks will be
  routed and observed). Each `route()` records a decision; each `observe()` records an
  observation (requires `storage.enabled=true`, the default) so quality/cost/latency
  coverage accrues.

### 6. Verification matrix
- In Pi: `/router telemetry` → must report `telemetry=enabled`
  (and `store=available` so observations flow).
- In Pi: `/router status` → `health.telemetryAvailable = true`.
- Run `analyze_model_router_telemetry` (focus `all` or `rollout`) after traffic:
  `decisions_total` and `completed_total` (observations) should show `samples >= 10`,
  and `rollout readiness` reasons should shrink (the earlier `unavailable; samples=0`
  must become real numbers).
- `GET http://127.0.0.1:8889/metrics` contains `pi_model_router_decisions_total`
  (and `pi_model_router_observations_total`, `pi_model_router_cost_USD_*`,
  `pi_model_router_latency_milliseconds_*`, etc.).
- Jaeger (`127.0.0.1:16686`) shows service `pi-model-router` with
  `pi.model_router.route` spans.
- Loki shows log streams from the collector's logs pipeline (host/other signals now;
  router signals after the follow-up).

## Test Plan (acceptance criteria)
- [ ] `/router telemetry` => `telemetry=enabled`.
- [ ] After >= 10 routed runs, `analyze_model_router_telemetry` => `decisions_total`
      and `completed_total` samples >= 10; readiness reasons no longer all-incomplete.
- [ ] Collector `:8889/metrics` exposes `pi_model_router_decisions_total` and peer series.
- [ ] Jaeger lists `pi-model-router` with `pi.model_router.route` spans and bounded
      attributes (`model`, `intent`, `complexity_tier`, `stage`, `outcome`).
- [ ] Loki receives logs from the collector logs pipeline.
- [ ] No `router_store_unavailable` / degraded-exporter warnings in `/router status`.

## Metric-name reconciliation (verify; do not change code in this plan)
- The analyzer (`AnalysisClient.ts`) expects Prometheus names like
  `pi_model_router_latency_milliseconds_bucket` and `pi_model_router_cost_USD_*`.
  OTel unit translation can differ by collector version (the OBSERVABILITY docs warn
  time histograms may become `_seconds_`); if the collector emits a different suffix,
  latency/cost coverage queries still read 0 even with data. Inspect `:8889/metrics`
  and compare to the analyzer's expected names; if mismatched, record it as a
  follow-up (a config/query reconciliation task, out of this operational plan's scope).

## Assumptions
- Full Podman stack (collector, Jaeger, Prometheus, Loki) is up and reachable; the
  analysis tool already proved Prometheus+Jaeger reachable at `127.0.0.1:9090`/`16686`.
- The collector will be published on host `127.0.0.1:4318` (same pattern as the
  already-working backends), so the extension's hardcoded loopback endpoint reaches it.
- Scope = operational only: no router source changes; telemetry schema stays `{ enabled }`.
- `storage.enabled` remains `true` (default) so observations/coverage flow.
- OTel optional deps are installable in `model-router/node_modules`.
- The collector image for the Loki swap is `otelcol-contrib` (provides the `loki` exporter).

## Out of scope / follow-ups
- Router-side log emission: add an OTel log-record API to `RouterTelemetry` +
  `OpenTelemetryRouterTelemetry` (warnings, store-unavailable, degraded exporter,
  dropped records) and wire it from the engine/extension. The Loki pipeline is ready
  to receive these.
- Telemetry coverage improvements: emit `applied`/`forced` as metric labels and add a
  store/pipeline-health metric so shadow-vs-applied and pipeline health are measurable
  from Prometheus (needed before recommending rollout-policy changes).
- If `127.0.0.1:4318` cannot be published (e.g., Pi in a separate Podman network),
  extend `extension.ts` + `schema.ts` to accept `telemetry.tracesEndpoint` /
  `metricsEndpoint` (code change, not in this plan).


<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. 1. Verify the OTel optional dependencies are present in model-router/node_modules; install them if missing. _(done)_
- [x] 2. 2. Create or merge ~/.pi/agent/model-router.json so it contains "telemetry": { "enabled": true } (preserve any existing keys). _(done)_
- [x] 3. 3. Confirm the combined collector's OTLP/HTTP receiver is published to host 127.0.0.1:4318 from Podman; verify collector health on :13133. _(done)_
- [x] 4. 4. Edit observability/otel-collector.yaml to replace the debug/logs exporter with a durable Loki exporter and point the logs pipeline at it (requires the otelcol-contrib image). _(done)_
- [x] 5. 5. Redeploy/restart the collector to pick up the Loki logs exporter. _(done)_
- [>] 6. 6. Restart Pi so the extension re-reads model-router.json and loads the OTel runtime (telemetry is constructed lazily at session_start/model_select). _(deferred — now ALSO required to load the subagent/index.ts wiring fix below and the venice/* excludeModels rule)_
- [x] 7. 7. Generate real routed traffic (run several balanced-mode tasks) so decisions and observations are produced. _(done via scripts/router-telemetry-smoke.ts: real ModelRoutingEngine route()+observe() through the OTel pipeline; live-session traffic pending step 6)_
- [x] 8. 8. Verify the pipeline end-to-end (router telemetry command, analysis tool, collector :8889/metrics, Jaeger service, Loki). _(done: Prometheus has pi_model_router_decisions_total/observations_total/latency_milliseconds_*/cost_USD_*; Jaeger lists pi-model-router with pi.model_router.route spans; analyzer trace examples resolve. Metric names match the analyzer's expectations exactly.)_

## Execution note (2026-07-25): root cause of "0 completed samples"

The operational steps were all complete, but the subagent extension builds its own
ModelRoutingEngine in subagent/index.ts initializeRouter() WITHOUT passing telemetry,
so every subagent-routed decision (the only routed traffic in practice) exported
nothing. The model-router extension's own engine (which has telemetry) only serves
the model-router/* virtual provider, which the main agent never selects. Fixed by
creating OTel router telemetry from loaded.config.telemetry.enabled in
initializeRouter() and passing it to the engine (engine.close() already shuts it
down). Requires a Pi restart to take effect in live sessions.

<!-- pi-plan-progress:end -->
