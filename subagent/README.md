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
- Child subprocesses are launched with extension/resource discovery disabled, plus a controlled child policy extension.
- Read-only children can use `read` inside the child `cwd` (plus explicit `allowedPaths`) and conservative read-only `bash` commands.
- `edit`/`write` are blocked unless `writeMode: "disjoint_scope"` and the path is under `allowedPaths`.
- `writeMode: "git_worktree"` is reserved for a later phase and currently rejected.
- Running agents are killed on session shutdown/reload.
- After restart/reload, previously running agents are reconstructed as `lost`, persisted with explicit `agent.lost` / `graph.edge_lost` events, and not claimed as controllable.

## Persistence

The extension persists append-only lifecycle state with `pi.appendEntry()`:

- `agent.spawned`
- `agent.started`
- `agent.output_tail`
- `agent.succeeded`
- `agent.failed`
- `agent.interrupted`
- `agent.closed`
- `agent.lost`
- `agent.message`
- `agent.followup`
- `graph.edge_opened`
- `graph.edge_closed`
- `graph.edge_lost`
- batch job state and events such as `batch.started`, `batch.worker_started`, `batch.worker_result`, `batch.completed`, `batch.failed`, `batch.cancelled`, and `batch.exported`

It also persists latest agent records, parent/child graph edge records, and batch job records. This is enough to reconstruct historical state and display a graph after reload, but does not reattach to old subprocesses or resume in-flight batch workers.

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
---

You are a fast reconnaissance agent. Inspect only; do not modify files.
```

Project-local agent definitions require confirmation by default.

## Examples

### Single research subagent

With `contextMode: "summary"`, the extension includes a capped, sanitized excerpt of recent visible parent conversation when no explicit `contextSummary` is provided.

```json
{
  "taskName": "inspect-auth-flow",
  "prompt": "Inspect the auth flow and summarize risks. Do not modify files.",
  "contextMode": "summary",
  "contextSummary": "We are reviewing authentication code for security risks.",
  "writeMode": "read_only"
}
```

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
