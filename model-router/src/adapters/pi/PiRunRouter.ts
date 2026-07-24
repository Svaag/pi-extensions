import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QualityJudge } from "../../judge/QualityJudge.ts";
import { classifyTaskIntent } from "../../core/features.ts";
import { ModelRoutingEngine } from "../../core/ModelRoutingEngine.ts";
import type {
	FailureDomain,
	RouteDecision,
	RouteObservation,
	RouteOutcome,
	RouterStatus,
	RoutingProfile,
	ThinkingLevel,
} from "../../core/types.ts";
import { PiModelSource, piModelRef, type PiModelLike } from "./PiModelSource.ts";
import {
	OBSERVATION_ENTRY_TYPE,
	PREFERENCES_ENTRY_TYPE,
	ROUTE_ENTRY_TYPE,
	formatDecision,
	privacySafeRouteEntry,
	updateRouterStatus,
	type PiObservationEntryData,
	type PiPreferencesEntryData,
} from "./rendering.ts";

export type PiRouterMode = "off" | "managed" | "shadow";

export interface PiRunRouterOptions {
	pi: ExtensionAPI;
	engine: ModelRoutingEngine;
	modelSource: PiModelSource;
	mode?: PiRouterMode;
	profile?: RoutingProfile;
	judge?: QualityJudge;
	startupWarnings?: readonly string[];
}

interface NumericTotals {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}

interface ActiveRun extends NumericTotals {
	decision: RouteDecision;
	startedAt: number;
	firstDeltaAt?: number;
	providerRequests: number;
	toolCalls: number;
	toolErrors: number;
	lastStopReason?: string;
	contextOverflow: boolean;
	assistantMessages: Set<string>;
	promptForJudge: string;
	outputForJudge: string;
	sensitive: boolean;
}

interface AssistantLike {
	role?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	content?: Array<{ type?: string; text?: string }>;
}

