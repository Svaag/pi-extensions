---
created: 2026-07-25T00:12:16.357Z
source: pi-plan-mode
status: accepted-for-execution
---

# `coding-conventions` Extension — Commit Attribution + Layered Coding Conventions

## Summary

A single Pi extension, `coding-conventions/`, installed globally. It does two things:

1. **Deterministic attribution trailer** — intercepts every `git commit` run through the Pi harness (agent `bash` tool + `!` user-bash) and silently inserts `Assisted-by: pi-coding-agent:<model-id> [pi]` via `git --trailer`, with duplicate suppression. The active model id is read at commit time from `ctx.model`, so `/model` switches are always reflected.

2. **Layered coding-conventions injection** — on every agent turn, appends a compact conventions block to the system prompt assembled from **three layers**: a global base layer (always active), the detected commit-message rules layer (always active), and zero or more **ecosystem-specific snippets** auto-detected from the git repo root (kernel, Rust, Go, Python, TypeScript, generic C/C++).

The agent never needs to remember either feature; both are enforced deterministically by the extension.

## Implementation Steps

1. **Verify kernel doc spec + local git** — fetch `docs.kernel.org/process/coding-assistants.html` (was blocked in Plan Mode; confirm exact `Assisted-by` wording) and verify `git --version` ≥ 2.32 (`--trailer` support). Adjust only the `kernel.md` convention-snippet wording if the doc differs.
2. **Implement `coding-conventions/utils.ts`** — all pure functions: git-commit detection/rewrite, trailer builder, config parser/validator, ecosystem detectors, convention-layer resolver/assembler.
3. **Implement `coding-conventions/index.ts`** — extension entry: config load on `session_start`, `tool_call` + `user_bash` hooks for trailer, `before_agent_start` hook for conventions injection, ecosystem detection + layer assembly, `/conventions` command.
4. **Write built-in convention snippets** (`coding-conventions/conventions/*.md`) — global.md, commit.md, kernel.md, rust.md, go.md, python.md, typescript.md, c.md. Each ≤ 25 lines, concise.
5. **Add `tests/coding-conventions.test.ts`** — unit tests for all pure functions in utils.ts (node:test, type-stripped, auto-picked-up by `npm test`).
6. **Add `coding-conventions/README.md`** — usage, config reference, command reference, limitation notes.
7. **Update root `README.md`** — add extension to the list + symlink instruction.
8. **Manual smoke test** — symlink into `~/.pi/agent/extensions/`, `/reload`, scratch-repo commit, inspect trailer; verify ecosystem detection in this repo (TypeScript), a kernel checkout, and a multi-ecosystem repo; run `/conventions show`.

## Key Details — Attribution Trailer

### Behavior
- **Hook**: `pi.on("tool_call", ...)` + `pi.on("user_bash", ...)` (user-bash gated by `includeUserBash` config, default `true`).
- **Command scan**: walk each command string outside single/double quotes, split into segments on `&&`, `||`, `;`, `|`, newlines. Per segment: skip leading `VAR=value` env assignments → match `git` → consume global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `-P`, `--no-pager`, etc.) → match subcommand `commit` (word boundary; `commit-tree` excluded).
- **Skip** if full command text already contains the literal string `Assisted-by` (idempotent; respects a manually written trailer).
- **Rewrite** each match: `git [globals] commit` → `git [globals] -c trailer.ifExists=doNothing commit --trailer 'Assisted-by: …'`.
  - `-c trailer.ifExists=doNothing` prevents duplicates on `--amend` of an already-attributed commit.
  - `--trailer` works with `-m`, `-F`, editor, and `--amend` flows alike.
  - Trailer value is single-quoted; only `[A-Za-z0-9 ._:\[\]-]` characters are allowed (enforced at config load).
- **Notify**: `ctx.ui.notify("Attributed: Assisted-by: …")` per rewritten commit, TUI mode only.
- **Global coverage**: because the extension installs via symlink into `~/.pi/agent/extensions/`, subagent RPC child processes (swarm workers) inherit it and their commits are attributed too.

