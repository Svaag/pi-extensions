import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RoutingMode, RoutingObjective, ThinkingLevel } from "../core/AgentTypes.ts";
import { type ManagerGetter, preview, textResult } from "./common.ts";
import { resolveRouting } from "./router.ts";

const FollowupTaskParams = Type.Object({
	agentId: Type.String({ description: "Target agent id." }),
	prompt: Type.String({ description: "Follow-up task prompt." }),
	mode: Type.Optional(StringEnum(["live_if_supported", "spawn_followup"] as const, { description: "Use the live child if possible, or spawn a follow-up child when unavailable." })),
	contextMode: Type.Optional(StringEnum(["fresh", "summary", "last_n_turns", "full_sanitized"] as const, { description: "Reserved for spawned follow-up context." })),
	spawnRoutingMode: Type.Optional(StringEnum(["inherit", "auto", "off", "explain"] as const, { description: "For mode=spawn_followup: inherit the original model/thinking, reroute, disable routing, or explain only. Defaults to inherit." })),
	routingProfile: Type.Optional(StringEnum(["balanced", "cost_first", "quality_first"] as const, { description: "Router objective for spawned follow-up rerouting." })),
	model: Type.Optional(Type.String({ description: "Explicit model override for spawned follow-up agents." })),
	thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Explicit thinking level override for spawned follow-up agents." })),
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
			if (mode === "spawn_followup") {
				const record = manager.getRecord(params.agentId);
				if (!record) throw new Error(`Unknown agentId: ${params.agentId}`);
				const contextMode = params.contextMode ?? "summary";
				const spawnRoutingMode = params.spawnRoutingMode ?? "inherit";
				if (spawnRoutingMode === "inherit") {
					spawnOptions = {
						contextMode,
						model: params.model,
						thinkingLevel: params.thinkingLevel as ThinkingLevel | undefined,
						inheritModelAndThinking: true,
					};
				} else {
					const routed = await resolveRouting(ctx, {
						taskName: `${record.taskName}-followup`,
						prompt: params.prompt,
						contextSummary: record.result?.summary ?? record.outputTail,
						contextMode,
						writeMode: record.writeMode,
						tools: record.tools,
						explicitModel: params.model,
						explicitThinkingLevel: params.thinkingLevel as ThinkingLevel | undefined,
						routingMode: spawnRoutingMode as RoutingMode,
						routingProfile: params.routingProfile as RoutingObjective | undefined,
					});
					spawnOptions = {
						contextMode,
						model: routed.model,
						thinkingLevel: routed.thinkingLevel,
						routingMode: spawnRoutingMode as RoutingMode,
						routingProfile: params.routingProfile as RoutingObjective | undefined,
						routingDecision: routed.decision,
						inheritModelAndThinking: false,
					};
				}
			}
			const result = await manager.followupTask(params.agentId, params.prompt, mode, spawnOptions);
			return textResult(result.message, result);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("followup_task "))}${theme.fg("accent", args.agentId ?? "...")} ${theme.fg("dim", preview(args.prompt, 60))}`, 0, 0);
		},
	});
}
