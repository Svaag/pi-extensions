import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

interface SentUserMessage {
	content: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

interface SentCustomMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

interface ExtensionHarness {
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	events: Map<string, (event: any, ctx: any) => Promise<any>>;
	entries: any[];
	sentUserMessages: SentUserMessage[];
	sentCustomMessages: SentCustomMessage[];
	notifications: { message: string; level: string }[];
	context: any;
	setIdle: (value: boolean) => void;
	setProcessing: (value: boolean) => void;
}

const jiti = createJiti(import.meta.url, { interopDefault: true });
const goalModeExtension = await jiti.import<(pi: any, options?: any) => void>(
	"../goal-mode/index.ts",
	{ default: true },
);

function createHarness(idle: boolean | (() => boolean), extensionOptions?: any): ExtensionHarness {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const events = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const entries: any[] = [];
	const sentUserMessages: SentUserMessage[] = [];
	const sentCustomMessages: SentCustomMessage[] = [];
	const notifications: { message: string; level: string }[] = [];
	let isIdle = typeof idle === "function" ? idle : () => idle;
	// Mimic pi: sending without a delivery mode while the agent is busy throws.
	let processing = false;
	const ui = {
		theme: {
			fg: (_color: string, text: string) => text,
			strikethrough: (text: string) => text,
		},
		setStatus: () => {},
		setWidget: () => {},
		notify: (message: string, level: string) => {
			notifications.push({ message, level });
		},
		input: async () => undefined,
	};
	const context = {
		ui,
		isIdle: () => isIdle(),
		sessionManager: {
			getBranch: () => entries,
		},
	};
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
		registerCommand: (name: string, definition: any) => {
			commands.set(name, definition.handler);
		},
		registerShortcut: () => {},
		on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => {
			events.set(name, handler);
		},
		sendUserMessage: (content: string, options?: SentUserMessage["options"]) => {
			if (processing && !options?.deliverAs) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			sentUserMessages.push({ content, options });
		},
		sendMessage: (
			message: SentCustomMessage["message"],
			options?: SentCustomMessage["options"],
		) => {
			sentCustomMessages.push({ message, options });
		},
	};

	goalModeExtension(pi, extensionOptions);
	return {
		commands,
		events,
		entries,
		sentUserMessages,
		sentCustomMessages,
		notifications,
		context,
		setIdle: (value: boolean) => {
			isIdle = () => value;
		},
		setProcessing: (value: boolean) => {
			processing = value;
		},
	};
}

test("busy /goal submissions steer the running agent and replace active goals", async () => {
	const harness = createHarness(false);
	await harness.events.get("session_start")?.({}, harness.context);

	await harness.commands.get("goal")?.("First goal", harness.context);
	await harness.commands.get("goal")?.("Replacement goal", harness.context);

	assert.equal(harness.sentUserMessages.length, 2);
	assert.deepEqual(harness.sentUserMessages.map((message) => message.options), [
		{ deliverAs: "steer" },
		{ deliverAs: "steer" },
	]);
	assert.match(harness.sentUserMessages[1].content, /replaces the previous goal/);
	assert.deepEqual(harness.entries.at(-1)?.data, {
		enabled: true,
		goal: "Replacement goal",
		revision: 2,
		paused: false,
		turns: 0,
		progress: [],
	});
});

test("active goals are injected after rebuilt context and restored from the branch", async () => {
	const harness = createHarness(true);
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Persist this goal", harness.context);

	assert.equal(harness.sentUserMessages[0].options, undefined);

	const beforeStart = await harness.events.get("before_agent_start")?.(
		{ systemPrompt: "base" },
		harness.context,
	);
	assert.match(beforeStart.message.content, /Persist this goal/);
	assert.match(beforeStart.message.content, /Revision: 1/);

	const rebuilt = await harness.events.get("context")?.(
		{
			messages: [
				{ role: "compactionSummary", summary: "old summary" },
				{ role: "custom", customType: "goal-mode-context", content: "stale" },
			],
		},
		harness.context,
	);
	assert.equal(rebuilt.messages.length, 2);
	assert.equal(rebuilt.messages[1].customType, "goal-mode-context");
	assert.match(rebuilt.messages[1].content, /Persist this goal/);

	const resumed = createHarness(true);
	resumed.entries.push(...harness.entries);
	await resumed.events.get("session_start")?.({}, resumed.context);
	const resumedContext = await resumed.events.get("context")?.({ messages: [] }, resumed.context);
	assert.match(resumedContext.messages[0].content, /Persist this goal/);
	assert.match(resumedContext.messages[0].content, /Revision: 1/);

	await flushTimers();
	assert.equal(resumed.sentCustomMessages.length, 1);
	assert.match(resumed.sentCustomMessages[0].message.content, /session was restored/);
});

