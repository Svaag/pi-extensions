import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { loadRouterConfig } from "../core/RouterConfig.ts";
import {
	parseClassifierDecision,
	routeSubagentModel,
	type DeterministicIntentInput,
	type RouteSubagentResult,
	type RouterClassifier,
} from "../core/SmartRouter.ts";
import type { RoutingMode, RoutingObjective, ThinkingLevel } from "../core/AgentTypes.ts";

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict classifier for Pi subagent model routing.
Return JSON only. Do not include markdown.
Allowed intents: lookup, scout, summarize, batch_simple, plan, review, debug, implement, complex.
Risk, complexity, and confidence must be numbers from 0 to 1.`;

export interface ResolveRoutingOptions extends DeterministicIntentInput {
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
}

function textFromAssistant(response: any): string {
	return (response?.content ?? [])
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

export function isProjectTrustedForRouting(ctx: any): boolean {
	try {
		return typeof ctx.isProjectTrusted === "function" ? Boolean(ctx.isProjectTrusted()) : false;
	} catch {
		return false;
	}
}

export function createRouterClassifier(ctx: any): RouterClassifier {
	return async (input) => {
		const model = input.model.model as any;
		if (!ctx.modelRegistry?.getApiKeyAndHeaders) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) return undefined;
		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: input.prompt }],
			timestamp: Date.now(),
		};
		const response = await complete(
			model,
			{ systemPrompt: CLASSIFIER_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		return parseClassifierDecision(textFromAssistant(response));
	};
}

export async function resolveRouting(ctx: any, options: ResolveRoutingOptions): Promise<RouteSubagentResult> {
	const projectTrusted = isProjectTrustedForRouting(ctx);
	const config = loadRouterConfig(ctx.cwd, { projectTrusted });
	return routeSubagentModel({
		...options,
		cwd: ctx.cwd,
		config,
		modelRegistry: ctx.modelRegistry,
		currentModel: ctx.model,
		projectTrusted,
		classifier: createRouterClassifier(ctx),
	});
}
