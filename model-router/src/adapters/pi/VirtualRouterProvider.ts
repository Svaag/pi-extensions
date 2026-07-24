import {
	createAssistantMessageEventStream,
	streamSimple,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoutingEngine } from "../../core/ModelRoutingEngine.ts";
import type { RouteDecision, RoutingCandidate, RoutingProfile, ThinkingLevel } from "../../core/types.ts";
import { PiModelSource, type PiModelLike, type PiModelRegistryLike } from "./PiModelSource.ts";

const PROVIDER = "model-router";
const PROFILE_BY_MODEL: Record<string, RoutingProfile> = {
	balanced: "balanced",
	quality: "quality_first",
	cost: "cost_first",
	latency: "latency_first",
};

export interface VirtualRouterRuntime {
	engine: ModelRoutingEngine;
	modelSource: PiModelSource;
	context: ExtensionContext;
}

export interface VirtualRouterProviderController {
	resetSession(): void;
}

export type VirtualRouterRuntimeGetter = () => VirtualRouterRuntime | undefined;

export interface VirtualRouterProviderOptions {
	delegate?: typeof streamSimple;
}

function splitRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 && slash < ref.length - 1 ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) } : undefined;
}

function contextText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index] as any;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
	}
	return "";
}

function estimateContextTokens(context: Context): number {
	let characters = context.systemPrompt?.length ?? 0;
	for (const message of context.messages as any[]) {
		if (typeof message.content === "string") characters += message.content.length;
		else if (Array.isArray(message.content)) {
			for (const part of message.content) characters += typeof part?.text === "string" ? part.text.length : typeof part?.thinking === "string" ? part.thinking.length : 0;
		}
	}
	return Math.max(1_000, Math.ceil(characters / 4));
}

function hasImages(context: Context): boolean {
	return (context.messages as any[]).some((message) => Array.isArray(message.content) && message.content.some((part: any) => part?.type === "image"));
}

function isVisibleContent(event: AssistantMessageEvent): boolean {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end";
}

function finalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function usageObservation(decision: RouteDecision, message: AssistantMessage | undefined, startedAt: number, firstContentAt: number | undefined, outcome: "succeeded" | "failed") {
	const usage = message?.usage;
	return {
		routeId: decision.routeId,
		outcome,
		failureDomain: outcome === "failed" ? "provider" as const : undefined,
		latencyMs: Math.max(0, Date.now() - startedAt),
		firstTokenMs: firstContentAt === undefined ? undefined : Math.max(0, firstContentAt - startedAt),
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		cacheReadTokens: usage?.cacheRead,
		cacheWriteTokens: usage?.cacheWrite,
		costUsd: usage?.cost?.total,
		providerRequests: 1,
	};
}

function errorMessage(model: Model<Api>, reason: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: reason,
		timestamp: Date.now(),
	};
}

