---
created: 2026-06-30T03:38:51.897Z
source: pi-plan-mode
status: accepted-for-execution
---

# Smart Agentic Intent Router for Pi Subagents

## Summary
Build a routing layer inside `/home/svag/Dev/pi-extensions/subagent` that automatically selects a suitable scoped model and thinking level for each subagent when the caller does not explicitly choose a model. The router will optimize for the selected default policy: **balanced cost/reward/quality**, using a **deterministic rubric first** and an **optional cheap/local classifier only for ambiguous cases**.

## Grounding / Current State
- Active extension: `/home/svag/Dev/pi-extensions/subagent`
- Current `spawn_agent` accepts optional `model`, but if omitted the child Pi process inherits Pi defaults.
- `SubprocessRpcBackend.ts` passes `--model` only when `record.model` exists; it never passes `--thinking`.
- Current global default is `openai-codex/gpt-5.5` with `defaultThinkingLevel: xhigh`, which explains why cheap/grunt subagents can accidentally run at main-thread effort.
- Current scoped models come from `~/.pi/agent/settings.json` `enabledModels`; the router should use those as its candidate pool.

## Decisions Locked
- Default objective: **balanced cost/reward/quality**.
- Router style: **hybrid** — deterministic scoring always; optional classifier only when ambiguous.
- Explicit model choices are **hard model-identity overrides**.
- Rollout: **on automatically when model is omitted**.
- Explicit thinking choices, when provided, are also hard overrides.
- For explicit model without explicit thinking, the router may still choose an appropriate child thinking level unless routing is disabled.

## Implementation Steps
1. Add routing types, config loading, scoped-model discovery, and model profiling.
2. Implement deterministic task intent classification and model/thinking scoring.
3. Add optional ambiguous-case classifier support with safe cost/privacy limits.
4. Wire routing into `spawn_agent` and batch fan-out tools before `AgentManager.spawnAgent`.
5. Persist and render routing decisions in agent/job records and summaries.
6. Update child process launch to pass routed `--model` and `--thinking`.
7. Add tests for routing, explicit overrides, batch behavior, persistence, and backend CLI args.
8. Update `subagent/README.md` with router behavior, config, and examples.

## Detailed Specification

### Public Tool/API Changes
Update `spawn_agent`, `spawn_agents_on_csv`, and `spawn_agents_on_jsonl` schemas:

```ts
routingMode?: "auto" | "off" | "explain"; // default "auto"
routingProfile?: "balanced" | "cost_first" | "quality_first"; // default from config, initially "balanced"
thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; // explicit override
```

Behavior:
- `model` present: do not change model.
- `thinkingLevel` present: do not change thinking.
- `routingMode: "off"`: preserve current behavior except pass explicit `thinkingLevel` if supplied.
- `routingMode: "explain"`: compute and store/render the routing decision but do not apply it.
- `routingMode: "auto"` and no explicit model: select model from scoped models.

Agent markdown frontmatter additions:

```md
---
model: anthropic/claude-sonnet-4-6
thinking: medium
router: auto
---
```

### New/Updated Types
In `subagent/core/AgentTypes.ts`:

```ts
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type RoutingMode = "auto" | "off" | "explain";
export type RoutingObjective = "balanced" | "cost_first" | "quality_first";

export interface RoutingDecision {
  mode: RoutingMode;
  objective: RoutingObjective;
  applied: boolean;
  reason:
    | "selected"
    | "explicit_model"
    | "explicit_thinking"
    | "disabled"
    | "explain_only"
    | "no_scoped_models"
    | "no_available_models"
    | "fallback_current_model";
  selectedModel?: string;          // provider/id
  selectedThinkingLevel?: ThinkingLevel;
  explicitModel?: string;
  explicitThinkingLevel?: ThinkingLevel;
  intent: string;
  risk: number;
  complexity: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  explanation: string;
  candidates: Array<{
    model: string;
    score: number;
    estimatedCostUsd: number;
    quality: number;
    notes: string[];
  }>;
}
```

Add to `AgentRecord`, `SpawnAgentRequest`, `BatchJob`, and `CreateBatchJobRequest`:
```ts
thinkingLevel?: ThinkingLevel;
routingMode?: RoutingMode;
routingProfile?: RoutingObjective;
routingDecision?: RoutingDecision;
```

### New Files
Add:
- `subagent/core/RouterConfig.ts`
- `subagent/core/ScopedModels.ts`
- `subagent/core/SmartRouter.ts`

### Config
Load optional config from:
1. `~/.pi/agent/subagent-router.json`
2. nearest trusted project `.pi/subagent-router.json`

Default config:

