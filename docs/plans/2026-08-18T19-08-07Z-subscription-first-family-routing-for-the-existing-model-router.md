---
created: 2026-08-18T19:08:07.727Z
source: pi-plan-mode
status: accepted-for-execution
---

# Subscription-first family routing for the existing model-router

## Summary

Extend `@svaag/pi-model-router` with a deterministic `subscription_first` profile. It will immediately route through a new virtual model, `model-router/subscription`, using a hard family ranking and a global included-vs-metered split. No new extension package. Other profiles stay on the current shadow/bandit safety model.

Locked policy:

- Rank: **Codex > Claude > Grok > Kimi > GLM**
- Included ($0 marginal): `openai-codex`, `kimi-coding`, `zai-official`, `anthropic`, `xai`
- Metered: `venice`, `openrouter`
- Pool: only those five families. Venice/OpenRouter are alternate endpoints for Kimi/GLM, not extra models
- Codex representative: `openai-codex/gpt-5.6-sol`
- Failover: same-turn, skip the **entire family**, then walk the remaining ranking until visible output or the list is exhausted
- Thinking: keep the existing complexity-based thinking picker
- Apply immediately (no shadow/explore gate for this profile)

## Implementation Steps

1. Add `subscription_first` plus a sanitized `subscriptionPolicy` config schema and defaults.
2. Implement family matching, included-first ranking, and family suppression in a new core module wired into the engine.
3. Add the `model-router/subscription` virtual model with same-turn whole-family failover.
4. Auto-select that virtual model from the Pi adapter when the profile is active and unpinned.
5. Add unit/adapter tests for policy, engine, virtual failover, config load, and Pi run auto-select.
6. Update router docs and write the local `~/.pi/agent` config so this machine actually uses the profile.

## Current state

- Router package already exists and is installed via symlink.
- `~/.pi/agent/model-router.json` has `"enabled": false` and `"excludeModels": ["model-router/*", "venice/*"]`.
- Default session model is `xai/grok-4.6` at `xhigh`.
- Catalog mismatches the request: `enabledModels` has `zai-official/glm-5.2` while `models.json` defines `zai-official/glm-5.3`; Grok override in `models.json` is `grok-4.5` while settings enable `grok-4.6`.
- Enabled models such as DeepSeek, Mistral, Meta Muse, Minimax, Hy3, Qwen, Gemini Flash, and local llama.cpp are **out of pool** for this profile.

## Selection algorithm

Use this exact order. Do not invent a quality/cost score for this profile.

1. Start from Pi `enabledModels` ∩ authenticated `getAvailable()`, after the existing `filterConfiguredCandidates` / preview exclusion.
2. Keep only candidates that match a configured family member pattern. Drop everything else, including Venice/OpenRouter models that are not Kimi or GLM.
3. Assign each candidate to exactly one family: the highest-ranked family whose `members` pattern matches. Overlaps go to the higher-ranked family.
4. Drop arms that fail **hard** constraints only:
   - missing modality
   - context window / maxTokens too small
   - circuit/family cooldown open
   - unauthenticated / unavailable
5. Do **not** apply quality floors, reliability floors, cost caps, latency caps, Thompson sampling, explore/shadow, or critical-task lockout for this profile.
6. Partition remaining families:
   - **included family** = at least one eligible member whose `provider` is in `includedProviders`
   - **metered family** = otherwise, and `provider` is treated as metered if it is in `meteredProviders` **or in neither list**
7. If any included family exists, ignore every metered family. Pick the included family with the best rank.
8. Else pick the metered family with the best rank.
9. Inside the winning family:
   - If the family was chosen as included, consider only included members.
   - If chosen as metered, consider only metered members.
   - Walk `members` in list order.
   - If `preferred` is still eligible in that subset, use it.
   - Else use the first remaining member in `members` order. This is what promotes `kimi-coding/k3-256k` when `k3` fails the context check.
10. Thinking level comes from existing `thinkingLevelsFor(candidate, complexityTier)` (no explicit thinking override from the virtual model).
11. User `/model` or `/router pin` remains a hard override. `/router unpin` resumes this policy.

Worked examples:

