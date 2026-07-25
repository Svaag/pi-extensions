import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanStepText,
	extractDoneSteps,
	extractProposedPlan,
	extractTodoItemsFromProposedPlan,
	formatPlanQuestionsResult,
	hasHandoffClaim,
	isSafeCommand,
	isTodoClosed,
	markCompletedSteps,
	setTodoStatus,
	upsertPlanProgressSection,
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

test("extractTodoItemsFromProposedPlan preserves snake_case paths from code spans", () => {
	// Regression: stripMarkdownInline used to unwrap code spans before applying a
	// naive _emphasis_ rule, so `src/evm_hunter/..._receipts.py` lost underscores.
	const plan = `# Plan

## Implementation Steps
1. Adapt \`src/evm_hunter/oracle/terminal_blocked_skim_receipts.py\` to the typed fanout-authority API.
2. Route markers with missing \`schema_version\` to \`_verify_terminal_skim_completion_v1\` and fail closed.
`;

	const texts = extractTodoItemsFromProposedPlan(plan).map((item) => item.text);
	assert.equal(texts.length, 2);
	assert.ok(texts[0].includes("evm_hunter"), texts[0]);
	assert.ok(texts[1].includes("schema_version"), texts[1]);
});

test("cleanStepText keeps underscores in code spans and bare identifiers", () => {
	assert.equal(
		cleanStepText("1. Adapt \`terminal_blocked_skim_receipts.py\` to the typed API."),
		"Adapt terminal_blocked_skim_receipts.py to the typed API.",
	);
	// Intraword underscores are literal in CommonMark even outside code spans.
	assert.equal(
		cleanStepText("- Update terminal_blocked_skim_receipts handling."),
		"Update terminal_blocked_skim_receipts handling.",
	);
	// Code span content is verbatim, even when it looks like markup.
	assert.equal(cleanStepText("- Call \`_verify_*chain*_v1\` next."), "Call _verify_*chain*_v1 next.");
});