### Trailer format
```
Assisted-by: pi-coding-agent:claude-opus-4-5 [pi]
```
- `AGENT_NAME` = `"pi-coding-agent"` (config-overridable).
- `MODEL_VERSION` = `ctx.model.id` resolved at commit time; falls back to `"unknown"` if no model loaded. Config can pin a static string via `modelVersion`.
- Tools = `["pi"]` (config-overridable list; each `[value]` appended).

### Config snippet
```json5
// ~/.pi/agent/coding-conventions.json
{
  "attribution": {
    "enabled": true,
    "agentName": "pi-coding-agent",
    "tools": ["pi"],
    "modelVersion": "auto",
    "includeUserBash": true
  },
  // … conventions section below
}
```

## Key Details — Convention Injection

### Architecture
Three layers are assembled per turn, in order. The assembled block is appended to `event.systemPrompt` in `before_agent_start`:

| Layer | When active | Source |
|-------|-------------|--------|
| **Global** | Always (unless `conventions.global = false`) | Built-in `global.md` or override |
| **Commit rules** | Always (unless `conventions.commitRules = false`) | Built-in `commit.md` or override |
| **Ecosystem** | Per detected ecosystem(s) at git root | Built-in `{ecosystem}.md` or per-ecosystem overrides |

The final block is assembled as:
```
## Global Conventions
<global.md content>

## Commit Conventions
<commit.md content>

## <Ecosystem> Conventions
<kernel.md / rust.md / …>
```

### Ecosystem detection (`session_start`, cached per session)
Run `git rev-parse --show-toplevel` (via `node:child_process execSync`). If no git root, skip ecosystem detection entirely. Check in priority order; **all matching ecosystems are injected** (a monorepo may match several):

| Ecosystem | Detection | Notes |
|-----------|-----------|-------|
| **Kernel** | `MAINTAINERS` + `scripts/checkpatch.pl` both exist at root | Supersedes generic C; `c.md` is NOT injected when kernel is detected |
| **C/C++** | `*.c` or `*.h` at root, OR `CMakeLists.txt`, OR `Makefile` | Only if kernel was NOT detected |
| **Rust** | `Cargo.toml` at root | |
| **Go** | `go.mod` at root | |
| **Python** | `pyproject.toml` OR `setup.py` OR `setup.cfg` at root | |
| **TypeScript** | `tsconfig.json` at root OR `package.json` with `devDependencies.typescript` | |

### Override files
`~/.pi/agent/conventions/{global,commit,kernel,rust,go,python,typescript,c}.md`

- If a file exists, it **replaces** the corresponding built-in snippet.
- An empty override file (= the layer is injected as blank → effectively disabled for that ecosystem). A cleaner disable: set the layer's config flag to `false`, or for ecosystem layers, detection doesn't match (no file = not injected at all) — override exists empty = still detected, still injected, but empty block.
- Override directory location is configurable via `conventions.overridesDir`.
- Built-in snippets ship inside the extension directory (`coding-conventions/conventions/*.md`), versioned in this repo.

### Config snippet (conventions section)
```json5
// ~/.pi/agent/coding-conventions.json
{
  // attribution: { … as above … },
  "conventions": {
    "enabled": true,           // master toggle for all convention injection
    "global": true,            // global base layer
    "commitRules": true,       // kernel-inspired commit-message rules (everywhere)
    "ecosystemDetection": true,
    "overridesDir": "~/.pi/agent/conventions"  // or null to disable overrides
  }
}
```

### Conventions content (summaries — final text in the `.md` files)

**global.md** (~10 lines): write clear self-documenting code; keep functions small; handle errors explicitly; write tests; no commented-out dead code; follow project conventions when present; be consistent.

**commit.md** (~15 lines): imperative subject ≤ 72 chars; blank line; body wrapped at 72 cols, explains WHY; trailers at end (`Signed-off-by`, `Reviewed-by`, etc.) — **do not** add `Assisted-by` (the harness adds it automatically); follow `submitting-patches.rst` for kernel projects.

**kernel.md** (~20 lines): `coding-style.rst`: 8-wide tabs, 80-col lines, K&R brace style, no CamelCase, `pr_`/`dev_` APIs preferred; run `scripts/checkpatch.pl`; `Signed-off-by` from the human developer only; `Assisted-by` is automatic; reference `Documentation/process/`.

