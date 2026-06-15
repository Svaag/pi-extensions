---
created: 2026-06-15T10:14:58.578Z
source: pi-plan-mode
status: accepted-for-execution
---

# Fix and Improve Pi TUI Rendering in pi-extensions

## Summary

Three related rendering issues are addressed. Two are fixable inside this repository (the `tool-highlight` extension); the third is an upstream Pi-core defect that is documented and filed but not patched locally.

1. **Tool output syntax highlighting (`read`/`edit`/`write`)** — already works via `ToolOutputHighlighter`. No logic change. Stabilize the surrounding code (move into a clean module layout with `ansi.ts`, `format-detector.ts`, `bash-renderer.ts`).
2. **Bash ANSI escaping** — replace `tool-highlight/bash-highlighter.ts` with a clean-room rewrite split into three modules. Fix the global `RegExp.test()` `lastIndex` bug, add colon-separator SGR support (`\x1b[38:2:255:0:0m`), and implement (instead of stub) the diagnostics/grep/log highlighters.
3. **Assistant Markdown rendering** — fenced code blocks render with visible backticks. This is a Pi-core bug, not interceptable via `pi.registerMessageRenderer`. File an upstream issue; do not work around it in the extension.

`highlightCode()` is assumed to return ANSI-embedded strings. The Text component from `@earendil-works/pi-tui` passes ANSI through to the terminal. `pi.registerTool({ name, renderResult })` fully replaces the built-in `bash` renderer's `renderResult` slot; the built-in `execute` is inherited.

## Implementation Steps

1. Create `tool-highlight/ansi.ts` with the fixed ANSI sanitizer and the `ThemeLike` interface.
2. Create `tool-highlight/format-detector.ts` with the extracted `detectFormat` (using the new `containsAnsi`).
3. Create `tool-highlight/bash-renderer.ts` with the new `BashOutputHighlighter` and real (non-stub) private highlight methods.
4. Update `tool-highlight/index.ts` to import `BashOutputHighlighter` from `./bash-renderer.ts`. No wiring change.
5. Delete `tool-highlight/bash-highlighter.ts`.
6. Rewrite `tests/bash-highlighter.test.ts` to cover `ansi.ts`, `format-detector.ts`, and `bash-renderer.ts`, including a hard regression test for the `RegExp.test()` `lastIndex` bug and colon-separator SGR support.
7. Update `tool-highlight/README.md` with the new module layout, the `PI_TOOL_HIGHLIGHT_BASH=1` env var, and an explicit note that assistant Markdown is an upstream issue.
8. Run `npm test` and verify all existing + new tests are green.
9. File the upstream bug report using the draft included in this plan (see "Upstream Bug Report Draft" below).

## Key Details

### New file: `tool-highlight/ansi.ts`

Pure ANSI sanitization. Zero `@earendil-works/pi-coding-agent` imports so tests can run with `node --experimental-strip-types --test`.

```ts
// Non-global SGR regex — no lastIndex footgun
// Includes colon sub-parameters (e.g. \x1b[38:2:255:0:0m)
const SGR_ONLY = /\x1b\[[0-9;:]*m/;
// Global regex for splitting/capturing ALL escape sequences
const ALL_ESCAPES = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Strip all escape sequences except SGR (color/style). */
export function sanitizeAnsi(text: string): string { ... }

/** True if the text contains at least one SGR sequence. */
export function containsAnsi(text: string): boolean { ... }
```

**`sanitizeAnsi` algorithm** (decision-complete):

1. `const parts = text.split(ALL_ESCAPES);`  // keeps plain text between escapes
2. `const escapes = text.match(ALL_ESCAPES) ?? [];`
3. `let out = parts[0] ?? "";`
4. For each `i` in `0..escapes.length-1`:
   - `const esc = escapes[i];`
   - `if (SGR_ONLY.test(esc)) out += esc;`  // non-global regex: always starts at index 0
   - `out += parts[i + 1] ?? "";`
5. `return out;`

The non-global `SGR_ONLY` is the key correctness fix. Because it has no `g` flag, `RegExp.prototype.test` does not advance `lastIndex`, so consecutive calls on different escape strings are independent.

**`containsAnsi` algorithm**:

- `return SGR_ONLY.test(text);` (using the non-global regex).

### New file: `tool-highlight/format-detector.ts`

Pure format detection. Extracted from the current `detectFormat`. Uses `containsAnsi` from `./ansi.ts`.

```ts
export type OutputFormat =
  | "ansi" | "json" | "diff" | "traceback"
  | "diagnostics" | "grep" | "log" | "plain";

export function detectFormat(text: string): OutputFormat { ... }
```

**Order of checks** (matters; earlier wins):

1. `containsAnsi(text)` → `"ansi"`
2. Diff: first non-empty line starts with `diff `, `--- `, `+++ `, `@@ `, `index `, or matches `/^\s*[+-]{3}\s/`
3. JSON: first non-empty line starts with `{`, `[`, or matches `/^\s*["{[]/` AND `JSON.parse(first)` succeeds
4. Traceback: matches Python `Traceback (most recent call last):`, JS `at foo (file:line:col)`, Rust `thread 'X' panicked at`, or `/^\s*Error:\s/`
5. Diagnostics: matches `[ERROR]`, `[WARN]`, `[WARNING]`, `[INFO]`, `[DEBUG]`, `[PASS]`, `[FAIL]`; or `^\s*(error|warning|info|note|help)\s*\[?`; or `:line:col:\s*(error|warning|info):`; or `/\bfail(ures?|ed)?\b/i`
6. Grep: matches `^[^\n]+:\d+:\d*:` or `^[^\n]+:\d+:`
7. Log: first non-empty line matches ISO-like timestamp `^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`, time-only `^\d{2}:\d{2}:\d{2}`, or text contains `\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b`
8. Default → `"plain"`

**Empty / whitespace-only input behavior** (verified): `"".split(/\r?\n/)` returns `[""]`, so `first = ""` and all checks are false → returns `"plain"`. No change needed; an explicit test case is added to lock this in.

### New file: `tool-highlight/bash-renderer.ts`

Clean-room rewrite. No `@earendil-works/pi-coding-agent` imports.

```ts
import type { HighlightFn } from "./highlighter.ts";
import type { ThemeLike } from "./ansi.ts";
import { sanitizeAnsi, containsAnsi } from "./ansi.ts";
import { detectFormat, type OutputFormat } from "./format-detector.ts";

export interface BashToolArgs {
  command?: string; args?: string[]; cwd?: string;
}
export interface BashToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: {
    command?: string; args?: string[]; cwd?: string;
    exitCode?: number; stdout?: string; stderr?: string;
  };
}

/** Minimal theme contract used by the bash renderer. */
export interface ThemeLike {
  fg(name: string, text: string): string;
}

export class BashOutputHighlighter {
  private readonly theme: ThemeLike;
  private readonly highlight: HighlightFn;
  private readonly isTruecolor: boolean;

  constructor(theme: ThemeLike, highlight: HighlightFn, isTruecolor: boolean) { ... }

  renderCommand(args: BashToolArgs): string { ... }
  renderResult(result: BashToolResult): string { ... }

  // Private methods:
  private highlightDiagnostics(text: string): string { ... }
  private highlightGrep(text: string): string { ... }
  private highlightLog(text: string): string { ... }
  private highlightTraceback(text: string): string { ... }
  private commandString(args: BashToolArgs): string | null { ... }
  private extractOutput(result: BashToolResult): string { ... }
  private safeHighlight(text: string, lang: string): string { ... }
}
```

> **Note on theme typing:** the constructor is typed `theme: ThemeLike` in `bash-renderer.ts`. `index.ts` already passes the real theme from Pi-core; we cast it: `theme: theme as ThemeLike`. The test file uses a stub `{ name: "test-theme" }` and the test code casts to `ThemeLike` at the call site — this is acceptable because the test fakes are deliberately minimal and the public methods only call `theme.fg(...)` via the interface.

**`renderCommand(args)`** — unchanged behavior:

- If `args.command` present → use it
- Else if `args.args.length > 0` → `args.args.join(" ")`
- Else → return `""`
- If `!isTruecolor` → return command as-is
- Else `return this.safeHighlight(cmd, "shell")`