test("cleanStepText still strips real emphasis and links", () => {
	assert.equal(cleanStepText("- **Bold step:** do the thing."), "Bold step: do the thing.");
	assert.equal(cleanStepText("- _Important note_ for later."), "Important note for later.");
	assert.equal(cleanStepText("- See [the docs](https://example.com) here."), "See the docs here.");
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

test("todo statuses distinguish skipped and deferred from done", () => {
	const items = todos(["Do code", "Manual resize", "Measure"]);
	setTodoStatus(items[0], "done");
	setTodoStatus(items[1], "skipped");
	setTodoStatus(items[2], "deferred");

	assert.deepEqual(items.map((item) => item.completed), [true, false, false]);
	assert.deepEqual(items.map((item) => isTodoClosed(item)), [true, true, true]);
});

test("whole-plan completion does not overwrite skipped or deferred items", () => {
	const items = todos(["Do code", "Manual resize", "Measure"]);
	setTodoStatus(items[1], "skipped");
	setTodoStatus(items[2], "deferred");

	assert.equal(markCompletedSteps("Plan is complete and verified.", items), 1);
	assert.deepEqual(items.map((item) => item.status ?? (item.completed ? "done" : "pending")), ["done", "skipped", "deferred"]);
});

test("upsertPlanProgressSection adds and replaces persisted progress", () => {
	const items = todos(["First", "Second"]);
	setTodoStatus(items[0], "done");
	const initial = upsertPlanProgressSection("# Plan\n\nBody\n", items);
	assert.match(initial, /<!-- pi-plan-progress:start -->/);
	assert.match(initial, /- \[x\] 1\. First _\(done\)_/);
	assert.match(initial, /- \[ \] 2\. Second _\(pending\)_/);

	setTodoStatus(items[1], "deferred");
	const updated = upsertPlanProgressSection(initial, items);
	assert.equal((updated.match(/<!-- pi-plan-progress:start -->/g) ?? []).length, 1);
	assert.match(updated, /- \[>\] 2\. Second _\(deferred\)_/);
});

test("handoff claims are detected for review-ready language", () => {
	assert.equal(hasHandoffClaim("PR is clean and ready for human review."), true);
	assert.equal(hasHandoffClaim("CI is clean; leaving this for review."), true);
	assert.equal(hasHandoffClaim("Implemented the parser and will continue with tests."), false);
});

test("formatPlanQuestionsResult produces a header line and decision bullets", () => {
	const questions = [
		{ id: "scope", label: "Approach" },
		{ id: "tests", label: "Test scope" },
	];
	const answers = [
		{ id: "scope", value: "hybrid", label: "Recommendation: Hybrid \u2014 verify + rename (option 3).", source: "agent" as const },
		{ id: "tests", value: "both", label: "3. Both \u2014 new focused tests + extend existing where natural." },
	];

	const output = formatPlanQuestionsResult(questions, answers);
	const expectedHeader = "The user answered your planning questions (final decisions \u2014 do not re-ask):";
	assert.ok(output.startsWith(expectedHeader), `output should start with header; got: ${output.slice(0, 80)}`);

	// Agent-accepted answer: stripped "Recommendation:" prefix
	assert.ok(output.includes("Approach (scope): Hybrid \u2014 verify + rename (option 3)."), `missing agent line; got: ${output}`);
	assert.ok(!output.includes("Recommendation:"), `"Recommendation:" should be stripped; got: ${output}`);
	assert.ok(!output.includes("agent"), `"agent" provenance should not appear; got: ${output}`);

	// User-selected answer: index preserved
	assert.ok(output.includes("Test scope (tests): 3. Both"), `missing selected line; got: ${output}`);
	assert.ok(!output.includes("selected"), `"selected" provenance should not appear; got: ${output}`);
});

test("formatPlanQuestionsResult handles agent answer without Recommendation prefix", () => {
	const questions = [{ id: "q", label: "Q" }];
	const answers = [{ id: "q", value: "custom", label: "Just do Y, because Z.", source: "agent" as const }];

	const output = formatPlanQuestionsResult(questions, answers);
	assert.ok(output.includes("Q (q): Just do Y, because Z."), `got: ${output}`);
});

test("formatPlanQuestionsResult handles user-typed custom answer", () => {
	const questions = [{ id: "rollout", label: "Rollout" }];
	const answers = [{ id: "rollout", value: "feature-flagged", label: "feature-flagged rollout" }];

	const output = formatPlanQuestionsResult(questions, answers);
	assert.ok(output.includes("- Rollout (rollout): feature-flagged rollout"), `got: ${output}`);
	assert.ok(!output.includes("wrote"), `"wrote" provenance should not appear; got: ${output}`);
});

test("formatPlanQuestionsResult collapses multi-line agent labels", () => {
	const questions = [{ id: "q", label: "Q" }];
	const answers = [{ id: "q", value: "multiline", label: "Recommendation: A.\nBecause B.\nAdditional detail.", source: "agent" as const }];

	const output = formatPlanQuestionsResult(questions, answers);
	// Should be a single-line bullet: no newlines in output after the header
	assert.ok(output.includes("A. Because B. Additional detail."), `got: ${output}`);
	assert.equal(output.split("\n").length, 2, `should have exactly 2 lines: header + bullet; got ${output.split("\n").length} lines`);
});

test("formatPlanQuestionsResult handles empty answers array", () => {
	const questions = [{ id: "q", label: "Q" }];
	const answers: Array<{ id: string; value: string; label: string; source?: "agent" | "user" }> = [];

	const output = formatPlanQuestionsResult(questions, answers);
	assert.equal(output, "The user answered your planning questions (final decisions \u2014 do not re-ask):");
});

test("formatPlanQuestionsResult strips Recommend: variant", () => {
	const questions = [{ id: "q", label: "Q" }];
	const answers = [{ id: "q", value: "x", label: "Recommend: Do X.", source: "agent" as const }];

	const output = formatPlanQuestionsResult(questions, answers);
	assert.ok(output.includes("Q (q): Do X."), `got: ${output}`);
	assert.ok(!output.includes("Recommend:"), `"Recommend:" should be stripped; got: ${output}`);
});

test("formatPlanQuestionsResult handles question without matching label gracefully", () => {
	// Fallback: when a question isn't in the map, use the bare id as prefix
	const questions: Array<{ id: string; label: string }> = [];
	const answers = [{ id: "orphan", value: "v", label: "Some answer" }];

	const output = formatPlanQuestionsResult(questions, answers);
	assert.ok(output.includes("- orphan: Some answer"), `got: ${output}`);
});
