import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ThinkingLevel } from "../core/AgentTypes.ts";
import { type ManagerGetter, preview, textResult } from "./common.ts";

const FollowupTaskParams = Type.Object({
	agentId: Type.String({ description: "Target agent id." }),
	prompt: Type.String({ description: "Follow-up task prompt." }),
	mode: Type.Optional(StringEnum(["live_if_supported", "spawn_followup"] as const, { description: "Use the live child if possible, or spawn a follow-up child when unavailable." })),
	contextMode: Type.Optional(StringEnum(["fresh", "summary", "last_n_turns", "full_sanitized"] as const, { description: "Sanitized context mode for a spawned follow-up. Defaults to summary." })),
	model: Type.Optional(Type.String({ description: "Explicit model override for spawned follow-up agents. Defaults to the original child model." })),
	thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Explicit thinking level override for spawned follow-up agents. Defaults to the original child thinking level." })),
});

export function registerFollowupTaskTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "followup_task",
		label: "Follow-up Task",
		description: "Give an existing subagent additional work. Uses RPC follow_up/prompt when live, or can spawn a follow-up child.",
		promptSnippet: "Assign follow-up work to an existing subagent",
		promptGuidelines: ["Use followup_task instead of spawn_agent when the new task depends on an existing subagent's result or context."],
		parameters: FollowupTaskParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const manager = getManager(ctx);
			const mode = params.mode ?? "live_if_supported";
			let spawnOptions: any = undefined;
			const record = manager.getRecord(params.agentId);
			if (!record) throw new Error(`Unknown agentId: ${params.agentId}`);
			if (mode === "spawn_followup") {
				spawnOptions = {
					contextMode: params.contextMode ?? "summary",
					model: params.model ?? record.actualModel ?? record.model,
					thinkingLevel: (params.thinkingLevel ?? record.actualThinkingLevel ?? record.thinkingLevel) as ThinkingLevel | undefined,
					inheritModelAndThinking: false,
				};
			}
			const result = await manager.followupTask(params.agentId, params.prompt, mode, spawnOptions);
			return textResult(result.message, result);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("followup_task "))}${theme.fg("accent", args.agentId ?? "...")} ${theme.fg("dim", preview(args.prompt, 60))}`, 0, 0);
		},
	});
}