```json
{
  "enabled": true,
  "objective": "balanced",
  "candidateSource": "scoped",
  "fallbackWhenNoScopedModels": "current_model",
  "showExplanations": true,
  "zeroCostPolicy": "trust",
  "classifier": {
    "enabled": "auto",
    "requireLocalOrZeroCost": true,
    "maxEstimatedCostUsd": 0.001,
    "maxPromptChars": 4000,
    "timeoutMs": 10000
  }
}
```

Read scoped models from effective Pi settings `enabledModels`; use project `.pi/settings.json` only if trusted.

### Deterministic Intent Taxonomy
Classify each task into one primary intent:

- `lookup`: targeted find/list/extract/read-only search
- `scout`: broad codebase reconnaissance
- `summarize`: summarize/transform/compress context
- `batch_simple`: CSV/JSONL fan-out or repetitive row work
- `plan`: design or implementation planning
- `review`: code/security/quality review
- `debug`: diagnose tests/logs/errors
- `implement`: write-capable or code-changing task
- `complex`: ambiguous high-risk multi-step task

Inputs:
- `taskName`
- `prompt`
- `agentName`
- `writeMode`
- `tools`
- `contextMode`
- batch metadata
- prompt length / estimated context size

High-risk keyword boosts:
`security`, `auth`, `crypto`, `wallet`, `payment`, `permission`, `secret`, `migration`, `schema`, `prod`, `data loss`, `concurrency`, `race`, `refactor`, `architecture`, `failing`, `review`.

Low-risk keyword reductions:
`list`, `find`, `locate`, `grep`, `search`, `summarize`, `inventory`, `inspect`, `read-only`, `map`.

### Model Profiles
Build profiles from model metadata plus pattern defaults. Exact profile overrides win over glob overrides.

Use current scoped defaults:

| Pattern | Quality | Speed | Preferred use |
|---|---:|---:|---|
| `local-llamacpp/local-model` | 0.20 | 0.85 | lookup, simple summarize |
| `openrouter/google/gemini-*-flash` | 0.45 | 0.90 | batch_simple, lookup, light scout |
| `openrouter/minimax/minimax-m3` | 0.55 | 0.75 | long-context scout/summarize |
| `kimi-coding/kimi-for-coding` | 0.68 | 0.70 | coding scout/debug standard |
| `zai-official/glm-5.2` | 0.72 | 0.70 | large-context scout/plan |
| `openrouter/deepseek/deepseek-v4-pro` | 0.78 | 0.60 | reasoning/debug/plan |
| `anthropic/claude-sonnet-*` | 0.90 | 0.55 | review, implement, complex |
| `anthropic/claude-opus-*` | 0.98 | 0.40 | exceptional high-risk expert work |
| `openai-codex/gpt-*` | 0.95 | 0.45 | exceptional code-heavy work |

Fallback inference:
- reasoning model: +0.10 quality
- `flash`, `haiku`, `mini`, `small`, `8b`, `local`: lower quality, higher speed
- `opus`, `sonnet`, `pro`, `gpt-5`, `deepseek`, `glm`, `kimi`: higher quality

### Scoring
Estimate:
- `estimatedInputTokens = ceil((prompt + inherited context + agent definition).length / 4) + 1000`
- output budget:
  - lookup/summarize: 1000
  - scout/batch: 2000
  - debug/plan/review: 3000
  - implement/complex: 4000

Filter candidates:
- must be in scoped models
- must be available/authenticated via `ctx.modelRegistry.getAvailable()`
- must fit estimated context if possible
- if none fit context, choose largest context and include warning

Balanced score:

```text
score =
  0.50 * qualityFit +
  0.25 * costFit +
  0.15 * speedFit +
  0.10 * contextFit +
  roleBoost -
  overkillPenalty -
  riskPenalty
```

Other profiles:
- `cost_first`: quality 0.35, cost 0.40, speed 0.15, context 0.10
- `quality_first`: quality 0.70, cost 0.10, speed 0.10, context 0.10

Prevent premium overkill:
- For `lookup`, `summarize`, `batch_simple`, subtract penalty when model quality exceeds required quality by >0.30 and estimated cost is >2x median candidate cost.

### Thinking Level Selection
If model does not support reasoning: `off`.

Defaults:
- `lookup`, `batch_simple`: `off`
- `summarize`, light `scout`: `minimal`
- normal `scout`, moderate `debug`: `low`
- `plan`, `review`, complex `debug`: `medium`
- `implement`, high-risk security/review/design: `high`
- `xhigh`: only for explicit thinking or exceptional `quality_first` high-risk work

Backend change in `SubprocessRpcBackend.ts`:
```ts
if (record.model) args.push("--model", record.model);
if (record.thinkingLevel) args.push("--thinking", record.thinkingLevel);
```

