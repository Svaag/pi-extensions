# Subagent / Agent Swarm Extension

Codex-inspired subagents for Pi, implemented as a harness-level extension rather than a Pi core patch.

This extension exposes interactive child-agent tools backed by isolated `pi --mode rpc --no-session` subprocesses.

## Tools

- `spawn_agent` — spawn a bounded child agent for a concrete task.
- `wait_agent` — wait for one, many, or all subagents.
- `send_message` — steer/message a running subagent when live RPC steering is available; otherwise record an honest mailbox-only event.
- `followup_task` — queue or trigger additional work on an existing subagent, or spawn a follow-up child.
- `list_agents` — list active/recent agents.
- `list_agent_graph` — show the persistent parent/child task-path graph.
- `spawn_agents_on_csv` / `spawn_agents_on_jsonl` — fan out one worker per structured input row.
- `list_agent_jobs` / `wait_agent_job` / `cancel_agent_job` — inspect and control batch jobs.
- `export_agent_job_results` — export batch results to JSONL or CSV.
- `interrupt_agent` — abort/kill a running child and preserve partial output.
- `close_agent` — release child process resources while preserving history.

## Safety defaults

- Child agents default to `writeMode: "read_only"`.
- When `model` is omitted, the Smart Agentic Intent Router selects a child model and thinking level from Pi's scoped model list instead of inheriting the parent model/effort.
- Child subprocesses are launched with extension/resource discovery disabled, plus a controlled child policy extension.
- Read-only children can use `read` inside the child `cwd` (plus explicit `allowedPaths`) and conservative read-only `bash` commands.
- `edit`/`write` are blocked unless `writeMode: "disjoint_scope"` and the path is under `allowedPaths`.
- `writeMode: "git_worktree"` is reserved for a later phase and currently rejected.
- Running agents are killed on session shutdown/reload.
- Explicit per-agent `timeoutMs` values below 5 minutes are ignored and normalized to the default 30-minute runtime to avoid accidental 120s cutoffs.
- On runtime timeout, the manager first asks the child to stop tools and emit a partial final summary, then hard-aborts after a bounded recovery grace period while preserving output tails.
- After restart/reload, previously running agents are reconstructed as `lost`, persisted with explicit `agent.lost` / `graph.edge_lost` events, and not claimed as controllable.

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

It also persists latest agent records, parent/child graph edge records, and batch job records. Routing decisions are stored with agent/job records so `/subagents`, `list_agents`, and expanded render views can explain which model was chosen and why. This is enough to reconstruct historical state and display a graph after reload, but does not reattach to old subprocesses or resume in-flight batch workers.

## Smart Agentic Intent Router

The router is enabled by default for `spawn_agent`, `spawn_agents_on_csv`, and `spawn_agents_on_jsonl` when `model` is omitted.

Routing inputs include task text, `taskName`, `agentName`, write mode, tools, context mode, and batch metadata. The router classifies intent (`lookup`, `scout`, `summarize`, `batch_simple`, `plan`, `review`, `debug`, `implement`, or `complex`), estimates task size/risk, scores available scoped models, and launches the child with `--model` plus `--thinking`.

Defaults:

- Objective: `balanced` cost/reward/quality.
- Explicit `model` is a hard override; it is preserved.
- Explicit `thinkingLevel` is a hard override; it is preserved.
- If `model` is explicit but `thinkingLevel` is omitted, the router may still pick a task-appropriate thinking level.
- If no scoped models are available, it falls back to the current parent model when configured to do so.
- Optional classifier support is bounded: it only runs for ambiguous tasks, uses a local/zero-cost or very cheap scoped model, receives a sanitized/truncated classifier prompt, and deterministic routing remains the fallback.

Tool parameters:

```json
{
  "routingMode": "auto",
  "routingProfile": "balanced",
  "thinkingLevel": "low"
}
```

- `routingMode`: `auto` (default), `off`, or `explain`.
- `routingProfile`: `balanced` (default), `cost_first`, or `quality_first`.
- `thinkingLevel`: optional explicit `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

Optional config files:

- `~/.pi/agent/subagent-router.json`
- nearest trusted `.pi/subagent-router.json`

Example:

```json
{
  "enabled": true,
  "objective": "balanced",
  "fallbackWhenNoScopedModels": "current_model",
  "classifier": {
    "enabled": "auto",
    "requireLocalOrZeroCost": true,
    "maxEstimatedCostUsd": 0.001,
    "maxPromptChars": 4000,
    "timeoutMs": 10000
  },
  "modelProfiles": {
    "local-llamacpp/local-model": { "quality": 0.2, "speed": 0.9, "preferredIntents": ["lookup", "summarize"] },
    "anthropic/claude-sonnet-*": { "quality": 0.9, "preferredIntents": ["review", "implement", "complex"] }
  }
}
```

The candidate pool comes from Pi scoped models (`enabledModels` / `/scoped-models`). Keep cheap/fast models in the scoped list if you want the router to use them for grunt work.

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
router: auto
routingProfile: cost_first
---

You are a fast reconnaissance agent. Inspect only; do not modify files.
```

Project-local agent definitions require confirmation by default.

## Examples

### Single research subagent

With `contextMode: "summary"`, the extension includes a capped, sanitized excerpt of recent visible parent conversation when no explicit `contextSummary` is provided. Because `model` is omitted, the router selects from scoped models.

```json
{
  "taskName": "inspect-auth-flow",
  "prompt": "Inspect the auth flow and summarize risks. Do not modify files.",
  "contextMode": "summary",
  "contextSummary": "We are reviewing authentication code for security risks.",
  "writeMode": "read_only",
  "routingProfile": "balanced"
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

The router records the override but does not replace the explicit model/thinking choice.

### Parallel read-only specialists

```json
{ "taskName": "review-routing", "prompt": "Review routing for risks.", "writeMode": "read_only" }
{ "taskName": "review-database", "prompt": "Review database layer for risks.", "writeMode": "read_only" }
{ "all": true, "timeoutMs": 120000 }
```

### Follow-up task

```json
{
  "agentId": "agent_...",
  "prompt": "Now check whether your finding applies to the admin API too.",
  "mode": "live_if_supported"
}
```

If the original subprocess is no longer live, use `mode: "spawn_followup"`.

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
- `last_n_turns` and `full_sanitized` context modes are intentionally rejected until a stronger sanitizer/summarizer exists.

## Install

Symlink the extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /home/svag/Dev/pi-extensions/subagent ~/.pi/agent/extensions/subagent
```

Then run `/reload` in Pi.