- Codex official up → always `openai-codex/gpt-5.6-sol`, even if Claude/Grok are “better” or Venice GLM is cheaper.
- Codex 429 before output → Codex family suppressed; same request retries Claude.
- Claude also fails before output → Grok, then Kimi official, then Z.AI GLM.
- All included families unavailable → `openrouter/moonshotai/kimi-k3`, then Venice/OpenRouter GLM in members order.
- After a Codex failure, do **not** try another Codex sibling or a metered Codex clone. The whole family is out.

## Failover and cooldown

`model-router/subscription` is the only activation path that can same-turn retry.

- Virtual provider already retries before visible text/thinking/tool-call content. Keep that “no replay after visible output” rule.
- For this virtual model only, a pre-output auth/upstream failure removes **every remaining candidate in that family**, not just the one model.
- Attempt budget for `subscription` is `max(1, number of remaining families)`, not `virtualProvider.maxFallbacksBeforeOutput + 1`. Other virtual models stay at one fallback.
- After a pre-output `provider`/`model` failure, call a new engine method `suppressFamily(familyId)`:
  - Immediately open the existing circuit-breaker rows for every fingerprint of that family seen on the failed decision.
  - `openUntil = now + subscriptionPolicy.familyCooldownMs`.
  - Default cooldown is `900000` (15 minutes).
  - Do not change the 3-strike circuit behavior for other profiles.
- Also keep an in-memory `suppressedFamilies` set on the virtual provider for the current session so a store outage still skips the family on later requests. Reset it in the existing `resetSession()`.
- Cache affinity may keep the last successful **member** only if that family is still the policy winner and not suppressed. It must never resurrect a cooled-down family or beat included-first ranking.

## Config schema

Add to `RouterConfig` in `model-router/src/config/schema.ts`:

```ts
export interface RouterFamilyConfig {
  preferred?: string;
  members: string[]; // exact refs or existing * / ? patterns
}

export interface RouterSubscriptionPolicy {
  enabled: boolean;
  ranking: string[];
  includedProviders: string[];
  meteredProviders: string[];
  families: Record<string, RouterFamilyConfig>;
  familyCooldownMs: number;
}
```

Package defaults in `defaults.ts`:

- `profile` stays `"balanced"`.
- `subscriptionPolicy.enabled = false`.
- `ranking`, provider lists, and `families` empty.
- `familyCooldownMs = 900_000`.
- Add `profiles.subscription_first` with dummy weights `{ quality: 0, reliability: 0, cost: 1, latency: 0 }` and **no** cost/latency caps. Selection does not use these weights.

`load.ts` / `mergeRouterConfig` must sanitize the new object:

- unknown profile names in `ranking` that have no `families` entry are dropped
- empty/invalid member strings dropped
- provider ids trimmed, de-duplicated, case-sensitive as Pi provider ids
- `familyCooldownMs` integer, min 0, fallback 900000
- if `profile === "subscription_first"` but policy is disabled or `ranking` is empty after sanitize, keep the profile value but the engine must not apply routing and must emit warning `subscription_policy_unconfigured`

Bump `POLICY_VERSION` in `ModelRoutingEngine.ts` to `1.1.0`.

## User catalog (write this exact policy into `~/.pi/agent/model-router.json`)

```json
{
  "enabled": true,
  "profile": "subscription_first",
  "excludeModels": ["model-router/*"],
  "telemetry": { "enabled": true },
  "subscriptionPolicy": {
    "enabled": true,
    "ranking": ["codex", "claude", "grok", "kimi", "glm"],
    "includedProviders": ["openai-codex", "kimi-coding", "zai-official", "anthropic", "xai"],
    "meteredProviders": ["venice", "openrouter"],
    "familyCooldownMs": 900000,
    "families": {
      "codex": {
        "preferred": "openai-codex/gpt-5.6-sol",
        "members": [
          "openai-codex/gpt-5.6-sol",
          "openai-codex/gpt-5.6-luna",
          "openai-codex/gpt-5.6-terra",
          "openai-codex/gpt-daybreak-blue-latest"
        ]
      },
      "claude": {
        "preferred": "anthropic/claude-sonnet-5",
        "members": ["anthropic/claude-sonnet-*"]
      },
      "grok": {
        "preferred": "xai/grok-4.6",
        "members": ["xai/grok-4.6", "xai/grok-4.5"]
      },
      "kimi": {
        "preferred": "kimi-coding/k3",
        "members": [
          "kimi-coding/k3",
          "kimi-coding/k3-256k",
          "openrouter/moonshotai/kimi-k3"
        ]
      },
      "glm": {
        "preferred": "zai-official/glm-5.3",
        "members": [
          "zai-official/glm-5.3",
          "zai-official/glm-5.2",
          "venice/zai-org-glm-5-2",
          "openrouter/z-ai/glm-5.2"
        ]
      }
    }
  }
}
```

