---
created: 2026-07-24T15:02:24.019Z
source: pi-plan-mode
status: accepted-for-execution
---

# OpenTelemetry for Pi Subagents, Informed by Codex Code-Mode Host

## Summary

There is no exact “Codex-host Worker” equivalent in Pi.

- OpenAI Codex’s relevant component is `codex-code-mode-host`: a long-lived process that hosts multiple logical V8 code-mode sessions.
- Pi’s closest equivalent is the composition of:
  - `subagent/core/AgentManager.ts` — scheduling and lifecycle
  - `subagent/core/SubprocessRpcBackend.ts` — worker process ownership
  - `subagent/core/RpcClient.ts` — transport
  - `subagent/child-policy.ts` — child permissions and output controls
- Pi currently starts one complete `pi --mode rpc --no-session` process per subagent. Codex multiplexes logical sessions through one host process.
- Codex’s host executes code and delegates privileged tool operations back to Codex; Pi’s child processes execute tools locally under the child policy. Therefore, Pi’s current design is an agent-worker system, not a direct code-mode-host clone.

Instrument the existing Pi subagent system before replacing it. Add opt-in, metadata-only OpenTelemetry traces, metrics, and logs exported over OTLP/HTTP to one collector. The collector can route traces to Jaeger, expose metrics to Prometheus, and forward logs to an operator-selected backend.

Add a read-only analysis tool so Pi can inspect bounded aggregate telemetry and recommend improvements without accessing prompts, source code, tool output, or raw error messages.

## Research Basis

Codex findings are based on `openai/codex` main commit `634a998d8aaeaf5f535e04d8475b17a62e7043a7`:

- `codex-rs/code-mode-host/`
- `codex-rs/code-mode-protocol/src/host/`
- `codex-rs/core/src/code_mode/`
- `codex-rs/app-server/src/code_mode_host.rs`
- `codex-rs/app-server/tests/suite/v2/code_mode_host.rs`

Relevant Codex characteristics:

- A process-owned provider lazily starts and reuses one host.
- Logical sessions are multiplexed by session ID.
- The protocol has version/capability negotiation.
- Stdio uses bounded, length-prefixed JSON frames rather than unbounded JSONL.
- Operations explicitly model open, execute, wait, terminate, and shutdown.
- Requests and responses are correlated.
- Nested privileged operations are delegated back to the controlling Codex process.
- Local stdio and remote WebSocket transports share the same protocol.
- Host lifecycle and transport behavior have dedicated integration tests.

Pi should preserve the failure isolation benefit of one process per agent until telemetry demonstrates that process startup, memory, or queue latency justifies pooling.

## Scope

### Included

- Subagent extension lifecycle, RPC, child tool execution, routing, batches, context recovery, timeouts, usage, cost, steering, and follow-ups.
- OTLP traces, metrics, and structured logs.
- Jaeger and Prometheus compatibility through one OTel Collector.
- Collector configuration and operator documentation.
- Seven-day recommended backend retention.
- A read-only Pi telemetry-analysis tool.
- Metadata-only privacy rules.
- Exporter health and bounded shutdown.

### Excluded

- Root Pi turn/provider instrumentation.
- Replacing per-agent subprocesses with a shared host.
- Resuming workers after Pi reload.
- Worktree, container, or VM isolation.
- Capturing prompts, inherited context, source paths, source code, tool arguments, tool output, or raw errors.
- Bundling Jaeger, Prometheus, Grafana, or a log backend.
- Letting the analysis tool execute arbitrary PromQL, Jaeger queries, or arbitrary URLs.

## Implementation Steps

1. Add the subagent-local OTel dependencies, configuration loader, privacy helpers, and no-op telemetry interface.
2. Instrument agent, process, turn, RPC, tool, routing, recovery, messaging, and batch lifecycles.
3. Extract and persist child token usage, cost, tool counts, and turn-level timing metrics.
4. Implement explicit OTLP trace, metric, and log providers with bounded buffering and non-fatal exporter behavior.
5. Add exporter-health UI and the read-only telemetry-analysis tool.
6. Add the collector configuration, query catalog, retention guidance, dashboards/alerts documentation, and installation instructions.
7. Add unit, privacy, lifecycle, analysis-client, and failure-path tests.
8. Run the full test suite and perform a local collector/Jaeger/Prometheus smoke test.

