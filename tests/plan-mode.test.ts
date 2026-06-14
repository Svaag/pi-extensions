import assert from "node:assert/strict";
import test from "node:test";
import {
	extractDoneSteps,
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	isSafeCommand,
	markCompletedSteps,
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

test("extractDoneSteps parses multiple tag and phrase formats", () => {
	assert.deepEqual(extractDoneSteps("[DONE:1, 3-4]\nsteps 6 and 7 done"), [1, 3, 4, 6, 7]);
});