**`renderResult(result)`** — new decision-complete algorithm:

1. `const output = this.extractOutput(result);`
2. If `output === ""` → return `""`
3. If `!isTruecolor` → return `output` (raw, no ANSI)
4. If `containsAnsi(output)` → return `sanitizeAnsi(output)` (preserve SGR, strip dangerous sequences)
5. `const format = detectFormat(output);` and dispatch:

| `format`        | Action                                                      |
| --------------- | ----------------------------------------------------------- |
| `"ansi"`        | `sanitizeAnsi(output)` (defensive; branch 4 already covers) |
| `"json"`        | `this.safeHighlight(output, "json")`                        |
| `"diff"`        | `this.safeHighlight(output, "diff")`                        |
| `"traceback"`   | `this.highlightTraceback(output)`                           |
| `"diagnostics"` | `this.highlightDiagnostics(output)`                         |
| `"grep"`        | `this.highlightGrep(output)`                                |
| `"log"`         | `this.highlightLog(output)`                                 |
| `"plain"`       | `output`                                                    |

**Private highlighter methods** (no longer stubs):

- **`highlightTraceback(text)`** — guess language using the same heuristics as `detectFormat` (Python: `Traceback (most recent call last):` → `"python"`; JS: `at foo (file:line:col)` → `"javascript"`; Rust: `thread 'X' panicked at` → `"rust"`). If a language is detected, return `this.safeHighlight(text, lang)`. If no language detected, return `text` unchanged.

- **`highlightDiagnostics(text)`** — split into lines; for each line, colorize:
  - Leading `[ERROR]`, `[FATAL]` → `theme.fg("error", ...)`
  - Leading `[WARN]`, `[WARNING]` → `theme.fg("warning", ...)`
  - Leading `[INFO]`, `[PASS]` → `theme.fg("success", ...)`
  - Leading `[DEBUG]`, `[TRACE]`, `[NOTE]`, `[HELP]` → `theme.fg("dim", ...)`
  - Compiler-style `path:line:col: error: ...` → `theme.fg("error", "error:")` and the rest plain
  - All transformations preserve the surrounding text; only the matched token is wrapped. Fallback to plain if `theme.fg` throws.

- **`highlightGrep(text)`** — for each line matching `^([^\n]+:\d+:\d*:?)(.*)$`:
  - `theme.fg("accent", prefix)` + `rest`
  - If the line does not match (interleaved context), return as-is.
  - Must not break if the line has no colon prefix.

- **`highlightLog(text)`** — for each line:
  - Colorize a leading ISO timestamp `^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?` with `theme.fg("dim", ts)`
  - Then scan for `\b(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\b` and colorize with the same mapping as `highlightDiagnostics`
  - All transformations preserve the line; only the matched spans are wrapped. Fallback to plain if `theme.fg` throws.

`safeHighlight(text, lang)` wraps `this.highlight(text, lang, this.theme)` in `try/catch` and returns `text` on error.

`extractOutput(result)` is unchanged from the current code: prefers `details.stdout` + `details.stderr` (joined with `\n`) if either is defined; otherwise `content[].text`.

### Modified file: `tool-highlight/index.ts`

Single import line change:

```ts
// Before:
import { BashOutputHighlighter, type BashToolArgs, type BashToolResult } from "./bash-highlighter.ts";
// After:
import { BashOutputHighlighter, type BashToolArgs, type BashToolResult } from "./bash-renderer.ts";
import type { ThemeLike } from "./bash-renderer.ts";
```

Plus the cast in the `registerTool({ name: "bash", ... })` callbacks:

```ts
renderCall: (args, theme, _context) => {
  const highlighter = new BashOutputHighlighter(theme as ThemeLike, highlightCode, isTruecolor);
  return highlighter.renderCommand(args as BashToolArgs);
},
renderResult: (result, _options, theme, _context) => {
  const highlighter = new BashOutputHighlighter(theme as ThemeLike, highlightCode, isTruecolor);
  return highlighter.renderResult(result as BashToolResult);
},
```

The header comment block already documents the optional `PI_TOOL_HIGHLIGHT_BASH=1` path. No other change.

### Deleted file: `tool-highlight/bash-highlighter.ts`