## Proposed File Changes

### New files

```text
subagent/
  package.json
  package-lock.json
  telemetry/
    Config.ts
    Privacy.ts
    Telemetry.ts
    NoopTelemetry.ts
    OpenTelemetry.ts
    Usage.ts
    AnalysisClient.ts
    AnalysisTypes.ts
  tools/
    analyzeSubagentTelemetry.ts
  OBSERVABILITY.md

observability/
  otel-collector.yaml

tests/
  subagent-telemetry-config.test.ts
  subagent-telemetry-privacy.test.ts
  subagent-telemetry-lifecycle.test.ts
  subagent-telemetry-usage.test.ts
  subagent-telemetry-analysis.test.ts
```

### Modified files

- `subagent/index.ts`
- `subagent/core/AgentBackend.ts`
- `subagent/core/AgentManager.ts`
- `subagent/core/AgentTypes.ts`
- `subagent/core/BatchJobManager.ts`
- `subagent/core/BatchTypes.ts`
- `subagent/core/RpcClient.ts`
- `subagent/core/SubprocessRpcBackend.ts`
- `subagent/tools/spawnAgent.ts`
- `subagent/README.md`
- root `README.md`
- Existing subagent tests where interfaces gain telemetry callbacks or metrics fields

## Dependency Design

Create `subagent/package.json` because Pi resolves extension runtime dependencies from the extension directory. Commit its lockfile.

Use compatible releases of:

- `@opentelemetry/api`
- `@opentelemetry/api-logs`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/sdk-trace-node`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/sdk-logs`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/exporter-metrics-otlp-http`
- `@opentelemetry/exporter-logs-otlp-http`

Use explicit providers and exporters. Do not install auto-instrumentation and do not register global providers, because Pi or another extension may also use OTel.

## Configuration

Telemetry remains disabled unless:

```bash
PI_SUBAGENT_OTEL_ENABLED=1
```

Supported configuration:

| Variable | Default | Meaning |
|---|---:|---|
| `PI_SUBAGENT_OTEL_ENDPOINT` | `http://127.0.0.1:4318` | Base OTLP/HTTP collector endpoint |
| `PI_SUBAGENT_OTEL_SERVICE_NAME` | `pi-subagent-extension` | OTel service name |
| `PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO` | `1.0` | Trace sampling ratio |
| `PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS` | `10000` | Metric export interval |
| `PI_SUBAGENT_OTEL_LOG_LEVEL` | `info` | Minimum structured-log severity |
| `PI_SUBAGENT_OTEL_ALLOW_REMOTE` | `0` | Permit non-loopback exporter/query endpoints |
| `PI_SUBAGENT_PROMETHEUS_URL` | `http://127.0.0.1:9090` | Analysis query endpoint |
| `PI_SUBAGENT_JAEGER_URL` | `http://127.0.0.1:16686` | Jaeger query/UI endpoint |
| `PI_SUBAGENT_OTEL_QUERY_HEADERS` | unset | Optional JSON object of query headers |

Endpoint precedence:

1. Per-signal standard OTel endpoint, if defined.
2. `PI_SUBAGENT_OTEL_ENDPOINT`.
3. `OTEL_EXPORTER_OTLP_ENDPOINT`.
4. Loopback default.

Append `/v1/traces`, `/v1/metrics`, or `/v1/logs` only when the selected endpoint is a base endpoint.

Remote endpoints must use HTTPS and require `PI_SUBAGENT_OTEL_ALLOW_REMOTE=1`. Headers must never be displayed, persisted, or included in telemetry.

Do not reuse Pi’s existing `PI_TELEMETRY`; that variable controls Pi installation/update telemetry and provider attribution, not this extension.

## Telemetry Abstraction

Define an injectable `SubagentTelemetry` interface with a no-op implementation. `AgentManager`, `BatchJobManager`, `SubprocessRpcBackend`, and `RpcClient` must depend on this interface rather than OTel packages directly.

The interface owns in-memory span handles keyed by agent, turn, batch, RPC request, and child tool-call IDs. OTel objects must never be serialized into `AgentRecord`, `BatchJob`, or Pi session entries.

