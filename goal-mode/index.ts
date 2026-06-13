/**
 * Goal Mode Extension — Codex "execute" collaboration style for Pi.
 *
 * /goal <description>   Enter execute (goal) mode and begin autonomous work.
 * /no-goal              Exit goal mode.
 * /goal-status          Show current goal and progress.
 *
 * In goal mode the agent executes end-to-end, makes assumptions when
 * information is missing, avoids asking open-ended questions, reports
 * progress as it works, and delivers the task autonomously.
 *
 * Behavior modelled exactly on OpenAI Codex collaboration mode template:
 * https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/execute.md
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// ── Codex "Collaboration Style: Execute" system prompt (verbatim) ────────────

const EXECUTE_SYSTEM_PROMPT = `# Collaboration Style: Execute
You execute on a well-specified task independently and report progress.

You do not collaborate on decisions in this mode. You execute end-to-end.
You make reasonable assumptions when the user hasn't specified something, and you proceed without asking questions.

## Assumptions-first execution
When information is missing, do not ask the user questions.
Instead:
- Make a sensible assumption.
- Clearly state the assumption in the final message (briefly).
- Continue executing.

Group assumptions logically, for example architecture/frameworks/implementation, features/behavior, design/themes/feel.
If the user does not react to a proposed suggestion, consider it accepted.

## Execution principles
*Think out loud.* Share reasoning when it helps the user evaluate tradeoffs. Keep explanations short and grounded in consequences. Avoid design lectures or exhaustive option lists.

*Use reasonable assumptions.* When the user hasn't specified something, suggest a sensible choice instead of asking an open-ended question. Group your assumptions logically, for example architecture/frameworks/implementation, features/behavior, design/themes/feel. Clearly label suggestions as provisional. Share reasoning when it helps the user evaluate tradeoffs. Keep explanations short and grounded in consequences. They should be easy to accept or override. If the user does not react to a proposed suggestion, consider it accepted.

Example: "There are a few viable ways to structure this. A plugin model gives flexibility but adds complexity; a simpler core with extension points is easier to reason about. Given what you've said about your team's size, I'd lean towards the latter."
Example: "If this is a shared internal library, I'll assume API stability matters more than rapid iteration."

*Think ahead.* What else might the user need? How will the user test and understand what you did? Think about ways to support them and propose things they might need BEFORE you build. Offer at least one suggestion you came up with by thinking ahead.
Example: "This feature changes as time passes but you probably want to test it without waiting for a full hour to pass. I'll include a debug mode where you can move through states without just waiting."

*Be mindful of time.* The user is right here with you. Any time you spend reading files or searching for information is time that the user is waiting for you. Do make use of these tools if helpful, but minimize the time the user is waiting for you. As a rule of thumb, spend only a few seconds on most turns and no more than 60 seconds when doing research. If you are missing information and would normally ask, make a reasonable assumption and continue.
Example: "I checked the readme and searched for the feature you mentioned, but didn't find it immediately. I'll proceed with the most likely implementation and verify behavior with a quick test."

## Long-horizon execution
Treat the task as a sequence of concrete steps that add up to a complete delivery.
- Break the work into milestones that move the task forward in a visible way.
- Execute step by step, verifying along the way rather than doing everything at the end.
- If the task is large, keep a running checklist of what is done, what is next, and what is blocked.
- Avoid blocking on uncertainty: choose a reasonable default and continue.

## Reporting progress
Provide updates that directly map to the work you are doing (what changed, what you verified, what remains).
- If something fails, report what failed, what you tried, and what you will do next.
- When you finish, summarize what you delivered and how the user can validate it.

## Executing
Once you start working, you should execute independently. Your job is to deliver the task and report progress.`;

// ── helpers ──────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Tag that signals the agent considers the goal complete. */
const GOAL_COMPLETE_PATTERN = /\[GOAL\s+COMPLETE\]|\[TASK\s+COMPLETE\]|\[DONE\]|Goal complete\./i;

/** Extract check-list-like items from assistant text: [DONE] item, - [x] item, etc. */
function extractProgressItems(text: string): { text: string; done: boolean }[] {
	const items: { text: string; done: boolean }[] = [];
	// [DONE] some task
	for (const match of text.matchAll(/^\s*\[DONE\]\s*(.+)$/gim)) {
		items.push({ text: match[1].trim(), done: true });
	}
	// - [x] some task
	for (const match of text.matchAll(/^\s*-?\s*\[x\]\s*(.+)$/gim)) {
		items.push({ text: match[1].trim(), done: true });
	}
	// - [ ] some task
	for (const match of text.matchAll(/^\s*-?\s*\[\s*\]\s*(.+)$/gim)) {
		if (!items.find((i) => i.text === match[1].trim())) {
			items.push({ text: match[1].trim(), done: false });
		}
	}
	return items;
}

// ── main extension ───────────────────────────────────────────────────────────

