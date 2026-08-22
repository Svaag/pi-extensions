/**
 * Goal Mode Extension — Codex "execute" collaboration style for Pi.
 *
 * /goal <description>   Start or replace a persistent autonomous goal.
 * /goal, /no-goal       Exit goal mode when active.
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
import {
	buildAutoResumePrompt,
	buildPersistentGoalContext,
	buildPlanModeCoordinationPrompt,
	extractProgressItems,
	getAutoResumeDelayMs,
	getGoalDeliveryMode,
	GOAL_MODE_CONTEXT_TYPE,
	isGoalCompleteSignal,
	mergeProgressItems,
	replaceGoalModeContext,
	type PlanModeState,
} from "./utils.js";

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

function getPlanModeState(ctx: ExtensionContext): PlanModeState | undefined {
	const entries = ctx.sessionManager.getBranch();
	const planEntry = entries
		.filter((e: any) => e.type === "custom" && e.customType === "plan-mode")
		.pop() as any;
	if (!planEntry?.data) return undefined;
	const todos = Array.isArray(planEntry.data.todos) ? planEntry.data.todos : [];
	const executing = planEntry.data.executing === true;
	if (!executing || todos.length === 0) return undefined;
	return { executing, todos };
}

// ── main extension ───────────────────────────────────────────────────────────

const AUTO_RESUME_BASE_DELAY_MS = 2_000;
const AUTO_RESUME_MAX_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_ERROR_RESUMES = 5;

export interface GoalModeExtensionOptions {
	/** Base delay for the auto-resume error backoff (tests inject a small value). */
	autoResumeBaseDelayMs?: number;
	/** Upper bound for the auto-resume error backoff. */
	autoResumeMaxDelayMs?: number;
	/** Consecutive error resumes allowed before pausing goal mode. */
	maxConsecutiveErrorResumes?: number;
}

