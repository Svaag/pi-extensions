# Goal Mode Extension

OpenAI Codex-style `/goal` ("execute" collaboration style) for Pi, with session persistence.

## What it does

- **`/goal <task>`** — Starts goal mode, or replaces the active goal. The goal
  is saved before delivery, so this also works while the agent is running:
  the new goal steers the active run at its next model call. In goal mode the
  agent makes reasonable assumptions, avoids asking open-ended questions,
  works step-by-step, and reports progress.
- **`/goal`** — Opens a goal prompt when inactive; exits goal mode when active.
- **`/no-goal`** — Legacy alias to exit goal mode (bare `/goal` also exits).
- **`/goal-status`** — Shows the current goal, turn count, and extracted
  progress checklist.
- **`Ctrl+Alt+G`** — Shortcut to exit goal mode when active.

## How it works

1. When `/goal <task>` is invoked, the extension stores the task description
   and a revision number in the Pi session before sending it to the agent.
   `/goal <new task>` replaces an existing goal instead of toggling it off.
2. If the agent is idle, the goal starts a new run. If it is busy, the goal is
   delivered as a `steer` message after the current assistant turn's tool calls
   and before the next model call.
3. On every `before_agent_start` while goal mode is active, the **exact** Codex
   "Collaboration Style: Execute" system prompt
   ([source](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/execute.md))
   is appended to the system prompt sent to the LLM.
4. The active goal is also stored as a hidden context checkpoint. Before every
   model call, the extension removes stale goal checkpoints and injects exactly
   one authoritative copy of the latest goal. This happens after context is
   rebuilt too, so manual compaction, automatic compaction, overflow retries,
   and tool-loop turns cannot drop the active goal.
5. **Goal mode compacts between tool-loop turns.** After each completed
   `toolUse` response, the extension checks Pi's current context estimate. If
   usage exceeds `contextWindow - 16,384` tokens (Pi's default response
   reserve), it stops the tool loop and requests one compaction before another
   provider call. The active goal is re-injected and resumed exactly once after
   compaction succeeds. Goal replacement is saved but deferred while the
   summary is being generated. If compaction ultimately fails after Pi's
   retries, the goal remains persisted but pauses until you send a message.
6. **Goal mode keeps driving.** When Pi reaches `agent_settled` with no
   completion signal, retry, compaction retry, or queued user follow-up left,
   the extension atomically starts a hidden continuation turn. It tells the
   model to take another concrete action, investigate failures, and change
   tactics instead of only reporting a blocker. Failed runs back off
   progressively and pause goal mode on the fifth consecutive failure. An
   explicit user interrupt (`Esc`) intentionally pauses goal mode instead of
   resuming; send any message or run `/goal <task>` to continue.
7. The agent receives instructions like:
   - **Assumptions-first execution**: "When information is missing, do not ask
     questions — make a sensible assumption, state it briefly, and continue."
   - **Long-horizon execution**: "Break the work into milestones and keep a
     running checklist."
   - **Reporting progress**: "Summarize what you delivered and how to validate it."
8. Progress items written by the agent in formats like `[DONE] item`,
   `- [x] item`, or `- [ ] item` are extracted and shown in the status widget.
9. The agent can signal whole-goal completion by putting `[GOAL COMPLETE]`,
   `[TASK COMPLETE]`, or `Goal complete.` on the final non-empty response line.
   The extension then exits goal mode. A checklist item such as `[DONE] Add
   tests`, a quoted marker, or a marker followed by remaining caveats does not
   end the whole goal.
10. State persists across session resume and follows the active session branch.
   A running restored goal automatically restarts after startup, `/reload`,
   session resume, or fork. A goal paused by `Esc` or repeated failures stays
   paused across reloads until you send a new message.

The footer and checklist explicitly show **persisted** while a goal is running
and **paused** when operator action or repeated failures stopped it.
`/goal-status` also reports how the goal is saved and re-injected.

## Differences from Codex

- Codex has a built-in `/goal` slash command in their CLI; in Pi it is an
  extension.
- This extension **does not** restrict tools (unlike plan mode). Full `edit`,
  `write`, `bash`, etc. access is available — the agent is expected to use them
  autonomously.
- Between-turn compaction is a Goal Mode safeguard, not a replacement for Pi's
  core automatic compaction in ordinary sessions.

## Usage

```
/goal Add a rate-limiter middleware to the Express app
```

The agent will immediately start working, making assumptions as needed and
reporting progress. You can watch the checklist widget in the UI.

You may replace the goal while work is in progress:

```
/goal Keep the rate limiter, but store counters in Redis and add integration tests
```

The replacement is persisted immediately and steers the running agent. If a
Goal Mode compaction is already in progress, delivery waits for the new summary
instead. Bare `/goal`, `/no-goal`, or `Ctrl+Alt+G` exits goal mode.

## Updating an existing install

Use a symlink rather than a copied extension directory so fixes take effect on
`git pull`, then run `/reload` in every already-running Pi session:

```bash
rm -rf ~/.pi/agent/extensions/goal-mode
ln -s /path/to/pi-extensions/goal-mode ~/.pi/agent/extensions/goal-mode
```

The current footer reads `⚡ goal • persisted`. If it only reads `⚡ goal`, Pi is
still running the legacy copy, which stops after ordinary assistant responses
and also mistakes `[DONE]` checklist items for whole-goal completion.

## Plan Mode Integration

If a Plan Mode execution is active when you run `/goal`, goal mode appends a
coordination section to the system prompt that:

- Lists the active plan steps and the next unfinished step.
- Instructs the agent to keep marking completed plan steps with `[DONE:n]`
  (e.g. `[DONE:2]`) or phrases like "Completed step N" / "Completed phase N".
- Prevents the agent from declaring `[GOAL COMPLETE]` until every unfinished
  plan step is marked done.

This keeps the Plan Mode todo widget (`/todos`) and footer counter advancing
while the agent works autonomously in goal mode.
