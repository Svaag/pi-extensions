# Pi Extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by Svaag.

## Extensions

- `plan-mode/` — read-only planning mode with proposed-plan extraction, interactive planning questions, and execution progress tracking.
- `goal-mode/` — autonomous goal/execute mode inspired by Codex collaboration style.
- `hyrule-loop/` — helper commands for running and inspecting the Hyrule Engineering Loop.
- [`model-router/`](./model-router/README.md) — public telemetry-informed, self-learning model router with standalone Pi, virtual-provider, SDK, and Subagent adapters.
- [`subagent/`](./subagent/README.md) — isolated RPC child-agent/swarm extension integrated with the shared router and metadata-only OTel.

## Install

Clone this repository, then copy or symlink the extension directories into Pi's global extension directory:

```bash
git clone git@github.com:Svaag/pi-extensions.git
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
ln -s "$PWD/pi-extensions/goal-mode" ~/.pi/agent/extensions/goal-mode
ln -s "$PWD/pi-extensions/hyrule-loop" ~/.pi/agent/extensions/hyrule-loop
ln -s "$PWD/pi-extensions/model-router" ~/.pi/agent/extensions/model-router
ln -s "$PWD/pi-extensions/subagent" ~/.pi/agent/extensions/subagent
npm install
```

Reload Pi with `/reload` after installing or updating.

## Testing

Run the full extension, router, storage, telemetry, Pi-adapter, and Subagent regression suite:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping. Run `npm install` first for Pi/OTel integration dependencies, and `npm run build:model-router` for the public package type/build check.

## Notes

Extensions run with your local permissions. Review code before enabling extensions on a machine you care about.