export function registerVirtualRouterProvider(pi: ExtensionAPI, getRuntime: VirtualRouterRuntimeGetter, options: VirtualRouterProviderOptions = {}): VirtualRouterProviderController {
	let cacheAffinityModel: string | undefined;
	const delegate = options.delegate ?? streamSimple;

	const stream = (routerModel: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			const runtime = getRuntime();
			if (!runtime) {
				outer.push({ type: "error", reason: "error", error: errorMessage(routerModel, "model_router_not_initialized") });
				outer.end();
				return;
			}
			const profile = PROFILE_BY_MODEL[routerModel.id] ?? "balanced";
			let snapshot;
			try {
				snapshot = await runtime.modelSource.snapshot({
					cwd: runtime.context.cwd,
					projectTrusted: runtime.context.isProjectTrusted(),
					modelRegistry: runtime.context.modelRegistry as unknown as PiModelRegistryLike,
				});
			} catch {
				outer.push({ type: "error", reason: "error", error: errorMessage(routerModel, "model_router_candidate_discovery_failed") });
				outer.end();
				return;
			}
			let remaining: RoutingCandidate[] = [...snapshot.candidates];
			const attempts = Math.max(1, runtime.engine.config.virtualProvider.maxFallbacksBeforeOutput + 1);
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				let decision: RouteDecision;
				try {
					decision = await runtime.engine.route({
						host: "pi_provider_request",
						granularity: "request",
						projectKey: runtime.context.cwd,
						prompt: contextText(context),
						tools: context.tools?.map((tool) => tool.name),
						modality: hasImages(context) ? "image" : "text",
						estimatedContextTokens: estimateContextTokens(context),
						candidates: remaining,
						profile,
						forceMode: "auto",
						explicitThinkingLevel: options?.reasoning as ThinkingLevel | undefined,
						cacheAffinityModel,
					});
				} catch {
					outer.push({ type: "error", reason: "error", error: errorMessage(routerModel, "model_router_decision_failed") });
					outer.end();
					return;
				}
				const selected = decision.selectedModel && splitRef(decision.selectedModel);
				const target = selected ? (runtime.context.modelRegistry as unknown as PiModelRegistryLike).find(selected.provider, selected.id) : undefined;
				if (!target || !decision.selectedModel) {
					outer.push({ type: "error", reason: "error", error: errorMessage(routerModel, "model_router_no_safe_candidate") });
					outer.end();
					return;
				}
				let auth;
				try { auth = await (runtime.context.modelRegistry as unknown as PiModelRegistryLike).getApiKeyAndHeaders(target); }
				catch { auth = { ok: false }; }
				if (!auth.ok) {
					runtime.engine.recordFallback(decision, "provider", "failed");
					await runtime.engine.observe({ routeId: decision.routeId, outcome: "failed", failureDomain: "provider", providerRequests: 1 });
					remaining = remaining.filter((candidate) => `${candidate.provider}/${candidate.id}` !== decision.selectedModel);
					continue;
				}

				const startedAt = Date.now();
				let firstContentAt: number | undefined;
				let visible = false;
				let terminal: AssistantMessageEvent | undefined;
				const buffered: AssistantMessageEvent[] = [];
				try {
					const selectedReasoning = decision.selectedThinkingLevel === "off" ? undefined : decision.selectedThinkingLevel;
					const inner = delegate(target as Model<Api>, context, { ...options, apiKey: auth.apiKey ?? "", headers: auth.headers, env: auth.env, reasoning: (selectedReasoning ?? options?.reasoning) as any });
					for await (const event of inner) {
						if (isVisibleContent(event) && !visible) {
							visible = true;
							firstContentAt = Date.now();
							for (const pending of buffered) outer.push(pending);
							buffered.length = 0;
						}
						if (event.type === "done" || event.type === "error") terminal = event;
						if (visible) outer.push(event); else buffered.push(event);
					}
				} catch {
					terminal = undefined;
				}
				const failed = !terminal || terminal.type === "error";
				if (failed && !visible && attempt + 1 < attempts) {
					runtime.engine.recordFallback(decision, "pre_output", "failed");
					await runtime.engine.observe(usageObservation(decision, terminal ? finalMessage(terminal) : undefined, startedAt, firstContentAt, "failed"));
					remaining = remaining.filter((candidate) => `${candidate.provider}/${candidate.id}` !== decision.selectedModel);
					continue;
				}
				if (!visible) for (const pending of buffered) outer.push(pending);
				await runtime.engine.observe(usageObservation(decision, terminal ? finalMessage(terminal) : undefined, startedAt, firstContentAt, failed ? "failed" : "succeeded"));
				if (attempt > 0) runtime.engine.recordFallback(decision, "pre_output", failed ? "failed" : "succeeded");
				if (!failed) cacheAffinityModel = decision.selectedModel;
				if (!terminal) outer.push({ type: "error", reason: "error", error: errorMessage(target as Model<Api>, "model_router_upstream_failed") });
				outer.end();
				return;
			}
			outer.push({ type: "error", reason: "error", error: errorMessage(routerModel, "model_router_fallback_exhausted") });
			outer.end();
		})();
		return outer;
	};

	pi.registerProvider(PROVIDER, {
		name: "Pi Model Router",
		baseUrl: "http://127.0.0.1/model-router",
		apiKey: "router-local",
		api: "model-router-routing" as any,
		models: [
			{ id: "balanced", name: "Router · Balanced", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
			{ id: "quality", name: "Router · Quality", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
			{ id: "cost", name: "Router · Cost", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
			{ id: "latency", name: "Router · Latency", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
		],
		streamSimple: stream as any,
	});

	return { resetSession() { cacheAffinityModel = undefined; } };
}
