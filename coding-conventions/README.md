# coding-conventions

Deterministic `Assisted-by:` trailer on every commit + layered coding-conventions injection with ecosystem auto-detection, for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Features

### 1. Commit Attribution Trailer

Intercepts every `git commit` command run through Pi (both agent `bash` tool calls and user `!` bash commands) and silently appends the kernel-standard `Assisted-by` trailer via `git --trailer`:

```
Assisted-by: pi-coding-agent:claude-opus-4-5
```

- Uses the **active model id** at commit time — automatically reflects `/model` switches.
- Deduplicates via `trailer.ifExists=doNothing` — safe to `--amend`.
- Skips commands that already contain `Assisted-by` (idempotent).
- Covers subagent/swarm commits (global install → child Pi processes inherit the extension).

### 2. Layered Coding Conventions

Injects a compact conventions block into the system prompt on every agent turn, assembled from three layers:

| Layer | Active | Example content |
|-------|--------|-----------------|
| **Global** | Always | Write clean code, handle errors, write tests |
| **Commit** | Always | Imperative subject, wrapped body, trailers at end |
| **Ecosystem** | Per-detected ecosystem | Linux kernel style, Rust/clippy, Go/gofmt, Python/ruff, TS/ESLint, C/C++ |

Ecosystems are auto-detected from the git repo root. All matching ecosystems are injected (monorepo-friendly). Kernel detection suppresses generic C.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/coding-conventions" ~/.pi/agent/extensions/coding-conventions
```

Then `/reload` in Pi.

## Config

Optional: `~/.pi/agent/coding-conventions.json` (created automatically with defaults if absent):

```json
{
  "attribution": {
    "enabled": true,
    "agentName": "pi-coding-agent",
    "tools": [],
    "modelVersion": "auto",
    "includeUserBash": true
  },
  "conventions": {
    "enabled": true,
    "global": true,
    "commitRules": true,
    "ecosystemDetection": true,
    "overridesDir": null
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `attribution.enabled` | `true` | Master toggle for the commit trailer |
| `attribution.agentName` | `"pi-coding-agent"` | AGENT_NAME in the trailer |
| `attribution.tools` | `[]` | Optional specialized analysis tools (space-separated, per kernel doc) |
| `attribution.modelVersion` | `"auto"` | `"auto"` uses the active model id; pin a static string otherwise |
| `attribution.includeUserBash` | `true` | Also rewrite `!git commit` typed in the TUI |
| `conventions.enabled` | `true` | Master toggle for convention injection |
| `conventions.global` | `true` | Inject the global base layer |
| `conventions.commitRules` | `true` | Inject commit-message rules |
| `conventions.ecosystemDetection` | `true` | Detect and inject ecosystem-specific conventions |
| `conventions.overridesDir` | `null` | Custom conventions override directory (default: `~/.pi/agent/conventions/`) |

### Override files

Place replacement `.md` files in `~/.pi/agent/conventions/`:

```
~/.pi/agent/conventions/
├── global.md        # replaces built-in global conventions
├── commit.md        # replaces built-in commit rules
├── kernel.md        # replaces built-in kernel conventions
├── c.md
├── rust.md
├── go.md
├── python.md
└── typescript.md
```

An empty override file (= whitespace only) disables that layer. Missing override files fall back to the built-in snippets.

## Command

```
/conventions           → show full status
/conventions on        → re-enable (attribution + conventions)
/conventions off       → session-level disable
/conventions trailer   → show trailer preview
/conventions reload    → re-read config + override files from disk
```

## Limitations

- Only intercepts literal `git commit` in bash commands. Aliases (`git ci`), wrapper scripts, and commits inside executed scripts are not covered.
- Commit commands already containing `Assisted-by` are passed through unchanged; a malformed trailer is not corrected.
- `modelVersion: "auto"` reflects the model at commit time, not necessarily the model that authored the code.
- User-bash rewrite mutates typed `!git commit` commands silently. Disable with `"includeUserBash": false`.
- Very large override files consume tokens; the extension does not truncate them.

## Format Reference

Per [Documentation/process/coding-assistants.rst](https://docs.kernel.org/process/coding-assistants.html):

```
Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]
```

- Tools are space-separated **specialized analysis tools** (e.g., `coccinelle sparse clang-tidy`).
- Basic development tools (git, gcc, make, editors) should not be listed.
- AI agents MUST NOT add `Signed-off-by` — only the human developer certifies the DCO.
