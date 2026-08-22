# Model Router Configuration

Configuration precedence:

1. Package defaults.
2. `~/.pi/agent/model-router.json`.
3. Nearest trusted `.pi/model-router.json`.
4. Runtime/CLI overrides.

Legacy `subagent-router.json` files are read first and migrated in memory; the new file wins. Untrusted project configuration is ignored. Project files may narrow candidates/budgets or disable features, but should not be used to weaken machine privacy policy.

## Complete starter configuration

```json
{
  "version": 1,
  "enabled": true,
  "profile": "balanced",
  "granularity": "run",
  "includeModels": [],
  "excludeModels": ["model-router/*"],
  "fallbackWhenNoCandidates": "current_model",
  "complexity": {
    "thresholds": {
      "trivialMax": 0.2,
      "simpleMax": 0.38,
      "moderateMax": 0.58,
      "complexMax": 0.78
    },
    "qualityFloor": {
      "trivial": 0.2,
      "simple": 0.4,
      "moderate": 0.6,
      "complex": 0.78,
      "critical": 0.9
    },
    "reliabilityFloor": {
      "trivial": 0.9,
      "simple": 0.93,
      "moderate": 0.95,
      "complex": 0.97,
      "critical": 0.99
    }
  },
  "learning": {
    "enabled": true,
    "halfLifeDays": 30,
    "rawRetentionDays": 90,
    "projectOverlayMinSamples": 20,
    "projectOverlayFullWeightSamples": 50,
    "qualityPriorStrength": 4,
    "reliabilityPriorMean": 0.97,
    "reliabilityPriorStrength": 20,
    "autoExplorationRate": 0.05
  },
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
    "requiredCostOrLatencyImprovement": 0.1,
    "softCostLatencyRegression": 0.2
  },
  "critical": {
    "minimumReliabilityObservations": 50,
    "minimumHumanValidatorLabels": 20,
    "minimumReliabilityMean": 0.99,
    "minimumQualityMean": 0.9
  },
  "judge": {
    "enabled": false,
    "model": "anthropic/your-explicit-judge-model",
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
    "switchMinimumUtilityGain": 0.15,
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  "storage": {
    "enabled": true,
    "busyTimeoutMs": 250
  },
  "telemetry": {
    "enabled": false
  }
}
```

Unknown/invalid values fall back safely. Judge sampling is capped at 5% even if a larger number is supplied.

## Subscription policy

The `subscription_first` profile is driven by a `subscriptionPolicy` object in the router config.
It is sanitized on load: ranking entries without a configured family are dropped, family configs
not referenced by the ranking are dropped, empty/invalid members are dropped, provider ids are
trimmed and de-duplicated, and `familyCooldownMs` falls back to `900000`. If the profile is
selected but the policy is disabled or has no usable ranking, routing is skipped with the
`subscription_policy_unconfigured` warning and the current model is kept.

```json
{
  "profile": "subscription_first",
  "subscriptionPolicy": {
    "enabled": true,
    "ranking": ["codex", "claude", "grok", "kimi", "glm"],
    "includedProviders": ["openai-codex", "kimi-coding", "zai-official", "anthropic", "xai"],
    "meteredProviders": ["venice", "openrouter"],
    "familyCooldownMs": 900000,
    "families": {
      "codex": {
        "preferred": "openai-codex/gpt-5.6-sol",
        "members": ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"]
      },
      "claude": { "preferred": "anthropic/claude-sonnet-5", "members": ["anthropic/claude-sonnet-*"] },
      "grok": { "preferred": "xai/grok-4.6", "members": ["xai/grok-4.6", "xai/grok-4.5"] },
      "kimi": { "preferred": "kimi-coding/k3", "members": ["kimi-coding/k3", "kimi-coding/k3-256k", "openrouter/moonshotai/kimi-k3"] },
      "glm": { "preferred": "zai-official/glm-5.3", "members": ["zai-official/glm-5.3", "venice/zai-org-glm-5-2"] }
    }
  }
}
```

Semantics:

- **Included first**: a family is *included* when any eligible member's provider is in
  `includedProviders`; included families always beat metered ones regardless of rank.
- **Family membership anchors on the full `provider/id` ref**, so endpoint mirrors such as
  `openrouter/anthropic/claude-*` are not part of the official `anthropic` family.
- **Member walk**: the `preferred` member if still eligible, else members in list order. This is
  what promotes `kimi-coding/k3-256k` when `k3` fails the context check.
- **Failover**: only `model-router/subscription` retries within a turn. A pre-output failure
  removes every remaining candidate of that family (not just the one model) and walks the next
  family in rank order until visible output or exhaustion.
- **Hard constraints only**: modality, context window, max output tokens, and circuit/family
  cooldowns. Quality floors, reliability floors, cost/latency caps, Thompson sampling, explore
  coins, and critical-task lockout do not apply to this profile.
- **Pins win**: `/model` and `/router pin` override the policy; `/router unpin` re-selects
  `model-router/subscription`.

## Profile caps

Each entry under `profiles` supports:

```json
{
  "maxCostRatio": 1,
  "maxP95LatencyRatio": 1,
  "maxCostUsd": 0.1,
  "maxP95LatencyMs": 30000,
  "weights": {
    "quality": 0.55,
    "reliability": 0.2,
    "cost": 0.15,
    "latency": 0.1
  }
}
```

Absolute caps are never silently relaxed. Learned relative latency caps activate only when candidate and baseline have at least ten latency observations.

## Model prior overrides

Overrides accept exact refs or `*`/`?` patterns:

```json
{
  "modelProfiles": {
    "local-llamacpp/local-model": {
      "quality": 0.2,
      "speed": 0.9,
      "preferredIntents": ["lookup", "summarize"],
      "preferredTiers": ["trivial", "simple"]
    },
    "anthropic/claude-sonnet-*": {
      "quality": 0.9,
      "reliabilityPrior": 0.98,
      "preferredIntents": ["review", "implement", "complex"]
    }
  }
}
```

These values are weak cold-start priors, not permanent rankings.

## Environment

- `PI_CODING_AGENT_DIR` changes the Pi agent directory.
- `PI_MODEL_ROUTER_PROMETHEUS_URL` changes the fixed analysis Prometheus endpoint.
- `PI_MODEL_ROUTER_JAEGER_URL` changes the fixed analysis Jaeger endpoint.

OTel export currently defaults to loopback OTLP/HTTP when `telemetry.enabled` is true. See [`OBSERVABILITY.md`](./OBSERVABILITY.md).
