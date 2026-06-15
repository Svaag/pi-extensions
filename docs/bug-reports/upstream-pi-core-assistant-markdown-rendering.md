# Upstream bug report: Assistant message Markdown rendering

> Exported from the (unexecuted) plan at
> `docs/plans/2026-06-15T10-14-58Z-fix-and-improve-pi-tui-rendering-in-pi-extensions.md`.
> File against `earendil-works/pi-mono` (or the current monorepo URL) when ready.

## Filing command

```bash
gh issue create \
  --repo earendil-works/pi-mono \
  --title "Assistant message Markdown rendering: fenced code blocks show visible backticks" \
  --body-file docs/bug-reports/upstream-pi-core-assistant-markdown-rendering.md
```

(The body is the section below, minus this header. Strip the `## Filing command`
and `## Issue body` lines, then pass the rest as the issue body — e.g. with
`--body-file -` and a heredoc, or by editing the issue in the browser.)

---

## Issue body

### Summary

Assistant message prose containing fenced code blocks (and other Markdown
constructs) is rendered in the TUI as raw text, with the leading/trailing triple
backticks visible. This breaks display of any Markdown the model emits in a
normal assistant turn.

### Reproduction

1. Start `pi` in any TUI.
2. Ask the assistant a question whose natural answer includes a fenced code
   block, e.g. "show me a `tsconfig.json` example".
3. The assistant emits a fenced code block in its reply.

### Expected

The fenced code block is rendered as syntax-highlighted code (using the same
theme tokens available via `mdCodeBlock`, `mdCodeBlockBorder`, `mdCode`, etc.)
and the surrounding prose is rendered with the existing Markdown formatting
(headings, lists, links).

### Actual

The triple backticks are visible as literal characters. The code body is shown
as monospace but with no syntax highlighting. Surrounding Markdown (headings,
lists, quotes) is shown as plain text.

### Investigation notes

- `pi.registerMessageRenderer(customType, renderer)` is documented as only
  handling messages with a `customType` field; built-in `role: "assistant"`
  messages are not interceptable via this API.
- The Markdown component exists in `@earendil-works/pi-tui` and a
  `getMarkdownTheme()` helper is exported from `@earendil-works/pi-coding-agent`.
- Theme tokens exist: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`,
  `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`. None
  of them appear to be applied to assistant message prose in the TUI today.
- Likely fix location: Pi-core's assistant message rendering component
  (e.g. `packages/coding-agent/src/modes/interactive/components/`). Wrapping
  each `TextContent` block in the Markdown component using `getMarkdownTheme()`
  would address the issue.
- Workaround attempted at the extension layer: `pi.registerMessageRenderer`
  does not provide a hook for built-in `assistant` messages, so there is no
  extension-side fix.

### Environment

- `pi` version: (latest from `earendil-works/pi-mono` main as of filing date)
- Terminal: Alacritty 0.13+, `$COLORTERM=truecolor`
- Theme: any (issue is not theme-specific)

### Related

The `tool-highlight` extension (in `Svaag/pi-extensions`) overrides
`renderResult` for `read`/`edit`/`write` and (optionally, with
`PI_TOOL_HIGHLIGHT_BASH=1`) `bash`, and works correctly because
`pi.registerTool({ name, renderResult })` is a per-slot override. There is no
equivalent hook for the assistant message renderer.