Also update `~/.pi/agent/settings.json`:

- Add `model-router/subscription` to `enabledModels` so `setModel` can select it.
- Add `zai-official/glm-5.3` next to the existing `zai-official/glm-5.2` so the preferred GLM can exist.
- Do **not** remove other enabled models; the profile filter ignores them.
- Optionally set `defaultModel` to `subscription` and `defaultProvider` to `model-router` so new sessions start on the virtual model before the first `before_agent_start`. If that is set, keep `defaultThinkingLevel` as `xhigh`; the engine still remaps thinking by complexity for the **target** model.

Do not copy API keys from `models.json` into the repo or docs.

## Code structure

New file `model-router/src/core/families.ts`:

- `familyIdFor(candidate, policy) => string | undefined`
- `billingClass(candidate, policy) => "included" | "metered"`
- `filterFamilyCandidates(candidates, policy)`
- `pickSubscriptionArm({ candidates, profiles, constraints, policy, cacheAffinityModel })`
- `familyMembers(familyId, candidates, policy)`
- Pure functions, no I/O. Export from `model-router/src/index.ts`.

Engine changes in `ModelRoutingEngine.route()` when `profile === "subscription_first"` and policy is configured:

- After normal candidate filter, apply `filterFamilyCandidates`.
- Build arms/thinking as today.
- Evaluate constraints with a flag/path that skips quality/reliability/cost/latency reasons (`evaluateArmConstraints` should take `ignoreSoftFloors?: boolean` or a `mode: "standard" | "subscription"` argument — do not fork the whole function).
- Skip posterior sampling and explore/treatment coin flips.
- Sort/select via `pickSubscriptionArm`, not `objectiveScore`.
- Still populate `decision.score` for display: `included ? 2000 - rankIndex : 1000 - rankIndex`, plus `+0.1` if preferred member, `+0.01` if cache-affinity member.
- Set `applied = true` unless disabled, `forceMode === "off"|"explain"`, or an explicit model pin is present. Treat this like `forceMode: "auto"` so shadow rollout cannot block it.
- Put `family:<id>` and `billing:included|metered` in `decision.explanation` and the winning arm `notes`.
- `arm` is `"forced"` for this profile so rollout promotion math for `balanced` is not polluted.

`evaluateArmConstraints` stays the source of capability/circuit checks.

New engine API:

```ts
suppressFamily(familyId: string, decision: RouteDecision, untilMs?: number): void
```

Used by the virtual provider after a pre-output failure. Safe no-op if store is down.

## Pi adapters

`VirtualRouterProvider.ts`

- Register model `{ id: "subscription", name: "Router · Subscription", reasoning: true, input: ["text", "image"], cost all 0, contextWindow 128000, maxTokens 16384 }`.
- `PROFILE_BY_MODEL.subscription = "subscription_first"`.
- For `routerModel.id === "subscription"`:
  - do **not** pass `options.reasoning` as `explicitThinkingLevel` (that would freeze thinking at the session `xhigh` and defeat complexity mapping).
  - still pass the engine’s `selectedThinkingLevel` into `delegate(... { reasoning })`.
  - on failure before visible content, drop the whole family from `remaining`.
  - walk remaining families until success or exhaustion.
  - call `suppressFamily` + `recordFallback(..., "family", ...)`.

`PiRunRouter.ts`

- If profile is `subscription_first`, there is no pin, and `currentModel !== "model-router/subscription"`, `setModel` the virtual model using the existing suppression window so `model_select` does not create a pin.
- If current model is already `model-router/*`, keep the current early-return that skips per-run concrete `setModel`. The virtual provider owns the real target.
- `/router unpin` with this profile must re-select `model-router/subscription`.
- Footer continues to use `formatDecision`, which will show the concrete target after each request.

`commands.ts` and `extension.ts`