Add a structured `BackendObservation` union to `AgentBackendEvents` for:

- Process spawned and exited
- RPC request started/completed/failed
- First model output
- Tool execution started/completed
- Compaction started/completed
- Context-window overflow detected
- Overflow recovery completed/failed
- Malformed RPC message
- Child provider/model error

Existing textual `onOutput` behavior remains unchanged for the TUI.

## Trace Model

Use the following hierarchy:

```text
pi.subagent.session
├── pi.subagent.batch
│   └── pi.subagent.process
│       └── pi.subagent.turn
│           ├── pi.subagent.rpc
│           └── pi.subagent.tool
└── pi.subagent.process
    ├── pi.subagent.turn
    │   ├── pi.subagent.rpc
    │   ├── pi.subagent.tool
    │   └── pi.subagent.context_recovery
    └── pi.subagent.turn  # live follow-up
```

Behavior:

- A session span starts at `session_start` and ends at `session_shutdown`.
- A batch span starts in `createJob()` and ends on completed, failed, or cancelled.
- A process span starts when an agent is queued and ends only when the subprocess exits, is closed, is killed, or becomes lost.
- Each initial prompt and live follow-up receives a separate turn span.
- A spawned follow-up agent is parented to the original agent process span.
- Batch worker processes are parented to the batch span.
- RPC spans are keyed by request ID.
- Tool spans are keyed by child tool-call ID. Unclosed spans end as errors when the turn or process ends.
- Long-lived parent spans may end before all descendants; explicit stored parent contexts preserve correlation.
- On restore, previously running agents generate a new reconciliation trace/log with outcome `lost`; old spans are not fabricated or resumed.

Required span attributes include:

- Random agent/job identifiers where applicable
- Status and outcome
- Model provider and model ID
- Thinking level
- Routing mode, profile, intent, complexity tier, and score
- Write and context modes
- Queue, startup, turn, idle, and total durations
- Prompt and output character counts, never content
- Token and cost totals
- RPC command name
- Tool name
- Recovery type and outcome
- Error category and error-message hash
- Hashed session/project/task identifiers

## Usage and Cost Accounting

Extend `AgentMetrics` with cumulative fields:

```ts
interface AgentMetrics {
  durationMs?: number;
  queueDurationMs?: number;
  startupDurationMs?: number;
  firstProgressMs?: number;
  outputChars?: number;
  exitCode?: number;
  turns?: number;
  toolCalls?: number;
  providerRequests?: number;
  compactions?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}
```

At every child `agent_end`:

- Sum assistant-message usage from that completed turn.
- Sum input, output, cache-read, cache-write, and total token counters.
- Sum `usage.cost.total`.
- Merge the delta into the agent’s cumulative metrics rather than replacing prior follow-up usage.
- Emit turn-level telemetry from the delta and persist cumulative totals in the existing agent state.
- Treat absent usage as “unknown,” not zero, in comparisons.

This allows routing estimates already stored in `RoutingDecision` to be compared against actual input/output tokens and cost.

## Metrics

Use low-cardinality labels only. Exact agent IDs, job IDs, task names, project hashes, and trace IDs must not be metric labels.

Core instruments:

| Instrument | Type | Unit |
|---|---|---|
| `pi.subagent.agent.started` | Counter | `{agent}` |
| `pi.subagent.agent.completed` | Counter | `{agent}` |
| `pi.subagent.agent.duration` | Histogram | `s` |
| `pi.subagent.agent.queue.duration` | Histogram | `s` |
| `pi.subagent.agent.startup.duration` | Histogram | `s` |
| `pi.subagent.agent.first_progress.duration` | Histogram | `s` |
| `pi.subagent.agent.active` | Observable gauge | `{agent}` |
| `pi.subagent.process.active` | Observable gauge | `{process}` |
| `pi.subagent.rpc.requests` | Counter | `{request}` |
| `pi.subagent.rpc.duration` | Histogram | `s` |
| `pi.subagent.tool.executions` | Counter | `{execution}` |
| `pi.subagent.tool.duration` | Histogram | `s` |
| `pi.subagent.output.size` | Histogram | `By` |
| `pi.subagent.tokens` | Counter | `{token}` |
| `pi.subagent.cost` | Counter | `USD` |
| `pi.subagent.context_recovery` | Counter | `{recovery}` |
| `pi.subagent.messages` | Counter | `{message}` |
| `pi.subagent.batch.jobs` | Counter | `{job}` |
| `pi.subagent.batch.items` | Counter | `{item}` |
| `pi.subagent.batch.duration` | Histogram | `s` |
| `pi.subagent.queue.depth` | Observable gauge | `{agent}` |
| `pi.subagent.telemetry.export.errors` | Counter | `{error}` |
| `pi.subagent.telemetry.dropped` | Counter | `{event}` |

