---
created: 2026-07-04T02:44:59.732Z
source: pi-plan-mode
status: accepted-for-execution
---

# Deterministic Complexity-Based Subagent Model Routing

## Summary
Refine the existing `subagent` Smart Router so every subagent spawn routes through Pi scoped models based on a first-class deterministic complexity tier, while preserving the current hybrid classifier default for ambiguous cases. The router will remain enabled by default for `spawn_agent` and batch tools, route batch jobs once per job, and expose controlled follow-up rerouting.

## Current State
- Existing router files:
  - `subagent/core/SmartRouter.ts`
  - `subagent/core/RouterConfig.ts`
  - `subagent/core/ScopedModels.ts`
  - `subagent/tools/router.ts`
- Existing tool support:
  - `spawn_agent`, `spawn_agents_on_csv`, and `spawn_agents_on_jsonl` already accept `model`, `thinkingLevel`, `routingMode`, and `routingProfile`.
  - `SubprocessRpcBackend.ts` already passes routed `--model` and `--thinking`.
  - Routing decisions are persisted/rendered.
- Current user scoped models are configured in `~/.pi/agent/settings.json`:
  - `local-llamacpp/local-model`
  - `openrouter/google/gemini-3.5-flash`
  - `openrouter/minimax/minimax-m3`
  - `kimi-coding/kimi-for-coding`
  - `zai-official/glm-5.2`
  - `openrouter/deepseek/deepseek-v4-pro`
  - `anthropic/claude-sonnet-4-6`
  - `anthropic/claude-opus-4-8`
  - `openai-codex/gpt-5.5`
- Main gaps:
  - Complexity is currently an internal numeric score, not a public/auditable routing tier.
  - Follow-up spawned agents currently inherit the original model/thinking without a routing choice.
  - Candidate scoring is intent-aware, but not explicitly tier-aware.

## Implementation Steps
1. Add public deterministic complexity tiers to routing types and decisions.
2. Refactor deterministic classification to compute a stable `complexityScore` and `complexityTier`.
3. Make model profiles and scoring tier-aware while preserving existing intent/cost/context logic.
4. Keep the current hybrid classifier default, but recompute the deterministic tier after classifier refinement.
5. Add controlled routing parameters to `followup_task` for spawned follow-up agents.
6. Update rendering, persistence, docs, and examples to show complexity tiers.
7. Expand router, follow-up, batch, persistence, and rendering tests.

## Detailed Specification

### 1. New Public Complexity Contract

Update `subagent/core/AgentTypes.ts`:

```ts
export type ComplexityTier =
  | "trivial"
  | "simple"
  | "moderate"
  | "complex"
  | "critical";
```

Extend `RoutingDecision`:

```ts
complexityTier: ComplexityTier;
complexityScore: number;
confidence: number;
classificationReason: string;
signals: string[];
classifierUsed?: boolean;
classifierModel?: string;
```

Keep existing fields for backward compatibility:
- `intent`
- `risk`
- `complexity`
- `estimatedInputTokens`
- `estimatedOutputTokens`
- `candidates`

### 2. Deterministic Complexity Scoring

In `subagent/core/SmartRouter.ts`, add deterministic tier scoring after `classifyTaskIntent()`.

Use this intent base table:

```ts
const INTENT_COMPLEXITY_BASE = {
  lookup: 0.05,
  batch_simple: 0.10,
  summarize: 0.15,
  scout: 0.30,
  debug: 0.45,
  plan: 0.50,
  review: 0.60,
  implement: 0.70,
  complex: 0.85,
};
```

Compute:

```ts
complexityScore = clamp01(
  0.45 * INTENT_COMPLEXITY_BASE[intent] +
  0.25 * classification.complexity +
  0.25 * classification.risk +
  0.05 * contextBoost
);
```

Where:

```ts
contextBoost = contextMode && contextMode !== "fresh" ? 1 : 0;
```

Tier thresholds:

```ts
score < 0.20 => "trivial"
score < 0.38 => "simple"
score < 0.58 => "moderate"
score < 0.78 => "complex"
otherwise    => "critical"
```

