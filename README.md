# Pi Extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by Svaag.

## Extensions

- `plan-mode/` — read-only planning mode with proposed-plan extraction, interactive planning questions, and execution progress tracking.
- `goal-mode/` — autonomous goal/execute mode inspired by Codex collaboration style.
- `hyrule-loop/` — helper commands for running and inspecting the Hyrule Engineering Loop.
- [`subagent/`](./subagent/README.md) — isolated RPC child-agent/swarm extension with metadata-only OTel.
- `coding-conventions/` — deterministic `Assisted-by:` trailer on every commit + layered coding-conventions injection with ecosystem auto-detection.
- [`code-mode/`](./code-mode/README.md) — Codex-style JavaScript REPL (`exec`/`wait`) that puts tool calling behind a sandbox, with RLM-style `llm.query()` sub-LLM calls.

## Install

Clone this repository, then copy or symlink the extension directories into Pi's global extension directory:

```bash
git clone git@github.com:Svaag/pi-extensions.git
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
ln -s "$PWD/pi-extensions/goal-mode" ~/.pi/agent/extensions/goal-mode
ln -s "$PWD/pi-extensions/hyrule-loop" ~/.pi/agent/extensions/hyrule-loop
ln -s "$PWD/pi-extensions/subagent" ~/.pi/agent/extensions/subagent
ln -s "$PWD/pi-extensions/coding-conventions" ~/.pi/agent/extensions/coding-conventions
ln -s "$PWD/pi-extensions/code-mode" ~/.pi/agent/extensions/code-mode
npm install
```

Reload Pi with `/reload` after installing or updating.

## Testing

Run the full extension, router, storage, telemetry, Pi-adapter, and Subagent regression suite:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping. Run `npm install` first for Pi/OTel integration dependencies.

## Notes

Extensions run with your local permissions. Review code before enabling extensions on a machine you care about.