Allowed metric labels:

- `outcome`
- `error_category`
- `provider`
- `model`
- `thinking_level`
- `routing_mode`
- `routing_profile`
- `intent`
- `complexity_tier`
- `write_mode`
- `context_mode`
- `rpc_command`
- `tool_name`
- `delivery_mode`
- `batch_source`
- `recovery_type`

Normalize label values, cap them at 80 characters, and map unknown values to `other`.

## Structured Logs

Emit logs through the OTel log provider:

- `INFO`: queued, started, turn completed, routing selected, batch transitions, message delivery.
- `WARN`: timeout recovery, context overflow, policy block, lost worker, exporter degradation.
- `ERROR`: RPC failure, process failure, unrecovered context overflow, terminal agent failure.

Every log includes its related trace/span IDs and the same safe attribute allowlist. Logs must never contain lifecycle `data` objects wholesale.

The supplied collector config routes logs to its `debug` exporter by default. Documentation must show how to replace that exporter with Loki, an OTLP log service, or another persistent backend.

## Privacy and Cardinality Rules

Never export:

- Prompt or inherited-context text
- Agent summaries or final output
- Tool arguments or output
- Shell commands
- File paths or `cwd`
- Environment variables or headers
- Raw error messages or stack traces
- Agent definitions
- CSV/JSONL row data

Use HMAC-SHA256 for stable project/session/task identifiers:

- Create `~/.pi/agent/subagent-telemetry-key` with mode `0600` on first opt-in use.
- Hash canonical values with that key and truncate to 16 hexadecimal characters.
- If the key cannot be created/read, use a process-random key and mark hashes as session-scoped.
- Never export the key.

Classify errors into:

- `context_window`
- `timeout`
- `rpc_protocol`
- `rpc_closed`
- `process_exit`
- `policy_block`
- `provider`
- `cancelled`
- `configuration`
- `exporter`
- `unknown`

Export only the category, concrete error class name, and an HMAC of the message.

## Exporter Reliability

Telemetry must never alter worker outcomes.

- Use bounded batch processors.
- Default trace/log queue: 2,048 records.
- Default batch delay: 2 seconds.
- Drop telemetry rather than block agent work when queues are full.
- Debounce local exporter warnings.
- Track last successful export, last failure category, and dropped-event count.
- Flush and shut down providers during `session_shutdown`.
- Bound combined flush/shutdown to five seconds.
- On timeout, abandon telemetry shutdown and continue Pi shutdown.
- Starting Pi with telemetry disabled must instantiate no OTel providers, timers, sockets, or exporters.

Extend `/subagents`:

```text
/subagents telemetry
```

It reports:

- Enabled/disabled
- Safe endpoint origin, without headers or credentials
- Last successful export
- Last error category
- Dropped record count
- Trace sample ratio
- Query endpoint availability

Show a TUI warning only while enabled telemetry is degraded; do not add permanent status noise.

## Read-Only Self-Analysis Tool

Register:

```ts
analyze_subagent_telemetry({
  window?: "1h" | "6h" | "24h" | "3d" | "7d";
  focus?: "reliability" | "cost" | "ux" | "all";
  comparePreviousPeriod?: boolean;
  maxTraceExamples?: number;
})
```

Defaults:

- `window: "24h"`
- `focus: "all"`
- `comparePreviousPeriod: true`
- `maxTraceExamples: 10`, capped at 25

The tool:

