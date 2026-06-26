import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderAgentSummary } from "../render/renderAgent.ts";
import { type ManagerGetter, textResult } from "./common.ts";

const InterruptAgentParams = Type.Object({
	agentId: Type.String({ description: "Agent id to interrupt." }),
	reason: Type.Optional(Type.String({ description: "Optional interrupt reason." })),
});

export function registerInterruptAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description: "Interrupt and cancel a running subagent, preserving partial output and marking it interrupted.",
		promptSnippet: "Interrupt a running subagent",
		parameters: InterruptAgentParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const record = await getManager(ctx).interruptAgent(params.agentId, params.reason);
			return textResult(`Interrupted ${record.taskPath}.`, record);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("interrupt_agent "))}${theme.fg("accent", args.agentId ?? "...")}`, 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			return result.details ? renderAgentSummary(result.details, theme, expanded) : new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