const ROUTING_PROFILES: readonly RoutingProfile[] = ["balanced", "quality_first", "cost_first", "latency_first"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SUPPRESSION_WINDOW_MS = 5_000;

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function add(current: number | undefined, value: unknown): number | undefined {
	const number = finite(value);
	return number === undefined ? current : (current ?? 0) + number;
}

function modelRef(model: PiModelLike | undefined): string | undefined {
	return model ? piModelRef(model) : undefined;
}

function assistantKey(message: AssistantLike): string {
	return `${message.provider ?? ""}/${message.model ?? ""}/${message.timestamp ?? ""}/${message.stopReason ?? ""}`;
}

function assistantText(message: AssistantLike): string {
	return (message.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function outcomeFor(run: ActiveRun): { outcome: RouteOutcome; failureDomain?: FailureDomain } {
	switch (run.lastStopReason) {
		case "error": return { outcome: "failed", failureDomain: run.contextOverflow ? "model" : "provider" };
		case "aborted": return { outcome: "cancelled", failureDomain: "user" };
		case "toolUse":
			if (run.toolErrors > 0) return { outcome: "failed", failureDomain: "tool" };
			return { outcome: "succeeded" };
		default:
			if (run.providerRequests === 0) return { outcome: "failed", failureDomain: run.toolErrors > 0 ? "tool" : "host" };
			return { outcome: "succeeded" };
	}
}

export class PiRunRouter {
	readonly engine: ModelRoutingEngine;
	readonly modelSource: PiModelSource;
	private readonly pi: ExtensionAPI;
	private readonly judge?: QualityJudge;
	private readonly startupWarnings: string[];
	private mode: PiRouterMode;
	private profile: RoutingProfile;
	private modelPin?: string;
	private thinkingPin?: ThinkingLevel;
	private active?: ActiveRun;
	private latestSettledRouteId?: string;
	private currentContext?: ExtensionContext;
	private restoring = true;
	private applyingRouterModel = false;
	private closed = false;
	private suppressedModels = new Map<string, number>();
	private suppressedThinking = new Map<ThinkingLevel, number>();
	private pendingJudge = new Set<Promise<void>>();

	constructor(options: PiRunRouterOptions) {
		this.pi = options.pi;
		this.engine = options.engine;
		this.modelSource = options.modelSource;
		this.mode = options.mode ?? "managed";
		this.profile = options.profile ?? options.engine.config.profile;
		this.judge = options.judge;
		this.startupWarnings = [...(options.startupWarnings ?? [])];
	}

	getMode(): PiRouterMode { return this.mode; }
	getProfile(): RoutingProfile { return this.profile; }
	getModelPin(): string | undefined { return this.modelPin; }
	getThinkingPin(): ThinkingLevel | undefined { return this.thinkingPin; }
	getLatestSettledRouteId(): string | undefined { return this.latestSettledRouteId; }
	getWarnings(): readonly string[] { return this.startupWarnings; }

	onSessionStart(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		this.restorePreferences(ctx);
		this.restoring = true;
		queueMicrotask(() => { this.restoring = false; });
		this.refreshFooter(ctx);
	}

	async beforeAgentStart(event: { prompt?: string; images?: unknown[] }, ctx: ExtensionContext): Promise<void> {
		if (this.closed) return;
		this.currentContext = ctx;
		if (this.active) await this.finalize("aborted", "host");
		const startedAt = Date.now();
		let snapshot;
		try {
			snapshot = await this.modelSource.snapshot({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				modelRegistry: ctx.modelRegistry as unknown as import("./PiModelSource.ts").PiModelRegistryLike,
			});
		} catch {
			this.addWarning("model_discovery_failed");
			return;
		}
		for (const warning of snapshot.warnings) this.addWarning(warning);
		const currentModel = modelRef(ctx.model as PiModelLike | undefined);
		if (currentModel?.startsWith("model-router/")) {
			updateRouterStatus(ctx, `router request/${currentModel.slice("model-router/".length)}`);
			return;
		}
		const currentThinking = THINKING_LEVELS.includes(ctx.thinkingLevel as ThinkingLevel) ? ctx.thinkingLevel as ThinkingLevel : undefined;
		let decision: RouteDecision;
		try {
			decision = await this.engine.route({
				host: "pi_run",
				granularity: "run",
				projectKey: ctx.cwd,
				prompt: event.prompt,
				tools: this.pi.getActiveTools(),
				modality: (event.images?.length ?? 0) > 0 ? "image" : "text",
				estimatedContextTokens: ctx.getContextUsage()?.tokens ?? undefined,
				candidates: snapshot.candidates,
				currentModel,
				currentThinkingLevel: currentThinking,
				explicitModel: this.modelPin,
				explicitThinkingLevel: this.thinkingPin,
				profile: this.profile,
				forceMode: this.mode === "off" ? "off" : this.mode === "shadow" ? "explain" : undefined,
			});
		} catch {
			this.addWarning("routing_failed");
			return;
		}

		if (decision.applied && decision.selectedModel) {
			const selected = snapshot.modelsByRef.get(decision.selectedModel);
			if (selected) {
				const applied = await this.applyDecision(selected, decision.selectedThinkingLevel, ctx);
				if (!applied) {
					// The persisted decision cannot be amended through Pi's public API.
					// Leave it unobserved rather than attributing this run to the wrong model.
					this.appendEntry(ROUTE_ENTRY_TYPE, privacySafeRouteEntry(decision));
					updateRouterStatus(ctx, "router retained current model · application failed");
					return;
				}
			} else if (decision.selectedModel !== currentModel) {
				this.addWarning("selected_model_not_resolved");
				this.appendEntry(ROUTE_ENTRY_TYPE, privacySafeRouteEntry(decision));
				return;
			}
		}

		const prompt = event.prompt ?? "";
		const classification = classifyTaskIntent({ prompt, modality: (event.images?.length ?? 0) > 0 ? "image" : "text" });
		this.active = {
			decision,
			startedAt,
			providerRequests: 0,
			toolCalls: 0,
			toolErrors: 0,
			contextOverflow: false,
			assistantMessages: new Set<string>(),
			promptForJudge: prompt.slice(0, this.engine.config.judge.maxPromptChars),
			outputForJudge: "",
			sensitive: classification.sensitive,
		};
		this.appendEntry(ROUTE_ENTRY_TYPE, privacySafeRouteEntry(decision));
		updateRouterStatus(ctx, formatDecision(decision));
	}

	onMessageUpdate(event: { message?: AssistantLike; assistantMessageEvent?: { type?: string } }): void {
		if (!this.active || this.active.firstDeltaAt !== undefined || event.message?.role !== "assistant") return;
		const type = event.assistantMessageEvent?.type ?? "";
		if (type.endsWith("_delta")) this.active.firstDeltaAt = Date.now();
	}

	onTurnEnd(event: { message?: AssistantLike }): void {
		if (!this.active || !event.message || event.message.role !== "assistant") return;
		this.consumeAssistant(event.message);
	}

	onAgentEnd(event: { messages?: AssistantLike[] }): void {
		if (!this.active) return;
		for (const message of event.messages ?? []) {
			if (message.role === "assistant") this.consumeAssistant(message);
		}
	}

	onToolExecutionStart(): void {
		if (this.active) this.active.toolCalls += 1;
	}

	onToolExecutionEnd(event: { isError?: boolean }): void {
		if (this.active && event.isError) this.active.toolErrors += 1;
	}

	async onAgentSettled(): Promise<void> {
		await this.finalize();
	}

	/*
	 * model_select labels both user `set` changes and pi.setModel() as `set`,
	 * while thinking_level_select has no provenance at all. Exact-target,
	 * expiring suppression plus a restore window is therefore heuristic. A very
	 * delayed/reordered third-party model change can conservatively create a pin;
	 * /router unpin is the bounded recovery and the router never overrides it.
	 */
	onModelSelect(model: PiModelLike, source: string): void {
		const ref = piModelRef(model);
		if (source === "restore" || this.restoring || this.consumeSuppression(this.suppressedModels, ref)) return;
		this.modelPin = ref;
		this.persistPreferences();
	}

	onThinkingLevelSelect(level: ThinkingLevel): void {
		if (this.restoring || this.applyingRouterModel || this.consumeSuppression(this.suppressedThinking, level)) return;
		this.thinkingPin = level;
		this.persistPreferences();
	}

	pinCurrent(ctx: ExtensionContext): void {
		this.modelPin = modelRef(ctx.model as PiModelLike | undefined);
		const thinking = ctx.thinkingLevel as ThinkingLevel;
		this.thinkingPin = THINKING_LEVELS.includes(thinking) ? thinking : undefined;
		this.persistPreferences();
		this.refreshFooter(ctx);
	}

	unpin(ctx?: ExtensionContext): void {
		this.modelPin = undefined;
		this.thinkingPin = undefined;
		this.persistPreferences();
		if (ctx) this.refreshFooter(ctx);
	}

	setProfile(profile: RoutingProfile, ctx?: ExtensionContext): boolean {
		if (!ROUTING_PROFILES.includes(profile)) return false;
		this.profile = profile;
		this.persistPreferences();
		if (ctx) this.refreshFooter(ctx);
		return true;
	}

	async status(): Promise<RouterStatus> {
		return this.engine.getStatus();
	}

	async recordFeedback(score: number, routeId?: string): Promise<string | undefined> {
		const target = routeId ?? this.latestSettledRouteId;
		if (!target || !Number.isFinite(score) || score < 0 || score > 1) return undefined;
		const decision = await this.engine.getDecision(target);
		if (!decision) return undefined;
		await this.engine.recordQuality(target, score, "user");
		return target;
	}

	async resetRollout(): Promise<void> {
		await this.engine.resetRollout({ host: "pi_run", granularity: "run", profile: this.profile });
	}

	async close(reason: "quit" | "reload" | "new" | "resume" | "fork" | string = "quit"): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.active) {
			const failureDomain: FailureDomain = reason === "reload" ? "host" : "user";
			await this.finalize("aborted", failureDomain);
		}
		if (this.pendingJudge.size > 0) await Promise.allSettled([...this.pendingJudge]);
		this.pendingJudge.clear();
		this.suppressedModels.clear();
		this.suppressedThinking.clear();
		if (this.currentContext) updateRouterStatus(this.currentContext, undefined);
		this.currentContext = undefined;
		await this.engine.close();
	}

	private async applyDecision(model: PiModelLike, thinking: ThinkingLevel | undefined, ctx: ExtensionContext): Promise<boolean> {
		const target = piModelRef(model);
		const current = modelRef(ctx.model as PiModelLike | undefined);
		this.applyingRouterModel = true;
		try {
			if (current !== target) {
				this.suppressedModels.set(target, Date.now() + SUPPRESSION_WINDOW_MS);
				const applied = await this.pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
				if (!applied) {
					this.suppressedModels.delete(target);
					this.addWarning("model_application_failed");
					return false;
				}
			}
			if (thinking && this.pi.getThinkingLevel() !== thinking) {
				this.suppressedThinking.set(thinking, Date.now() + SUPPRESSION_WINDOW_MS);
				this.pi.setThinkingLevel(thinking);
			}
			return true;
		} catch {
			this.suppressedModels.delete(target);
			this.addWarning("model_application_failed");
			return false;
		} finally {
			queueMicrotask(() => { this.applyingRouterModel = false; });
		}
	}

	private consumeAssistant(message: AssistantLike): void {
		const run = this.active;
		if (!run) return;
		const key = assistantKey(message);
		if (run.assistantMessages.has(key)) return;
		run.assistantMessages.add(key);
		run.providerRequests += 1;
		run.lastStopReason = message.stopReason ?? run.lastStopReason;
		if (message.errorMessage && /context.*(?:length|window|token)|too many tokens|prompt too long/i.test(message.errorMessage)) {
			run.contextOverflow = true;
		}
		const usage = message.usage;
		if (usage) {
			run.inputTokens = add(run.inputTokens, usage.input);
			run.outputTokens = add(run.outputTokens, usage.output);
			run.cacheReadTokens = add(run.cacheReadTokens, usage.cacheRead);
			run.cacheWriteTokens = add(run.cacheWriteTokens, usage.cacheWrite);
			run.costUsd = add(run.costUsd, usage.cost?.total);
		}
		const text = assistantText(message);
		if (text) run.outputForJudge = text.slice(0, this.engine.config.judge.maxOutputChars);
	}

	private async finalize(forcedOutcome?: RouteOutcome, forcedDomain?: FailureDomain): Promise<void> {
		const run = this.active;
		if (!run) return;
		this.active = undefined;
		const terminal = forcedOutcome ? { outcome: forcedOutcome, failureDomain: forcedDomain } : outcomeFor(run);
		const completedAt = Date.now();
		const observation: RouteObservation = {
			routeId: run.decision.routeId,
			completedAt,
			outcome: terminal.outcome,
			failureDomain: terminal.failureDomain,
			latencyMs: Math.max(0, completedAt - run.startedAt),
			firstTokenMs: run.firstDeltaAt === undefined ? undefined : Math.max(0, run.firstDeltaAt - run.startedAt),
			inputTokens: run.inputTokens,
			outputTokens: run.outputTokens,
			cacheReadTokens: run.cacheReadTokens,
			cacheWriteTokens: run.cacheWriteTokens,
			costUsd: run.costUsd,
			providerRequests: run.providerRequests,
			toolCalls: run.toolCalls,
			contextOverflow: run.contextOverflow || undefined,
		};
		try {
			await this.engine.observe(observation);
		} catch {
			this.addWarning("observation_failed");
		}
		this.latestSettledRouteId = run.decision.routeId;
		const entry: PiObservationEntryData = {
			schemaVersion: 1,
			routeId: run.decision.routeId,
			completedAt,
			outcome: observation.outcome,
			latencyMs: observation.latencyMs,
			providerRequests: run.providerRequests,
			toolCalls: run.toolCalls,
			toolErrors: run.toolErrors,
		};
		this.appendEntry(OBSERVATION_ENTRY_TYPE, entry);
		if (this.currentContext) this.refreshFooter(this.currentContext);
		if (observation.outcome === "succeeded") this.scheduleJudge(run);
	}

	private scheduleJudge(run: ActiveRun): void {
		if (!this.judge || !run.outputForJudge) return;
		let pending: Promise<void>;
		pending = this.judge.evaluate({
			routeId: run.decision.routeId,
			evaluatedModel: run.decision.executedModel ?? run.decision.baselineModel ?? "unknown",
			complexityTier: run.decision.complexityTier,
			sensitive: run.sensitive,
			prompt: run.promptForJudge,
			output: run.outputForJudge,
		}).then(async (evaluation) => {
			if (!this.closed && evaluation.label) {
				await this.engine.recordQuality(run.decision.routeId, evaluation.label.score, "judge", evaluation.label.weight);
			}
		}).catch(() => {
			this.addWarning("judge_failed");
		}).finally(() => {
			this.pendingJudge.delete(pending);
		});
		this.pendingJudge.add(pending);
	}

	private restorePreferences(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>) {
			if (entry.type !== "custom") continue;
			if (entry.customType === PREFERENCES_ENTRY_TYPE) {
				const data = entry.data as Partial<PiPreferencesEntryData> | undefined;
				this.modelPin = typeof data?.modelPin === "string" ? data.modelPin : undefined;
				this.thinkingPin = data?.thinkingPin && THINKING_LEVELS.includes(data.thinkingPin) ? data.thinkingPin : undefined;
				if (data?.profile && ROUTING_PROFILES.includes(data.profile)) this.profile = data.profile;
			}
			if (entry.customType === OBSERVATION_ENTRY_TYPE) {
				const data = entry.data as Partial<PiObservationEntryData> | undefined;
				if (typeof data?.routeId === "string") this.latestSettledRouteId = data.routeId;
			}
		}
	}

	private persistPreferences(): void {
		const data: PiPreferencesEntryData = {
			schemaVersion: 1,
			modelPin: this.modelPin,
			thinkingPin: this.thinkingPin,
			profile: this.profile,
			updatedAt: Date.now(),
		};
		this.appendEntry(PREFERENCES_ENTRY_TYPE, data);
	}

	private appendEntry(customType: string, data: unknown): void {
		try {
			this.pi.appendEntry(customType, data);
		} catch {
			this.addWarning("session_entry_failed");
		}
	}

	private addWarning(warning: string): void {
		if (!this.startupWarnings.includes(warning)) this.startupWarnings.push(warning);
	}

	private consumeSuppression<T>(map: Map<T, number>, value: T): boolean {
		const expires = map.get(value);
		map.delete(value);
		return expires !== undefined && expires >= Date.now();
	}

	private refreshFooter(ctx: ExtensionContext): void {
		const pin = this.modelPin ? ` · pinned ${this.modelPin}` : "";
		updateRouterStatus(ctx, `router ${this.mode}/${this.profile}${pin}`);
	}
}