function assistantTurn(harness: ExtensionHarness, stopReason: string, text = "working") {
	return async () => {
		await harness.events.get("agent_start")?.({}, harness.context);
		await harness.events.get("turn_start")?.({}, harness.context);
		await harness.events.get("turn_end")?.(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason,
				},
			},
			harness.context,
		);
		await harness.events.get("agent_end")?.(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason,
					},
				],
			},
			harness.context,
		);
	};
}

async function flushTimers(ms = 20): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

test("goal keeps driving after Pi exhausts retries for an API error", async () => {
	const harness = createHarness(true, { autoResumeBaseDelayMs: 1, autoResumeMaxDelayMs: 2 });
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Ship the feature", harness.context);

	await assistantTurn(harness, "error")();
	assert.equal(harness.sentCustomMessages.length, 0);

	await harness.events.get("agent_settled")?.({}, harness.context);
	await flushTimers();

	assert.equal(harness.sentCustomMessages.length, 1);
	assert.match(harness.sentCustomMessages[0].message.content, /after an API error/);
	assert.match(harness.sentCustomMessages[0].message.content, /Ship the feature/);
	assert.deepEqual(harness.sentCustomMessages[0].options, {
		triggerTurn: true,
		deliverAs: "followUp",
	});
});

test("ordinary stops continue as soon as Pi settles", async () => {
	const harness = createHarness(true);
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Keep going", harness.context);

	await assistantTurn(harness, "stop", "The first approach failed; here are next steps.")();
	assert.equal(harness.sentCustomMessages.length, 0);
	await harness.events.get("agent_settled")?.({}, harness.context);

	assert.equal(harness.sentUserMessages.length, 1);
	assert.equal(harness.sentCustomMessages.length, 1);
	assert.match(harness.sentCustomMessages[0].message.content, /next concrete action now/i);
	assert.match(harness.sentCustomMessages[0].message.content, /materially different approach/i);
	assert.deepEqual(harness.sentCustomMessages[0].options, {
		triggerTurn: true,
		deliverAs: "followUp",
	});
});

test("an explicit user interrupt pauses goal mode instead of resuming", async () => {
	const harness = createHarness(true);
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Do not fight me", harness.context);

	await assistantTurn(harness, "aborted")();
	await harness.events.get("agent_settled")?.({}, harness.context);

	assert.equal(harness.sentCustomMessages.length, 0);
	assert.equal(harness.entries.at(-1)?.data.enabled, true);
	assert.equal(harness.entries.at(-1)?.data.paused, true);
	assert.equal(harness.notifications.at(-1)?.level, "warning");

	const restored = createHarness(true);
	restored.entries.push(...harness.entries);
	await restored.events.get("session_start")?.({}, restored.context);
	await flushTimers();
	assert.equal(restored.sentCustomMessages.length, 0);

	await restored.events.get("before_agent_start")?.(
		{ systemPrompt: "base" },
		restored.context,
	);
	assert.equal(restored.entries.at(-1)?.data.paused, false);
});

test("completion signal exits goal mode so settled does not resume", async () => {
	const harness = createHarness(true);
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Finish up", harness.context);

	await assistantTurn(harness, "stop", "All done.\n[GOAL COMPLETE]")();
	assert.equal(harness.entries.at(-1)?.data.enabled, false);

	await harness.events.get("agent_settled")?.({}, harness.context);
	assert.equal(harness.sentCustomMessages.length, 0);
});

