import assert from "node:assert/strict";
import test from "node:test";
import {
	extractDoneSteps,
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	isSafeCommand,
	markCompletedSteps,
	markExplicitNonDoneSteps,
	type TodoItem,
} from "../plan-mode/utils.ts";

function todos(texts: string[]): TodoItem[] {
	return texts.map((text, index) => ({ step: index + 1, text, completed: false }));
}

test("plan mode allows read-only git and gh commands", () => {
	const allowed = [
		"git status --short",
		"git -C ../repo log --oneline -5",
		"git diff main...HEAD",
		"git branch --list",
		"git ls-files",
		"gh pr view 123 --json title,url",
		"gh -R owner/repo pr diff 123",
		"gh issue list --state open",
		"gh repo view owner/repo",
		"gh api repos/owner/repo/pulls --paginate",
		"gh api --method GET repos/owner/repo/issues",
	];

	for (const command of allowed) {
		assert.equal(isSafeCommand(command), true, command);
	}
});

test("plan mode allows pytest and ruff validation commands", () => {
	const allowed = [
		".venv/bin/pytest -q tests/test_hip4_*.py",
		"PYTHONDONTWRITEBYTECODE=1 .venv/bin/pytest -q tests",
		"timeout 120s python -m pytest tests/test_hip4_*.py",
		".venv/bin/ruff check hyperliquid_trading_agent/app/hip4 tests/test_hip4_*.py",
		"RUFF_CACHE_DIR=/tmp/pi-ruff-cache .venv/bin/ruff check .",
	];

	for (const command of allowed) {
		assert.equal(isSafeCommand(command), true, command);
	}
});

test("plan mode blocks mutating ruff validation commands", () => {
	const blocked = [
		"ruff check --fix .",
		".venv/bin/ruff check --fix-only .",
		"ruff check --unsafe-fixes .",
	];

	for (const command of blocked) {
		assert.equal(isSafeCommand(command), false, command);
	}
});

test("plan mode blocks mutating git and gh commands", () => {
	const blocked = [
		"git checkout main",
		"git branch feature/foo",
		"git commit -am test",
		"git diff --output=patch.diff",
		"git remote add origin x",
		"git tag v1.0.0",
		"gh pr checkout 123",
		"gh pr merge 123",
		"gh issue create --title x",
		"gh repo clone owner/repo",
		"gh api repos/owner/repo/issues -X POST",
		"gh api repos/owner/repo/issues -f title=x",
	];

	for (const command of blocked) {
		assert.equal(isSafeCommand(command), false, command);
	}
});

test("extractProposedPlan returns the markdown inside proposed_plan tags", () => {
	assert.equal(
		extractProposedPlan("before\n<proposed_plan>\n# Title\n\nBody\n</proposed_plan>\nafter"),
		"# Title\n\nBody",
	);
});

test("extractTodoItemsFromProposedPlan prefers tracker-level implementation steps", () => {
	const plan = `# Plan

## Facts
- Do not make this a todo
- Or this

## Implementation Steps
1. Update the config loader.
2. Refactor runtime paths.
3. Add tests.

## Test Plan
1. This is validation detail, not a tracker item.
`;

	assert.deepEqual(
		extractTodoItemsFromProposedPlan(plan).map((item) => item.text),
		["Update the config loader.", "Refactor runtime paths.", "Add tests."],
	);
});

test("extractTodoItemsFromProposedPlan preserves full tracker text", () => {
	const plan = `# Plan

## Implementation Steps
1. Add config, storage schemas, migrations, and persistence helpers.
2. Add Pi extension handoff, command aliases, docs, runbooks, and SKILL/README updates.
3. Add full test/backtest/migration coverage and verify final acceptance criteria.
`;

	assert.deepEqual(
		extractTodoItemsFromProposedPlan(plan).map((item) => item.text),
		[
			"Add config, storage schemas, migrations, and persistence helpers.",
			"Add Pi extension handoff, command aliases, docs, runbooks, and SKILL/README updates.",
			"Add full test/backtest/migration coverage and verify final acceptance criteria.",
		],
	);
});

test("extractTodoItemsFromProposedPlan ignores numbered narrative headings and uses final checklist", () => {
	const plan = `# HIP-4 Outcome Markets Paper/Shadow MVP — Production Implementation Plan

## 1. Executive Decision

Implement HIP-4 as an isolated bounded subsystem.

## 2. What Changes From The Original Plan

1. This numbered detail is not a tracker item.
2. Neither is this correction.

## 16. Open Questions Before Implementation

1. Re-check API availability before coding.
2. Confirm the SDK shape.

## 17. Final Implementation Checklist

1. Perform repo audit and define Hip4CapabilityProbe.
2. Add HIP-4 settings, metrics, and read-only /info helpers.
3. Implement read-only registry with raw payload persistence.
4. Add tests, replay fixtures, and runbook.
`;

	assert.deepEqual(
		extractTodoItemsFromProposedPlan(plan).map((item) => item.text),
		[
			"Perform repo audit and define Hip4CapabilityProbe.",
			"Add HIP-4 settings, metrics, and read-only /info helpers.",
			"Implement read-only registry with raw payload persistence.",
			"Add tests, replay fixtures, and runbook.",
		],
	);
});

