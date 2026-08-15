---
created: 2026-08-08T14:31:28.469Z
source: pi-plan-mode
status: accepted-for-execution
---

# Code Mode — a Codex-style REPL (`exec`/`wait`) Pi Extension with RLM `llm.query()`

## Summary

Build a new `code-mode/` extension in this repo that ports OpenAI Codex's **Code Mode** (researched from `openai/codex`: `codex-rs/code-mode{,-protocol,-runtime,-host}`, `core/src/tools/code_mode/`, `features/`) to Pi, plus one deliberate addition — an in-REPL `llm.query()` for RLM-style recursive sub-LLM calls.

Core idea (per the tweet): put tool calling behind a JavaScript REPL so intermediate results live as sandbox values and only deliberately-`text(...)`-ed output enters the model's context. The model writes code that composes `tools.read/bash/grep/...`, filters with plain JS, and delegates distillation to fresh-context sub-LLMs — instead of accumulating raw tool output in the conversation.

**Locked decisions (from research + user answers):**
- Follow Codex's design: two model-facing tools, `exec` (run JS) and `wait` (resume/kill a yielded cell); **fresh sandbox per exec call**; cross-call state only via explicit `store(key,value)`/`load(key)`; yield/background-cell semantics with 10s default yield.
- Runtime: in-process `node:vm` (no worker/subprocess), JSON tool params (Pi has no freeform-tool type — Codex's Lark-grammar freeform input is OpenAI-only).
- Nested tool surface: all 7 Pi built-ins (`read, bash, edit, write, grep, find, ls`) instantiated via `createAllTools(cwd)` from `@earendil-works/pi-coding-agent`.
- `llm.query()` in v1: fresh-context, tool-less sub-LLM via `streamSimple` from `@earendil-works/pi-ai/compat` (auth pattern copied from `model-router/src/adapters/pi/VirtualRouterProvider.ts`).
- Activation: opt-in per session; `/code-mode` toggles **strict** (only `exec`+`wait` active; previous tool set snapshotted/restored), `/code-mode hybrid` adds `exec`+`wait` alongside existing tools, `/code-mode off` restores.

## Implementation Steps

1. Scaffold `code-mode/` (`index.ts`, `repl.ts`, `utils.ts`, `README.md`) matching repo conventions; register the extension in the root `README.md` extension list + install snippets.
2. Implement `code-mode/utils.ts`: pure helpers — pragma parsing, JSON-Schema→TypeScript renderer, output budgeting, store serialization, validation, description builders.
3. Implement `code-mode/repl.ts`: `ReplSession` — vm sandbox creation, nested-tool bindings, `store`/`load`, cell registry with yield/wait/terminate, `llm.query`, usage aggregation, plan-mode gate.
4. Implement `code-mode/index.ts`: register `exec` + `wait` tools (with renderers), `/code-mode` command, session restore, strict-mode prompt line, shutdown cleanup.
5. Add `tests/code-mode.test.ts` (Node's built-in runner, `--experimental-strip-types`, repo style).
6. Write `code-mode/README.md` (concept, Codex mapping, usage, limitations) and update root `README.md`.

## Key Details

### File layout

```
code-mode/
  index.ts    # Extension wiring: tools, command, session lifecycle, rendering
  repl.ts     # ReplSession: vm cells, bindings, store, llm.query (deps injected for tests)
  utils.ts    # Pure helpers (unit-tested directly)
  README.md
tests/code-mode.test.ts
```

### `exec` tool (registered via `pi.registerTool`)

- `name: "exec"`, `label: "Exec (code mode)"`.
- `parameters` (typebox): `Type.Object({ source: Type.String(), yield_time_ms: Type.Optional(Type.Integer({minimum:0})), max_output_tokens: Type.Optional(Type.Integer({minimum:1})) })`. `additionalProperties: false`.
- `promptSnippet`: `"Run JavaScript to orchestrate nested tools (read/bash/edit/write/grep/find/ls) and sub-LLM calls with explicit output control"`.
- `promptGuidelines` (each names the tool, per Pi docs):
  - `"Use exec instead of individual tool calls when a task needs several tool calls, loops, or filtering of large outputs: intermediate results stay inside the exec sandbox and only text(...)/image(...) output enters the conversation."`
  - `"Use the llm.query(...) helper inside exec to summarize or extract from large data with a fresh-context sub-LLM instead of loading it into the conversation."`
  - `"Use the wait tool to collect more output from, or terminate, a long-running exec cell."`
- Validation (port of Codex `parse_exec_source` error behavior): empty/whitespace `source` → throw `Error("exec expects raw JavaScript source text (non-empty)…")`. If the first line starts with `// @exec:`, the remainder must be a JSON object containing only `yield_time_ms` / `max_output_tokens` (non-negative safe integers); malformed pragma → throw with Codex's messages. Explicit tool arguments override pragma values; pragma overrides defaults (`yield_time_ms=10000`, `max_output_tokens=10000`).
- Execution (in `ReplSession.execute(source, yieldMs, budgetTokens, signal, onUpdate)`):
  - Create a fresh `vm.createContext({})` per call and inject **only** the documented globals (no `console`, no timers beyond injected `setTimeout`/`clearTimeout`, no `process`/`require`). Nothing else exists — this gives Codex's "no Node, no fs, no network, no console" for free.
  - Compile `"(async () => {\n" + source + "\n})()"` with `vm.Script` (filename `"exec-cell.js"` for stack traces) and run in the context; the result is a Promise. Top-level `await` works inside the async body; `exit()` ends it successfully early.
  - Race three outcomes: script settle, `sleep(yieldMs)`, and the `yield_control()` deferred. If the script settles first → final result. Otherwise → keep the cell alive in the registry and return `"Script running with cell ID \"<id>\". Use the wait tool to collect output."` plus any buffered output items.
  - `signal` (Pi abort / Esc) and `wait {terminate:true}` → terminate: abort the cell's `AbortController` (cancels in-flight nested tool/LLM calls), cancel its timers, mark terminated, return buffered output + `"Cell <id> terminated."`.
  - Uncaught JS errors (incl. thrown nested-tool errors) complete the cell **in-band** (Codex style): final output gets an `Uncaught <message>` text item, `details.errorText` set; the tool result itself is **not** `isError`.
- Output: accumulated content items (`text(...)`/`notify(...)` strings, `image(...)` blocks) are returned as the tool result `content` (mixed `TextContent`/`ImageContent` is supported). Text is budgeted: convert `max_output_tokens` → `tokens*4` chars, apply `truncateTail` (hard cap `DEFAULT_MAX_BYTES` = 50KB regardless); on truncation append `[Output truncated to <N> token budget — full output lost; re-run with narrower output or use store()/load().]`. `notify()` additionally streams partials via `onUpdate`.
- `details`: `{ cellId, state: "completed"|"yielded"|"terminated"|"failed", errorText?, truncated, usage?: Usage }`.

### `wait` tool

- `parameters`: `{ cell_id: Type.String(), yield_time_ms?: int (default 10000), max_output_tokens?: int (default 10000), terminate?: boolean (default false) }`.
- Unknown or already-closed `cell_id` → non-error text result `"Cell \"<id>\" is unknown or already closed."` (Codex `MissingCell` semantics; matters on session resume/`/reload` since cells are in-memory).
- Otherwise: waits up to `yield_time_ms` for the cell to produce output or finish. Returns **only new items since the last return** (per-cell read cursor). On completion it returns the final result and closes the cell. `terminate:true` kills it and returns final buffered output.

### REPL globals (injected into every cell context)

- `tools`: `{ read, bash, edit, write, grep, find, ls }` — created once per session via `createAllTools(ctx.cwd)`; each global is `async (args) => …` calling `tool.execute("cell-"+id, args, cellSignal)`. Resolution mapping: all-text results → the joined text **string**; results containing images → the raw content-block array. Failures (throw or `isError`) → JS `Error` rejection with the tool's text. `edit`/`write` inherit `withFileMutationQueue` from the real factories.
- `ALL_TOOLS`: `[{name, description}]` for the 7 nested tools (API fidelity with Codex's discovery surface).
- `text(value)`: append text item; non-strings via `JSON.stringify`, fallback `String(value)`.
- `image(source, mimeType?)`: accepts a `{type:"image", data, mimeType}` block (e.g. from `tools.read` on a PNG), a `data:` URL string (parsed), or `(base64, mimeType)`.
- `store(key, value)` / `load(key)`: session-scoped `Map`; `store` rejects values that fail a `JSON.stringify` round-trip (throws `TypeError`). Returns `undefined` for missing keys.
- `notify(value)`: append item + push partial via `onUpdate`.
- `yield_control()`: force early return with cell ID; script keeps running.
- `exit()`: throws an internal `ExitSignal`, caught by the runner → successful completion.
- `setTimeout`/`clearTimeout`: Node's timers, tracked per cell and cancelled when the cell closes (pending timers do not keep a cell alive).
- `llm.query(prompt: string, opts?: { system?: string; model?: string; maxTokens?: number; reasoning?: ThinkingLevel }): Promise<string>` — **the RLM addition**:
  - Model: `opts.model` split as `"provider/id"` → `ctx.modelRegistry.find(...)`; default `ctx.model`.
  - Auth: `ctx.modelRegistry.getApiKeyAndHeaders(model)` → `{ apiKey, headers }`; `ok:false` → throw `Error` with the registry's message.
  - Call: `streamSimple(model, { systemPrompt: opts.system, messages: [{ role:"user", content: prompt, timestamp: Date.now() }] }, { apiKey, headers, signal: cellSignal, maxTokens: opts.maxTokens, reasoning: opts.reasoning })`; consume the event stream to the final `AssistantMessage`; extract via `contentText()`; throw if `stopReason` is `"error"`/`"aborted"`.
  - Every query's `usage` is summed into the owning cell's `usage`, returned on the `exec`/`wait` tool result `usage` field (Pi rolls it into session totals).

### Tool descriptions (generated in `utils.ts`, baked at registration)

Port Codex's `EXEC_DESCRIPTION_TEMPLATE` nearly verbatim (it's the surface RL'd models know), adapted: "Evaluates the provided JavaScript source as an async function body in a fresh sandbox (top-level await works)"; "Nested tools resolve to text (or content blocks for images) and throw on failure"; "no Node, no require, no process, no network, no console"; pragma sentence notes explicit arguments take precedence; helper list = our globals (incl. `llm.query` with a "use it to filter/summarize large data without bloating this conversation's context" line); then a `Nested tools:` section with a `declare const tools: { … }` TS block.

`renderJsonSchemaToTs(schema)` in `utils.ts` is a TS port of Codex's `render_json_schema_to_typescript` (typebox schemas are JSON Schema): `const`/`enum` literals, `anyOf`/`oneOf` → unions, `allOf` → intersections, arrays (`items`/`prefixItems`), objects with sorted properties, `?` for optional, property `description`s rendered as `//` comment lines, `additionalProperties` index signatures, `unknown`/`never` fallbacks. Input schemas are read from the `createAllTools` instances' `.parameters`. Same for `build_wait_tool_description` (port of Codex's `WAIT_DESCRIPTION_TEMPLATE`).

### Mode machinery (`index.ts`)

- State persisted via `pi.appendEntry("code-mode", { mode: "off"|"hybrid"|"strict", previousTools: string[] })`; restored on `session_start` (latest entry wins) and tool set re-applied.
- `/code-mode` command args: empty → toggle strict↔off; `strict`; `hybrid`; `off`; `status`. Strict entry: snapshot `pi.getActiveTools()` into the entry, then `pi.setActiveTools(["exec","wait"])`. Hybrid: additive only (`[...new Set([...active,"exec","wait"])]`). Off: restore the snapshotted set (fallback: remove only `exec`/`wait` if snapshot missing).
- Status: `ctx.ui.setStatus("code-mode", "⟨⟩ code: strict" | "hybrid")`, cleared when off.
- `before_agent_start`: when strict, append one line — `"Code mode (strict) is active: exec and wait are the only available tools. Do ALL file, search, and shell work inside exec via the tools object (await tools.read(...), tools.bash(...), ...), and keep raw outputs inside the sandbox; return only what matters via text(...)."` Hybrid/off: no injection.
- `session_shutdown`: terminate all live cells, clear registry and store.
- Rendering: `renderCall` for `exec` shows `exec` + first source line + `… (N lines)`; expanded shows full source via `highlightCode(code, "javascript", theme)`. `renderResult`: collapsed → state icon + first output line; expanded → full text. `wait` renders `wait <cell_id>` (+`terminate`).

### Plan-mode interplay (this repo)

At each `exec` start, scan `ctx.sessionManager.getEntries()` for the latest `customType === "plan-mode"` entry (same pattern as `goal-mode/index.ts`). If `data.executing === true`: nested `edit`/`write` throw `"Blocked: plan mode is active (read-only)."`; nested `bash` is filtered by `isSafeCommand`, imported via `await import("../plan-mode/utils.ts")` inside a `try/catch` at session start (works both in the repo checkout and when both extensions are symlinked side-by-side into `~/.pi/agent/extensions/`); if the import fails, all `bash` is blocked under plan mode. `read`/`grep`/`find`/`ls`/`llm.query` stay available.

### Known divergences from Codex (documented in README)

1. JSON params instead of freeform+Lark grammar (Pi limitation); pragma still honored inside `source`.
2. Nested calls invoke built-in tool factories directly — they do **not** pass through Pi's `tool_call` event pipeline, so other extensions' per-call guards don't fire (Codex routes through its normal dispatch). The plan-mode gate above covers this repo's case.
3. In-process `vm` can't preempt a synchronous infinite loop (`while(true){}` blocks Pi); async work is fully cooperative-abortable. No heap limit enforcement (Codex sets V8 heap caps).
4. Other extensions' tools (e.g. `spawn_agent`) can't be nested-callable — Pi exposes no execute handle via `pi.getAllTools()`; in strict mode they're deactivated; recursion is covered by `llm.query` instead.
5. Cells and the `store` Map are in-memory; they don't survive `/reload`/resume (`wait` then returns the missing-cell message).
6. `llm.query()` has no Codex equivalent (Codex punts recursion to its multi-agent v2).

## Test Plan

`tests/code-mode.test.ts`, importing `utils.ts` directly and driving `repl.ts`'s `ReplSession` with injected fake `tools`/`llmQuery` (no Pi runtime needed):

- **Pragma parsing** (port Codex's test matrix): no pragma; valid pragma; pragma-only (no code) → error; malformed JSON → error; unknown key → error; negative/non-safe-integer → error; explicit args override pragma.
- **`renderJsonSchemaToTs`**: port Codex's assertions — flat object; required vs `?`; property-description `//` comments (incl. the multi-line `weather` example); nested arrays; enums; index signatures.
- **Store**: round-trip; missing key → `undefined`; non-serializable (function/circular) → `TypeError`.
- **Cell lifecycle** (fake timers or 0ms yields): completes → result text; yields after `yield_time_ms` → "Script running with cell ID"; `wait` returns only *new* output; completes during `wait`; `terminate:true` → terminated + buffered output; `wait` on missing cell → missing-cell message; `exit()` mid-script; uncaught throw → in-band `Uncaught …` with `errorText`.
- **Bindings**: fake `tools.read` resolves string; throwing fake tool → JS rejection catchable in-cell; `ALL_TOOLS` shape.
- **Budget**: output beyond `max_output_tokens` truncated with the truncation notice.
- **`llm.query`**: fake `llmQuery` returns text; usage aggregation onto the exec result; model-ref parsing (`"provider/id"` valid/invalid).
- **Mode logic** (pure reducer extracted to `utils.ts`): strict entry snapshots; off restores; hybrid additive-only; status arg.
- **Plan-mode gate**: predicate over fabricated session entries (executing true/false/absent).

Run via root `npm test` (glob already covers `tests/*.test.ts`).

## Assumptions

- The extension lives in this repo and is installed by symlinking `code-mode/` into `~/.pi/agent/extensions/` (root README gains the `ln -s` line).
- Default budgets mirror Codex: `yield_time_ms` 10000, `max_output_tokens` 10000 (≈40KB, under Pi's 50KB tool-result guidance); both per-call overridable.
- `exec`/`wait` names don't collide with built-ins or this repo's other extensions (`subagent` uses `wait_agent`).
- `llm.query` defaults to the session's current model; cross-model via `"provider/id"`; errors throw in-sandbox.
- Strict mode snapshot/restore assumes no other extension mutates the active tool set between entry and exit; on conflict the last snapshot wins (documented).
- v1 excludes: tool-using subagents, persistent/on-disk store, heap limits, MCP/extension-tool nesting — all noted as future work in the README.




<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Scaffold code-mode/ (index.ts, repl.ts, utils.ts, README.md) matching repo conventions; register the extension in the root README.md extension list + install snippets. _(done)_
- [x] 2. Implement code-mode/utils.ts: pure helpers — pragma parsing, JSON-Schema→TypeScript renderer, output budgeting, store serialization, validation, description builders. _(done)_
- [x] 3. Implement code-mode/repl.ts: ReplSession — vm sandbox creation, nested-tool bindings, store/load, cell registry with yield/wait/terminate, llm.query, usage aggregation, plan-mode gate. _(done)_
- [x] 4. Implement code-mode/index.ts: register exec + wait tools (with renderers), /code-mode command, session restore, strict-mode prompt line, shutdown cleanup. _(done)_
- [x] 5. Add tests/code-mode.test.ts (Node's built-in runner, --experimental-strip-types, repo style). _(done)_
- [x] 6. Write code-mode/README.md (concept, Codex mapping, usage, limitations) and update root README.md. _(done)_

<!-- pi-plan-progress:end -->
