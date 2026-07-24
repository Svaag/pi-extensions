import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagerGetter } from "./common.ts";
import { textResult } from "./common.ts";
import { getSubagentRouterAdapter } from "./router.ts";

const RateAgentParams = Type.Object({
	agentId: Type.String({ description: "Completed agent id to rate." }),
	score: Type.Number({ minimum: 0, maximum: 1, description: "User- or validator-provided quality rating from 0 through 1." }),
});

function childAgentId(): string | undefined {
	try {
		const value = process.env.PI_SUBAGENT_POLICY;
		if (!value) return undefined;
		const parsed = JSON.parse(value);
		return typeof parsed?.agentId === "string" ? parsed.agentId : undefined;
	} catch {
		return undefined;
	}
}

export function registerRateAgentTool(pi: ExtensionAPI, getManager: ManagerGetter): void {
	pi.registerTool({
		name: "rate_agent",
		label: "Rate Agent",
		description: "Record a user- or validator-provided quality rating for a completed subagent route. Never invent a rating or let a child rate itself.",
		promptSnippet: "Record an explicit user/validator subagent quality rating",
		promptGuidelines: [
			"Use rate_agent only when the score was explicitly provided by the user or an authorized validator; never infer a score from the agent output.",
			"A child agent must never rate itself.",
		],
		parameters: RateAgentParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const score = Number(params.score);
			if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("rate_agent score must be between 0 and 1.");
			const manager = getManager(ctx);
			const record = manager.getRecord(String(params.agentId));
			if (!record) throw new Error(`Unknown agentId: ${params.agentId}`);
			if (childAgentId() === record.agentId) throw new Error("A child agent cannot rate itself.");
			if (record.status === "queued" || record.status === "running") throw new Error("rate_agent requires a completed agent.");
			const adapter = getSubagentRouterAdapter();
			if (!adapter) throw new Error("The shared model router is unavailable; no rating was recorded.");
			const routeId = record.routeId ?? record.routingDecision?.routeId;
			if (!routeId) throw new Error("This legacy agent has no routeId and cannot be rated.");

			let source: "user" | "validator" = "user";
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Record subagent quality rating?",
					`Agent: ${record.taskPath}\nScore: ${score.toFixed(2)}\n\nOnly confirm a rating supplied by you or an authorized validator.`,
				);
				if (!confirmed) throw new Error("Subagent rating was not confirmed.");
			} else {
				if (!adapter.allowNonInteractiveFeedback) {
					throw new Error("rate_agent is disabled in print/JSON mode. Validator feedback must use the core API unless allowNonInteractiveFeedback is explicitly enabled.");
				}
				source = "validator";
			}
			await adapter.recordQuality(routeId, score, source);
			return textResult(`Recorded ${source} quality score ${score.toFixed(2)} for ${record.taskPath}.`, { agentId: record.agentId, routeId, score, source });
		},
	});
}
