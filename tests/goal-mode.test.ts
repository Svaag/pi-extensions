import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPersistentGoalContext,
	buildPlanModeCoordinationPrompt,
	DEFAULT_GOAL_COMPACTION_RESERVE_TOKENS,
	extractProgressItems,
	getGoalDeliveryMode,
	GOAL_MODE_CONTEXT_TYPE,
	isGoalCompleteSignal,
	GOAL_MODE_RESUME_TYPE,
	mergeProgressItems,
	pruneGoalModeResumeMessages,
	replaceGoalModeContext,
	shouldCompactGoalContext,
} from "../goal-mode/utils.ts";

test("extractProgressItems extracts done and pending checklist items", () => {
	assert.deepEqual(extractProgressItems("[DONE] Bootstrap project\n- [x] Add tests\n- [ ] Push branch"), [
		{ text: "Bootstrap project", done: true },
		{ text: "Add tests", done: true },
		{ text: "Push branch", done: false },
	]);
});

test("extractProgressItems does not add a pending duplicate after a done item", () => {
	assert.deepEqual(extractProgressItems("[DONE] Add tests\n- [ ] Add tests"), [
		{ text: "Add tests", done: true },
	]);
});

test("mergeProgressItems preserves done status and merges case-insensitively", () => {
	const merged = mergeProgressItems(
		[{ text: "Add tests", done: false }],
		[
			{ text: "add tests", done: true },
			{ text: "Push branch", done: false },
		],
	);

	assert.deepEqual(merged, [
		{ text: "Add tests", done: true },
		{ text: "Push branch", done: false },
	]);
});

test("isGoalCompleteSignal recognizes only whole-goal completion markers", () => {
	assert.equal(isGoalCompleteSignal("[GOAL COMPLETE]"), true);
	assert.equal(isGoalCompleteSignal("[TASK COMPLETE]"), true);
	assert.equal(isGoalCompleteSignal("Goal complete."), true);
	assert.equal(isGoalCompleteSignal("Delivered and verified.\n[GOAL COMPLETE]"), true);
	assert.equal(isGoalCompleteSignal("[GOAL COMPLETE]\nOne caveat remains."), false);
	assert.equal(isGoalCompleteSignal("> [GOAL COMPLETE]"), false);
	assert.equal(isGoalCompleteSignal("[DONE] Add tests"), false);
	assert.equal(isGoalCompleteSignal('Do not say "Goal complete." until verification.'), false);
	assert.equal(isGoalCompleteSignal("Still working."), false);
});

test("buildPersistentGoalContext identifies the authoritative persisted goal", () => {
	const context = buildPersistentGoalContext("Ship the Redis rate limiter", 3);

	assert.match(context, /Active Goal \(persisted by Goal Mode\)/);
	assert.match(context, /Revision: 3/);
	assert.match(context, /Ship the Redis rate limiter/);
	assert.match(context, /remains active across turns, tool calls, and context compaction/);
	assert.match(context, /Only include \[GOAL COMPLETE\]/);
});

test("replaceGoalModeContext replaces stale contexts after a context rebuild", () => {
	const latest = { role: "custom", customType: GOAL_MODE_CONTEXT_TYPE, content: "revision 3" };
	const messages = replaceGoalModeContext(
		[
			{ role: "compactionSummary", content: "older work" },
			{ role: "custom", customType: GOAL_MODE_CONTEXT_TYPE, content: "revision 1" },
			{ role: "user", content: "continue" },
			{ role: "custom", customType: GOAL_MODE_CONTEXT_TYPE, content: "revision 2" },
		],
		latest,
	);

	assert.deepEqual(messages, [
		{ role: "compactionSummary", content: "older work" },
		{ role: "user", content: "continue" },
		latest,
	]);
});

test("pruneGoalModeResumeMessages keeps only the current resume input", () => {
	const currentResume = {
		role: "custom",
		customType: GOAL_MODE_RESUME_TYPE,
		content: "current",
		details: { revision: 3 },
	};
	const messages = [
		{
			role: "custom",
			customType: GOAL_MODE_RESUME_TYPE,
			content: "old",
			details: { revision: 2 },
		},
		{ role: "assistant", content: "work" },
		currentResume,
	];

	assert.deepEqual(pruneGoalModeResumeMessages(messages, 3), [messages[1], currentResume]);
	assert.deepEqual(pruneGoalModeResumeMessages(messages, 4), [messages[1]]);
	assert.deepEqual(pruneGoalModeResumeMessages(messages), [messages[1]]);
});

test("shouldCompactGoalContext uses Pi's default response reserve", () => {
	const contextWindow = 272_000;
	const threshold = contextWindow - DEFAULT_GOAL_COMPACTION_RESERVE_TOKENS;

	assert.equal(threshold, 255_616);
	assert.equal(
		shouldCompactGoalContext({ tokens: threshold - 1, contextWindow }),
		false,
	);
	assert.equal(shouldCompactGoalContext({ tokens: threshold, contextWindow }), false);
	assert.equal(shouldCompactGoalContext({ tokens: threshold + 1, contextWindow }), true);
});

test("shouldCompactGoalContext rejects unavailable or invalid usage", () => {
	assert.equal(shouldCompactGoalContext(undefined), false);
	assert.equal(shouldCompactGoalContext({ tokens: null, contextWindow: 272_000 }), false);
	assert.equal(shouldCompactGoalContext({ tokens: Number.NaN, contextWindow: 272_000 }), false);
	assert.equal(shouldCompactGoalContext({ tokens: 10_000 }), false);
	assert.equal(shouldCompactGoalContext({ tokens: 10_000, contextWindow: 0 }), false);
	assert.equal(
		shouldCompactGoalContext({ tokens: 10_000, contextWindow: Number.POSITIVE_INFINITY }),
		false,
	);
});

test("shouldCompactGoalContext accepts a reserve override for isolated tests", () => {
	assert.equal(shouldCompactGoalContext({ tokens: 80, contextWindow: 100 }, 20), false);
	assert.equal(shouldCompactGoalContext({ tokens: 81, contextWindow: 100 }, 20), true);
});

test("getGoalDeliveryMode steers busy agents and starts immediately when idle", () => {
	assert.equal(getGoalDeliveryMode(false), "steer");
	assert.equal(getGoalDeliveryMode(true), "immediate");
});

test("buildPlanModeCoordinationPrompt points to the first unfinished plan step", () => {
	const prompt = buildPlanModeCoordinationPrompt({
		executing: true,
		todos: [
			{ step: 1, text: "Create worktrees", completed: true },
			{ step: 2, text: "Implement feature", completed: false },
			{ step: 3, text: "Run tests", completed: false },
		],
	});

	assert.match(prompt, /1\. \[x\] Create worktrees/);
	assert.match(prompt, /2\. \[ \] Implement feature/);
	assert.match(prompt, /Next unfinished step: 2\. Implement feature/);
	assert.match(prompt, /\[DONE:n\]/);
	assert.match(prompt, /Only emit \[GOAL COMPLETE\]/);
});
