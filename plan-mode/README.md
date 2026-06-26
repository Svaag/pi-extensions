# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Guaranteed exploration tools**: Plan Mode always enables `read`, read-only `bash`, `plan_repo_overview`, `plan_files`, `plan_search`, `plan_read_many`, and `plan_questions` even if only a smaller tool set was active before planning
- **Highest reasoning by default**: Entering Plan Mode switches to Pi's highest thinking level (`xhigh`) and restores the previous level when leaving Plan Mode
- **Bash allowlist + tracked-file guard**: Only read-only bash commands are allowed, including repo search/list commands and read-only `git`/`gh` queries; tracked-file changes after bash produce a Plan Mode warning
- **Plan extraction**: Prefers `Implementation Steps`, `Execution Steps`, or `Action Plan` sections and extracts only numbered subheadings/top-level list items while preserving full tracker text
- **Interactive questions**: `plan_questions` tool gives a tabbed TUI wizard for implementation-detail questions instead of long A/B/C chat questionnaires
- **Feedback mode guard**: once a plan exists, normal feedback refines it, but a newly pasted `<proposed_plan>` is treated as fresh user input unless the prompt explicitly asks to refine/revise the stored plan
- **Agent-assisted answers**: Each custom-answer question can ask a user-selected Pi scoped model for a recommendation, with the current planning conversation and any draft/proposed plan forwarded as context
- **Plan archival**: Accepted plans are saved to `docs/plans/` in the selected project repository before execution starts; when planning from a multi-repo workspace, Plan Mode lists discovered repos so you can choose the target (with the detected best match first)
- **Reset-context execution**: The execution menu can start from a context-reset marker so the model sees only the accepted plan and later messages while the visible transcript remains available
- **Persisted progress**: Saved plan files get a `## Progress` section that is updated as steps are marked in-progress/done/skipped/deferred/blocked
- **Progress tracking**: Widget shows completion status during execution
- **Structured todo updates**: Execution mode enables an `update_plan` tool (Codex-style) so the agent updates statuses directly instead of relying on prose parsing or `[DONE:n]` markers
- **Non-done states**: Manual/operator work can be marked in-progress, skipped, deferred, or blocked without pretending it completed
- **Handoff guard**: If the agent says a PR/work item is ready while plan items are still open, Plan Mode warns before handoff
- **Session persistence**: State survives session resume

## Exploration Tools

- `plan_repo_overview` - Summarize cwd/root, git branch/status, manifests, top-level paths, likely tests, and sample files
- `plan_files` - List repository files using `git ls-files` or a read-only filesystem walk, with optional pattern filtering
- `plan_search` - Search code/docs with `rg` when available and a JavaScript fallback otherwise
- `plan_read_many` - Read multiple files or line ranges in one batch after search/list discovery
- `plan_questions` - Ask implementation-detail questions through the interactive wizard

## Commands

- `/plan` - Toggle plan mode; while executing, this refuses to replace the active tracker
- `/plan cancel` - Stop plan execution tracking and restore normal tools
- `/plan-start-empty-context` - Advanced/manual escape hatch: start the accepted plan in a fresh session containing only the plan prompt
- `/todos` - Show current plan progress
- `/todos start 2` - Manually mark a step in progress
- `/todos done 1-3` - Manually mark steps done
- `/todos skip 4` - Mark a user-skipped/manual step as skipped
- `/todos defer 4` - Mark a step deferred for later without blocking the current plan
- `/todos block 4` - Mark a step blocked and keep it visible
- `/todos open 4` - Reopen a skipped/deferred/blocked/done step as pending
- `/todos reset` - Reset all step statuses to pending
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Agent-Assisted Planning Questions

When a `plan_questions` question allows custom answers, the wizard shows:

- **Ask an agent for a recommendation** — opens a model picker for Pi scoped models from `enabledModels`, then forwards the current planning conversation plus any existing draft/proposed plan to the selected model.
- **Type a custom answer** — manually enter the answer.

The agent answer can be accepted directly or edited before use.

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a plan with a dedicated implementation section:

```markdown
## Implementation Steps
1. First tracker-level work item
2. Second tracker-level work item
3. Third tracker-level work item
```

Keep facts, config examples, sub-bullets, test plans, and acceptance criteria in separate sections so they do not become todos.

4. Choose an execution option when prompted:
   - **Start Implementation in current session** — Continue in the current session with the plan in context.
   - **Start Implementation with reset model context** — Continue in the current session, but insert a context-reset marker so the model sees only the accepted plan and later messages. Useful when the planning conversation has grown large and you want implementation to begin with clean context without relying on slash-command handoff.
5. Plan Mode saves the accepted plan to `docs/plans/<timestamp>-<title>.md`. If the current directory is a multi-repo workspace, Plan Mode shows the detected target repo, the current project root, and other discovered repos so you can choose where to save.
6. The saved plan file includes a `## Progress` section and Plan Mode updates it as execution proceeds.
7. During execution, the agent updates progress with the structured `update_plan` tool. It should mark exactly one step `in_progress`, then update the full checklist as steps become `completed`, `skipped`, `deferred`, or `blocked`.
8. If the user skips/defer/manual-blocks a step, use `update_plan`, `/todos skip`, `/todos defer`, or `/todos block` rather than marking the step done.
9. Progress widget shows completion status.

## How It Works

### Plan Mode (Read-Only)
- Only read-only tools available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `update_plan` tracks structured checklist progress; assistant prose is not parsed for completion
- `/todos start|done|skip|defer|block|open` handles manual status repair explicitly
- Saved plan files are updated with progress
- Widget shows progress

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`, `git grep`, `git ls-files`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git show`, `git branch --list`, `git ls-files`
- GitHub CLI read: `gh pr list/view/diff/status/checks`, `gh issue list/view/status`, `gh repo view/list`, `gh run list/view`, `gh api` GET-only queries
- Package info: `npm list`, `npm outdated`, `yarn info`, `pnpm list/view/info/outdated`
- Validation: `pytest` (including `.venv/bin/pytest` and `python -m pytest`) and `ruff check` without fix flags
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`, `git checkout`, `git pull`
- GitHub CLI write: `gh pr merge/checkout/comment`, `gh issue create/edit`, `gh repo clone/create/delete`, non-GET `gh api`
- Package install: `npm install`, `yarn add`, `pnpm install/add`, `pip install`
- Shell escalation/installers: `curl ... | bash`, `bash -c`, `sh -c`, downloads with `curl -o`/`wget -O file`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
