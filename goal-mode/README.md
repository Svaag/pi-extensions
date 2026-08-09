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
5. The agent receives instructions like:
   - **Assumptions-first execution**: "When information is missing, do not ask
     questions — make a sensible assumption, state it briefly, and continue."
   - **Long-horizon execution**: "Break the work into milestones and keep a
     running checklist."
   - **Reporting progress**: "Summarize what you delivered and how to validate it."
6. Progress items written by the agent in formats like `[DONE] item`,
   `- [x] item`, or `- [ ] item` are extracted and shown in the status widget.
7. The agent can signal whole-goal completion with `[GOAL COMPLETE]`,
   `[TASK COMPLETE]`, or `Goal complete.` — the extension will auto-exit goal
   mode. A checklist item such as `[DONE] Add tests` does not end the whole goal.
8. State persists across session resume and follows the active session branch.

The footer and checklist explicitly show **persisted** while a goal is active.
`/goal-status` also reports how the goal is saved and re-injected.

## Differences from Codex

- Codex has a built-in `/goal` slash command in their CLI; in Pi it is an
  extension.
- This extension **does not** restrict tools (unlike plan mode).  Full `edit`,
  `write`, `bash`, etc. access is available — the agent is expected to use them
  autonomously.

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

The replacement is persisted immediately and steers the running agent. Bare
`/goal`, `/no-goal`, or `Ctrl+Alt+G` exits goal mode.

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
