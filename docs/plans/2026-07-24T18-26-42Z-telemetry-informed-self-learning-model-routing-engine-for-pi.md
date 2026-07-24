---
created: 2026-07-24T18:26:42.703Z
source: pi-plan-mode
status: accepted-for-execution
---

# Telemetry-Informed, Self-Learning Model Routing Engine for Pi

## Summary

Create a public package, `@svaag/pi-model-router`, containing a host-neutral routing engine plus integrations for:

1. **Pi per-run routing** — choose one model/thinking level before each agent run.
2. **Pi per-provider-request routing** — opt-in virtual models such as `model-router/balanced`.
3. **Subagent Extension routing** — replace its embedded `SmartRouter` with the shared engine.
4. **SDK/custom-host use** — explicit `route()`, `observe()`, and feedback APIs.

The engine will start from the existing deterministic intent/complexity router as a cold-start prior, then learn model quality, reliability, cost, and latency through a constrained hierarchical Bayesian bandit. It will begin in shadow mode, promote automatically through guarded exploration to automatic routing, and roll back automatically when guardrails regress.

## Grounding and Telemetry Findings

### Repository state

- Current local `main` is at `8d559ab` and is two commits behind `origin/main`.
- Current `main` contains no tracked Subagent Extension.
- Clean worktree `/home/svag/.local/share/pi-subagent-otel-runtime` on `backup/pi-tui-rendering-2026-06-15` contains:
  - The complete Subagent Extension.
  - Deterministic intent and complexity routing.
  - Scoped-model discovery.
  - Batch and follow-up routing.
  - Metadata-only OpenTelemetry.
  - Prometheus/Jaeger analysis tooling and tests.
- That branch also contains unrelated plan-mode, goal-mode, wallet, and rendering changes; those must not be promoted wholesale.
- Existing untracked `pi-session-*.html` files must remain untouched.

### Telemetry snapshot

The seven-day Subagent Telemetry snapshot currently contains:

- `completed_total`: 0
- Tokens: 0
- Cost: $0
- No usable latency percentiles
- One approximately 6 ms failed process trace with no completed model turn

Consequences:

- No current model can be ranked from observed performance.
- The existing “0% success rate” critical alert is invalid because the sample size is zero.
- The process failure must be classified as a host/process failure, not evidence against a model.
- The router must start from weak deterministic priors and remain in shadow mode until sufficient observations exist.
- Rollout gates must use explicit sample-size and telemetry-completeness checks.

## Goals and Success Criteria

The implementation succeeds when:

- One reusable engine powers standalone Pi and Subagent routing.
- Explicit model and thinking choices are never overridden.
- Only effective Pi `enabledModels` with resolved authentication are candidates.
- Model capabilities, context capacity, reliability, and tier quality floors are hard constraints.
- Operational success is not incorrectly treated as answer quality.
- Quality can be supplied through:
  - Human feedback.
  - Host validators.
  - A confirmed Subagent feedback tool.
  - An opt-in sampled LLM judge.
- Cost and latency learn from every attributable completed call.
- Host, policy, tool, user-cancellation, and provider/model failures are distinguished.
- Installation begins in shadow mode and cannot auto-promote on missing or zero-volume data.
- Critical tasks are never explored.
- Automatic routing rolls back on statistically credible quality or reliability regressions.
- Prompts, outputs, code, paths, commands, credentials, and raw errors are never persisted or exported by router telemetry.
- The existing Subagent lifecycle, policy, batch, recovery, and rendering behavior remains compatible.

## Scope

### Included

- Public TypeScript package and Pi package entrypoint.
- Host-neutral model and thinking-level routing.
- Per-run and per-provider-call Pi integration.
- Subagent, batch, and spawned-follow-up integration.
- SQLite learning state.
- Bayesian online learning and deterministic cold-start priors.
- Four profiles: `balanced`, `quality_first`, `cost_first`, and `latency_first`.
- Metadata-only OTel metrics/traces.
- Fixed, bounded telemetry analysis tools.
- Human, validator, correction, and sampled-judge feedback.
- Automatic shadow/explore/auto stage management and rollback.
- Migration of existing Subagent routing records and configuration.

### Excluded

- Pi core patches.
- A remote routing service or centralized fleet learner.
- Cross-machine sharing of learned state.
- Persisting prompts, outputs, embeddings, source code, or judge input.
- Automatic routing to models outside Pi’s enabled/authenticated scope.
- Fine-tuning model weights.
- Exploring critical tasks.
- Treating missing usage, cost, latency, or quality as zero.
- Using Prometheus or Jaeger as the primary online-learning database.

## Target Repository and Package Layout

