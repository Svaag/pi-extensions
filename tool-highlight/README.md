# tool-highlight

Pi extension that adds syntax highlighting to file-content tool outputs in the TUI.

## What it does

Overrides `renderResult` for the built-in `read`, `edit`, and `write` tools. When the TUI displays the result, the text is run through `highlightCode()` using the active theme's syntax colors and the file's detected language. The LLM still receives the raw, unhighlighted text — the highlighting is presentation only.

## Behavior

- **Truecolor terminal (`COLORTERM=truecolor` / `24bit`, or `TERM=xterm-direct`/`alacritty`/`wezterm`/`ghostty`/`kitty`)** → ANSI-styled output using the active theme's `syntax*` colors.
- **256-color or unknown terminal** → falls back to plain text. Nothing breaks; you just don't get colors.
- **Unknown file extension** → plain text.
- **Highlighter throws** → plain text (graceful fallback, never breaks the TUI).
- **Non-text content (e.g. image items)** → passed through unchanged.

The canonical `result.content[].text` is never mutated. Only the string returned to the TUI is styled.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extensions/tool-highlight" ~/.pi/agent/extensions/tool-highlight
```

Then `/reload` in Pi.

## Architecture

```
tool-highlight/
├── index.ts          # Pi extension entry: registers overrides, wires up imports
└── highlighter.ts    # Pure logic, no @earendil-works/pi-coding-agent imports
```

`highlighter.ts` exports:

- `ToolOutputHighlighter` — the main boundary class. Takes `highlightCode`, `getLanguageFromPath`, theme, and a truecolor flag via the constructor so the test suite can inject fakes.
- `detectTruecolor(env?)` — reads `COLORTERM`/`TERM` from the environment (env override for tests).

`index.ts` imports `highlightCode` and `getLanguageFromPath` from `@earendil-works/pi-coding-agent` and registers a minimal `renderResult` override for each file tool. Pi inherits the built-in's `execute`, `parameters`, and `renderCall` automatically.

## Testing

```bash
npm test
```

Tests cover:

- Truecolor enabled / disabled
- Missing path, unknown language, empty language string
- Highlighter throwing
- Canonical content preservation (no mutation of `content[].text`)
- Empty / non-text content
- `detectTruecolor` against all known terminal identifiers
