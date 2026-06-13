# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, and `plan_questions`
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Prefers `Implementation Steps`, `Execution Steps`, or `Action Plan` sections and extracts only numbered subheadings/top-level list items
- **Interactive questions**: `plan_questions` tool gives a tabbed TUI wizard for implementation-detail questions instead of long A/B/C chat questionnaires
- **Progress tracking**: Widget shows completion status during execution
- **Completion tracking**: Supports `[DONE:n]` markers, `Completed steps/phases: 1-3` status lines, numbered checked lists, and manual `/todos done 1-3` updates
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `/todos done 1-3` - Manually mark steps done
- `/todos reset` - Reset all step completion flags
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

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

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags, `Completed steps/phases: 1-3`, or numbered checked lists like `1. ✅ ...`
6. Progress widget shows completion status

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
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