### Hybrid Classifier
Only run classifier when:
- deterministic confidence is low, or top two model scores differ by `< 0.08`
- classifier config is enabled/auto
- an eligible local/zero-cost/very-cheap scoped classifier model exists
- estimated classifier cost is under config cap

Classifier prompt:
- receives sanitized/truncated task prompt and metadata only
- asks for strict JSON:
```json
{
  "intent": "lookup|scout|summarize|batch_simple|plan|review|debug|implement|complex",
  "risk": 0.0,
  "complexity": 0.0,
  "confidence": 0.0,
  "reason": "short explanation"
}
```

If classifier fails, times out, or returns low confidence, ignore it and use deterministic result.

### Data Flow
`spawn_agent`:
1. Resolve agent definition/frontmatter.
2. Build routing request from params + agent + context summary size.
3. If explicit model: preserve model.
4. If no explicit model and `routingMode:auto`: route from scoped candidates.
5. Pass `model`, `thinkingLevel`, and `routingDecision` into `AgentManager.spawnAgent`.

Batch tools:
1. Parse rows.
2. Interpolate first up to 3 sample prompts.
3. Route once per job using representative prompt.
4. Store job-level `model`, `thinkingLevel`, and `routingDecision`.
5. Each worker inherits those fields.

Follow-up spawned agents:
- inherit original child model/thinking unless caller explicitly overrides in a later API expansion.

### Rendering / Observability
Update agent summaries to show:
```text
model: provider/id · thinking: low · routed: lookup balanced
```

Expanded view includes:
- selected model
- selected thinking
- top 3 candidates with scores
- estimated cost
- routing explanation
- reason if not applied

Persist in existing `subagent-agent-state` and batch job state via the record/job fields.

### Failure Modes
- No scoped models: use current parent model if available and route thinking; otherwise preserve current behavior.
- `ctx.modelRegistry.getAvailable()` fails: preserve current behavior and store `reason: "no_available_models"`.
- Selected model later fails in child due provider/auth issue: child failure is surfaced normally; routing decision remains available.
- Project router config ignored unless project is trusted.
- Classifier never blocks spawning; deterministic fallback always exists.

## Test Plan
Add `tests/subagent-smart-router.test.ts`:
- routes simple lookup to low-cost scoped model with `off`/`minimal`
- routes security review to Sonnet/high-quality model with `medium`/`high`
- routes write-capable task away from weak/local models
- explicit model is preserved
- explicit thinking is preserved
- no scoped models falls back safely
- overkill penalty prevents Opus/GPT for trivial lookup
- classifier failure falls back to deterministic route

Update existing tests:
- `subagent-agent-manager.test.ts`: record stores `thinkingLevel` and `routingDecision`
- `subagent-subprocess-rpc-backend.test.ts`: backend CLI includes `--model` and `--thinking`
- `subagent-batch-job-manager.test.ts`: batch workers inherit routed model/thinking
- `subagent-state-store.test.ts`: persisted/restored routing decisions survive reload
- `agents.ts` tests or new test: agent frontmatter parses `thinking` and `router`

Run:
```bash
cd /home/svag/Dev/pi-extensions
npm test
```

## Acceptance Criteria
- A `spawn_agent` call without `model` no longer inherits `openai-codex/gpt-5.5:xhigh` by default.
- Simple read-only/grunt subagents route to cheaper scoped models and low/off thinking.
- Complex review/implementation tasks route to high-quality models.
- Explicit `model` is never replaced.
- Explicit `thinkingLevel` is never replaced.
- Batch fan-out uses the router automatically when model is omitted.
- Routing decisions are visible in summaries and persisted in session state.
- All current tests pass plus new router coverage.

## Assumptions
- Scoped model source is effective `enabledModels` from Pi settings.
- Model cost metadata from Pi/model config is trusted, including zero-cost entries.
- The first implementation should not require modifying Pi core.
- The optional classifier is bounded and non-critical; deterministic routing remains the source of truth.












<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [ ] 1. Add routing types, config loading, scoped-model discovery, and model profiling. _(pending)_
- [ ] 2. Implement deterministic task intent classification and model/thinking scoring. _(pending)_
- [ ] 3. Add optional ambiguous-case classifier support with safe cost/privacy limits. _(pending)_
- [ ] 4. Wire routing into spawn_agent and batch fan-out tools before AgentManager.spawnAgent. _(pending)_
- [ ] 5. Persist and render routing decisions in agent/job records and summaries. _(pending)_
- [ ] 6. Update child process launch to pass routed --model and --thinking. _(pending)_
- [ ] 7. Add tests for routing, explicit overrides, batch behavior, persistence, and backend CLI args. _(pending)_
- [ ] 8. Update subagent/README.md with router behavior, config, and examples. _(pending)_

<!-- pi-plan-progress:end -->
