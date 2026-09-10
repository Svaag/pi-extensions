# Subagent / Agent Swarm Extension

Codex-inspired subagents for Pi, implemented as a harness-level extension rather than a Pi core patch.

This extension exposes interactive child-agent tools backed by isolated `pi --mode rpc --no-session` subprocesses.

## Tools

- `spawn_agent` — spawn a bounded child agent for a concrete task, or pass `tasks: [...]` to spawn several independent children in one tool execution.
- `wait_agent` — wait for one, many, or all subagents.
- `send_message` — steer/message a running subagent when live RPC steering is available; otherwise record an honest mailbox-only event.
- `followup_task` — queue or trigger additional work on an existing subagent, or spawn a follow-up child.
- `list_agents` — list active/recent agents.
- `list_agent_graph` — show the persistent parent/child task-path graph.
- `spawn_agents_on_csv` / `spawn_agents_on_jsonl` — fan out one worker per structured input row.
- `list_agent_jobs` / `wait_agent_job` / `cancel_agent_job` — inspect and control batch jobs.
- `export_agent_job_results` — export batch results to JSONL or CSV.
- `analyze_subagent_telemetry` — query a bounded metadata-only reliability/cost/UX snapshot from configured Prometheus and Jaeger endpoints.
- `interrupt_agent` — abort/kill a running child and preserve partial output.
- `close_agent` — release child process resources while preserving history.

## Safety defaults

- Child agents default to `writeMode: "read_only"`.
- Explicit `writeMode: "disjoint_scope"` authorizes spawning without a TUI confirmation, including for batch workers and unattended `/goal` runs; the child policy still limits writes to `allowedPaths`.
- When `model` is omitted, the child inherits the current main Pi model. Pass `model` to pin a different child model. Unspecified `thinkingLevel` is stepped down from the parent.
- Child subprocesses are launched with extension/resource discovery disabled, plus a controlled child policy extension.
- The child policy blocks raw reads of likely-binary/database files and caps oversized tool-result text before it enters the child LLM context.
- Read-only children can use `read` inside the child `cwd` (plus explicit `allowedPaths`) and conservative read-only `bash` commands, including simple `&&`/pipe chains and `sqlite3 -readonly` queries.
- `edit`/`write` are blocked unless `writeMode: "disjoint_scope"` and the path is under `allowedPaths`.
- `writeMode: "git_worktree"` is reserved for a later phase and currently rejected.
- Running agents are killed on session shutdown/reload.
- Completed RPC children remain reusable for live follow-ups for up to 30 minutes, then close automatically; they are also reaped early when process capacity is needed, and explicit `close_agent` calls release them sooner.
- Session history has no agent-count cap. Safety limits apply only to queued/running/live child processes, not completed or closed records.
- Explicit per-agent `timeoutMs` values below 5 minutes are ignored and normalized to the default 30-minute runtime to avoid accidental 120s cutoffs. Values above 30 minutes are capped at 30 minutes.
- On runtime timeout, the manager aborts the active child turn, disables child tools, and starts a partial-report turn using only retained context. It hard-aborts after a 60-second recovery grace period while preserving output tails.
- After restart/reload, previously running agents are reconstructed as `lost`, persisted with explicit `agent.lost` / `graph.edge_lost` events, and not claimed as controllable.

## Timeout semantics

| Setting | Default | Meaning |
|---|---:|---|
| Agent runtime `timeoutMs` | 30 minutes | Stops the delegated run. Explicit values are accepted from 5–30 minutes. |
| Timeout recovery grace | 60 seconds | Time allowed for aborting the active turn and generating a no-tools partial report before process termination. This is currently an internal limit. |
| `wait_agent.timeoutMs` | 60 seconds | Bounds only the parent tool's wait call. Expiry does not stop the child. |
| `wait_agent_job.timeoutMs` | 60 seconds | Bounds only the parent tool's batch wait call. Expiry does not cancel workers. |

The widget labels retained terminal counts as history. Timed-out records remain available through `/subagents full` and the list/graph tools, but do not keep the footer in an active-issue state.

## Persistence

The extension persists append-only lifecycle state with `pi.appendEntry()`:

- `agent.spawned`
- `agent.started`
- `agent.output_tail`
- `agent.succeeded`
- `agent.failed`
- `agent.interrupted`
- `agent.timeout_recovery`
- `agent.closed`
- `agent.lost`
- `agent.message`
- `agent.followup`
- `graph.edge_opened`
- `graph.edge_closed`
- `graph.edge_lost`
- batch job state and events such as `batch.started`, `batch.worker_started`, `batch.worker_result`, `batch.completed`, `batch.failed`, `batch.cancelled`, and `batch.exported`

