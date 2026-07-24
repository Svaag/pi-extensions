import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderAgentSummary } from "../render/renderAgent.ts";
import { type ManagerGetter, textResult } from "./common.ts";

const CloseAgentParams = Type.Object({
	agentId: Type.String({ description: "Agent id to close." }),
	deleteState: Type.Optional(Type.Boolean({ description: "Reserved. History is not deleted in the MVP." })),
});

export function registerCloseAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "close_agent",
		label: "Close Agent",
		description: "Close a subagent, release its process resources, and preserve history/state.",
		promptSnippet: "Close a subagent when no longer needed",
		promptGuidelines: ["Use close_agent after integrating a subagent result so idle child processes do not linger."],
		parameters: CloseAgentParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			if (params.deleteState) throw new Error("deleteState is not supported in the MVP; subagent history is preserved.");
			const record = await getManager(ctx).closeAgent(params.agentId, "closed by parent");
			return textResult(`Closed ${record.taskPath}.`, record);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("close_agent "))}${theme.fg("accent", args.agentId ?? "...")}`, 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			return result.details ? renderAgentSummary(result.details, theme, expanded) : new Text(result.content?.[0]?.text ?? "", 0, 0);
		},
	});
}