```text
model-router/
  index.ts
  package.json
  tsconfig.json
  README.md
  OBSERVABILITY.md
  src/
    index.ts
    core/
      ModelRoutingEngine.ts
      types.ts
      features.ts
      classifier.ts
      candidates.ts
      constraints.ts
      priors.ts
      bandit.ts
      objectives.ts
      rollout.ts
      feedback.ts
      modelFingerprint.ts
    config/
      defaults.ts
      load.ts
      schema.ts
      migrateLegacy.ts
    storage/
      RouterStore.ts
      SqliteRouterStore.ts
      migrations.ts
      histograms.ts
    judge/
      QualityJudge.ts
      rubric.ts
    telemetry/
      RouterTelemetry.ts
      NoopRouterTelemetry.ts
      OpenTelemetryRouterTelemetry.ts
      AnalysisClient.ts
      AnalysisTypes.ts
      Privacy.ts
    adapters/
      pi/
        extension.ts
        PiModelSource.ts
        PiRunRouter.ts
        VirtualRouterProvider.ts
        commands.ts
        rendering.ts
      subagent/
        SubagentRouterAdapter.ts
      sdk/
        RoutedSessionAdapter.ts

subagent/
  ...promoted Subagent Extension...
  tools/
    rateAgent.ts
  telemetry/
    ...existing telemetry updated for route IDs/rewards...

observability/
  otel-collector.yaml

tests/
  model-router-*.test.ts
  subagent-*.test.ts
```

### Package metadata

`model-router/package.json` will use:

- Name: `@svaag/pi-model-router`
- Initial version: `0.1.0`
- Node engine: `>=22.19.0`
- `pi.extensions`: `["./index.ts"]`
- Public exports:
  - `@svaag/pi-model-router`
  - `@svaag/pi-model-router/pi`
  - `@svaag/pi-model-router/subagent`
  - `@svaag/pi-model-router/sdk`
  - `@svaag/pi-model-router/telemetry`
- Pi packages and `typebox` as `peerDependencies: "*"` per Pi packaging guidance.
- OTel dependencies loaded dynamically only when telemetry is enabled.
- `prepack` builds JavaScript and declaration files under `dist/`.
- Source `index.ts` remains usable by Pi/jiti for local symlink development.

The root `package.json` will become a private workspace over `model-router` and `subagent`, while retaining the existing root test command.

## Public Core API

```ts
export type RoutingProfile =
  | "balanced"
  | "quality_first"
  | "cost_first"
  | "latency_first";

export type RoutingStage = "off" | "shadow" | "explore" | "auto";

export type RouteHost =
  | "pi_run"
  | "pi_provider_request"
  | "subagent"
  | "subagent_batch"
  | "sdk";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type FailureDomain =
  | "model"
  | "provider"
  | "host"
  | "rpc"
  | "tool"
  | "policy"
  | "user"
  | "router"
  | "unknown";

export interface RouteRequest {
  requestId?: string;
  host: RouteHost;
  projectKey?: string;
  taskName?: string;
  prompt?: string;
  agentDefinition?: string;
  contextSummary?: string;
  contextMode?: string;
  writeMode?: string;
  tools?: string[];
  modality: "text" | "image";
  estimatedContextTokens: number;
  estimatedOutputTokens?: number;
  candidates: RoutingCandidate[];
  currentModel?: string;
  currentThinkingLevel?: ThinkingLevel;
  explicitModel?: string;
  explicitThinkingLevel?: ThinkingLevel;
  profile?: RoutingProfile;
  forceMode?: "off" | "explain" | "auto";
  batch?: {
    source: "csv" | "jsonl";
    itemCount: number;
  };
}

export interface RouteDecision {
  schemaVersion: 1;
  routeId: string;
  policyVersion: string;
  createdAt: number;
  stage: RoutingStage;
  host: RouteHost;
  profile: RoutingProfile;
  applied: boolean;
  arm: "control" | "treatment" | "forced";
  reason: string;
  intent: TaskIntent;
  complexityTier: ComplexityTier;
  complexityScore: number;
  riskScore: number;
  confidence: number;
  selectedModel?: string;
  selectedThinkingLevel?: ThinkingLevel;
  executedModel?: string;
  executedThinkingLevel?: ThinkingLevel;
  baselineModel?: string;
  baselineThinkingLevel?: ThinkingLevel;
  estimatedCostUsd?: number;
  estimatedP95LatencyMs?: number;
  candidates: RouteCandidateDecision[];
  constraints: ConstraintEvaluation[];
  explanation: string;
}

export interface RouteObservation {
  routeId: string;
  completedAt: number;
  outcome:
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "aborted";
  failureDomain?: FailureDomain;
  latencyMs?: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  providerRequests?: number;
  toolCalls?: number;
  quality?: {
    score: number;
    source: "user" | "validator" | "judge" | "correction";
    weight?: number;
  };
}

export class ModelRoutingEngine {
  route(request: RouteRequest): Promise<RouteDecision>;
  observe(observation: RouteObservation): Promise<void>;
  recordQuality(routeId: string, score: number, source: QualitySource): Promise<void>;
  getStatus(): Promise<RouterStatus>;
  getDecision(routeId: string): Promise<RouteDecision | undefined>;
  resetRollout(scope?: RolloutScope): Promise<void>;
  close(): Promise<void>;
}
```

