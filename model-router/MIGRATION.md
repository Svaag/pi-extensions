# Migration from the Embedded Subagent Router

The promoted Subagent Extension previously owned `RouterConfig`, `ScopedModels`, and `SmartRouter`. Production routing now goes through `@svaag/pi-model-router`; the old deterministic modules remain temporarily as compatibility/reference code for historical tests.

## Configuration

Old locations are still read:

```text
~/.pi/agent/subagent-router.json
<nearest trusted project>/.pi/subagent-router.json
```

Move settings to:

```text
~/.pi/agent/model-router.json
<nearest trusted project>/.pi/model-router.json
```

Mappings:

| Legacy | Shared v1 |
|---|---|
| `objective` | `profile` |
| `complexity.tierQualityFloor` | `complexity.qualityFloor` |
| `modelProfiles` / `profiles` | `modelProfiles` |
| classifier `enabled: "auto"` | disabled unless explicitly enabled in v1 |

The shared config wins when both files exist. Migration is in-memory; user files and old session entries are not rewritten.

## Routing behavior

- Omitted Subagent `routingMode` now means managed rollout. It initially behaves like inherit because the default stage is shadow, but can route after automatic promotion.
- Explicit `routingMode: "auto"` remains an immediate forced route.
- `off` inherits the explicit/current model.
- `explain` records a recommendation without applying it.
- `latency_first` and thinking level `max` are now accepted; `max` is explicit-only.
- Explicit model/thinking values remain hard overrides.

## Persisted sessions

All new shared-router fields are optional in Subagent records:

- `routeId`
- `batchDecisionId`
- `policyVersion`
- baseline/executed model and thinking
- rollout stage and arm
- failure domain

Legacy records restore without those fields. They can be displayed and followed up, but cannot receive `rate_agent` feedback because there is no route ID.

## Batches and follow-ups

A batch still selects one model/thinking pair per job. Each worker now receives a unique bookkeeping route so outcomes contribute independently to learning. Forced/bookkeeping routes update arm statistics but do not bias automatic treatment/control promotion.

Live and spawned follow-ups create new route observations while retaining the current process/model unless rerouting is explicitly requested.

## SQLite schema

The database uses versioned `PRAGMA user_version` migrations. Migration from v1 adds rollout scope and arm dimensions transactionally. A newer or corrupt schema fails closed: Pi/Subagent continues on the current model, learning and promotion stop, and the database is not overwritten automatically.

## Operational rollout

Existing OTel data is not imported as learned state. In particular, zero completed turns and an early process failure seed no model conclusions. Installations begin in shadow and must satisfy the configured local observation/quality/coverage gates.