### 3. Tier-Aware Model Profiles

Extend `ModelProfile`:

```ts
preferredTiers: ComplexityTier[];
```

Default tier preferences:

| Model pattern | Preferred tiers |
|---|---|
| `local-llamacpp/local-model` | `trivial`, `simple` |
| `openrouter/google/gemini-*-flash` | `trivial`, `simple` |
| `openrouter/minimax/minimax-m3` | `simple`, `moderate` |
| `kimi-coding/kimi-for-coding` | `simple`, `moderate`, `complex` |
| `zai-official/glm-5.2` | `moderate`, `complex` |
| `openrouter/deepseek/deepseek-v4-pro` | `moderate`, `complex` |
| `anthropic/claude-sonnet-*` | `complex`, `critical` |
| `anthropic/claude-opus-*` | `critical` |
| `openai-codex/gpt-*` | `complex`, `critical` |

Extend router profile config overrides:

```ts
preferredTiers?: ComplexityTier[];
```

### 4. Tier-Aware Scoring

Add tier quality floors:

```ts
const TIER_QUALITY_FLOOR = {
  trivial: 0.20,
  simple: 0.40,
  moderate: 0.60,
  complex: 0.78,
  critical: 0.90,
};
```

Update `requiredQuality()` to use:

```ts
required = Math.max(existingIntentRiskQuality, TIER_QUALITY_FLOOR[complexityTier]);
```

Add scoring modifiers:

```ts
tierBoost = profile.preferredTiers.includes(complexityTier) ? 0.06 : 0;
tierMismatchPenalty =
  profile.quality < TIER_QUALITY_FLOOR[complexityTier]
    ? (TIER_QUALITY_FLOOR[complexityTier] - profile.quality) * 0.5
    : 0;
```

Keep current:
- quality fit
- cost fit
- speed fit
- context fit
- intent role boost
- overkill penalty
- risk penalty

### 5. Thinking Level by Tier

Update `defaultThinkingLevelForTask()`:

| Tier | Default thinking |
|---|---|
| `trivial` | `off` |
| `simple` | `off` for lookup/batch, otherwise `minimal` |
| `moderate` | `low` |
| `complex` | `medium`, or `high` for implement/review/high-risk |
| `critical` | `high`; `xhigh` only for explicit thinking or `quality_first` with very high risk/complexity |

Non-reasoning models still force `off`.

### 6. Hybrid Classifier Behavior

Keep current hybrid default:
- deterministic routing always runs first
- classifier only runs for ambiguity
- classifier remains bounded by current config
- if classifier returns usable intent/risk/complexity, recompute:
  - `complexityScore`
  - `complexityTier`
  - candidates
  - selected thinking level

Persist:
```ts
classifierUsed: true
classifierModel: "<provider/id>"
```

If classifier fails or returns low confidence, leave `classifierUsed` unset/false.

### 7. Follow-Up Routing Parameters

Update `subagent/tools/followupTask.ts` schema:

```ts
spawnRoutingMode?: "inherit" | "auto" | "off" | "explain"; // default "inherit"
routingProfile?: "balanced" | "cost_first" | "quality_first";
model?: string;
thinkingLevel?: ThinkingLevel;
```

Behavior:
- Live RPC follow-ups cannot change model; ignore routing fields unless `mode: "spawn_followup"`.
- For `mode: "spawn_followup"`:
  - `spawnRoutingMode: "inherit"` default:
    - reuse original agent model/thinking
    - persist a routing decision with reason `inherited`
  - `spawnRoutingMode: "auto"`:
    - route using follow-up prompt + prior agent summary/context
  - `spawnRoutingMode: "explain"`:
    - compute and persist decision but do not apply model/thinking
  - `spawnRoutingMode: "off"`:
    - only apply explicit `model`/`thinkingLevel`; otherwise leave model/thinking unset
  - explicit `model` always wins
  - explicit `thinkingLevel` always wins

Extend `RoutingDecisionReason` with:

```ts
"inherited"
```

### 8. Rendering and Observability

