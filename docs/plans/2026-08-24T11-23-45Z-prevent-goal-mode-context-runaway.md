---
created: 2026-08-24T11:23:45.347Z
source: pi-plan-mode
status: accepted-for-execution
---

# Prevent Goal Mode Context Runaway

## Summary

Add a Goal Mode safeguard that compacts context between tool-loop turns before another provider request can exceed Pi’s documented context threshold.

The inspected session confirms:

- Pi 0.84.2 checks automatic compaction after an agent run settles, not between successive tool calls.
- One uninterrupted Goal Mode run grew from roughly 217k to 576k tokens.
- The selected model advertised a 272k context window.
- Cache reuse later collapsed, causing almost the entire growing prompt to be re-billed repeatedly.

Scope is limited to active Goal Mode runs. Pi core, non-Goal Mode sessions, and cache accounting are out of scope.

## Success Criteria

- Active Goal Mode requests compaction once context exceeds:
  `contextWindow - 16,384`.
- Compaction is checked after completed `toolUse` turns, when assistant and tool results are safely persisted.
- No additional Goal Mode continuation starts while compaction is pending.
- Successful compaction resumes the current goal exactly once.
- Failed compaction pauses and persists the goal rather than risking more high-context requests.
- Goal replacement or exit during compaction is handled without reviving stale work.
- Existing Goal Mode retry, completion, interrupt, persistence, and Plan Mode behavior remains unchanged.

## Implementation Steps

1. Add deterministic Goal Mode context-threshold helpers.
2. Add the self-compaction lifecycle to Goal Mode.
3. Extend the Goal Mode test harness and regression coverage.
4. Document automatic between-turn compaction and failure behavior.
5. Run focused and repository-wide validation.

## Implementation Details

### Threshold helper

Update `goal-mode/utils.ts` with:

- `DEFAULT_GOAL_COMPACTION_RESERVE_TOKENS = 16_384`.
- A small `shouldCompactGoalContext()` helper accepting:
  - `tokens: number | null`
  - `contextWindow: number`
  - optional reserve for isolated tests
- Return `true` only when:
  - token usage is known and finite;
  - the context window is positive; and
  - `tokens > contextWindow - reserveTokens`.

Equality with the threshold must not trigger, matching Pi’s existing `shouldCompact()` semantics.

### Goal Mode state machine

Update `goal-mode/index.ts` with transient, non-persisted state:

- `contextCompactionPending`
- an extension-instance active flag to ignore callbacks after shutdown

Do not change the persisted Goal Mode schema; an interrupted compaction cannot meaningfully survive process shutdown.

After normal progress extraction in `turn_end`:

1. Require an active, unpaused goal owned by the current revision.
2. Require an assistant message with `stopReason === "toolUse"`.
   - Ordinary `stop` and error paths already reach Pi’s normal post-run compaction handling.
3. Skip if a Goal Mode compaction is already pending.
4. Read `ctx.getContextUsage()`.
5. Apply the fixed 16,384-token reserve.
6. Mark compaction pending before calling `ctx.compact()`.
7. Notify the user with current tokens, context window, and threshold.
8. Supply compaction instructions to preserve:
   - completed Goal Mode work;
   - current repository state;
   - unresolved blockers;
   - the exact next concrete action;
   - the fact that compaction does not complete the goal.

`ctx.compact()` is appropriate here because Pi first aborts the current low-level tool loop at a safe turn boundary and then rebuilds context from the generated summary.

### Resume coordination

While `contextCompactionPending` is true:

- `agent_settled` must not schedule the normal Goal Mode auto-resume.
- Repeated `turn_end` events must not request additional compactions.
- A replacement `/goal <task>` must persist the new revision but defer delivery until compaction finishes.
- Bare `/goal` or `/no-goal` may exit normally; successful compaction must then remain idle.

On successful compaction:

1. Clear the pending flag exactly once.
2. If Goal Mode remains active and unpaused, call the existing `resumeGoal()` with the current revision and reason `after context compaction`.
3. If another user or extension run already owns the idle transition, let its later `agent_settled` event resume the goal instead.
4. Resume the newest revision if the goal was replaced during compaction.

On final compaction failure:

1. Clear the pending flag.
2. Call the existing `pauseGoal()` path.
3. Persist the paused state.
4. Show the compaction error and explain that an explicit message is required to retry.
5. Do not start another paid model request automatically.

On `session_shutdown`, invalidate pending callbacks and clear transient compaction state.

## Tests

### `tests/goal-mode.test.ts`

Add pure threshold tests covering:

- below threshold;
- exact threshold;
- one token above threshold;
- unknown token usage;
- invalid or absent context windows;
- the 272k model example, whose threshold is 255,616 tokens.

### `tests/goal-mode-extension.test.ts`

Extend the harness with:

- mutable context usage;
- captured `ctx.compact()` requests;
- helpers to invoke compaction success and failure callbacks.

Add regression cases for:

- inactive Goal Mode never compacting;
- non-`toolUse` responses relying on normal Pi behavior;
- active tool loops compacting immediately after crossing the threshold;
- only one request while compaction is pending;
- `agent_settled` not auto-resuming during compaction;
- successful compaction resuming exactly once;
- failed compaction pausing without continuation;
- replacement goals being deferred and resumed at the latest revision;
- exiting Goal Mode during compaction suppressing resume;
- shutdown making late callbacks inert.

Retain all existing tests for errors, interrupts, completion signals, restoration, replacement races, and Plan Mode coordination.

## Documentation

Update `goal-mode/README.md` to explain that:

- Goal Mode independently checks context after every completed tool turn.
- It uses Pi’s documented default 16,384-token response reserve.
- It compacts before issuing another Goal Mode provider request.
- The active goal is re-injected and resumed after successful compaction.
- Final compaction failure pauses rather than continuing an expensive loop.
- This is a Goal Mode safeguard, not a general replacement for Pi core compaction.

## Validation

Run:

```bash
node --experimental-strip-types --test \
  tests/goal-mode.test.ts \
  tests/goal-mode-extension.test.ts

npm test
git diff --check
```

Manually verify with a small injected context window that a multi-tool Goal Mode run shows one compaction, resumes from the summary, and never issues a provider request above the configured test threshold.

## Compatibility and Constraints

- Target the installed Pi 0.84.2 extension API.
- Use only APIs already present in the repository’s Pi 0.82 development dependency: `turn_end`, `getContextUsage()`, and `compact()`.
- Do not update dependencies or lockfiles.
- Do not alter non-Goal Mode runs.
- Do not modify cache-miss calculations or suppress cache-miss notices.
- Do not patch the separate dirty `/home/svag/Dev/pi-mono` checkout.








<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Add deterministic Goal Mode context-threshold helpers. _(done)_
- [x] 2. Add the self-compaction lifecycle to Goal Mode. _(done)_
- [x] 3. Extend the Goal Mode test harness and regression coverage. _(done)_
- [x] 4. Document automatic between-turn compaction and failure behavior. _(done)_
- [x] 5. Run focused and repository-wide validation. _(done)_

<!-- pi-plan-progress:end -->
