# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, and `plan_questions`
- **Bash allowlist**: Only read-only bash commands are allowed, including read-only `git` and `gh` queries
- **Plan extraction**: Prefers `Implementation Steps`, `Execution Steps`, or `Action Plan` sections and extracts only numbered subheadings/top-level list items
- **Interactive questions**: `plan_questions` tool gives a tabbed TUI wizard for implementation-detail questions instead of long A/B/C chat questionnaires
- **Agent-assisted answers**: Each custom-answer question can ask a user-selected Pi scoped model for a recommendation, with the current planning conversation and any draft/proposed plan forwarded as context
- **Plan archival**: Accepted plans are saved to `docs/plans/` in the project repository before execution starts
- **Progress tracking**: Widget shows completion status during execution
- **Completion tracking**: Supports `[DONE:n]` markers, `Completed steps/phases: 1-3` status lines, numbered checked lists, whole-plan completion summaries, fuzzy summary matching, resume-time recovery, and manual `/todos done 1-3` updates
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode; while executing, this refuses to replace the active tracker
- `/plan cancel` - Stop plan execution tracking and restore normal tools
- `/todos` - Show current plan progress
- `/todos done 1-3` - Manually mark steps done
- `/todos reset` - Reset all step completion flags
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
   - **Start Implementation in fresh session with empty context** — Start a fresh session containing only the proposed plan. Useful when the planning conversation has grown large and you want implementation to begin with clean context.
5. Plan Mode saves the accepted plan to `docs/plans/<timestamp>-<title>.md` in the current git repository, then starts execution
6. During execution, the agent marks steps complete with `[DONE:n]` tags, `Completed steps/phases: 1-3`, numbered checked lists like `1. ✅ ...`, whole-plan completion summaries like `Plan is complete`, fuzzy matching against implementation summaries, or checklist items like `[DONE] item text` / `- [x] item text`
7. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Only read-only tools available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git show`, `git branch --list`, `git ls-files`
- GitHub CLI read: `gh pr list/view/diff/status/checks`, `gh issue list/view/status`, `gh repo view/list`, `gh run list/view`, `gh api` GET-only queries
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`, `git checkout`, `git pull`
- GitHub CLI write: `gh pr merge/checkout/comment`, `gh issue create/edit`, `gh repo clone/create/delete`, non-GET `gh api`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
