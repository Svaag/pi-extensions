---
created: 2026-06-26T12:32:11.167Z
source: pi-plan-mode
status: accepted-for-execution
---

# Pi Subagent / Agent Swarm Extension Plan

## Summary

Build `/home/svag/Dev/pi-extensions/subagent/` as a production-quality Pi extension that provides Codex-like interactive subagents first, using Pi subprocesses in **RPC mode** rather than invasive Pi core changes.

The MVP will implement:

- `spawn_agent`
- `wait_agent`
- `send_message`
- `followup_task`
- `list_agents`
- `interrupt_agent`
- `close_agent`

It will use a Phase 1.5 persistence foundation:

- append-only lifecycle event log
- persisted agent records
- persisted parent/child graph edges
- conservative restart reconciliation: previously-running subprocess agents become `lost`/`unknown`, not “resumed”

Batch CSV/JSONL swarm jobs, worktree isolation, SDK-backed in-process sessions, and true process reattachment are explicitly deferred until the interactive subagent foundation works.

## Repository Findings

- Target repo: `/home/svag/Dev/pi-extensions`
- Existing repo convention:
  - extension directories live directly under repo root: `plan-mode/`, `goal-mode/`, `tool-highlight/`
  - tests live under root `tests/*.test.ts`
  - root `package.json` runs: `node --experimental-strip-types --test tests/*.test.ts`
  - existing extensions are TypeScript modules loaded directly by Pi; no per-extension build step
- Current repo has unrelated uncommitted Plan Mode / Goal Mode changes. The subagent work should avoid modifying those except if root README/package test coverage needs updates.
- Existing Pi example to adapt:
  - `/opt/pi-coding-agent/examples/extensions/subagent/index.ts`
  - `/opt/pi-coding-agent/examples/extensions/subagent/agents.ts`
- Pi extension APIs available:
  - `pi.registerTool()`
  - `renderCall` / `renderResult`
  - `onUpdate` while a tool is running
  - `ctx.ui.setStatus()` / `ctx.ui.setWidget()` for ongoing session UI
  - `ctx.ui.confirm()` for safety prompts
  - `pi.appendEntry()` for append-only custom persistence
  - `ctx.sessionManager.getBranch()` / `getEntries()` for restore
  - `tool_call` event interception for child policy extensions
- Pi subprocess modes:
  - JSON mode exists and is used by the example.
  - RPC mode exists and supports live `prompt`, `steer`, `follow_up`, `abort`, events, and state queries.
  - Therefore MVP should use **RPC subprocess backend**.

## Recommended File Layout

Use repo-native flat extension layout, not a separate package/build system.

```text
/home/svag/Dev/pi-extensions/
  subagent/
    README.md
    index.ts
    agents.ts
    child-policy.ts
    core/
      AgentBackend.ts
      AgentGraph.ts
      AgentManager.ts
      AgentTypes.ts
      ContextSanitizer.ts
      Limits.ts
      RpcClient.ts
      StateStore.ts
      SubprocessRpcBackend.ts
      prompt.ts
      utils.ts
    tools/
      closeAgent.ts
      followupTask.ts
      interruptAgent.ts
      listAgents.ts
      sendMessage.ts
      spawnAgent.ts
      waitAgent.ts
    render/
      renderAgent.ts
      renderAgentList.ts
      renderAgentGraph.ts
  tests/
    subagent-rpc-client.test.ts
    subagent-agent-manager.test.ts
    subagent-state-store.test.ts
    subagent-context-sanitizer.test.ts
```

No `subagent/package.json` or `tsconfig.json` for MVP. Keep root `npm test` behavior.

## Existing Files To Copy / Adapt

Copy/adapt:

1. `/opt/pi-coding-agent/examples/extensions/subagent/agents.ts`
   - Use mostly as-is for markdown agent discovery.
   - Keep user/project agent scopes.
   - Keep project-agent confirmation behavior.

2. `/opt/pi-coding-agent/examples/extensions/subagent/index.ts`
   - Reuse selectively:
     - child process spawning patterns
     - temp prompt file helper
     - JSON/event rendering ideas
     - output cap concepts
     - usage formatting helpers
     - markdown result rendering patterns
   - Do **not** preserve the one-tool architecture as the main implementation.

3. `/opt/pi-coding-agent/examples/extensions/subagent/README.md`
   - Use as documentation seed only.

Do not copy sample agents/prompts into the MVP unless needed later. The extension should discover user agents from `~/.pi/agent/agents` and project agents from `.pi/agents`.

## New Files To Create

Create all files under:

- `/home/svag/Dev/pi-extensions/subagent/`
- `/home/svag/Dev/pi-extensions/tests/subagent-*.test.ts`