Raw prompt, context, or output text may be used transiently by feature extraction or the optional judge, but must not appear in `RouteDecision`, SQLite, OTel, logs, or session entries.

## Candidate and Arm Model

A routing arm is a pair:

```text
(provider/model fingerprint, thinking level)
```

This allows the engine to learn that the same model may have different quality, cost, and latency at different reasoning levels.

### Candidate requirements

A candidate must:

- Match effective Pi `enabledModels`.
- Be returned by `ctx.modelRegistry.getAvailable()`.
- Resolve valid authentication immediately before use.
- Not be a synthetic `model-router/*` model.
- Support the request modality.
- Fit estimated input plus output within its context window.
- Support the selected thinking level.
- Satisfy configured provider/model allow/deny rules.
- Not have an open circuit breaker.
- Meet applicable reliability and quality constraints.

Scoped patterns with a thinking suffix, such as `provider/model:high`, fix the arm to that thinking level.

### Thinking-level candidate ranges

| Tier | Automatically considered levels |
|---|---|
| `trivial` | `off` |
| `simple` | `off`, `minimal` |
| `moderate` | `minimal`, `low`, `medium` |
| `complex` | `low`, `medium`, `high` |
| `critical` | `medium`, `high`, `xhigh` |

`max` is explicit-only in v1. Non-reasoning models expose only `off`.

## Task Features and Cold-Start Classification

Extract transient features from:

- Task name and prompt.
- Agent definition.
- Context mode and approximate context size.
- Write mode and active tools.
- Text/image modality.
- Batch size and source.
- Whether the request follows tool results.
- Whether the task is a continuation of an existing run.
- Risk keywords and write capability.

Preserve the existing intent taxonomy:

- `lookup`
- `scout`
- `summarize`
- `batch_simple`
- `plan`
- `review`
- `debug`
- `implement`
- `complex`

Preserve the existing complexity tiers:

- `trivial`
- `simple`
- `moderate`
- `complex`
- `critical`

The current deterministic rules and model-family profiles become weak, versioned priors rather than final ranking truth. Model-specific operator overrides continue to win over generic family patterns.

The existing optional ambiguous-task classifier becomes a plugin and is disabled by default. If enabled, it must use an explicit non-router model, have its own cost/timeout cap, and fall back to deterministic classification on every failure.

## Learning Model

### Hierarchical Bayesian estimators

Maintain separate estimators for:

1. **End-to-end reliability**
2. **Model/provider-attributable reliability**
3. **Quality**
4. **Cost**
5. **Total latency**
6. **First-token latency**

Cohorts use:

```text
host × intent × complexity tier × context-size bucket × modality × tool/write mode
```

Each model/thinking arm has:

- Machine-global statistics.
- Optional hashed-project overlay.
- Broader tier and global backoff statistics.

The project overlay activates after 20 effective observations and reaches full weight at 50. Before that, predictions blend toward machine-global and broader-cohort statistics.

### Posterior updates

- Reliability uses a Beta posterior.
- Successful attributable calls add one positive reliability observation.
- Provider/model failures add one negative reliability observation.
- Context-overflow failures add a 0.5-weight negative observation.
- Host process, RPC, policy, tool, router, and user-cancellation failures affect end-to-end SLOs but do not penalize model reliability.
- Quality uses fractional Beta updates:
  - Human feedback: weight `1.0`
  - Validator score: default weight `1.0`, caller-configurable
  - Sampled judge: weight `0.35`
  - Explicit correction: score `0.0`, weight `0.20`
- A successful call without a quality label does not update quality.

### Cost and latency estimators

Use exponentially decayed histograms:

- Latency buckets in milliseconds:
  - 250, 500, 1,000, 2,000, 4,000, 8,000, 16,000, 32,000, 60,000, 120,000, 300,000, infinity
- Cost buckets in USD:
  - 0, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, infinity

Store decayed count, mean, variance, and histogram mass. Use the histogram for p50/p95 estimates.

All sufficient statistics use a 30-day half-life. Raw metadata observations are retained for 90 days and then compacted into decayed aggregates.

### Priors

- Quality prior strength: 4 pseudo-observations.
- Reliability prior mean: 0.97.
- Reliability prior strength: 20 pseudo-observations.
- Generic family rules from the existing router seed quality/speed priors.
- Exact config overrides take precedence.
- A changed model fingerprint starts a new arm while preserving the previous arm’s history.

The model fingerprint includes non-secret model metadata: provider, ID, API type, reasoning support, context/max-output limits, input modalities, pricing, thinking map, and relevant compatibility capabilities. It excludes API keys, headers, and raw endpoint URLs.

## Constraints and Routing Profiles

### Tier floors

| Tier | Quality floor | Reliability floor after 20 attributable observations |
|---|---:|---:|
| `trivial` | 0.20 | 0.90 |
| `simple` | 0.40 | 0.93 |
| `moderate` | 0.60 | 0.95 |
| `complex` | 0.78 | 0.97 |
| `critical` | 0.90 | 0.99 |