test("extractTodoItemsFromProposedPlan does not invent todos from structured narrative plans", () => {
	const plan = `# Implementation Plan

## Summary
- Summarize the goal.
- Summarize constraints.

## Assumptions
1. This is context, not a todo.
2. This is also context.

## Test Plan
1. This validates the implementation later.
`;

	assert.deepEqual(extractTodoItemsFromProposedPlan(plan), []);
});

test("markCompletedSteps supports explicit tags and natural-language ranges", () => {
	const items = todos(["First", "Second", "Third", "Fourth"]);
	assert.equal(markCompletedSteps("[DONE:1]\nCompleted steps: 2-3", items), 3);
	assert.deepEqual(items.map((item) => item.completed), [true, true, true, false]);
});

test("markCompletedSteps detects whole-plan completion summaries", () => {
	const items = todos(["One", "Two"]);
	assert.equal(markCompletedSteps("Plan is complete and verified.", items), 2);
	assert.deepEqual(items.map((item) => item.completed), [true, true]);
});

test("markCompletedSteps recovers progress from implementation summaries without marking stated remaining work", () => {
	const items = todos([
		"Create clean implementation worktrees for network-operations and engineering-loop.",
		"Add the dedicated loop VM substrate in network-operations.",
		"Harden engineering-loop daemon for the seven core repos and low-and-slow production rollout.",
		"Deploy engineering-loop to the loop VM with Vault-rendered secrets and safe GitHub auth.",
		"Run manual canaries, then enable the hourly timer.",
	]);

	const summary = `Implemented the first execution tranche in clean worktrees.

## Worktrees created
- network-operations: /tmp/network-operations-loop-vm
- engineering-loop: /tmp/engineering-loop-daemon-rollout

## Implemented

### network-operations
Added dedicated loop VM substrate, inventory, playbook, role, Vault policy, Vault Agent env template, DNS records, and docs.

### engineering-loop
Hardened daemon rollout: default daemon repo scope is now the seven core repos, low-and-slow defaults, explicit repo mapping, repo discovery, CLI defaults, and tests.

## Still requires operator/live steps
1. Seed Vault.
2. Deploy to the loop VM.
3. Manual daemon canary.
4. Enable timer only after canary succeeds.
`;

	assert.equal(markCompletedSteps(summary, items), 3);
	assert.deepEqual(items.map((item) => item.completed), [true, true, true, false, false]);
});

test("markCompletedSteps respects explicit partial and pending status lines", () => {
	const items = todos([
		"Run preflight checklist and lock current repo state.",
		"Add config, storage schemas, migrations, and persistence helpers.",
		"Add BufferOfThought, focal contexts, compaction, export/import, sanitization, and quality checks.",
		"Add Pi extension handoff, command aliases, docs, runbooks, and SKILL/README updates.",
	]);

	const summary = `Implemented initial execution through the vertical-slice foundation.

## Current status

Completed steps: 1-2
1. ✅ Preflight
2. ✅ Storage/config/migration foundation
3. 🟨 BufferOfThought foundation added; import persistence/debug retention still pending
4. ☐ Pi extension/docs/SKILL updates pending
`;

	assert.equal(markExplicitNonDoneSteps(summary, items), 0);
	assert.equal(markCompletedSteps(summary, items), 2);
	assert.deepEqual(items.map((item) => item.status ?? (item.completed ? "done" : "pending")), ["done", "done", "pending", "pending"]);
});

test("markExplicitNonDoneSteps can repair previously false-completed steps", () => {
	const items = todos(["First", "Second", "Third"]);
	for (const item of items) {
		item.completed = true;
		item.status = "done";
	}

	const summary = `1. ✅ First
2. 🟨 Second partial
3. ☐ Third pending`;

	assert.equal(markExplicitNonDoneSteps(summary, items), 2);
	assert.deepEqual(items.map((item) => item.status ?? (item.completed ? "done" : "pending")), ["done", "pending", "pending"]);
});

test("extractDoneSteps parses multiple tag and phrase formats", () => {
	assert.deepEqual(extractDoneSteps("[DONE:1, 3-4]\nsteps 6 and 7 done"), [1, 3, 4, 6, 7]);
});