Update:

- `/home/svag/Dev/pi-extensions/README.md`
  - add install line for `subagent/`
- `/home/svag/Dev/pi-extensions/package.json`
  - only if test script needs broadening; preferred: no change by placing tests in root `tests/`

## Minimal Tool Surface For Phase 1

### `spawn_agent`

Registers a child agent, enforces limits, starts or queues it, persists lifecycle events, and returns stable identity.

Input:

```ts
{
  taskName: string
  prompt: string
  cwd?: string
  parentAgentId?: string
  taskPath?: string

  agentName?: string
  agentScope?: "user" | "project" | "both"
  confirmProjectAgents?: boolean

  agentDefinition?: string
  agentDefinitionFile?: string

  contextMode?: "fresh" | "summary" | "last_n_turns" | "full_sanitized"
  contextTurns?: number
  contextSummary?: string

  writeMode?: "read_only" | "disjoint_scope" | "git_worktree"
  allowedPaths?: string[]

  timeoutMs?: number
  maxOutputChars?: number
  model?: string
}
```

Phase 1 behavior:

- `writeMode` defaults to `read_only`.
- `contextMode` defaults to `fresh`.
- `summary` may use explicit `contextSummary` plus sanitized visible session text.
- `last_n_turns` and `full_sanitized` may be accepted only if implemented safely; otherwise reject with a clear error.
- `git_worktree` is rejected in Phase 1 with “not implemented yet”.
- Child process uses `pi --mode rpc --no-session`.
- Child process is launched with a child policy extension.
- Returns:

```ts
{
  agentId: string
  taskPath: string
  status: "queued" | "running"
  parentAgentId: string | null
  startedAt?: number
  cwd: string
  controllable: boolean
  message: string
}
```

### `wait_agent`

Waits for one, many, or all agents.

Input:

```ts
{
  agentId?: string
  agentIds?: string[]
  all?: boolean
  timeoutMs?: number
  returnMode?: "summary" | "full" | "events"
}
```

Output:

```ts
{
  agents: Array<{
    agentId: string
    taskPath: string
    status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "closed" | "lost"
    summary?: string
    output?: string
    error?: string
    controllable: boolean
    metrics: {
      durationMs?: number
      outputChars?: number
      exitCode?: number
    }
  }>
  timedOut: boolean
}
```

### `send_message`

Uses RPC steering if possible.

Behavior:

- If agent is running and controllable: send RPC `steer`.
- If agent is idle/succeeded but process still alive: persist mailbox event but do not trigger a turn.
- If process is closed/lost: persist event as undelivered and return honest status.

Input:

```ts
{
  agentId: string
  content: string
  kind?: "message" | "correction" | "constraint" | "note"
}
```

Output includes:

```ts
{
  delivered: boolean
  queued: boolean
  deliveryMode: "rpc_steer" | "mailbox_only" | "unavailable"
  message: string
}
```

### `followup_task`

Triggers additional work on an existing controllable child agent.

Behavior:

- If child is running: use RPC `follow_up`.
- If child is idle but process still alive: use RPC `prompt`.
- If child is closed/lost and `mode === "spawn_followup"`: spawn a new child with prior summary context and parent edge.
- Otherwise return explicit failure.

Input:

```ts
{
  agentId: string
  prompt: string
  mode?: "live_if_supported" | "spawn_followup"
  contextMode?: "fresh" | "summary" | "last_n_turns" | "full_sanitized"
}
```

### `list_agents`

Input:

```ts
{
  includeClosed?: boolean
  parentAgentId?: string
  jobId?: string
}
```

Output includes:

- `agentId`
- `taskName`
- `taskPath`
- `parentAgentId`
- `status`
- `controllable`
- age/duration
- output tail
- final summary/error

### `interrupt_agent`

Input:

```ts
{
  agentId: string
  reason?: string
}
```

Behavior:

- Prefer RPC `abort`.
- Then SIGTERM if needed.
- Then SIGKILL after grace timeout.
- Persist `agent.interrupted`.

### `close_agent`

Input:

```ts
{
  agentId: string
  deleteState?: false
}
```

Behavior:

- Abort/kill live process if needed.
- Mark status `closed`.
- Persist `agent.closed` and `graph.edge_closed`.
- Never delete history in MVP.

## Core Architecture

### `AgentManager`

Owns:

- in-memory agent map
- queue
- running limit enforcement
- graph
- persistence calls
- UI status/widget updates
- lifecycle transitions

State shape:

```ts
type AgentRecord = {
  agentId: string
  taskName: string
  taskPath: string
  parentAgentId: string | null
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "closed" | "lost"
  processState: "not_started" | "live_running" | "live_idle" | "exited" | "killed" | "unknown"
  cwd: string
  prompt: string
  model?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  contextMode: "fresh" | "summary" | "last_n_turns" | "full_sanitized"
  writeMode: "read_only" | "disjoint_scope" | "git_worktree"
  allowedPaths: string[]
  outputTail: string
  outputChars: number
  result?: AgentResult
  error?: string
  exitCode?: number
  controllable: boolean
}
```

### `SubprocessRpcBackend`

Owns:

- spawning `pi --mode rpc --no-session`
- strict LF JSONL parsing
- request/response correlation by `id`
- event forwarding
- process lifecycle
- timeout handling
- stderr capture
- abort/kill behavior

Command shape:

```ts
pi --mode rpc --no-session --name "subagent:<taskPath>" \
  --no-extensions \
  -e /home/svag/Dev/pi-extensions/subagent/child-policy.ts \
  --append-system-prompt <temp-policy-and-agent-prompt-file>
```

Add optional:

- `--model <model>`
- `--tools <allowlist>`

Do not use shell interpolation. Always call `spawn(command, args, { shell: false })`.

### `RpcClient`

Must:

- split only on `\n`
- strip optional trailing `\r`
- handle partial lines
- handle malformed JSON without crashing the manager
- correlate RPC responses by request id
- emit agent events separately from command responses
- cap stderr and raw tail buffers

### `child-policy.ts`

A lightweight extension loaded into child Pi processes.

Purpose:

- enforce `writeMode`
- block `edit` / `write` in `read_only`
- block dangerous bash in `read_only`
- restrict paths in `disjoint_scope`
- use environment variable or temp policy file for policy config
- never load project-local extensions in the child by default

Phase 1 policy:

- `read_only`:
  - allow `read`
  - allow `bash` only for commands that pass a conservative read-only allowlist
  - block `edit` and `write`
- `disjoint_scope`:
  - allow edits only under `allowedPaths`
  - still block denied paths such as `.env`, `.git`, `node_modules`
- `git_worktree`:
  - reject until Phase 6

### `StateStore`

Use Pi session persistence via append-only entries.

Custom entry types:

- `subagent-event`
- `subagent-agent-state`
- `subagent-graph-edge-state`

Required event names:

- `agent.spawned`
- `agent.started`
- `agent.output_tail`
- `agent.succeeded`
- `agent.failed`
- `agent.interrupted`
- `agent.closed`
- `agent.message`
- `agent.followup`
- `graph.edge_opened`
- `graph.edge_closed`

On `session_start`:

- read active branch entries via `ctx.sessionManager.getBranch()`
- reconstruct latest agent records and graph edges
- any record with previous status `running` or `queued` becomes `lost`
- mark `controllable: false`
- do not attempt process reattachment

Output persistence rule:

- keep in-memory output capped by `maxOutputChars`
- persist only output tail snapshots
- throttle `agent.output_tail` writes by time/size
- final persisted tail max: 8 KiB by default

## Limits And Defaults

Create `core/Limits.ts`.

Defaults:

```ts
{
  maxAgentsTotal: 32,
  maxOpenAgents: 12,
  maxAgentsRunning: 4,
  maxDepth: 3,
  maxOutputCharsPerAgent: 64_000,
  maxPersistedOutputTailChars: 8_192,
  maxTaskPromptChars: 40_000,
  maxRuntimeMsPerAgent: 30 * 60_000,
  maxQueuedMessages: 50,
  allowedCwdRoots: [], // empty means ctx.cwd only
  requireConfirmationForProjectAgents: true,
  requireConfirmationForWrites: true,
  idleTtlMs: 30 * 60_000
}
```

Behavior:

- when max running is reached, new agents become `queued`
- when total/open limit is reached, `spawn_agent` fails with a clear error
- queued agents start when a running slot frees
- depth is derived from task path or parent graph
- child processes are killed on session shutdown/reload unless already closed

## Context Handling In Phase 1

Implement a small `ContextSanitizer`.

Supported immediately:

- `fresh`
- `summary` with explicit `contextSummary`
- optional sanitized recent visible user/assistant text if easy and capped

Sanitizer requirements:

- redact common secret patterns
- drop tool result blobs by default
- cap inherited context
- label inherited context clearly
- do not include hidden/internal reasoning
- do not include large raw command output

Defer advanced context modes:

- full `last_n_turns`
- full `full_sanitized`
- LLM-generated context summarization

## Rendering And UI

Implement custom rendering for each tool.

Also maintain a session widget:

- key: `subagent-agents`
- shows active/queued/recent agents
- icons:
  - `⏳ running`
  - `… queued`
  - `✓ succeeded`
  - `✗ failed`
  - `⚠ interrupted/lost`
  - `■ closed`
