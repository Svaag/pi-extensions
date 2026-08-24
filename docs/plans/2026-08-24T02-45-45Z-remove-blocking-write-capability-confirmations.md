---
created: 2026-08-24T02:45:45.568Z
source: pi-plan-mode
status: accepted-for-execution
---

# Remove Blocking Write-Capability Confirmations

## Summary

Treat an explicit non-read-only `writeMode` as sufficient authorization. Remove modal write confirmations because they are routinely accepted and can suspend unattended `/goal` execution indefinitely while the tool call waits for UI input.

Preserve all deterministic safety controls: read-only defaults, scoped write paths, denied sensitive paths, and rejection of unsupported worktree mode.

## Implementation Steps

1. Remove write-capability confirmations from all subagent spawn tools.
2. Add regression tests proving write-capable spawning never opens a confirmation dialog.
3. Document the non-interactive authorization and safety behavior.
4. Run the targeted Subagent tests and full repository test suite.

## Implementation Details

### Spawn Agent Tool

In `subagent/tools/spawnAgent.ts`:

- Delete `confirmWriteCapability()`.
- Remove its invocation from `spawn_agent.execute()`.
- Continue directly from parameter expansion to the spawning progress update.
- Preserve single-task and multi-task spawning, routing, context inheritance, agent-definition resolution, and manager forwarding.

### Batch Spawn Tools

Remove the inline write-confirmation blocks from:

- `subagent/tools/spawnAgentsOnCsv.ts`
- `subagent/tools/spawnAgentsOnJsonl.ts`

CSV and JSONL jobs using `writeMode: "disjoint_scope"` should begin without waiting for interactive approval.

### Confirmations Retained

Do not modify unrelated confirmation flows:

- Project-local agent definitions remain governed by `confirmProjectAgents`.
- `rate_agent` continues requiring explicit user or validator confirmation.
- No changes are required in `goal-mode/`; eliminating the blocking tool dialogs resolves the `/goal` interaction.

## Safety Model

The authorization boundary remains deterministic:

- Omitted `writeMode` defaults to `read_only`.
- `disjoint_scope` writes remain limited to resolved `allowedPaths`.
- Empty `allowedPaths` provides no writable path.
- `.git`, `node_modules`, and sensitive configuration files remain denied.
- `git_worktree` remains rejected because it is not implemented.
- Callers remain responsible for assigning non-overlapping paths to parallel workers.

No configuration toggle, environment variable, migration, or compatibility fallback will be introduced.

## Test Plan

Add `tests/subagent-spawn-tools.test.ts` with tool-level harnesses whose `ctx.ui.confirm()` throws if called.

Cover:

- Multi-task `spawn_agent` with `writeMode: "disjoint_scope"` reaches the fake manager without confirmation.
- CSV fan-out with write access reaches `createJob()` without confirmation.
- JSONL fan-out with write access reaches `createJob()` without confirmation.
- `writeMode` and `allowedPaths` are forwarded unchanged.
- Existing child-policy tests continue proving out-of-scope and sensitive-path writes are blocked.

Run:

```bash
node --experimental-strip-types --test tests/subagent-spawn-tools.test.ts
npm test
```

`npm run build:model-router` is excluded because no model-router code is affected.

## Assumptions

- Passing `writeMode: "disjoint_scope"` is an intentional request for write capability.
- Existing child-policy enforcement remains the authoritative write boundary.
- Removing the prompt is preferable to adding Goal Mode coupling or another user configuration option.

## Acceptance Criteria

- “Spawn write-capable subagent(s)?” is no longer displayed.
- CSV and JSONL write-capable fan-out also run without confirmation.
- `/goal` cannot stall waiting for these write-capability dialogs.
- Read-only defaults and path-level restrictions remain unchanged.
- Project-agent and quality-rating confirmations remain intact.
- The targeted regression test and full repository suite pass.







<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Remove write-capability confirmations from all subagent spawn tools. _(done)_
- [x] 2. Add regression tests proving write-capable spawning never opens a confirmation dialog. _(done)_
- [x] 3. Document the non-interactive authorization and safety behavior. _(done)_
- [x] 4. Run the targeted Subagent tests and full repository test suite. _(done)_

<!-- pi-plan-progress:end -->
