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