- include task path, age, and output tail summary

Use `renderResult` for:

- compact agent lists
- expanded output tails
- graph tree preview
- wait results

## Implementation Steps

1. Scaffold the `subagent/` extension and shared type/utility modules.
2. Implement RPC subprocess client/backend and child process lifecycle handling.
3. Implement `AgentManager`, limits, queueing, persistent event/state store, and graph reconstruction.
4. Register the seven Phase 1 tools and wire them to `AgentManager`.
5. Add child policy enforcement for read-only/disjoint-scope subprocesses.
6. Add renderers, status/widget updates, README documentation, and root README install notes.
7. Add tests for RPC parsing, lifecycle, limits, persistence reconstruction, and sanitization.
8. Run validation: TypeScript syntax check, `npm test`, and `git diff --check`.

## Test Strategy

Add root tests under `tests/subagent-*.test.ts`.

### RPC Client

Test:

- valid JSONL events
- partial line buffering
- CRLF handling
- malformed JSON line handling
- response correlation by id
- process exit before final event
- stderr cap

### AgentManager

Test:

- spawn queued/running
- running to succeeded
- running to failed
- interrupt to interrupted
- close to closed
- max running queues additional agents
- max total rejects
- max depth rejects
- timeout fails/kills agent
- output cap enforced

Use fake backend for manager tests.

### StateStore / Graph

Test:

- append `agent.spawned`
- append `graph.edge_opened`
- append terminal events
- reconstruct records from entries
- previously running agent becomes `lost`
- graph edge closes on close/failure/interruption

### ContextSanitizer

Test:

- redacts obvious secrets
- drops/summarizes tool outputs
- caps inherited context
- preserves visible user/assistant text
- rejects unsupported context modes when required

### Child Policy

Test pure helpers:

- read-only bash allowlist
- dangerous bash rejection
- edit/write blocked in read-only
- allowedPaths enforcement

## Security And Concurrency Notes

- Default `writeMode` is `read_only`.
- Run child process with `--no-extensions` plus only the controlled child policy extension.
- Do not trust project-local agents without confirmation.
- Do not use shell strings.
- Do not allow cwd outside configured roots.
- Do not allow unbounded stdout/stderr buffers.
- Do not silently keep orphan processes.
- Kill live subprocesses on `session_shutdown`.
- Persist state honestly; after reload, do not claim old subprocesses are still controllable.
- Parallel write-capable agents must not freely mutate the same checkout.
- `git_worktree` is the preferred future write mode but is not in MVP.

## Extension API Limitations Discovered

- `pi.appendEntry()` is append-only and session-bound; good for event logs, not a database.
- `onUpdate` only streams while a tool call is running, so background subagent progress should use session widget/status updates and be returned to the model via `wait_agent`.
- JSON mode is one-shot and not enough for honest live messaging.
- RPC mode supports live steering/follow-up/abort but still requires subprocess lifecycle management.
- True process reattachment after extension reload is not available from extension APIs.
- SDK `createAgentSession()` exists, but SDK-backed children should be Phase 4 after subprocess RPC is stable.

## Documentation To Include

`subagent/README.md` should include:

1. Single research subagent example.
2. Parallel read-only specialists example.
3. Follow-up task example.
4. Explanation of `send_message` vs `followup_task`.
5. State/restart limitations.
6. Security model.
7. Agent markdown definition format.
8. Installation symlink instructions.

## Do Not Implement Yet

Defer until after Phase 1 is stable:

- CSV/JSONL batch swarm tools
- `report_agent_job_result`
- persistent batch job resume
- worktree isolation
- git merge/apply workflow
- SDK-backed in-process sessions
- full process reattachment after reload
- cross-session live control guarantees
- sibling-to-sibling messaging
- advanced tree UI
- graph migrations/compaction
- LLM-generated context summaries
- full `full_sanitized` context forking




<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Scaffold the subagent/ extension and shared type/utility modules. _(done)_
- [x] 2. Implement RPC subprocess client/backend and child process lifecycle handling. _(done)_
- [x] 3. Implement AgentManager, limits, queueing, persistent event/state store, and graph reconstruction. _(done)_
- [x] 4. Register the seven Phase 1 tools and wire them to AgentManager. _(done)_
- [x] 5. Add child policy enforcement for read-only/disjoint-scope subprocesses. _(done)_
- [x] 6. Add renderers, status/widget updates, README documentation, and root README install notes. _(done)_
- [x] 7. Add tests for RPC parsing, lifecycle, limits, persistence reconstruction, and sanitization. _(done)_
- [x] 8. Run validation: TypeScript syntax check, npm test, and git diff --check. _(done)_

<!-- pi-plan-progress:end -->
