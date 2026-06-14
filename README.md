# Pi Extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by Svaag.

## Extensions

- `plan-mode/` — read-only planning mode with proposed-plan extraction, interactive planning questions, and execution progress tracking.
- `goal-mode/` — autonomous goal/execute mode inspired by Codex collaboration style.
- `hyrule-loop/` — helper commands for running and inspecting the Hyrule Engineering Loop.

## Install

Clone this repository, then copy or symlink the extension directories into Pi's global extension directory:

```bash
git clone git@github.com:Svaag/pi-extensions.git
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
ln -s "$PWD/pi-extensions/goal-mode" ~/.pi/agent/extensions/goal-mode
ln -s "$PWD/pi-extensions/hyrule-loop" ~/.pi/agent/extensions/hyrule-loop
```

Reload Pi with `/reload` after installing or updating.

## Testing

Run the pure utility test suite for Plan Mode and Goal Mode:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping and require no npm dependencies.

## Notes

Extensions run with your local permissions. Review code before enabling extensions on a machine you care about.