1. Executes a fixed catalog of Prometheus queries.
2. Fetches bounded trace summaries from Jaeger for failed, slow, timed-out, and context-recovery runs.
3. Removes all trace tags outside the telemetry allowlist.
4. Returns current values, previous-period values, deltas, SLO violations, and trace IDs/UI links.
5. Caps output at 16,000 characters.
6. Never accepts a URL, PromQL expression, service name, or Jaeger tag query from the model.
7. Continues with metrics-only analysis if Jaeger is unavailable.
8. Reports unavailable previous-period data for a seven-day window rather than querying beyond retention.

The model then interprets this deterministic snapshot. The tool itself does not call an LLM or automatically change configuration/code.

Logs are excluded from automated analysis initially because no log-query backend was selected.

## Initial Self-Improvement SLOs

Use these as dashboard and analysis defaults, not runtime enforcement:

### Reliability

- Successful turns: at least 95%.
- Lost plus timed-out turns: at most 1%.
- RPC failure rate: below 0.5%.
- Context-overflow recovery success: at least 90%.
- Exporter failures must have no correlation with agent failures.

### Cost and Routing

- Report median and p95 tokens/cost by model, intent, and complexity tier.
- Flag a model/intent cohort when cost per successful turn regresses more than 20% against the preceding comparable period.
- Flag routing estimation when actual tokens fall outside 0.5–2.0× the estimate for more than 20% of eligible turns.
- Do not compare cohorts with fewer than ten completed turns.

### UX

- Interactive p95 queue time: below 5 seconds.
- Batch p95 queue time: below 30 seconds.
- p95 time to first progress: below 10 seconds.
- Steering delivery success for live workers: at least 99%.
- Flag repeated `wait_agent` timeouts where the worker completes within the following minute, because this indicates poor wait defaults rather than worker failure.

## Collector Configuration and Operations

Add `observability/otel-collector.yaml` with:

- OTLP/HTTP receiver on `0.0.0.0:4318`
- Memory limiter
- Attribute deletion/allowlist processor as defense in depth
- Batch processor
- OTLP exporter targeting an operator-provided Jaeger OTLP endpoint
- Prometheus exporter on `0.0.0.0:8889`
- Debug log exporter
- Separate traces, metrics, and logs pipelines

Do not include Docker Compose or backend containers.

`subagent/OBSERVABILITY.md` must document:

- Installing subagent dependencies
- Starting/configuring a collector
- Connecting Jaeger and Prometheus
- Replacing the debug log exporter
- Prometheus scrape configuration
- Seven-day Prometheus retention
- Seven-day retention guidance for the chosen Jaeger storage backend
- Environment variables
- Example PromQL queries
- Jaeger service/operation searches
- Privacy guarantees
- Analysis-tool usage
- Troubleshooting and exporter-health checks

## Lessons from Codex for Later Pi Improvements

Telemetry should inform, rather than predetermine, these follow-up changes:

1. **Versioned worker protocol:** Add a handshake, protocol version, and advertised capabilities before accepting prompts.
2. **Bounded framing:** Cap RPC line/frame size and parser buffers; reject oversized or malformed messages deterministically.
3. **Explicit operations:** Model open, execute, wait, terminate, and shutdown rather than relying only on inferred process state.
4. **Central supervision:** Track process groups, shutdown acknowledgements, heartbeats, orphan detection, and forced-kill outcomes.
5. **Parent-owned privilege:** Consider routing privileged filesystem/shell operations back through the parent instead of executing them inside the child process.
6. **Environment minimization:** Replace full `process.env` inheritance with an allowlist plus only required provider credentials.
7. **Transport abstraction:** Separate worker protocol from stdio so a future local host, SDK runtime, container, VM, or remote worker can implement the same interface.
8. **Logical session reuse:** Consider a shared host or SDK-backed session pool only if startup latency, queue pressure, and follow-up reuse telemetry justify its larger crash blast radius.
9. **Reattachment identity:** Persist host/session identities and heartbeat state before attempting reload reattachment.
10. **Protocol integration tests:** Test malformed frames, unknown protocol versions, cancellation races, host crashes, and partial shutdowns.

## Test Plan

### Configuration

