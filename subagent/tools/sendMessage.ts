import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ManagerGetter, preview, textResult } from "./common.ts";

const SendMessageParams = Type.Object({
	agentId: Type.String({ description: "Target agent id." }),
	content: Type.String({ description: "Message content." }),
	kind: Type.Optional(StringEnum(["message", "correction", "constraint", "note"] as const, { description: "Message kind." })),
});

export function registerSendMessageTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description: "Send a mailbox message to a running subagent. If live steering is unavailable, records an honest mailbox-only event.",
		promptSnippet: "Send a steering/message note to a live subagent",
		promptGuidelines: ["Use send_message for lightweight steering of a running subagent; use followup_task when the message should trigger additional work."],
		parameters: SendMessageParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const result = await getManager(ctx).sendMessage(params.agentId, params.content, params.kind ?? "message");
			return textResult(result.message, result);
		},
		renderCall(args: any, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("send_message "))}${theme.fg("accent", args.agentId ?? "...")} ${theme.fg("dim", preview(args.content, 60))}`, 0, 0);
		},
	});
}
