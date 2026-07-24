# @svaag/pi-model-router

Telemetry-informed, self-learning model routing for Pi, Subagent, and compatible SDK hosts.

The router keeps answer quality separate from operational reliability, starts from deterministic low-confidence model-family priors, and learns model/thinking-level quality, reliability, cost, latency, and first-token latency from privacy-safe local observations.

## Safety model

- Installation starts in `shadow`; it recommends without changing the current model.
- Only authenticated models matching trusted Pi `enabledModels` settings are candidates.
- Explicit model and thinking choices are hard overrides.
- Capability, context, output, quality, reliability, circuit, and configured budget limits are hard filters.
- Critical tasks are never explored and require strict human/validator evidence before learned exploitation.
- Automatic stages are `shadow → explore → auto`; statistically credible regressions roll back automatically.
- Missing data is unknown. Zero observations are “insufficient data,” never 0% success or zero cost.
- Prompts, outputs, code, paths, tool payloads, credentials, and raw errors are not persisted or exported.

## Install as a Pi package

```bash
pi install npm:@svaag/pi-model-router
```

For this repository checkout:

```bash
npm install
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/model-router" ~/.pi/agent/extensions/model-router
```

Add both real candidates and the opt-in virtual models to `enabledModels`, for example:

```json
{
  "enabledModels": [
    "local-llamacpp/local-model",
    "anthropic/claude-sonnet-*",
    "openai-codex/gpt-*",
    "model-router/*"
  ]
}
```

Pi does not currently expose the effective `--models`/`enabledModels` scope to extensions. The per-run adapter therefore reads only global and trusted-project settings and intersects them with `modelRegistry.getAvailable()`. If no settings scope is visible it fails closed and retains the current model.

Reload Pi, then inspect:

```text
/router status
/router profile balanced
/router rollout
```

A manual `/model` selection becomes a conservative pin. Use `/router unpin` to resume managed per-run routing.

## Routing granularities

### Managed per-run routing (default)

The extension routes once in `before_agent_start` and aggregates every provider turn through `agent_settled`. Shadow mode never calls `setModel`.

Profiles:

- `balanced` — quality/reliability first, with cost and learned p95 latency no worse than baseline by default.
- `quality_first` — maximize conservative quality within 2× baseline cost/latency.
- `cost_first` — minimize cost while preserving tier quality/reliability and ≤1.5× baseline latency.
- `latency_first` — minimize p95 latency while preserving quality/reliability and ≤1.25× baseline cost.

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

Feedback is accepted interactively in TUI mode and updates quality, not reliability.

### Opt-in per-provider-request routing

Select one of:

```text
model-router/balanced
model-router/quality
model-router/cost
model-router/latency
```

The virtual provider resolves the target model and auth for each request, delegates through Pi’s generic `streamSimple`, and streams the actual target provider/model/usage. It retries the next safe candidate exactly once only when the first upstream fails before text, thinking, or tool-call content. It never replays after visible output.

The Pi-selected reasoning level is a hard request override. Within tool loops, the last target receives a cache-affinity preference and is changed only for capability requirements or sufficient predicted utility gain.

## Persistence and learning

Default database:

```text
~/.pi/agent/model-router/router.db
```

The SQLite store uses WAL, foreign keys, transactional migrations, a 250 ms busy timeout, a 30-day statistics half-life, and 90-day raw metadata retention. Project overlays use an HMAC project ID and activate after sufficient observations.

Model arms are `(provider/model fingerprint, thinking level)`. A changed model capability/pricing fingerprint creates a new arm without deleting prior history.

Failure attribution matters:

- Model/provider failures update model reliability.
- Context overflow is a half-weight model failure.
- Host process, RPC, tool, policy, router, and user failures affect end-to-end health but do not penalize model reliability.
- Operational success alone never updates answer quality.

## Quality signals

- `/router feedback` or `engine.recordQuality(..., "user")`: weight 1.0.
- Host validator: weight 1.0 by default.
- Explicit correction: weak negative signal, weight 0.2.
- Opt-in LLM judge: weight 0.35, at most 5%, non-critical/non-sensitive only.

The judge requires an explicit concrete non-router model. Defaults are `$0.005` per evaluation, `$0.25` per UTC day, 30-second timeout, and no persisted judge content. Calibration disables judge learning after 30 overlapping labels if MAE exceeds 0.20 or absolute bias exceeds 0.15.

## Configuration, SDK, migration, and telemetry

- [`CONFIGURATION.md`](./CONFIGURATION.md)
- [`SDK.md`](./SDK.md)
- [`MIGRATION.md`](./MIGRATION.md)
- [`OBSERVABILITY.md`](./OBSERVABILITY.md)

## Development

```bash
npm install
npm test
npm run build --workspace @svaag/pi-model-router
cd model-router && npm pack --dry-run
```

Requires Node 22.19 or newer and Pi 0.82.x for the initial release.
