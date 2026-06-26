# Goal Mode Extension

Exact port of OpenAI Codex `/goal` ("execute" collaboration style) for Pi.

## What it does

- **`/goal <task>`** — Toggles goal mode.  When inactive, it puts the agent
  into autonomous execution mode: it makes reasonable assumptions when
  information is missing, avoids asking open-ended questions, works
  step-by-step, and reports progress as it goes.  When already active, it exits
  goal mode and restores normal collaboration.
- **`/no-goal`** — Legacy alias to exit goal mode (`/goal` toggles).
- **`/goal-status`** — Shows the current goal, turn count, and extracted
  progress checklist.
- **`Ctrl+Alt+G`** — Shortcut to exit goal mode when active.

## How it works

1. When `/goal` is invoked while inactive, the extension stores the task
   description and activates goal mode.
2. On every `before_agent_start` while goal mode is active, the **exact**
   Codex "Collaboration Style: Execute" system prompt
   ([source](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/execute.md))
   is appended to the system prompt sent to the LLM.
3. The agent receives instructions like:
   - **Assumptions-first execution**: "When information is missing, do not ask
     questions — make a sensible assumption, state it briefly, and continue."
   - **Long-horizon execution**: "Break the work into milestones and keep a
     running checklist."
   - **Reporting progress**: "Summarize what you delivered and how to validate it."
4. Progress items written by the agent in formats like `[DONE] item`,
   `- [x] item`, or `- [ ] item` are extracted and shown in the status widget.
5. The agent can signal completion with `[GOAL COMPLETE]`, `[TASK COMPLETE]`,
   `[DONE]`, or similar — the extension will auto-exit goal mode.
6. State persists across session resume.

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
reporting progress.  You can watch the checklist widget in the UI.

## Plan Mode Integration

If a Plan Mode execution is active when you run `/goal`, goal mode appends a
coordination section to the system prompt that:

- Lists the active plan steps and the next unfinished step.
- Instructs the agent to use `update_plan` when available to keep the full
  Plan Mode checklist current.
- Prevents the agent from declaring `[GOAL COMPLETE]` until every unfinished
  plan step is closed in the checklist.

This keeps the Plan Mode todo widget (`/todos`) and footer counter advancing
while the agent works autonomously in goal mode.