- Add `subscription_first` to every `PROFILES` array and completions.
- CLI `--router-profile subscription_first` must be accepted.

Do not change Subagent host semantics beyond the shared engine. If Subagent uses `subscription_first` from the same config, it automatically gets the same ranking.

## Tests

Add `tests/model-router-subscription-policy.test.ts` covering:

- Included Codex beats included Claude and every metered endpoint.
- After Codex is ineligible, Claude wins.
- No included family left → OpenRouter Kimi before Venice GLM.
- Preferred Codex is `gpt-5.6-sol`; luna/terra/daybreak only if sol is missing or fails context.
- `kimi-coding/k3` wins when it fits; `k3-256k` wins when estimated tokens exceed k3 `contextWindow`.
- Image request drops text-only GLM and still picks an image-capable included family.
- `openrouter/minimax/minimax-m3` and `local-llamacpp/local-model` never win under this profile even if they are the only cheap/authenticated extras in the candidate list.
- Quality floor would have rejected GLM/Kimi on a complex/critical prompt; they still remain eligible if they are the correct next family.
- Unconfigured policy does not apply and keeps the current model.
- `mergeRouterConfig` accepts/sanitizes `subscriptionPolicy` and a new profile name.

Extend `tests/model-router-virtual-provider.test.ts`:

- `model-router/subscription` on first-family pre-output error retries the next **family**, not a sibling in the same family.
- Visible output still disables fallback.
- Non-subscription virtual models still retry only once and still drop only the one model.

Extend `tests/model-router-pi-run.test.ts`:

- With `profile: "subscription_first"` and a configured policy, the adapter `setModel`s `model-router/subscription` immediately (no shadow wait).
- A user `model_select` pin still wins; `unpin` returns to the virtual model.

Extend `tests/model-router-engine.test.ts`:

- Existing shadow test must still pass for default `balanced`.
- New test: `subscription_first` applies on a fresh store with zero observations.

Keep `npm test` (Node test runner + type stripping) as the acceptance command. Also run `npm run build:model-router`.

## Docs

Update, do not create a second extension README:

- `model-router/README.md`: list `subscription_first` and `model-router/subscription`; state that this profile is deterministic, immediate, and family-based.
- `model-router/CONFIGURATION.md`: document `subscriptionPolicy` and the starter JSON above (without secrets).
- `model-router/MIGRATION.md`: one paragraph that v1.1 adds an opt-in profile; defaults remain `balanced` + shadow.
- `model-router/SDK.md` only if public `RoutingProfile` examples are enumerated there.

## Out of scope

- A second standalone extension
- Live Arena / OpenRouter endpoint leaderboards
- Quota/credit APIs or remaining-balance polling
- Changing `balanced` / `quality_first` / `cost_first` / `latency_first` defaults
- Enabling Venice/OpenRouter non-family models
- Mid-request failover after visible tokens
- Rewriting `models.json` keys or committing any credentials
- Pi core patches

## Assumptions

- “Included” is a static provider list, not live subscription-status detection.
- Official GLM 5.3 is the preferred GLM; 5.2 remains a same-family fallback if 5.3 is missing from the registry.
- Grok preferred is `xai/grok-4.6`; `grok-4.5` is only a fallback member.
- Walking every remaining family on same-turn failure is intended (not a single skip).
- Learning/telemetry may still record cost/latency/quality for this profile, but must not change the pick.
- Package defaults stay safe for other users; only this machine’s `~/.pi/agent/model-router.json` turns the policy on.







<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Add subscription_first plus a sanitized subscriptionPolicy config schema and defaults. _(pending)_
- [x] 2. Implement family matching, included-first ranking, and family suppression in a new core module wired into the engine. _(pending)_
- [x] 3. Add the model-router/subscription virtual model with same-turn whole-family failover. _(pending)_
- [x] 4. Auto-select that virtual model from the Pi adapter when the profile is active and unpinned. _(pending)_
- [x] 5. Add unit/adapter tests for policy, engine, virtual failover, config load, and Pi run auto-select. _(pending)_
- [ ] 6. Update router docs and write the local ~/.pi/agent config so this machine actually uses the profile. _(~in progress: docs updated; local ~/.pi/agent config intentionally not written yet)_

<!-- pi-plan-progress:end -->
