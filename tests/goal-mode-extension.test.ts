import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

interface SentUserMessage {
	content: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

interface ExtensionHarness {
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	events: Map<string, (event: any, ctx: any) => Promise<any>>;
	entries: any[];
	sentUserMessages: SentUserMessage[];
	context: any;
}

const jiti = createJiti(import.meta.url, { interopDefault: true });
const goalModeExtension = await jiti.import<(pi: any) => void>("../goal-mode/index.ts", {
	default: true,
});

function createHarness(idle: boolean): ExtensionHarness {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const events = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const entries: any[] = [];
	const sentUserMessages: SentUserMessage[] = [];
	const ui = {
		theme: {
			fg: (_color: string, text: string) => text,
			strikethrough: (text: string) => text,
		},
		setStatus: () => {},
		setWidget: () => {},
		notify: () => {},
		input: async () => undefined,
	};
	const context = {
		ui,
		isIdle: () => idle,
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
			sentUserMessages.push({ content, options });
		},
	};

	goalModeExtension(pi);
	return { commands, events, entries, sentUserMessages, context };
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
});
