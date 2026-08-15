# Code Mode

A Codex-style JavaScript REPL for [Pi](https://github.com/earendil-works/pi-coding-agent): tool calling goes behind a REPL, so intermediate results live as sandbox values and only deliberately returned output enters the model's context.

This is a port of OpenAI Codex's code mode (`openai/codex`: `codex-rs/code-mode{,-protocol,-runtime,-host}`) to a Pi extension, plus one addition Codex doesn't have: an in-sandbox `llm.query()` for RLM-style recursive sub-LLM calls.

## Why

Instead of N tool calls each dumping raw output into the conversation, the model writes one piece of JavaScript that orchestrates tools, keeps large results in variables, filters/transforms them with plain code, and returns only the distilled result:

```js
// one exec call instead of dozens of read/grep calls in the transcript
const files = await tools.grep({ pattern: "TODO", path: "src" });
const byFile = {};
for (const line of files.split("\n")) {
  const [file] = line.split(":");
  byFile[file] = (byFile[file] ?? 0) + 1;
}
const summary = await llm.query(`One-line summary per file:\n${JSON.stringify(byFile)}`);
text(summary);
```

## Tools

### `exec`

Runs `source` (raw JavaScript) as an async function body in a **fresh sandbox per call** (top-level `await` works). Parameters:

| param | default | meaning |
|---|---|---|
| `source` | — | Raw JS. May start with a first-line pragma `// @exec: {"yield_time_ms": …, "max_output_tokens": …}` (explicit params win). |
| `yield_time_ms` | 10000 | If still running after this, return early with a cell ID; the script keeps running in the background. |
| `max_output_tokens` | 10000 | Text budget for the returned output (oldest output dropped first). |

### `wait`

`{ cell_id, yield_time_ms?, max_output_tokens?, terminate? }` — collects new output from a running cell, its final result (closing it), or terminates it. Unknown/closed cells get a "missing cell" message.

### Sandbox globals

| global | behavior |
|---|---|
| `tools.read / bash / edit / write / grep / find / ls` | The real Pi built-in tools, as async functions. Resolve to text (or content blocks for images); throw on failure. |
| `ALL_TOOLS` | `[{ name, description }]` metadata for the nested tools. |
| `text(value)` / `image(source, mimeType?)` | Append output items (the only way data enters the transcript). |
| `notify(value)` | Like `text`, plus streams progress to the UI immediately. |
| `store(key, value)` / `load(key)` | Session-scoped, JSON-serializable key-value store — the only state that persists across `exec` calls. |
| `yield_control()` | Return accumulated output now (with a cell ID) while the script keeps running. |
| `exit()` | End the script successfully, immediately. |
| `setTimeout` / `clearTimeout` | Tracked per cell; pending timers don't keep a cell alive. |
| `llm.query(prompt, opts?)` | Fresh-context sub-LLM call (no tools). `opts`: `{ system?, model? /* "provider/id" */, maxTokens?, reasoning? }`. Resolves to the reply text; usage is billed to the tool call. Use it to summarize/filter large data without loading it into the conversation. |

There is deliberately **no** `console`, `process`, `require`, `fetch`, or file system access — only the globals above. Uncaught errors complete the call in-band as `Uncaught <message>`.

## Modes

```
/code-mode            toggle strict ↔ off
/code-mode strict     only exec + wait are active (all work goes through the REPL)
/code-mode hybrid     exec + wait alongside the existing tools
/code-mode off        restore the previous tool set
/code-mode status     show mode, live cells, store keys
pi --code-mode        start a session in strict mode
```

Strict mode snapshots the active tool set on entry and restores it on exit. Mode persists in the session and is restored on resume. A footer status (`⟨⟩ code: strict|hybrid`) shows the current mode.

## Codex mapping

| Codex (`codex-rs`) | This extension |
|---|---|
| `exec` freeform tool + Lark grammar | `exec` JSON tool; pragma still honored in `source` |
| `wait` tool | `wait` tool |
| Fresh V8 isolate per call | Fresh `node:vm` context per call |
| `store`/`load` session KV | same |
| `tools` object, normalized identifiers, `ALL_TOOLS` | same |
| `text`/`image`/`audio`/`generatedImage` content items | `text`/`image` |
| `notify`, `yield_control`, `exit`, `setTimeout` | same |
| Nested calls routed through the owner's tool dispatch (approvals apply) | Nested calls invoke the built-in tool factories directly (see limitations) |
| JSON-schema → TypeScript declarations in the tool description | ported (`renderJsonSchemaToTs`) |
| `code_mode` / `code_mode_only` features | `/code-mode hybrid` / `/code-mode strict` |
| multi-agent v2 (`non_code_mode_only`) | `llm.query` (fresh-context, tool-less) instead |
| yield 10s / 10k output tokens defaults | same |

## Limitations (divergences from Codex)

1. **JSON params, not freeform.** Pi tools take JSON-schema arguments; Codex's raw-text + grammar input is OpenAI-only. The `// @exec:` pragma is still parsed from the first line of `source`.
2. **No tool_call pipeline for nested calls.** REPL-internal `tools.*` calls don't emit Pi `tool_call` events, so other extensions' per-call guards don't fire. Exception: when this repo's **plan-mode** is executing, `edit`/`write` are blocked inside the sandbox and `bash` is filtered through plan-mode's read-only command guard (falling back to fully blocked if the guard can't be imported).
3. **No preemption of synchronous infinite loops.** `while (true) {}` blocks the Pi process (a 60s budget covers the script's initial synchronous chunk). Async work is fully abortable via Esc / `wait { terminate: true }`.
4. **Only the 7 built-in tools are nested-callable.** Pi exposes no execute handle for other extensions' tools (e.g. `spawn_agent`); in strict mode they're deactivated. Recursion is covered by `llm.query` instead.
5. **Cells and the store are in-memory.** They don't survive `/reload` or resume; `wait` on a stale cell ID returns the missing-cell message.
6. **No heap limits.** Codex caps V8 heap per session; `node:vm` can't.

## Install

```bash
ln -s "$PWD/pi-extensions/code-mode" ~/.pi/agent/extensions/code-mode
```

Then `/reload` in Pi.

## Development

```bash
npm test   # repo root; tests/code-mode.test.ts covers utils + ReplSession
```

Files: `index.ts` (Pi wiring: tools, `/code-mode`, session lifecycle), `repl.ts` (`ReplSession`: vm sandboxes, cells, store, `llm.query`), `utils.ts` (pure helpers: pragma parsing, JSON-schema→TS, budgets, mode state machine).