**rust.md, go.md, python.md, typescript.md, c.md**: concise, ~10–15 lines each, referencing canonical style guides (`rustfmt`/`clippy`, `gofmt`/Effective Go, PEP 8/`ruff`, Prettier/ESLint, C naming/alloc conventions).

### `/conventions` command
```
/conventions
  → status: enabled/disabled, trailer preview, detected ecosystems, loaded layers
/conventions on        → re-enable (attribution + conventions)
/conventions off       → session-level disable
/conventions show      → print all active convention blocks (notify)
/conventions trailer   → print trailer preview only
```

Also aliased as `/conventions reload` → re-read config + overrides from disk (without `/reload`; just refreshes the extension's in-memory state).

## File Layout

```
coding-conventions/
├── index.ts                 # Extension entry: hooks, config, command
├── utils.ts                 # Pure functions (testable without pi)
├── conventions/
│   ├── global.md            # Universal base conventions
│   ├── commit.md            # Commit-message rules
│   ├── kernel.md            # Linux kernel specific
│   ├── c.md                 # Generic C/C++
│   ├── rust.md
│   ├── go.md
│   ├── python.md
│   └── typescript.md
└── README.md

tests/
└── coding-conventions.test.ts
```

Root `README.md` appends:
```markdown
- `coding-conventions/` — deterministic `Assisted-by:` trailer on every commit + layered coding-conventions injection with ecosystem auto-detection.
```
And the install section adds:
```bash
ln -s "$PWD/pi-extensions/coding-conventions" ~/.pi/agent/extensions/coding-conventions
```

## Test Plan

### Unit tests (`tests/coding-conventions.test.ts`, node:test, auto-included by `npm test`)

**Trailer functions:**
- `buildTrailer(cfg, modelId)`: defaults → `Assisted-by: pi-coding-agent:claude-opus-4-5 [pi]`; custom agentName; missing model → `unknown`; pinned `modelVersion`; multi-tool list; trailing `]` spacing.
- `findGitCommitRewrites(command)`: plain `git commit -m "x"`; `git commit -m "fix git commit bug"` (second `git commit` inside quotes — not matched); chained `git add && git commit && git push`; `git -C /p -c k=v commit --amend`; `GIT_EDITOR=true git commit …`; heredoc `-F - <<EOF`; two commits in one command → two rewrite points; `git commit-tree` → no match; `sudo git commit` → how to handle? Decision: treat `sudo` as a command prefix (skip it) — parser skips `sudo` like it skips env assignments; existing `commit` already containing `Assisted-by` in full command → skip; non-git commands → no match.
- `applyRewrites(command, rewrites, trailer)`: produces expected rewritten command for simple case; env prepended correctly; chained; multiple segments.

**Config functions:**
- `parseConfig(json)`: missing file → full defaults; empty object → full defaults; partial override; invalid JSON → defaults + schema error; `attribution.enabled: false` respected.
- `resolveConventionLayer(builtinPath, overridePath)`: override exists → its content; override missing → built-in content; both missing → empty string (ecosystem not present); override empty → empty string (disables that layer).

**Ecosystem detection:**
- `detectEcosystems(root, existsFn)`: injected `exists(path) => boolean` for test isolation.
  - Kernel detected (MAINTAINERS + checkpatch) → `["kernel"]` (NOT `["c"]`), regardless of `.c`/`.h` files.
  - Kernel not detected, C files present → `["c"]`.
  - Kernel + Rust (Cargo.toml) → `["kernel", "rust"]`.
  - TS + Python → `["typescript", "python"]`.
  - All nothing → `[]`.
  - `package.json` but no `tsconfig.json` and no `typescript` in devDeps → not TypeScript.
  - `package.json` with `devDependencies.typescript` → TypeScript.

**Convention block assembly:**
- `assembleConventionBlock(layers)`: global + commit + kernel → three labeled sections in order; no ecosystems → only global + commit; disabled global → no global section; disabled commit → no commit section.

### Manual acceptance
- Symlink into `~/.pi/agent/extensions/coding-conventions`.
- `/reload` → verify `session_start` notification shows loaded convention layers.
- Scratch repo commit via Pi agent → `git log -1 --format=%B` shows the `Assisted-by` trailer.
- `git commit --amend` without changes re-runs → trailer not duplicated.
- `/conventions` status correctly shows: attribution enabled, model version, detected ecosystems, loaded convention layers.
- TypeScript repo (this repo) → injected global + commit + TypeScript conventions (no kernel).
- Kernel checkout → global + commit + kernel conventions.
- `/conventions off` → commit goes through without trailer; agent-turn excludes convention block.
- `/conventions on` → restores both.

## Assumptions

- The kernel doc's trailer format matches the user-quoted `"Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]"`. Network fetch was blocked in Plan Mode; step 1 confirms and adjusts the `kernel.md` snippet text if needed.
- Local `git --version` ≥ 2.32 (2021), providing `--trailer` + `trailer.ifExists` support. Verified in step 1; if git is older, trailer injection is skipped with a one-time warning notify.
- The `tool_call` `bash` hook covers agent-initiated commits; the `user_bash` hook covers `!git commit` typed by the user in the TUI, matching "all commits done with my Pi Harness."
- Subagent workers (via the `subagent/` extension) spawn Pi RPC processes that load global extensions from `~/.pi/agent/extensions/`, so swarm commits are attributed too.
- Convention snippets are injected every turn (not per-session). Their token cost is negligible (~200–400 tokens added to an already-2k+ system prompt). If a user creates very large override files, the extension does not truncate; this is documented as a caveat.
- Ecosystem detection uses `execSync` for `git rev-parse --show-toplevel` at session start. This is fast (local, sub-ms). If git is unavailable, detection is skipped and only global + commit conventions are injected.
- Existing repo conventions files (per-project AGENTS.md/CLAUDE.md) are Pi-native and load independently; they are not modified, suppressed, or duplicated by this extension.

## Known Limitations (documented in README)

- Only intercepts literal `git commit` in bash commands. Aliases, wrapper scripts, and `git commit` inside executed scripts are not covered.
- Commit commands already containing `Assisted-by` are passed through unchanged; a manually malformed trailer is not corrected.
- `modelVersion` reflects the model selected at commit time, not necessarily the model that authored the code (the config can pin a string if preferred).
- Very large user override files will increase token consumption; the extension does not truncate them.
- The `!git commit` user-bash rewrite mutates the user's typed command silently. This is enabled by default (`includeUserBash: true`); set to `false` if you prefer only agent commits be attributed.


<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Verify kernel doc spec + local git — fetch docs.kernel.org/process/coding-assistants.html (was blocked in Plan Mode; confirm exact Assisted-by wording) and verify git --version ≥ 2.32 (--trailer support). Adjust only the kernel.md convention-snippet wording if the doc differs. _(done)_
- [x] 2. Implement coding-conventions/utils.ts — all pure functions: git-commit detection/rewrite, trailer builder, config parser/validator, ecosystem detectors, convention-layer resolver/assembler. _(done)_
- [x] 3. Implement coding-conventions/index.ts — extension entry: config load on session_start, tool_call + user_bash hooks for trailer, before_agent_start hook for conventions injection, ecosystem detection + layer assembly, /conventions command. _(done)_
- [x] 4. Write built-in convention snippets (coding-conventions/conventions/*.md) — global.md, commit.md, kernel.md, rust.md, go.md, python.md, typescript.md, c.md. Each ≤ 25 lines, concise. _(done)_
- [x] 5. Add tests/coding-conventions.test.ts — unit tests for all pure functions in utils.ts (node:test, type-stripped, auto-picked-up by npm test). _(done)_
- [x] 6. Add coding-conventions/README.md — usage, config reference, command reference, limitation notes. _(done)_
- [x] 7. Update root README.md — add extension to the list + symlink instruction. _(done)_
- [x] 8. Manual smoke test — symlink into ~/.pi/agent/extensions/, /reload, scratch-repo commit, inspect trailer; verify ecosystem detection in this repo (TypeScript), a kernel checkout, and a multi-ecosystem repo; run /conventions show. _(done)_

<!-- pi-plan-progress:end -->