Replaced by the three new modules above. The file is removed; no shim, no re-export.

### Rewritten file: `tests/bash-highlighter.test.ts`

Single file, three comment-delimited sections. The test file imports from the new module locations.

```ts
import {
  BashOutputHighlighter,
  type BashToolArgs,
  type BashToolResult,
  type ThemeLike,
} from "../tool-highlight/bash-renderer.ts";
import { containsAnsi, sanitizeAnsi } from "../tool-highlight/ansi.ts";
import { detectFormat, type OutputFormat } from "../tool-highlight/format-detector.ts";
```

A small test-theme helper:

```ts
const testTheme: ThemeLike = {
  fg: (_name, text) => `<<${_name}:${text}>>`,
};
const noopHighlight: HighlightFn = (code, lang) => `<<${lang}:${code}>>`;
```

#### Section 1 — `ansi.ts`

| # | Test                                                                                                                                             |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | `sanitizeAnsi` preserves basic 8-color SGR: `\x1b[31mred\x1b[0m` round-trips.                                                                     |
| 2 | `sanitizeAnsi` preserves 256-color SGR with semicolons: `\x1b[38;5;196mred\x1b[0m` round-trips.                                                  |
| 3 | `sanitizeAnsi` preserves 24-bit colon-separator SGR: `\x1b[38:2:255:0:0mred\x1b[0m` round-trips.                                                 |
| 4 | `sanitizeAnsi` preserves 24-bit semicolon-separator SGR: `\x1b[38;2;255;0;0mred\x1b[0m` round-trips.                                             |
| 5 | `sanitizeAnsi` strips cursor movement: `before\x1b[2J\x1b[Hafter` → `beforeafter`.                                                              |
| 6 | `sanitizeAnsi` strips screen clear / line clear: `\x1b[2K`, `\x1b[3J`.                                                                          |
| 7 | `sanitizeAnsi` strips OSC hyperlinks: `\x1b]8;;https://x.example\x1b\\link\x1b]8;;\x1b\\` → `link`.                                              |
| 8 | `sanitizeAnsi` strips terminal title changes: `\x1b]0;title\x07`.                                                                                |
| 9 | `sanitizeAnsi` strips DCS / APC / PM: `\x1bP...payload...ST` and `\x1b_...ST`.                                                                   |
| 10 | **Bug 1 regression** — `sanitizeAnsi` preserves consecutive SGR sequences of varying lengths: `\x1b[38;5;196mred\x1b[31mmore\x1b[0m` round-trips. (Pre-fix global regex would have dropped the `\x1b[31m`.) |
| 11 | `sanitizeAnsi` on empty string returns empty string.                                                                                             |
| 12 | `sanitizeAnsi` on plain text (no escapes) returns text unchanged.                                                                                |
| 13 | `containsAnsi` detects basic SGR, 256-color SGR, colon-separator SGR, all → `true`.                                                               |
| 14 | `containsAnsi` returns `false` for cursor movement, OSC, and plain text.                                                                         |
| 15 | **Bug 1 regression** — `containsAnsi` is correct on consecutive calls: `containsAnsi("\x1b[38;5;196m")` → `true`; then `containsAnsi("\x1b[31m")` → `true`; then `containsAnsi("\x1b[0m")` → `true`; then `containsAnsi("plain")` → `false`. (Pre-fix global regex would have returned `false` for the second and third calls due to `lastIndex` advancing.) |

#### Section 2 — `format-detector.ts`

All existing `detectFormat` tests are kept; one new edge case is added.