export default function goalModeExtension(
	pi: ExtensionAPI,
	options: GoalModeExtensionOptions = {},
): void {
	const autoResumeBaseDelayMs = options.autoResumeBaseDelayMs ?? AUTO_RESUME_BASE_DELAY_MS;
	const autoResumeMaxDelayMs = options.autoResumeMaxDelayMs ?? AUTO_RESUME_MAX_DELAY_MS;
	const maxConsecutiveErrorResumes =
		options.maxConsecutiveErrorResumes ?? MAX_CONSECUTIVE_ERROR_RESUMES;

	let goalModeEnabled = false;
	let currentGoal = "";
	let goalRevision = 0;
	let turnCount = 0;
	let turnGoalRevision: number | undefined;
	let progressItems: { text: string; done: boolean }[] = [];
	// Stop reason of the last assistant message of the most recent low-level run.
	let lastRunStopReason: AssistantMessage["stopReason"] | undefined;
	let consecutiveErrorResumes = 0;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	function persistState(): void {
		pi.appendEntry("goal-mode", {
			enabled: goalModeEnabled,
			goal: currentGoal,
			revision: goalRevision,
			turns: turnCount,
			progress: progressItems,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (goalModeEnabled && currentGoal) {
			ctx.ui.setStatus(
				"goal-mode",
				ctx.ui.theme.fg("accent", "⚡ goal • persisted"),
			);
		} else {
			ctx.ui.setStatus("goal-mode", undefined);
		}

		if (goalModeEnabled && currentGoal) {
			const lines: string[] = [
				ctx.ui.theme.fg("accent", "Goal: ") + currentGoal,
				ctx.ui.theme.fg("dim", "Persisted in this session • re-injected after compaction"),
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

	function clearPendingResume(): void {
		if (resumeTimer !== undefined) {
			clearTimeout(resumeTimer);
			resumeTimer = undefined;
		}
	}

	function enterGoalMode(goal: string, ctx: ExtensionContext): void {
		clearPendingResume();
		goalModeEnabled = true;
		currentGoal = goal;
		goalRevision++;
		turnCount = 0;
		turnGoalRevision = undefined;
		progressItems = [];
		consecutiveErrorResumes = 0;
		persistState();
		updateStatus(ctx);
	}

	function submitGoal(goal: string, ctx: ExtensionContext): void {
		const replacing = goalModeEnabled;
		const deliveryMode = getGoalDeliveryMode(ctx.isIdle());
		enterGoalMode(goal, ctx);

		const submission = [
			`Goal Mode revision ${goalRevision}${replacing ? " (replaces the previous goal)" : ""}:`,
			goal,
		].join("\n\n");

		try {
			if (deliveryMode === "steer") {
				// Steer the active run at its next model call instead of waiting for the
				// entire existing task to finish.
				pi.sendUserMessage(submission, { deliverAs: "steer" });
			} else {
				pi.sendUserMessage(submission);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Goal was persisted, but delivery failed: ${message}`, "error");
			return;
		}

		const action = replacing ? "replaced" : "saved";
		const delivery = deliveryMode === "steer" ? "sent to the running agent" : "started";
		ctx.ui.notify(
			`Goal ${action} and ${delivery}. It will be re-injected after compaction.`,
			"info",
		);
	}

	function exitGoalMode(ctx: ExtensionContext): void {
		clearPendingResume();
		goalModeEnabled = false;
		currentGoal = "";
		turnCount = 0;
		turnGoalRevision = undefined;
		progressItems = [];
		persistState();
		updateStatus(ctx);
	}

	// ── /goal command ──────────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set or replace a persistent autonomous goal (bare /goal exits)",
		handler: async (args, ctx) => {
			const goal = args.trim();

			// A goal argument always starts or replaces the active goal. Keep the
			// toggle behavior only for a bare /goal while already active.
			if (goal) {
				submitGoal(goal, ctx);
				return;
			}
			if (goalModeEnabled) {
				exitGoalMode(ctx);
				ctx.ui.notify("Goal mode exited. Collaboration style restored.", "info");
				return;
			}

			const input = await ctx.ui.input("Goal:", "Describe the task you want executed autonomously");
			if (!input?.trim()) {
				ctx.ui.notify("No goal provided. Goal mode not activated.", "warning");
				return;
			}
			submitGoal(input.trim(), ctx);
		},
	});

	// ── /no-goal command (legacy alias) ────────────────────────────────────────

	pi.registerCommand("no-goal", {
		description: "Exit goal mode (legacy alias; bare /goal also exits)",
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
				`Revision: ${goalRevision}`,
				`Turns: ${turnCount}`,
				`Progress: ${doneCount}/${progressItems.length}`,
				"Persistence: saved in this session and re-injected on every model call",
			].join("\n");
			ctx.ui.notify(status, "info");
		},
	});

	// ── shortcut: Ctrl+Alt+G to toggle ─────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("g"), {
		description: "Toggle goal mode",
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (!goalModeEnabled) return;

		// Append the execute collaboration-style instructions to the system prompt.
		let systemPrompt = event.systemPrompt + "\n\n" + EXECUTE_SYSTEM_PROMPT;

		// Coordinate with active plan-mode todos so progress keeps updating.
		const planState = getPlanModeState(ctx);
		if (planState) {
			systemPrompt += "\n\n" + buildPlanModeCoordinationPrompt(planState);
		}

		return {
			systemPrompt,
			// Store a durable context checkpoint for this run. The context hook below
			// canonicalizes these checkpoints to the latest revision before each call.
			message: {
				customType: GOAL_MODE_CONTEXT_TYPE,
				content: buildPersistentGoalContext(currentGoal, goalRevision),
				display: false,
				details: { revision: goalRevision },
			},
		};
	});

	// ── turn tracking ──────────────────────────────────────────────────────────

	pi.on("turn_start", async (_event, _ctx) => {
		turnGoalRevision = goalModeEnabled ? goalRevision : undefined;
		if (turnGoalRevision === undefined) return;
		turnCount++;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!goalModeEnabled || turnGoalRevision !== goalRevision) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);

		// Extract progress items from this turn
		const extracted = extractProgressItems(text);
		if (extracted.length > 0) {
			progressItems = mergeProgressItems(progressItems, extracted);
		}

		persistState();
		updateStatus(ctx);
	});

	// ── agent_end: auto-exit on completion signal ──────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		// Remember why the last run stopped so agent_settled can decide whether to
		// resume driving. Captured before the guards: even runs for a replaced or
		// exited goal must not leave a stale reason behind.
		lastRunStopReason = [...event.messages].reverse().find(isAssistantMessage)?.stopReason;

		if (!goalModeEnabled || turnGoalRevision !== goalRevision) return;

		// Check if the assistant signaled goal/task completion
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			if (isGoalCompleteSignal(text)) {
				exitGoalMode(ctx);
				ctx.ui.notify("Goal complete — goal mode exited.", "info");
				return;
			}
		}

		// If we're coordinating with plan mode and every step is done, exit too
		const planState = getPlanModeState(ctx);
		if (planState && planState.todos.every((t) => t.completed)) {
			exitGoalMode(ctx);
			ctx.ui.notify("All plan steps complete — goal mode exited.", "info");
		}
	});

	// ── keep driving after anything pauses the feed ────────────────────────────
	// Re-injecting the goal into context is not enough: if a run ends because of
	// an API error, a dropped stream, or any other pause, Pi settles idle and
	// nothing would ever restart it. agent_settled fires exactly when Pi will
	// not continue on its own (retries and auto-compaction included), so that is
	// where goal mode re-kicks the agent until the goal is delivered.
	pi.on("agent_settled", async (_event, ctx) => {
		clearPendingResume();

		if (!goalModeEnabled || !currentGoal) return;
		if (!ctx.isIdle()) return; // another run is already queued or active
		if (turnGoalRevision !== goalRevision) return; // stale run for an old goal

		// An explicit user interrupt (Esc) pauses goal mode on purpose. Never
		// fight the operator: require a new message or /goal <task> to resume.
		if (lastRunStopReason === "aborted") {
			ctx.ui.notify(
				"Goal mode paused by interrupt. Send a message or run /goal <task> to resume.",
				"warning",
			);
			return;
		}

		if (lastRunStopReason === "error") {
			consecutiveErrorResumes++;
			if (consecutiveErrorResumes > maxConsecutiveErrorResumes) {
				ctx.ui.notify(
					`Goal paused after ${maxConsecutiveErrorResumes} consecutive API errors. Send a message to retry.`,
					"error",
				);
				return;
			}
		} else {
			consecutiveErrorResumes = 0;
		}

		const reason =
			lastRunStopReason === "error" ? "after an API error" : "before the goal was completed";
		const delayMs =
			lastRunStopReason === "error"
				? getAutoResumeDelayMs(consecutiveErrorResumes, autoResumeBaseDelayMs, autoResumeMaxDelayMs)
				: 0;

		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			resumeAfterSettle(reason, ctx);
		}, delayMs);
	});

	function queueGoalResume(prompt: string, ctx: ExtensionContext): void {
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Goal auto-resume failed: ${message}`, "error");
		}
	}

	function resumeAfterSettle(reason: string, ctx: ExtensionContext): void {
		// State may have changed while the backoff timer was pending.
		if (!goalModeEnabled || !currentGoal) return;
		const prompt = buildAutoResumePrompt(reason, currentGoal, goalRevision);

		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				// Another extension or the user started a run while the resume
				// timer was pending: queue behind it instead of throwing.
				queueGoalResume(prompt, ctx);
			}
		} catch {
			// Race: a run started between the idle check and the send. Queue the
			// resume behind the active run rather than dropping it.
			queueGoalResume(prompt, ctx);
		}
	}

	// ── keep exactly one authoritative goal in every model context ─────────────

	pi.on("context", async (event) => {
		const activeContext: AgentMessage | undefined =
			goalModeEnabled && currentGoal
				? {
						role: "custom",
						customType: GOAL_MODE_CONTEXT_TYPE,
						content: buildPersistentGoalContext(currentGoal, goalRevision),
						display: false,
						details: { revision: goalRevision },
						timestamp: Date.now(),
					}
				: undefined;

		return { messages: replaceGoalModeContext(event.messages, activeContext) };
	});

	// ── session shutdown / start ─────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		clearPendingResume();
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
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
						revision?: number;
						turns?: number;
						progress?: { text: string; done: boolean }[];
					};
			  }
			| undefined;

		if (goalEntry?.data) {
			goalModeEnabled = goalEntry.data.enabled;
			currentGoal = goalEntry.data.goal ?? "";
			goalRevision = goalEntry.data.revision ?? (goalModeEnabled ? 1 : 0);
			turnCount = goalEntry.data.turns ?? 0;
			turnGoalRevision = undefined;
			progressItems = goalEntry.data.progress ?? [];
			consecutiveErrorResumes = 0;
		} else {
			goalModeEnabled = false;
			currentGoal = "";
			goalRevision = 0;
			turnCount = 0;
			turnGoalRevision = undefined;
			progressItems = [];
			consecutiveErrorResumes = 0;
		}

		clearPendingResume();
		updateStatus(ctx);
	});
}