export default function goalModeExtension(pi: ExtensionAPI): void {
	let goalModeEnabled = false;
	let currentGoal = "";
	let turnCount = 0;
	let progressItems: { text: string; done: boolean }[] = [];

	function persistState(): void {
		pi.appendEntry("goal-mode", {
			enabled: goalModeEnabled,
			goal: currentGoal,
			turns: turnCount,
			progress: progressItems,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (goalModeEnabled && currentGoal) {
			ctx.ui.setStatus(
				"goal-mode",
				ctx.ui.theme.fg("accent", "⚡ goal"),
			);
		} else {
			ctx.ui.setStatus("goal-mode", undefined);
		}

		if (goalModeEnabled && currentGoal) {
			const lines: string[] = [
				ctx.ui.theme.fg("accent", "Goal: ") + currentGoal,
			];
			if (turnCount > 0) {
				lines.push(ctx.ui.theme.fg("dim", `Turns: ${turnCount}`));
			}
			if (progressItems.length > 0) {
				const doneCount = progressItems.filter((i) => i.done).length;
				lines.push(
					"",
					ctx.ui.theme.fg("muted", `Progress ${doneCount}/${progressItems.length}`),
				);
				for (const item of progressItems) {
					lines.push(
						item.done
							? `${ctx.ui.theme.fg("success", "✓ ")}${ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))}`
							: `${ctx.ui.theme.fg("dim", "○ ")}${item.text}`,
					);
				}
			}
			ctx.ui.setWidget("goal-checklist", lines);
		} else {
			ctx.ui.setWidget("goal-checklist", undefined);
		}
	}

	function enterGoalMode(goal: string, ctx: ExtensionContext): void {
		goalModeEnabled = true;
		currentGoal = goal;
		turnCount = 0;
		progressItems = [];
		persistState();
		updateStatus(ctx);
	}

	function exitGoalMode(ctx: ExtensionContext): void {
		goalModeEnabled = false;
		currentGoal = "";
		turnCount = 0;
		progressItems = [];
		persistState();
		updateStatus(ctx);
	}

	// ── /goal command ──────────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Enter goal (execute) mode and work autonomously",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				const input = await ctx.ui.input("Goal:", "Describe the task you want executed autonomously");
				if (!input?.trim()) {
					ctx.ui.notify("No goal provided. Goal mode not activated.", "warning");
					return;
				}
				enterGoalMode(input.trim(), ctx);
				pi.sendUserMessage(input.trim());
			} else {
				enterGoalMode(goal, ctx);
				pi.sendUserMessage(goal);
			}
		},
	});

	// ── /no-goal command ───────────────────────────────────────────────────────

	pi.registerCommand("no-goal", {
		description: "Exit goal (execute) mode",
		handler: async (_args, ctx) => {
			if (!goalModeEnabled) {
				ctx.ui.notify("Not in goal mode.", "info");
				return;
			}
			exitGoalMode(ctx);
			ctx.ui.notify("Goal mode exited. Collaboration style restored.", "info");
		},
	});

	// ── /goal-status command ───────────────────────────────────────────────────

	pi.registerCommand("goal-status", {
		description: "Show current goal status and progress",
		handler: async (_args, ctx) => {
			if (!goalModeEnabled || !currentGoal) {
				ctx.ui.notify("No active goal. Use /goal to start one.", "info");
				return;
			}
			const doneCount = progressItems.filter((i) => i.done).length;
			const status = [
				`Goal: ${currentGoal}`,
				`Turns: ${turnCount}`,
				`Progress: ${doneCount}/${progressItems.length}`,
			].join("\n");
			ctx.ui.notify(status, "info");
		},
	});

	// ── shortcut: Ctrl+Alt+G to toggle ─────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("g"), {
		description: "Exit goal mode",
		handler: async (ctx) => {
			if (goalModeEnabled) {
				exitGoalMode(ctx);
				ctx.ui.notify("Goal mode exited.", "info");
			} else {
				ctx.ui.notify("Not in goal mode. Use /goal <task> to enter.", "warning");
			}
		},
	});

	// ── inject execute system prompt while goal mode is active ─────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!goalModeEnabled) return;

		// Prepend the execute collaboration-style instructions to the system prompt
		return {
			systemPrompt:
				// Append to existing system prompt so other extensions' injections are preserved
				event.systemPrompt + "\n\n" + EXECUTE_SYSTEM_PROMPT,
		};
	});

	// ── turn tracking ──────────────────────────────────────────────────────────

	pi.on("turn_start", async (_event, _ctx) => {
		if (!goalModeEnabled) return;
		turnCount++;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!goalModeEnabled) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);

		// Extract progress items from this turn
		const extracted = extractProgressItems(text);
		if (extracted.length > 0) {
			// Merge new items, preferring done status if seen before
			for (const item of extracted) {
				const existing = progressItems.find(
					(p) => p.text.toLowerCase() === item.text.toLowerCase(),
				);
				if (existing) {
					existing.done = existing.done || item.done;
				} else {
					progressItems.push(item);
				}
			}
		}

		persistState();
		updateStatus(ctx);
	});

	// ── agent_end: auto-exit on completion signal ──────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!goalModeEnabled) return;

		// Check if the assistant signaled goal/task completion
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			if (GOAL_COMPLETE_PATTERN.test(text)) {
				exitGoalMode(ctx);
			}
		}
	});

	// ── filter stale goal context when not in goal mode ────────────────────────

	pi.on("context", async (event) => {
		if (goalModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "goal-mode-context") return false;
				return true;
			}),
		};
	});

	// ── session start: restore state ───────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const goalEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "goal-mode",
			)
			.pop() as
			| {
					data?: {
						enabled: boolean;
						goal?: string;
						turns?: number;
						progress?: { text: string; done: boolean }[];
					};
			  }
			| undefined;

		if (goalEntry?.data) {
			goalModeEnabled = goalEntry.data.enabled;
			currentGoal = goalEntry.data.goal ?? "";
			turnCount = goalEntry.data.turns ?? 0;
			progressItems = goalEntry.data.progress ?? [];
		} else {
			goalModeEnabled = false;
			currentGoal = "";
			turnCount = 0;
			progressItems = [];
		}

		updateStatus(ctx);
	});
}