| # | Test                                                                                         |
| - | -------------------------------------------------------------------------------------------- |
| 1 | `detectFormat("\x1b[31merr\x1b[0m")` → `"ansi"`.                                             |
| 2 | Diff: `diff --git a/x b/x\n--- a/x\n+++ b/x` → `"diff"`; `@@ -1,3 +1,4 @@\n-old\n+new` → `"diff"`. |
| 3 | JSON: `'{"ok":true}'` → `"json"`; `'[1,2,3]'` → `"json"`; NDJSON `{"a":1}\n{"b":2}` → `"json"`. |
| 4 | Tracebacks: Python `Traceback (most recent call last):`; JS `Error: x\n    at y (/z.js:1:2)`; Rust `thread 'main' panicked at src/lib.rs:1`. |
| 5 | Diagnostics: `src/main.ts:1:2: error TS1234: bad type`; `[ERROR] x`; `FAIL test`.            |
| 6 | Grep: `src/main.ts:10:import foo`; `file.txt:42:matched line`.                               |
| 7 | Log: `2024-01-15T09:30:00Z INFO starting`; `09:30:00 WARN slow query`; `DEBUG trace info`.   |
| 8 | Plain: `hello world` → `"plain"`.                                                            |
| 9 | **Empty / whitespace input** — `""`, `"\n\n"`, `"   \n   "` all return `"plain"`. (Locks in the verified `text.split(/\r?\n/)` → `[""]` behavior.) |

#### Section 3 — `bash-renderer.ts`

`BashOutputHighlighter` is exercised end-to-end via `renderCommand` and `renderResult`. The previously-exported `highlightLog`/`highlightGrep`/`highlightDiagnostics`/`highlightTraceback` helpers are now private; coverage goes through `renderResult`.

| # | Test                                                                                                                          |
| - | ----------------------------------------------------------------------------------------------------------------------------- |
| 1 | `renderCommand({ command: "ls -la" })` with truecolor → `<<shell:ls -la>>`.                                                  |
| 2 | `renderCommand({ command: "ls -la" })` with `truecolor: false` → `"ls -la"`.                                                  |
| 3 | `renderCommand({ args: ["git","status","--short"] })` → `<<shell:git status --short>>`.                                      |
| 4 | `renderCommand({})` → `""`.                                                                                                   |
| 5 | `renderResult`: input with ANSI + dangerous sequence (`\x1b[31mred\x1b[2K\x1b[0m`) → `\x1b[31mred\x1b[0m`.                    |
| 6 | `renderResult`: JSON `{"a":1}` → `<<json:{"a":1}>>`.                                                                          |
| 7 | `renderResult`: diff output → starts with `<<diff:`.                                                                          |
| 8 | `renderResult`: Python traceback → `<<python:...>>` (via `safeHighlight`).                                                   |
| 9 | `renderResult`: JS traceback → `<<javascript:...>>`.                                                                          |
| 10 | `renderResult`: Rust panic → `<<rust:...>>`.                                                                                  |
| 11 | `renderResult`: diagnostics `[ERROR] boom` → contains `<<error:[ERROR]>>`.                                                    |
| 12 | `renderResult`: grep `file.txt:42:hit` → contains `<<accent:file.txt:42:>>` followed by `hit`.                                |
| 13 | `renderResult`: log `2024-01-15T09:30:00Z INFO starting` → contains `<<dim:2024-01-15T09:30:00Z>>` and `<<success:INFO>>`.   |
| 14 | `renderResult`: plain `hello world` → `"hello world"`.                                                                        |
| 15 | `renderResult`: `truecolor: false` → raw text regardless of format.                                                           |
| 16 | `renderResult`: uses `details.stdout`/`details.stderr` when present (joins with `\n`).                                        |
| 17 | `renderResult`: combines stdout + stderr.                                                                                     |
| 18 | `renderResult`: empty output → `""`.                                                                                          |
| 19 | `renderResult`: highlighter throws → returns raw text (graceful fallback).                                                    |
| 20 | `renderResult`: does NOT mutate `result.content[].text` (the canonical raw is preserved; only the returned display string is styled). |

A small private-method direct test is also included for confidence in the new logic: instantiate `BashOutputHighlighter`, call `renderResult` with a grep input, and assert the returned string starts with the `theme.fg("accent", ...)` wrapping. This is the same as test #12 above; no additional public surface is needed.

### Modified file: `tool-highlight/README.md`

Updates required:

- Architecture diagram: list `index.ts`, `highlighter.ts`, `ansi.ts`, `format-detector.ts`, `bash-renderer.ts`.
- New section "Optional: bash output highlighting" documenting:
  - `PI_TOOL_HIGHLIGHT_BASH=1` env var.
  - What it does: registers a `renderResult` + `renderCall` override for the built-in `bash` tool.
  - Pipeline: `extractOutput` → `containsAnsi` (sanitize) or `detectFormat` (dispatch) → `highlightCode` / private colorizers.
  - Safety: `sanitizeAnsi` strips non-SGR escapes (cursor moves, screen clears, OSC, DCS, terminal titles).