Before 20 attributable observations, weak priors and deterministic model-class eligibility apply. Unknown values are never converted to zero.

### Profile defaults

| Profile | Relative constraints | Selection inside safe set |
|---|---|---|
| `balanced` | Cost ≤ 1.0× baseline; learned p95 latency ≤ 1.0× baseline | 55% quality, 20% reliability, 15% cost saving, 10% latency saving |
| `cost_first` | Learned p95 latency ≤ 1.5× baseline | Lowest expected cost, then quality/reliability |
| `latency_first` | Cost ≤ 1.25× baseline | Lowest learned p95 latency, then quality/reliability |
| `quality_first` | Cost ≤ 2.0× baseline; p95 latency ≤ 2.0× baseline | Highest conservative quality estimate |

Operators may configure stricter absolute `maxCostUsd` and `maxP95LatencyMs` caps per profile.

A latency constraint is enforced only after both baseline and candidate have at least 10 effective latency observations. Until then, speed priors affect ranking but do not form a hard latency rejection.

If no candidate dominates or safely replaces the baseline, the engine retains the baseline and explains which constraints rejected alternatives. Capability constraints are never relaxed. Absolute caps are never silently relaxed.

## Exploration and Automatic Rollout

Rollout state is stored separately for each:

```text
host × granularity × profile
```

Project configuration may cap a stage but may not silently promote beyond the learned global stage.

### Stage 1: Shadow

- Default after installation.
- Compute and persist recommendations.
- Execute the current/explicit model.
- Learn only from the arm that actually executed.
- Display recommendations without changing behavior.

Automatic promotion to `explore` requires:

- At least 100 eligible completed observations.
- At least 10 quality-labelled observations.
- 100% outcome attribution.
- At least 90% cost and latency coverage where the provider reports those values.
- At least two safe authenticated candidate arms for relevant non-critical work.
- No store corruption or unresolved telemetry-completeness warning.
- No zero-sample SLO result treated as a pass or failure.

### Stage 2: Explore

- Apply routing to 20% of eligible non-critical calls.
- Keep 80% as control/baseline.
- Use conservative Thompson sampling within the safe candidate set for treatment calls.
- Forced routes, explicit models, virtual-router use, and pinned models contribute arm statistics but are excluded from treatment/control promotion comparisons.
- Critical tasks remain control/deterministic.

Automatic promotion to `auto` uses aggregate global gates, as selected:

- At least 100 treatment observations.
- At least 100 control observations.
- At least seven elapsed days in explore mode.
- At least 10 quality labels in each arm.
- At least 95% posterior probability that:
  - Reliability regression is no worse than 1 percentage point.
  - Quality regression is no worse than 3 percentage points.
- At least one of:
  - Cost per successful call improves by 10%.
  - p95 latency improves by 10%.
- No sustained reliability, quality, exporter-completeness, or data-integrity violation.

Sparse intent/tier cohorts may borrow the aggregate gate result, but retain their own candidate constraints and circuit breakers.

### Stage 3: Auto

- Apply the learned champion to all eligible calls.
- Use at most 5% conservative Thompson exploration among safe non-critical candidates.
- Maintain control-like baseline estimates through shadow scoring.
- Never explore critical work.

### Critical-task policy

A learned arm may replace the current/deterministic critical-task model only after:

- At least 50 attributable reliability observations on that arm.
- At least 20 human or validator quality labels; sampled-judge labels do not satisfy this gate.
- Mean reliability at least 0.99.
- At least 95% posterior probability of being no more than one percentage point worse than the critical baseline.
- Mean quality at least 0.90.
- No active provider/model circuit breaker.

Otherwise preserve an explicit/current model or use the deterministic premium fallback.

### Automatic rollback

- Three consecutive provider/model failures immediately open that arm’s circuit.
- With at least 20 recent attributable calls, a posterior probability above 95% that failure rate exceeds 10% also opens the circuit.
- `auto` rolls back to `explore` when cost or latency regresses more than 20% for two consecutive evaluation windows.
- `auto` rolls back to `shadow` when:
  - Reliability regresses by more than one percentage point with 95% probability.
  - Quality regresses by more than three percentage points with 95% probability.
  - Observation completeness falls below 90%.
  - The SQLite store or schema cannot be trusted.
- A model-catalog/config fingerprint change affecting more than half the candidate arms resets the affected rollout scope to shadow.
- Rollback transitions are persisted, rendered, and emitted to telemetry.

## Sampled LLM Judge

The judge is disabled until explicitly configured with a concrete authenticated non-router model.

Defaults when enabled:

- Sample rate: at most 5%.
- Exclude `critical` tasks.
- Exclude tasks classified as security, authentication, payment, wallet, secret, or privacy-sensitive even if their numeric tier was lower.
- Maximum judge cost: `$0.005` per evaluation.
- Maximum daily judge cost: `$0.25`.
- Timeout: 30 seconds.
- Prompt excerpt cap: 8,000 characters.
- Output excerpt cap: 12,000 characters.
- No tool arguments or tool output are included.
- Judge input exists only in memory and is never persisted or exported.
- The judge cannot be the evaluated model or any synthetic `model-router/*` model.
- Budget exhaustion skips judging without affecting the routed call.

The judge returns strict JSON scores for:

- Correctness: 40%
- Completeness: 25%
- Relevance: 20%
- Safety/instruction adherence: 15%

After 30 observations with both judge and human/validator labels, automatically disable judge updates if:

- Mean absolute error exceeds 0.20, or
- Absolute systematic bias exceeds 0.15.

The judge remains diagnostic after disablement but no longer updates quality posteriors until manually re-enabled.

## SQLite State

Default path:

```text
~/.pi/agent/model-router/router.db
```

Use `node:sqlite` with:

- WAL mode.
- `busy_timeout=250`.
- `foreign_keys=ON`.
- `synchronous=NORMAL`.
- Versioned, transactional migrations.

Tables:

- `schema_meta`
- `router_config_state`
- `rollout_state`
- `routes`
- `observations`
- `quality_feedback`
- `arm_statistics`
- `metric_histograms`
- `judge_budget`
- `circuit_breakers`

Stored route metadata includes only IDs, hashes, feature categories, numeric estimates, selected arms, outcome categories, usage, quality labels, and policy/config versions.

On database failure:

- Do not block Pi or Subagent execution.
- Disable learning and automatic promotion.
- Fall back to deterministic shadow scoring or the current/explicit model.
- Surface a bounded health warning.
- Never recreate or overwrite a corrupt database automatically.

## Pi Integration

### Per-run routing

The Pi extension routes in `before_agent_start`, after prompt/template expansion and before the first provider request.

Behavior:

- In shadow mode, append a non-context custom entry and show the recommendation without changing model.
- In explore/auto mode, call `pi.setModel()` and `pi.setThinkingLevel()` before the run.
- Aggregate every `turn_end` usage record into one run observation.
- Measure:
  - Agent-run duration.
  - Time to first assistant delta.
  - Provider-request count.
  - Tokens and cost.
  - Tool calls and errors.
  - Final stop reason.
- Finalize the observation at `agent_settled`.
- Run judging asynchronously after settlement without delaying the user-visible result.

### Manual model pins

- A user `/model` selection or manual model cycle pins that model for subsequent runs.
- Router-originated `pi.setModel()` calls are suppressed from pin detection.
- Session restore does not create a pin.
- `/router unpin` resumes managed routing.
- Explicit model pins and explicit thinking levels are hard overrides and are recorded as `forced`, not rollout treatment.

### Commands and flags

Commands:

```text
/router status
/router profile balanced|quality_first|cost_first|latency_first
/router pin
/router unpin
/router feedback up|down|<0..1> [routeId]
/router rollout
/router reset-rollout
/router telemetry
```

`/router feedback` defaults to the latest settled route. `up` maps to 1.0 and `down` to 0.0. It accepts no free-text reason, preventing accidental sensitive-data persistence.

Flags:

```text
--router-mode off|managed|shadow
--router-profile balanced|quality_first|cost_first|latency_first
```

`managed` uses the persisted automatic rollout stage.

All UI behavior must degrade safely in print, JSON, and RPC modes.

### Virtual per-provider-request models

Register provider `model-router` with:

- `model-router/balanced`
- `model-router/quality`
- `model-router/cost`
- `model-router/latency`

Selecting one explicitly activates per-provider-request routing and bypasses automatic-stage application as a forced route. These observations train arm statistics but do not count toward automatic treatment/control promotion.

The virtual provider:

1. Reads the full provider `Context` transiently.
2. Filters Pi-enabled/authenticated candidates.
3. Resolves target authentication immediately before dispatch.
4. Calls Pi’s generic `streamSimple(targetModel, context, targetOptions)`.
5. Streams target events unchanged so persisted assistant messages contain the actual target provider/model and usage.
6. Preserves Pi-selected reasoning as a hard thinking override.
7. Applies a cache-affinity preference to the previous target during a tool loop.
8. Changes target mid-run only when:
   - A capability constraint requires it, or
   - Predicted utility improves by at least 15%.

If the target fails before emitting any text, thinking, or tool-call content, retry exactly once with the next safe candidate. Never replay after visible content begins. Record both attempts and attribute the first failure correctly.

Use conservative synthetic model metadata:

- Context window: 128,000
- Max output: 16,384
- Input: text and image
- Reasoning levels: all Pi levels

Actual candidate capability filtering remains authoritative.

## Subagent Integration

Promote the backup Subagent Extension selectively, then replace:

- `core/RouterConfig.ts`
- `core/ScopedModels.ts`
- `core/SmartRouter.ts`
- `tools/router.ts`