test("consecutive API errors back off and eventually pause instead of looping forever", async () => {
	const harness = createHarness(true, {
		autoResumeBaseDelayMs: 1,
		autoResumeMaxDelayMs: 2,
		maxConsecutiveErrorResumes: 3,
	});
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Retry logic", harness.context);

	const turn = assistantTurn(harness, "error");
	for (let attempt = 0; attempt < 10; attempt++) {
		await turn();
		await harness.events.get("agent_settled")?.({}, harness.context);
		await flushTimers();
	}

	assert.equal(harness.sentCustomMessages.length, 2);
	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /consecutive failed runs/);
});

test("runs without an assistant outcome back off and stop at the failure limit", async () => {
	const harness = createHarness(true, {
		autoResumeBaseDelayMs: 1,
		autoResumeMaxDelayMs: 2,
		maxConsecutiveErrorResumes: 3,
	});
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Handle missing outcomes", harness.context);

	for (let attempt = 0; attempt < 5; attempt++) {
		await harness.events.get("agent_start")?.({}, harness.context);
		await harness.events.get("agent_end")?.({ messages: [] }, harness.context);
		await harness.events.get("agent_settled")?.({}, harness.context);
		await flushTimers();
	}

	assert.equal(harness.sentCustomMessages.length, 2);
	assert.equal(harness.notifications.at(-1)?.level, "error");
});

test("a stale run settling after replacement drives the new goal", async () => {
	const harness = createHarness(false, { autoResumeBaseDelayMs: 1 });
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Old goal", harness.context);

	await assistantTurn(harness, "error")();
	await harness.commands.get("goal")?.("Replacement goal", harness.context);
	harness.setIdle(true);
	await harness.events.get("agent_settled")?.({}, harness.context);

	assert.equal(harness.sentCustomMessages.length, 1);
	assert.match(harness.sentCustomMessages[0].message.content, /Replacement goal/);
	assert.doesNotMatch(harness.sentCustomMessages[0].message.content, /after an API error/);
});

test("settlement before turn_start cannot strand the active goal", async () => {
	const harness = createHarness(true, { autoResumeBaseDelayMs: 1 });
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Survive preflight", harness.context);

	await harness.events.get("agent_start")?.({}, harness.context);
	await harness.events.get("agent_end")?.(
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			],
		},
		harness.context,
	);
	await harness.events.get("agent_settled")?.({}, harness.context);
	await flushTimers();

	assert.equal(harness.sentCustomMessages.length, 1);
	assert.match(harness.sentCustomMessages[0].message.content, /Survive preflight/);
});

test("replacing a goal cancels its pending error backoff", async () => {
	const harness = createHarness(true, { autoResumeBaseDelayMs: 30, autoResumeMaxDelayMs: 40 });
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Old timer", harness.context);

	await assistantTurn(harness, "error")();
	await harness.events.get("agent_settled")?.({}, harness.context);
	await harness.commands.get("goal")?.("New goal", harness.context);
	await flushTimers(60);

	assert.equal(harness.sentCustomMessages.length, 0);
	assert.equal(harness.sentUserMessages.length, 2);
});

test("a busy run during error backoff discards the timer instead of queueing", async () => {
	const harness = createHarness(true, { autoResumeBaseDelayMs: 30, autoResumeMaxDelayMs: 40 });
	await harness.events.get("session_start")?.({}, harness.context);
	await harness.commands.get("goal")?.("Race the timer", harness.context);

	await assistantTurn(harness, "error")();
	await harness.events.get("agent_settled")?.({}, harness.context);

	harness.setProcessing(true);
	harness.setIdle(false);
	await flushTimers(60);
	assert.equal(harness.sentCustomMessages.length, 0);

	// No stale Goal Mode follow-up survives to trigger after an explicit exit.
	await harness.commands.get("no-goal")?.("", harness.context);
	harness.setProcessing(false);
	harness.setIdle(true);
	await flushTimers();
	assert.equal(harness.sentCustomMessages.length, 0);
});