- New section "Upstream issues (out of scope)" with a one-paragraph note that assistant Markdown rendering is a Pi-core bug, link to the filed issue (added in step 9 below).

The existing `## Behavior` and `## Testing` sections are preserved.

## Test Plan

`npm test` runs `node --experimental-strip-types --test tests/*.test.ts`. The test glob automatically picks up the rewritten `tests/bash-highlighter.test.ts` and the existing `tests/tool-highlight.test.ts`, `tests/plan-mode.test.ts`, `tests/goal-mode.test.ts`.

**Hard regression test (Bug 1) — `containsAnsi` consecutive calls:**

```ts
test("containsAnsi: works correctly on consecutive calls (Bug 1 regression)", () => {
  // Pre-fix global regex /\x1b\[[0-9;]*m/g persists lastIndex across calls.
  // A long SGR (9 chars) would set lastIndex=9, causing the next shorter
  // SGR (5 chars) to be missed. The fix uses a non-global SGR_ONLY regex.
  assert.equal(containsAnsi("\x1b[38;5;196m"), true);
  assert.equal(containsAnsi("\x1b[31m"), true);   // would FAIL pre-fix
  assert.equal(containsAnsi("\x1b[0m"), true);    // would FAIL pre-fix
  assert.equal(containsAnsi("plain"), false);
});
```

**Hard regression test (Bug 1) — `sanitizeAnsi` mixed lengths:**

```ts
test("sanitizeAnsi: preserves consecutive SGR of varying lengths (Bug 1 regression)", () => {
  const input = "\x1b[38;5;196mred\x1b[31mmore\x1b[0m";
  assert.equal(sanitizeAnsi(input), input);
});
```

**Colon-separator SGR test (Bug 2):**

```ts
test("sanitizeAnsi: preserves colon-separated SGR sub-parameters", () => {
  const input = "\x1b[38:2:255:0:0mtruecolor\x1b[0m";
  assert.equal(sanitizeAnsi(input), input);
});
```

**Raw content preservation (regression):**

```ts
test("renderResult: does not mutate result.content[].text", () => {
  const h = makeHighlighter({ truecolor: true });
  const result: BashToolResult = {
    content: [{ type: "text", text: "original-raw" }],
  };
  const before = result.content[0].text;
  h.renderResult(result);
  assert.equal(result.content[0].text, before);
});
```

**Manual Alacritty verification** (post-implementation):

1. `read` of a `.ts` file renders highlighted code in the TUI.
2. `PI_TOOL_HIGHLIGHT_BASH=1 pi ...` then `printf '\033[31mred\033[0m'` → red text, not `\x1b[31m` literals.
3. `printf '\033[38;2;255;0;0mtruecolor\033[0m'` → truecolor red.
4. `printf '\033[2J\033[Hclear'` → cursor/screen sequences stripped, only `clear` is visible.
5. `python3 -c 'import json; print(json.dumps({"a":1}))'` → JSON syntax-highlighted.
6. Assistant fenced code blocks still show literal backticks (expected; covered by the upstream bug report).

## Acceptance Criteria

1. `read`/`edit`/`write` render highlighted output exactly as today (no behavior regression).
2. Raw tool output (`result.content[].text`) is never mutated by any renderer.
3. `sanitizeAnsi` preserves SGR with both `;` and `:` sub-parameter separators (3-bit, 8-bit, 24-bit).
4. `sanitizeAnsi` strips cursor movement, screen clears, OSC, DCS, APC, PM, and terminal title sequences.
5. `sanitizeAnsi` and `containsAnsi` use a non-global SGR regex with no `lastIndex` footgun.
6. `containsAnsi` returns correct results on consecutive calls (regression-locked).
7. `BashOutputHighlighter` (with `PI_TOOL_HIGHLIGHT_BASH=1`) sanitizes existing ANSI and adds safe highlight-based colorization.
8. Bash output goes through `detectFormat` before highlighting; only recognized formats are highlighted. Unknown formats and `truecolor: false` both fall back to plain text.
9. `highlightDiagnostics`, `highlightGrep`, `highlightLog` are real implementations (not stubs) and use `theme.fg(name, text)`.
10. `highlightTraceback` uses `safeHighlight` with detected language (`python` / `javascript` / `rust`).
11. All existing tests in `tests/*.test.ts` remain green.
12. New tests cover Bug 1 regression (×2), colon SGR (×1), all 8 format types (×1), empty-input format detection (×1), bash `renderResult` for every format (×5), and raw-content preservation (×1).
13. Upstream bug report is filed with the draft from this plan (see below).
14. `tool-highlight/README.md` documents the new module layout, the `PI_TOOL_HIGHLIGHT_BASH=1` env var, and the upstream Markdown issue.