It also persists latest agent records, parent/child graph edge records, and batch job records. This is enough to reconstruct historical state and display a graph after reload, but does not reattach to old subprocesses or resume in-flight batch workers.

## Child model

Children inherit the current main Pi model unless `model` is set on the spawn (or in an agent definition). `thinkingLevel` is an optional override; when omitted it is stepped down from the parent session. There is no automatic model routing.

## OpenTelemetry observability

The extension supports opt-in metadata-only traces, metrics, and structured logs over OTLP/HTTP. It is disabled unless `PI_SUBAGENT_OTEL_ENABLED=1`.

```bash
npm install --prefix subagent
export PI_SUBAGENT_OTEL_ENABLED=1
export PI_SUBAGENT_OTEL_ENDPOINT=http://127.0.0.1:4318
```

Use `/subagents telemetry` for exporter/query health and `analyze_subagent_telemetry` for fixed, read-only Prometheus/Jaeger analysis. Prompts, source paths, commands, tool payloads, output, raw errors, environment variables, and headers are never exported.

See [`OBSERVABILITY.md`](./OBSERVABILITY.md) and [`../observability/otel-collector.yaml`](../observability/otel-collector.yaml) for collector configuration, signal/query catalogs, retention, SLOs, and troubleshooting.

## Agent definitions

Optional markdown agents are discovered from:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md` when `agentScope` is `project` or `both`

Format:

```markdown
---
name: scout
description: Fast read-only codebase recon
tools: read,bash
model: claude-haiku-4-5
thinking: minimal
---

You are a fast reconnaissance agent. Inspect only; do not modify files.
```

Project-local agent definitions require confirmation by default.

## Examples

### Single research subagent

With `contextMode: "summary"`, the extension includes a capped, sanitized excerpt of recent visible parent conversation when no explicit `contextSummary` is provided. `last_n_turns` selects the requested number of visible user turns, while `full_sanitized` considers the full visible conversation before applying the context cap. Hidden reasoning and tool results are excluded from all generated context. Because `model` is omitted, the child inherits the current main Pi model.

```json
{
  "taskName": "inspect-auth-flow",
  "prompt": "Inspect the auth flow and summarize risks. Do not modify files.",
  "contextMode": "summary",
  "contextSummary": "We are reviewing authentication code for security risks.",
  "writeMode": "read_only"
}
```

### Explicit model override

```json
{
  "taskName": "critical-auth-review",
  "prompt": "Review auth and permission checks for security issues.",
  "model": "anthropic/claude-sonnet-4-6",
  "thinkingLevel": "high",
  "writeMode": "read_only"
}
```

The explicit model/thinking choice is preserved.

### Parallel read-only specialists

Use one multi-task `spawn_agent` call (or `spawn_agents_on_jsonl` / `spawn_agents_on_csv` for structured batches) instead of emitting several separate `spawn_agent` calls in the same assistant message.

```json
{
  "writeMode": "read_only",
  "tasks": [
    { "taskName": "review-routing", "prompt": "Review routing for risks." },
    { "taskName": "review-database", "prompt": "Review database layer for risks." }
  ]
}
```

Then wait for the workers:

```json
{ "all": true, "timeoutMs": 300000 }
```

### Follow-up task

```json
{
  "agentId": "agent_...",
  "prompt": "Now check whether your finding applies to the admin API too.",
  "mode": "live_if_supported"
}
```

If the original subprocess is no longer live, use `mode: "spawn_followup"`. Spawned follow-ups keep the original child model and thinking level unless `model` or `thinkingLevel` is set.

### CSV batch fan-out

```json
{
  "csvPath": "tasks.csv",
  "idColumn": "id",
  "promptTemplate": "For row {{id}}, inspect {{path}} and answer: {{question}}",
  "maxConcurrency": 4,
  "writeMode": "read_only"
}
```

Then use:

```json
{ "jobId": "job_...", "timeoutMs": 300000 }
{ "jobId": "job_...", "format": "jsonl", "outputPath": "batch-results.jsonl" }
```

## Current limitations

- Backend is subprocess RPC, not SDK in-process sessions.
- No true process reattachment after `/reload` or session restart.
- Batch job state is restored after reload, but in-flight queued/running workers are conservatively marked lost/failed rather than resumed.
- `report_agent_job_result` and output-schema validation are not implemented yet; the MVP records each worker's final summary/output/error.
- Worktree isolation and merge workflows are not implemented yet.

## Install

Symlink the extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /home/svag/Dev/pi-extensions/subagent ~/.pi/agent/extensions/subagent
```

Install the extension-local OTel runtime dependencies:

```bash
npm install --prefix /home/svag/Dev/pi-extensions/subagent
```

Then run `/reload` in Pi.