Update:
- `subagent/render/renderAgent.ts`
- `subagent/tools/batchCommon.ts`
- `subagent/render/renderAgentList.ts` if needed
- `subagent/render/renderSubagentWidget.ts` if compact space allows

Collapsed metadata should include:

```text
model:<model> · thinking:<level> · routed:<intent>/<tier>/<objective>
```

Expanded routing view should include:

```text
tier=<complexityTier> score=<complexityScore> confidence=<confidence>
reason=<classificationReason>
signals=<comma-separated signals>
classifier=<model or none>
```

### 9. Config Updates

Update `subagent/core/RouterConfig.ts`:

```ts
complexity: {
  thresholds: {
    trivialMax: 0.20,
    simpleMax: 0.38,
    moderateMax: 0.58,
    complexMax: 0.78
  },
  tierQualityFloor: {
    trivial: 0.20,
    simple: 0.40,
    moderate: 0.60,
    complex: 0.78,
    critical: 0.90
  }
}
```

Allow global config:
- `~/.pi/agent/subagent-router.json`

Allow trusted project config:
- nearest `.pi/subagent-router.json`

Reject/sanitize invalid threshold order by falling back to defaults.

### 10. Documentation Updates

Update `subagent/README.md`:
- Explain complexity tiers.
- Show default tier-to-model behavior.
- Document `spawnRoutingMode` for `followup_task`.
- Show config example for tier thresholds and profile overrides.
- Clarify that batch routing remains once per job.

## Test Plan

Add/update tests in `tests/subagent-smart-router.test.ts`:
- lookup routes to `trivial` and local/off
- simple scout routes to flash/minimax/kimi class
- moderate debug routes to mid-tier reasoning model
- complex implementation routes to Sonnet/Codex class
- critical security/payment/auth migration routes to Sonnet/Opus/Codex class
- classifier refinement recomputes tier
- classifier failure preserves deterministic tier
- config threshold overrides affect tier
- profile `preferredTiers` affects candidate scoring
- explicit model/thinking remain hard overrides

Add/update follow-up tests:
- default spawned follow-up inherits model/thinking and records `inherited`
- `spawnRoutingMode: auto` reroutes from follow-up prompt
- explicit model/thinking override follow-up routing
- live follow-up does not attempt rerouting

Add/update persistence/render tests:
- `StateStore` preserves new routing fields
- expanded render shows tier/score/confidence
- batch job summary includes tier
- existing routing fixtures include required new fields

Run after implementation:

```bash
npm test
```

## Acceptance Criteria
- Subagent routing decisions expose `complexityTier` and `complexityScore`.
- Simple read-only tasks route to cheap/fast scoped models with low/off thinking.
- Complex and critical tasks route to high-quality scoped models with higher thinking.
- Existing explicit `model` and `thinkingLevel` overrides are preserved.
- Hybrid classifier remains bounded and non-blocking.
- Batch CSV/JSONL tools still route once per job.
- Spawned follow-up agents can inherit, reroute, explain-only, or disable routing by parameter.
- Routing explanations are visible in expanded agent/job output and persisted across reload.
- All tests pass.

## Assumptions
- Pi scoped models from `enabledModels` remain the candidate pool.
- No Pi core changes are required.
- Current model cost/context/reasoning metadata is trusted.
- Project-local router config is honored only when the project is trusted.







<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [ ] 1. Add public deterministic complexity tiers to routing types and decisions. _(pending)_
- [ ] 2. Refactor deterministic classification to compute a stable complexityScore and complexityTier. _(pending)_
- [ ] 3. Make model profiles and scoring tier-aware while preserving existing intent/cost/context logic. _(pending)_
- [ ] 4. Keep the current hybrid classifier default, but recompute the deterministic tier after classifier refinement. _(pending)_
- [ ] 5. Add controlled routing parameters to followup_task for spawned follow-up agents. _(pending)_
- [ ] 6. Update rendering, persistence, docs, and examples to show complexity tiers. _(pending)_
- [ ] 7. Expand router, follow-up, batch, persistence, and rendering tests. _(pending)_

<!-- pi-plan-progress:end -->