## Upstream Bug Report Draft

To be filed against `earendil-works/pi-mono` (or the current monorepo URL if it has moved) using `gh issue create`:

- **Title:** `Assistant message Markdown rendering: fenced code blocks show visible backticks`
- **Body:**

  ```markdown
  ## Summary

  Assistant message prose containing fenced code blocks (and other Markdown constructs) is rendered in the TUI as raw text, with the leading/trailing triple backticks visible. This breaks display of any Markdown the model emits in a normal assistant turn.

  ## Reproduction

  1. Start `pi` in any TUI.
  2. Ask the assistant a question whose natural answer includes a fenced code block, e.g. "show me a `tsconfig.json` example".
  3. The assistant emits a fenced code block in its reply.

  ## Expected

  The fenced code block is rendered as syntax-highlighted code (using the same theme tokens available via `mdCodeBlock`, `mdCodeBlockBorder`, `mdCode`, etc.) and the surrounding prose is rendered with the existing Markdown formatting (headings, lists, links).

  ## Actual

  The triple backticks are visible as literal characters. The code body is shown as monospace but with no syntax highlighting. Surrounding Markdown (headings, lists, quotes) is shown as plain text.

  ## Investigation notes

  - `pi.registerMessageRenderer(customType, renderer)` is documented as only handling messages with a `customType` field; built-in `role: "assistant"` messages are not interceptable via this API.
  - The Markdown component exists in `@earendil-works/pi-tui` and a `getMarkdownTheme()` helper is exported from `@earendil-works/pi-coding-agent`.
  - Theme tokens exist: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`. None of them appear to be applied to assistant message prose in the TUI today.
  - Likely fix location: Pi-core's assistant message rendering component (e.g. `packages/coding-agent/src/modes/interactive/components/`). Wrapping each `TextContent` block in the Markdown component using `getMarkdownTheme()` would address the issue.
  - Workaround attempted at the extension layer: `pi.registerMessageRenderer` does not provide a hook for built-in `assistant` messages, so there is no extension-side fix.

  ## Environment

  - `pi` version: (latest from `earendil-works/pi-mono` main as of filing date)
  - Terminal: Alacritty 0.13+, `$COLORTERM=truecolor`
  - Theme: any (issue is not theme-specific)

  ## Related

  - The `tool-highlight` extension (in `Svaag/pi-extensions`) overrides `renderResult` for `read`/`edit`/`write` and (optionally, with `PI_TOOL_HIGHLIGHT_BASH=1`) `bash`, and works correctly because `pi.registerTool({ name, renderResult })` is a per-slot override. There is no equivalent hook for the assistant message renderer.
  ```

  ```
  gh issue create \
    --repo earendil-works/pi-mono \
    --title "Assistant message Markdown rendering: fenced code blocks show visible backticks" \
    --body-file - < <body text above>
  ```

## Assumptions

1. `highlightCode(code, language, theme)` returns a string with embedded ANSI escape codes. Inferred from the existing extension's working behavior; not modified by this plan.
2. `theme.fg("colorName", text)` returns a string with appropriate SGR codes prepended. Inferred from the documented theme API; cast to `ThemeLike` at the extension boundary.
3. The `Text` component from `@earendil-works/pi-tui` passes through ANSI codes embedded in its content string. Confirmed by the existing extension's working behavior.
4. `pi.registerTool({ name: "bash", renderResult })` fully replaces the built-in `bash` renderer's `renderResult` slot; the built-in `execute` is inherited.
5. `PI_TOOL_HIGHLIGHT_BASH=1` continues to be the only mechanism for enabling the optional bash diagnostic path. No new config knob is introduced.
6. `node --experimental-strip-types --test` is sufficient to run the new test cases; no new test framework dependency.
7. The `Text` / `Image` / `File` content-type polymorphism in the tool result is unchanged; `extractOutput` continues to look for the first `text` item and falls back to `""` if none exists.
8. The empty-input case for `detectFormat` is `text.split(/\r?\n/) → [""]` (not `[]`), and the existing checks all return `false` for `first = ""`. Verified and locked in by test.

## Risks and Tradeoffs

| Risk | Mitigation |
| --- | --- |
| ANSI inside layout-measured strings can break width calculations. | All ANSI is applied to the display string returned from `renderResult`. Pi-core's `Text` component handles ANSI-embedded strings; `renderResult` does not participate in layout measurement. |
| Raw ANSI passthrough can be unsafe. | `sanitizeAnsi` strips every non-SGR sequence (cursor movement, clears, OSC, DCS, APC, PM, terminal titles). Only SGR color/style codes survive. |
| Bash output is heterogeneous. | `detectFormat` runs before any highlighting. Recognized formats are highlighted; `plain` is returned as-is. |
| `theme.fg` API may be unstable. | Cast to the local `ThemeLike` interface in `bash-renderer.ts`; the interface is minimal and easy to evolve. If Pi-core adds more required methods, the cast is a single site. |
| Private highlight methods lose direct unit-test surface. | Tests cover them through `renderResult` end-to-end; this is sufficient because the methods are pure functions of `text` and `this.theme`. |
| `JSON.parse(first)` only validates the first line. | The current code has the same behavior; preserved. Full-text validation could be added later if false positives are observed. |

## Open Questions (for future)

1. **Pi TUI span/rich-text API** — Does `@earendil-works/pi-tui` expose a stable public API for styled spans within a `Text` component? Today we embed ANSI in strings; a span API would be cleaner. Filed as future investigation, not a blocker.
2. **Assistant Markdown as core vs. extension** — If Pi-core later exposes a hook for intercepting built-in `assistant` message rendering, an extension could provide it. Today, `registerMessageRenderer` only handles custom messages.
3. **Promote bash rendering to non-experimental** — Currently behind `PI_TOOL_HIGHLIGHT_BASH=1`. After this rewrite and once exercised in real usage, it could become a default-on feature in a follow-up.
4. **Copy-to-clipboard behavior** — Should `/copy` copy raw Markdown, rendered code, or both? Pi-core question, out of scope here.
5. **OSC 8 hyperlinks** — Currently stripped by `sanitizeAnsi`. If the Pi TUI later supports OSC 8 for clickable links, this can be re-enabled.
6. **Multi-line JSON validation in `detectFormat`** — The current check only parses the first line. A follow-up could switch to parsing the entire text or use a JSON-detection heuristic library.


<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [-] 1. Create tool-highlight/ansi.ts with the fixed ANSI sanitiz... _(skipped — plan aborted)_
- [-] 2. Create tool-highlight/format-detector.ts with the extract... _(skipped — plan aborted)_
- [-] 3. Create tool-highlight/bash-renderer.ts with the new BashO... _(skipped — plan aborted)_
- [-] 4. Update tool-highlight/index.ts to import BashOutputHighli... _(skipped — plan aborted)_
- [-] 5. Delete tool-highlight/bash-highlighter.ts. _(skipped — plan aborted)_
- [-] 6. Rewrite tests/bash-highlighter.test.ts to cover ansi.ts, ... _(skipped — plan aborted)_
- [-] 7. Update tool-highlight/README.md with the new module layou... _(skipped — plan aborted)_
- [-] 8. Run npm test and verify all existing + new tests are green. _(skipped — plan aborted)_
- [-] 9. File the upstream bug report using the draft included in ... _(skipped — plan aborted; bug report draft exported to `docs/bug-reports/upstream-pi-core-assistant-markdown-rendering.md` for manual filing)_

<!-- pi-plan-progress:end -->