with `@svaag/pi-model-router` and `SubagentRouterAdapter`.

### Compatibility

Preserve existing parameters:

- `routingMode: "auto" | "off" | "explain"`
- `routingProfile: "balanced" | "cost_first" | "quality_first"`
- Explicit `model`
- Explicit `thinkingLevel`

Add:

- `routingProfile: "latency_first"`
- Explicit `thinkingLevel: "max"`
- Omitted `routingMode` means managed rollout:
  - Initially equivalent to existing inherit behavior because the stage is shadow.
  - May automatically route after promotion.
- `auto` remains an explicit forced route and applies immediately.
- `explain` computes but does not apply.
- `off` inherits the explicit/current model.

### Agent and batch records

Add:

- `routeId`
- `policyVersion`
- `baselineModel`
- `baselineThinkingLevel`
- `rolloutStage`
- `arm`
- `failureDomain`
- Actual model/thinking if fallback occurred

Batch behavior remains “route once per job,” but each worker receives its own route ID and observation linked to a common batch decision ID. This prevents one job decision from collapsing many worker outcomes into one learning sample.

### Follow-ups

- Live follow-ups retain their process/model and create a new observation for the new turn.
- Spawned follow-ups default to inherited model/thinking.
- `spawnRoutingMode: "auto"` requests a new forced route.
- `spawnRoutingMode: "inherit"`, `off`, and `explain` remain compatible.

### Explicit Subagent feedback

Add:

```ts
rate_agent({
  agentId: string;
  score: number; // 0 through 1
})
```

Rules:

- In TUI mode, require user confirmation before recording.
- In print/JSON mode, reject interactive-user feedback.
- Non-interactive validator feedback must use the core API unless `allowNonInteractiveFeedback` is explicitly enabled.
- Never allow a child agent to rate itself.
- Tool guidance must say it is only for user- or validator-provided ratings.

### Failure attribution

Map Subagent failures into domains:

- Provider response/auth/rate limit: `provider`
- Model-generated context overflow: `model` with 0.5 reliability weight
- Spawn/exit before model output: `host`
- Malformed/closed RPC: `rpc`
- Tool execution failure: `tool`
- Child policy rejection: `policy`
- User interrupt: `user`
- Router resolution failure: `router`

The observed 6 ms process failure would therefore affect host reliability and telemetry completeness, not any model’s quality or reliability posterior.

## Configuration

Load in this order:

1. Package defaults.
2. `~/.pi/agent/model-router.json`
3. Nearest trusted `.pi/model-router.json`
4. CLI/runtime overrides.

For backward compatibility, also read:

- `~/.pi/agent/subagent-router.json`
- Trusted `.pi/subagent-router.json`

Legacy configuration is migrated in memory, with a deprecation warning. The new config wins when both are present.

Core defaults:

```json
{
  "version": 1,
  "enabled": true,
  "profile": "balanced",
  "granularity": "run",
  "candidateSource": "pi_enabled_authenticated",
  "rollout": {
    "automatic": true,
    "initialStage": "shadow",
    "shadowMinCompleted": 100,
    "shadowMinQualityLabels": 10,
    "minimumObservationCompleteness": 0.9,
    "exploreTreatmentRate": 0.2,
    "exploreMinTreatment": 100,
    "exploreMinControl": 100,
    "exploreMinDays": 7,
    "exploreMinQualityLabelsPerArm": 10,
    "nonInferiorityProbability": 0.95,
    "maxReliabilityRegression": 0.01,
    "maxQualityRegression": 0.03,
    "requiredCostOrLatencyImprovement": 0.1
  },
  "learning": {
    "halfLifeDays": 30,
    "rawRetentionDays": 90,
    "projectOverlayMinSamples": 20,
    "projectOverlayFullWeightSamples": 50,
    "autoExplorationRate": 0.05
  },
  "judge": {
    "enabled": false,
    "model": null,
    "sampleRate": 0.05,
    "maxCostPerEvaluationUsd": 0.005,
    "maxDailyCostUsd": 0.25,
    "timeoutMs": 30000,
    "excludeTiers": ["critical"],
    "maxPromptChars": 8000,
    "maxOutputChars": 12000
  },
  "virtualProvider": {
    "enabled": true,
    "maxFallbacksBeforeOutput": 1,
    "switchMinimumUtilityGain": 0.15
  }
}
```

Project configuration may narrow candidates, lower budgets, disable judging, or cap rollout. It may not enable untrusted models, weaken global privacy restrictions, or widen remote telemetry access.

## Telemetry and Analysis

### Router telemetry

Add metadata-only instruments:

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

Bounded labels:

- `host`
- `granularity`
- `profile`
- `stage`
- `arm`
- `outcome`
- `failure_domain`
- `provider`
- `model`
- `thinking_level`
- `intent`
- `complexity_tier`
- `quality_source`
- `fallback`
- `transition`

Route, project, session, and task identifiers may appear only as HMAC IDs on spans/logs, never metric labels.