- Disabled by default.
- No provider/exporter creation while disabled.
- Correct endpoint precedence and per-signal URL generation.
- Remote HTTP endpoints rejected.
- Remote HTTPS endpoints require explicit permission.
- Invalid sample ratios, intervals, headers, and URLs fail closed without affecting agents.

### Privacy

- Seed prompts, paths, commands, tool output, errors, headers, and secrets with recognizable canaries.
- Assert no exported span, metric, log, or analysis response contains any canary.
- Verify stable HMAC values with the persisted key.
- Verify ephemeral fallback when key creation fails.
- Verify high-cardinality attributes never enter metric labels.

### Lifecycle and Correlation

- Session → process → turn parentage.
- Batch → worker process parentage.
- Spawned follow-up parentage.
- Multiple live turns on one process.
- RPC request correlation and timing.
- Child tool start/end correlation.
- Dangling spans closed on failure, interruption, timeout, process exit, and shutdown.
- Restored workers emit lost reconciliation telemetry without fabricating old spans.

### Usage

- Aggregate assistant usage correctly.
- Merge multiple follow-up turns.
- Handle missing or partial usage.
- Sum cache and cost components.
- Preserve cumulative metrics through state serialization and restore.
- Compare routing estimates only when actual usage exists.

### Exporter Failure

- Collector unavailable at startup.
- Collector becomes unavailable mid-session.
- Queue overflow and dropped records.
- Flush timeout.
- Exporter failure never changes agent/job results.
- `/subagents telemetry` reports degraded state without leaking endpoint credentials.

### Analysis Tool

- Fixed Prometheus query catalog only.
- Time-window and trace-count caps.
- Current/previous-period delta calculations.
- Seven-day comparison behavior.
- Jaeger unavailable fallback.
- All-backends-unavailable response.
- Trace attribute allowlist and 16,000-character output cap.
- Remote query endpoint restrictions.
- No arbitrary URL or query injection.

### Regression

Run:

```bash
npm install --prefix subagent
npm test
```

All existing subagent lifecycle, routing, batching, rendering, policy, state, and RPC tests must continue to pass with the no-op telemetry implementation.

## Acceptance Criteria

- Telemetry-disabled behavior is functionally identical to the current extension.
- Enabling telemetry produces correlated traces in Jaeger, scrapeable metrics in Prometheus, and structured logs at the collector.
- One successful agent, one failed agent, one timeout recovery, one live follow-up, and one batch job are distinguishable end to end.
- Token and cost totals match the child assistant-message usage records.
- Exporter outages do not fail, delay materially, or alter worker outcomes.
- No prohibited payload appears in exported telemetry.
- Pi can call `analyze_subagent_telemetry` and receive a bounded reliability/cost/UX comparison with trace exemplars.
- Documentation is sufficient to connect an existing collector, Jaeger, Prometheus, and optional log backend.
- The full repository test suite passes.

## Rollout

1. Merge with telemetry disabled by default.
2. Enable locally against a loopback collector and validate privacy canaries.
3. Collect a seven-day baseline across normal interactive and batch usage.
4. Review the three SLO groups and representative failed/slow traces.
5. Implement only the Codex-inspired worker improvements supported by observed bottlenecks.
6. Compare each improvement against the prior comparable period and retain it only when reliability, cost, or UX improves without a material regression in the other categories.












<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Add the subagent-local OTel dependencies, configuration loader, privacy helpers, and no-op telemetry interface. _(done)_
- [x] 2. Instrument agent, process, turn, RPC, tool, routing, recovery, messaging, and batch lifecycles. _(done)_
- [x] 3. Extract and persist child token usage, cost, tool counts, and turn-level timing metrics. _(done)_
- [x] 4. Implement explicit OTLP trace, metric, and log providers with bounded buffering and non-fatal exporter behavior. _(done)_
- [x] 5. Add exporter-health UI and the read-only telemetry-analysis tool. _(done)_
- [x] 6. Add the collector configuration, query catalog, retention guidance, dashboards/alerts documentation, and installation instructions. _(done)_
- [x] 7. Add unit, privacy, lifecycle, analysis-client, and failure-path tests. _(done)_
- [x] 8. Run the full test suite and perform a local collector/Jaeger/Prometheus smoke test. _(done)_

<!-- pi-plan-progress:end -->
