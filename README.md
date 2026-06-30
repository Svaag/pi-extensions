# Pi Extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by Svaag.

## Extensions

- `plan-mode/` — read-only planning mode with proposed-plan extraction, interactive planning questions, and execution progress tracking.
- `goal-mode/` — autonomous goal/execute mode inspired by Codex collaboration style.
- `subagent/` — Codex-inspired subagent / agent swarm tools backed by isolated Pi RPC subprocesses, persistent lifecycle state, and conservative read-only defaults.
- `tool-highlight/` — overrides `renderResult` for `read`/`edit`/`write` so the TUI renders syntax-highlighted file content using the active theme. Truecolor auto-detected, safe fallback to plain text.
- `x402-wallet/` — built-in throwaway EVM wallet, x402 payment-aware HTTP tool, and bundled `x402-wallet` skill for Base USDC paid APIs.

## Install

Clone this repository, then copy or symlink the extension directories into Pi's global extension directory:

```bash
git clone git@github.com:Svaag/pi-extensions.git
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
ln -s "$PWD/pi-extensions/goal-mode" ~/.pi/agent/extensions/goal-mode
ln -s "$PWD/pi-extensions/subagent" ~/.pi/agent/extensions/subagent
ln -s "$PWD/pi-extensions/tool-highlight" ~/.pi/agent/extensions/tool-highlight
ln -s "$PWD/pi-extensions/x402-wallet" ~/.pi/agent/extensions/x402-wallet
```

Extensions with extra runtime dependencies (currently `x402-wallet`) need their dependencies installed next to the extension entrypoint because Pi resolves modules from the extension path:

```bash
npm install --prefix x402-wallet
```

If you copy only `x402-wallet/` outside this repo, run `npm install` inside that copied directory.

Reload Pi with `/reload` after installing or updating.

## Testing

Run the pure utility test suite:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping and require no npm dependencies.

## Notes

Extensions run with your local permissions. Review code before enabling extensions on a machine you care about.