### Analysis tools

Add independent:

```ts
analyze_model_router_telemetry({
  window?: "1h" | "6h" | "24h" | "3d" | "7d";
  focus?: "reliability" | "quality" | "cost" | "latency" | "rollout" | "all";
  comparePreviousPeriod?: boolean;
  maxTraceExamples?: number;
})
```

Extend `analyze_subagent_telemetry` with `focus: "routing"` and router cohort summaries while preserving all existing inputs.

Both tools use fixed query catalogs only. They never accept URLs, PromQL, arbitrary tags, raw logs, paths, or service names.

### Zero-sample and completeness corrections

- A ratio whose denominator is zero is `unavailable`, not zero.
- SLO findings require at least 10 eligible completed observations.
- Every analysis result reports denominator/sample count.
- Rollout reports cannot claim readiness without quality-label and coverage counts.
- Reconcile early process termination so both the terminal trace and completion counter are emitted.
- Add explicit observation-completeness counters for outcome, latency, cost, and quality.
- Missing provider cost or usage remains unknown.
- The current zero-volume telemetry produces “insufficient data; remain in shadow,” with no critical success-rate violation.

## Privacy and Security

Never persist or export:

- Prompts or context.
- Model output or summaries.
- Tool arguments or results.
- Commands or source paths.
- Project names or raw working directories.
- Headers, environment variables, API keys, or OAuth data.
- Judge inputs.
- Raw errors or stack traces.

Use the existing machine-stable HMAC key pattern with mode `0600`. Reuse a generic router privacy helper and retain the existing Subagent key compatibility.

OTel exporters remain opt-in, bounded, asynchronous, and non-fatal. SQLite failure, OTel failure, judge failure, model discovery failure, or classifier failure must never block the user’s current/explicit model.

## Implementation Steps

1. Synchronize a feature branch with `origin/main` and selectively promote only the Subagent, observability, and Subagent test paths from the clean backup worktree.
2. Create the `@svaag/pi-model-router` package, public types, configuration loader, candidate model abstraction, and deterministic cold-start feature pipeline.
3. Implement SQLite migrations, privacy-safe route storage, decayed hierarchical statistics, model fingerprints, and circuit breakers.
4. Implement constrained profile evaluation, Bayesian arm selection, critical-task safeguards, automatic rollout promotion, and rollback.
5. Implement quality feedback, validator integration, sampled judge evaluation, budget enforcement, and judge calibration.
6. Implement the independent Pi extension: per-run routing, model pins, commands, status rendering, observation aggregation, and feedback.
7. Implement the opt-in `model-router/*` virtual provider with target auth resolution, stream delegation, cache affinity, and one pre-output fallback.
8. Replace the Subagent router with the shared adapter; add per-worker observations, failure attribution, follow-up compatibility, and `rate_agent`.
9. Generalize router telemetry, repair zero-sample/completion accounting, extend the fixed analysis catalogs, and update collector/docs.
10. Add migration, unit, integration, packaging, privacy, failure, and rollout tests; run the complete regression and package smoke-test suite.
11. Update root, router, Subagent, SDK, migration, configuration, and observability documentation for public release.

## Baseline Promotion Procedure

During implementation:

1. Start a feature branch from `origin/main`, not the divergent backup branch.
2. Preserve all untracked session HTML files.
3. Restore only:
   - `subagent/`
   - `observability/otel-collector.yaml`
   - `tests/subagent-*.test.ts`
   - Necessary Subagent documentation
4. Do not restore unrelated backup changes to:
   - `plan-mode/`
   - `goal-mode/`
   - `hyrule-loop/`
   - `tool-highlight/`
   - `x402-wallet/`
5. Reapply root README/package changes manually.
6. Add `pi-session-*.html` to `.gitignore` without deleting existing files.
7. Keep old routing records readable through schema adapters rather than rewriting session history.

## Test Plan

### Core routing

- Deterministic intent and tier classification.
- Explicit model/thinking overrides.
- Capability, modality, context, auth, and circuit filtering.
- Model/thinking arm generation.
- All four routing profiles.
- Relative and absolute constraints.
- Unknown cost/latency handling.
- Baseline retention when no safe improvement exists.

### Learning

- Beta reliability and fractional quality updates.
- Failure-domain attribution.
- No quality update from success alone.
- Hierarchical global/project blending.
- 30-day decay and 90-day retention.
- Model fingerprint invalidation.
- Deterministic seeded Thompson tests.
- Fixed histogram p50/p95 calculations.

### Rollout

- Zero observations remain shadow.
- Shadow readiness gates.
- Aggregate explore treatment/control gates.
- Automatic promotion.
- Soft and hard rollback.
- Forced routes excluded from promotion comparisons.
- Critical tasks never explored.
- Strict critical exploitation gate.
- Model circuit opening and recovery.

### Judge and feedback

- 5% deterministic sampling.
- Sensitive/critical exclusion.
- Per-call and daily budget caps.
- No same-model or synthetic judge.
- Strict JSON parsing.
- Judge failure is non-fatal.
- Judge/manual calibration disablement.
- TUI feedback confirmation.
- Non-interactive feedback rejection by default.
- No prompt/output persistence canaries.

### Pi integration

- Per-run route before provider use.
- Shadow does not change model.
- Managed stages apply correctly.
- User model selection pins; router model changes do not.
- Thinking override behavior.
- Run-level usage aggregation across tool turns.
- JSON/RPC/print compatibility.
- Session reload and replacement cleanup.

### Virtual provider

- Candidate and auth resolution.
- Generic cross-provider stream delegation.
- Actual model/provider/usage preserved in assistant events.
- Image filtering.
- Tool-call continuation.
- One fallback before content.
- No fallback after text, thinking, or tool-call output.
- Router models excluded from recursion.
- Cache-affinity switching threshold.

### Subagent

- Existing lifecycle, RPC, safety, timeout, and state tests.
- Forced `auto`, `off`, `explain`, and managed omission.
- Batch decision with unique worker observations.
- Follow-up inherit/reroute behavior.
- Early spawn failure attributed to host.
- Provider/model failure attribution.
- `rate_agent` authorization.
- Legacy record/config restoration.

### Telemetry

- Zero denominators produce unavailable values.
- Minimum sample counts suppress false SLOs.
- Early process failures produce terminal metrics and traces.
- Router treatment/control metrics.
- Coverage metrics.
- Exporter failure never changes routing or worker outcomes.
- Full privacy canary coverage.
- Fixed queries and bounded output.

### Packaging

Run:

```bash
npm install
npm test
npm run build --workspace @svaag/pi-model-router
npm pack --workspace @svaag/pi-model-router --dry-run
```

Also test a temporary packed-package installation, Pi extension discovery, SDK imports, and a loopback OTel smoke test.

## Acceptance Criteria

- The initial telemetry state is reported as insufficient and remains shadow.
- Simple tasks can eventually select cheaper/faster arms without crossing quality/reliability floors.
- Complex tasks remain on strong arms unless learned evidence supports another safe choice.
- Critical tasks are never explored.
- Explicit user/caller choices always win.
- Root Pi, virtual-provider, SDK, and Subagent routes share one engine and schema.
- Quality, reliability, cost, and latency are learned separately.
- A host process failure cannot reduce a model’s learned reliability.
- Automatic promotion and rollback pass deterministic tests.
- Batch worker outcomes contribute independently.
- One pre-output provider fallback works without duplicate visible output.
- No prohibited content appears in SQLite, session entries, telemetry, or analyzer output.
- All existing and new tests pass.
- `@svaag/pi-model-router` can be installed as a Pi package and imported as a normal TypeScript/JavaScript library.

## Assumptions

- Pi `0.82.x` and Node `>=22.19.0` are the initial compatibility baseline.
- Effective `enabledModels` remains the user-controlled candidate boundary.
- Pi model pricing and capability metadata are trusted when explicitly present; absent data is unknown.
- The learner is local to one machine.
- External OTel retention remains seven days initially, while local learning metadata uses 90-day retention and 30-day decay.
- The current zero-volume telemetry seeds no learned performance conclusions.












<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [ ] 1. Synchronize a feature branch with origin/main and selectively promote only the Subagent, observability, and Subagent test paths from the clean backup worktree. _(pending)_
- [ ] 2. Create the @svaag/pi-model-router package, public types, configuration loader, candidate model abstraction, and deterministic cold-start feature pipeline. _(pending)_
- [ ] 3. Implement SQLite migrations, privacy-safe route storage, decayed hierarchical statistics, model fingerprints, and circuit breakers. _(pending)_
- [ ] 4. Implement constrained profile evaluation, Bayesian arm selection, critical-task safeguards, automatic rollout promotion, and rollback. _(pending)_
- [ ] 5. Implement quality feedback, validator integration, sampled judge evaluation, budget enforcement, and judge calibration. _(pending)_
- [ ] 6. Implement the independent Pi extension: per-run routing, model pins, commands, status rendering, observation aggregation, and feedback. _(pending)_
- [ ] 7. Implement the opt-in model-router/* virtual provider with target auth resolution, stream delegation, cache affinity, and one pre-output fallback. _(pending)_
- [ ] 8. Replace the Subagent router with the shared adapter; add per-worker observations, failure attribution, follow-up compatibility, and rate_agent. _(pending)_
- [ ] 9. Generalize router telemetry, repair zero-sample/completion accounting, extend the fixed analysis catalogs, and update collector/docs. _(pending)_
- [ ] 10. Add migration, unit, integration, packaging, privacy, failure, and rollout tests; run the complete regression and package smoke-test suite. _(pending)_
- [ ] 11. Update root, router, Subagent, SDK, migration, configuration, and observability documentation for public release. _(pending)_

<!-- pi-plan-progress:end -->
