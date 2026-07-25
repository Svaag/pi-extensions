import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterConfig } from "../../config/schema.ts";
import { assessTaskComplexity, classifyTaskIntent } from "../../core/features.ts";
import type { ModelRoutingEngine } from "../../core/ModelRoutingEngine.ts";
import type {
	ComplexityAssessment,
	ComplexityTier,
	FailureDomain,
	IntentClassification,
	RouteDecision,
	RouteForceMode,
	RouteObservation,
	RouteOutcome,
	RouteRequest,
	RoutingCandidate,
	RoutingProfile,
	ThinkingLevel,
} from "../../core/types.ts";
import { PiModelSource, piModelRef, type PiModelLike, type PiModelRegistryLike, type PiModelSnapshot } from "../pi/PiModelSource.ts";

export type LegacySubagentRoutingMode = "auto" | "off" | "explain";
export type LegacySubagentRoutingProfile = RoutingProfile;

export interface LegacySubagentCandidateScore {
	model: string;
	score: number;
	estimatedCostUsd: number;
	quality: number;
	notes: string[];
}

/**
 * The promoted Subagent extension persists this shape in session entries.  New
 * shared-router fields are optional so old entries remain readable.
 */
export interface LegacySubagentRoutingDecision {
	mode: LegacySubagentRoutingMode;
	objective: LegacySubagentRoutingProfile;
	applied: boolean;
	reason: string;
	selectedModel?: string;
	selectedThinkingLevel?: ThinkingLevel;
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	intent: string;
	risk: number;
	complexity: number;
	complexityTier: ComplexityTier;
	complexityScore: number;
	confidence: number;
	classificationReason: string;
	signals: string[];
	classifierUsed?: boolean;
	classifierModel?: string;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	explanation: string;
	candidates: LegacySubagentCandidateScore[];
	routeId?: string;
	batchDecisionId?: string;
	policyVersion?: string;
	baselineModel?: string;
	baselineThinkingLevel?: ThinkingLevel;
	rolloutStage?: RouteDecision["stage"];
	arm?: RouteDecision["arm"];
	executedModel?: string;
	executedThinkingLevel?: ThinkingLevel;
	failureDomain?: FailureDomain;
}

export interface SubagentBatchTaskInput {
	source?: string;
	sourceType?: string;
	itemCount?: number;
	rowCount?: number;
	samplePrompts?: string[];
}

export interface SubagentRouteRequest {
	cwd: string;
	projectTrusted?: boolean;
	modelRegistry?: PiModelRegistryLike;
	currentModel?: PiModelLike;
	currentThinkingLevel?: ThinkingLevel;
	taskName: string;
	prompt: string;
	agentName?: string;
	agentDefinition?: string;
	contextSummary?: string;
	contextMode?: string;
	writeMode?: string;
	tools?: string[];
	modality?: "text" | "image";
	batch?: SubagentBatchTaskInput;
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	routingMode?: LegacySubagentRoutingMode;
	routingProfile?: LegacySubagentRoutingProfile;
}

export interface SubagentRouteResult {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	decision: LegacySubagentRoutingDecision;
	classification: IntentClassification;
	complexity: ComplexityAssessment;
	/** Compatibility field. Candidate metadata is intentionally prompt-free. */
	profiles: Array<{ ref: string; model: RoutingCandidate; profile: { ref: string; quality: number; speed: number; notes: string[] } }>;
}

export interface SubagentModelSource {
	snapshot(request: { cwd: string; projectTrusted: boolean; modelRegistry: PiModelRegistryLike }): Promise<PiModelSnapshot>;
}

export interface SubagentRouterAdapterOptions {
	engine: ModelRoutingEngine;
	config?: RouterConfig;
	modelSource?: SubagentModelSource;
	newRouteId?: () => string;
	allowNonInteractiveFeedback?: boolean;
}

export interface SubagentTerminalObservation {
	routeId?: string;
	outcome: RouteOutcome;
	failureDomain?: FailureDomain;
	completedAt?: number;
	latencyMs?: number;
	firstTokenMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	providerRequests?: number;
	toolCalls?: number;
	contextOverflow?: boolean;
}

export interface ForkBatchRouteOptions {
	/** Used only to force uniqueness; it is never persisted as router metadata. */
	requestId?: string;
}

function currentModelRef(model: PiModelLike | undefined): string | undefined {
	return model?.id ? piModelRef(model) : undefined;
}

function forceMode(mode: LegacySubagentRoutingMode | undefined): RouteForceMode | undefined {
	if (mode === "off") return "off";
	if (mode === "explain") return "explain";
	return undefined; // "auto" / undefined -> respect rollout stage (shadow = observe only)
}

function normalizedBatch(batch: SubagentBatchTaskInput | undefined): RouteRequest["batch"] {
	if (!batch) return undefined;
	return {
		source: batch.source ?? batch.sourceType,
		itemCount: batch.itemCount ?? batch.rowCount,
		samplePrompts: batch.samplePrompts ? [...batch.samplePrompts] : undefined,
	};
}

function legacyReason(decision: RouteDecision, request: SubagentRouteRequest, candidateCount: number, inherited = false): string {
	if (inherited) return "inherited";
	if (request.explicitThinkingLevel) return "explicit_thinking";
	if (request.explicitModel) return "explicit_model";
	if (request.routingMode === "off") return "disabled";
	if (request.routingMode === "explain") return "explain_only";
	if (candidateCount === 0 && decision.executedModel) return "fallback_current_model";
	if (request.routingMode === undefined && !decision.applied) return "inherited";
	return decision.reason;
}

function toLegacyDecision(
	decision: RouteDecision,
	request: SubagentRouteRequest,
	classification: IntentClassification,
	candidateCount: number,
	options: { inherited?: boolean; batchDecisionId?: string } = {},
): LegacySubagentRoutingDecision {
	return {
		mode: request.routingMode ?? "auto",
		objective: decision.profile,
		applied: decision.applied,
		reason: legacyReason(decision, request, candidateCount, options.inherited),
		selectedModel: decision.selectedModel,
		selectedThinkingLevel: decision.selectedThinkingLevel,
		explicitModel: request.explicitModel,
		explicitThinkingLevel: request.explicitThinkingLevel,
		intent: decision.intent,
		risk: decision.riskScore,
		complexity: classification.complexity,
		complexityTier: decision.complexityTier,
		complexityScore: decision.complexityScore,
		confidence: decision.confidence,
		classificationReason: classification.reason,
		signals: [...classification.signals],
		estimatedInputTokens: decision.estimatedInputTokens,
		estimatedOutputTokens: decision.estimatedOutputTokens,
		explanation: decision.explanation,
		candidates: decision.candidates.map((candidate) => ({
			model: candidate.model,
			score: candidate.score,
			estimatedCostUsd: candidate.estimatedCostUsd ?? 0,
			quality: candidate.quality,
			notes: [...candidate.notes],
		})),
		routeId: decision.routeId,
		batchDecisionId: options.batchDecisionId,
		policyVersion: decision.policyVersion,
		baselineModel: decision.baselineModel,
		baselineThinkingLevel: decision.baselineThinkingLevel,
		rolloutStage: decision.stage,
		arm: decision.arm,
		executedModel: decision.executedModel,
		executedThinkingLevel: decision.executedThinkingLevel,
	};
}

function compatibilityProfiles(snapshot: PiModelSnapshot, decision: RouteDecision): SubagentRouteResult["profiles"] {
	return snapshot.candidates.map((candidate) => {
		const ref = candidate.provider ? `${candidate.provider}/${candidate.id}` : candidate.id;
		const scored = decision.candidates.find((entry) => entry.model === ref);
		return {
			ref,
			model: candidate,
			profile: { ref, quality: scored?.quality ?? 0.5, speed: scored?.speed ?? 0.5, notes: [...(scored?.notes ?? [])] },
		};
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readFeedbackSetting(path: string | undefined): boolean | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return isObject(value) && typeof value.allowNonInteractiveFeedback === "boolean" ? value.allowNonInteractiveFeedback : undefined;
	} catch {
		return undefined;
	}
}

function nearest(cwd: string, filename: string, configDirName: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, configDirName, filename);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Reads the adapter-only feedback authorization without widening the core config schema. */
export function loadSubagentRouterAdapterSettings(
	cwd: string,
	options: { agentDir?: string; configDirName?: string; projectTrusted?: boolean } = {},
): { allowNonInteractiveFeedback: boolean } {
	const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configDirName = options.configDirName ?? ".pi";
	let allowed = false;
	for (const path of [join(agentDir, "subagent-router.json"), join(agentDir, "model-router.json")]) {
		const value = readFeedbackSetting(path);
		if (value !== undefined) allowed = value;
	}
	if (options.projectTrusted) {
		for (const filename of ["subagent-router.json", "model-router.json"]) {
			const value = readFeedbackSetting(nearest(cwd, filename, configDirName));
			if (value !== undefined) allowed = value;
		}
	}
	return { allowNonInteractiveFeedback: allowed };
}

/** Shared-router bridge that keeps the Subagent extension's persisted/API shape stable. */
export class SubagentRouterAdapter {
	readonly allowNonInteractiveFeedback: boolean;
	private readonly engine: ModelRoutingEngine;
	private readonly config: RouterConfig;
	private readonly modelSource: SubagentModelSource;
	private readonly newRouteId: () => string;
	private readonly routeRequests = new Map<string, RouteRequest>();
	private readonly rawDecisions = new Map<string, RouteDecision>();

	constructor(options: SubagentRouterAdapterOptions) {
		this.engine = options.engine;
		this.config = options.config ?? options.engine.config;
		this.modelSource = options.modelSource ?? new PiModelSource();
		this.newRouteId = options.newRouteId ?? randomUUID;
		this.allowNonInteractiveFeedback = options.allowNonInteractiveFeedback ?? false;
	}

	async resolve(request: SubagentRouteRequest): Promise<SubagentRouteResult> {
		return this.routeInternal(request);
	}

	async route(request: SubagentRouteRequest): Promise<SubagentRouteResult> {
		return this.routeInternal(request);
	}

	/** Creates a new learning sample while deliberately retaining model/process choice. */
	async routeInherited(request: SubagentRouteRequest): Promise<SubagentRouteResult> {
		return this.routeInternal({ ...request, routingMode: "off" }, true);
	}

	private async routeInternal(request: SubagentRouteRequest, inherited = false): Promise<SubagentRouteResult> {
		const normalizedInput = {
			taskName: request.taskName,
			prompt: request.prompt,
			agentName: request.agentName,
			agentDefinition: request.agentDefinition,
			contextSummary: request.contextSummary,
			contextMode: request.contextMode,
			writeMode: request.writeMode,
			tools: request.tools,
			modality: request.modality,
			batch: normalizedBatch(request.batch),
		};
		const classification = classifyTaskIntent(normalizedInput);
		const complexity = assessTaskComplexity(normalizedInput, classification, this.config.complexity.thresholds);
		let snapshot: PiModelSnapshot = { candidates: [], modelsByRef: new Map(), patterns: [], warnings: [] };
		if (request.modelRegistry) {
			try {
				snapshot = await this.modelSource.snapshot({
					cwd: request.cwd,
					projectTrusted: Boolean(request.projectTrusted),
					modelRegistry: request.modelRegistry,
				});
			} catch {
				// Discovery failure must retain the explicit/current model.
			}
		}
		const routeRequest: RouteRequest = {
			...normalizedInput,
			host: request.batch ? "subagent_batch" : "subagent",
			granularity: "run",
			projectKey: request.cwd,
			candidates: snapshot.candidates,
			currentModel: currentModelRef(request.currentModel),
			currentThinkingLevel: request.currentThinkingLevel,
			explicitModel: request.explicitModel,
			explicitThinkingLevel: request.explicitThinkingLevel,
			profile: request.routingProfile,
			forceMode: forceMode(request.routingMode),
		};
		try {
			const decision = await this.engine.route(routeRequest);
			this.routeRequests.set(decision.routeId, routeRequest);
			this.rawDecisions.set(decision.routeId, decision);
			return {
				model: decision.executedModel ?? request.explicitModel ?? currentModelRef(request.currentModel),
				thinkingLevel: decision.executedThinkingLevel ?? request.explicitThinkingLevel ?? request.currentThinkingLevel,
				decision: toLegacyDecision(decision, request, classification, snapshot.candidates.length, { inherited }),
				classification,
				complexity,
				profiles: compatibilityProfiles(snapshot, decision),
			};
		} catch {
			const model = request.explicitModel ?? currentModelRef(request.currentModel);
			const thinkingLevel = request.explicitThinkingLevel ?? request.currentThinkingLevel;
			return {
				model,
				thinkingLevel,
				classification,
				complexity,
				profiles: [],
				decision: {
					mode: request.routingMode ?? "auto",
					objective: request.routingProfile ?? this.config.profile,
					applied: false,
					reason: inherited ? "inherited" : "router_error",
					selectedModel: model,
					selectedThinkingLevel: thinkingLevel,
					explicitModel: request.explicitModel,
					explicitThinkingLevel: request.explicitThinkingLevel,
					intent: classification.intent,
					risk: classification.risk,
					complexity: classification.complexity,
					complexityTier: complexity.complexityTier,
					complexityScore: complexity.complexityScore,
					confidence: classification.confidence,
					classificationReason: classification.reason,
					signals: [...classification.signals],
					estimatedInputTokens: 0,
					estimatedOutputTokens: 0,
					explanation: "Shared router resolution failed; retained the explicit/current model.",
					candidates: [],
					baselineModel: model,
					baselineThinkingLevel: thinkingLevel,
					executedModel: model,
					executedThinkingLevel: thinkingLevel,
					failureDomain: "router",
				},
			};
		}
	}

	/**
	 * Materializes a worker-specific decision using the job recommendation as a
	 * hard baseline. Policy selection happened once for the job; this call only
	 * gives the worker an independently observable route.
	 */
	async forkBatchDecision(
		batchDecision: LegacySubagentRoutingDecision,
		options: ForkBatchRouteOptions = {},
	): Promise<LegacySubagentRoutingDecision> {
		const batchDecisionId = batchDecision.batchDecisionId ?? batchDecision.routeId;
		const raw = batchDecision.routeId ? this.rawDecisions.get(batchDecision.routeId) : undefined;
		const original = batchDecision.routeId ? this.routeRequests.get(batchDecision.routeId) : undefined;
		const model = batchDecision.executedModel ?? batchDecision.selectedModel ?? batchDecision.baselineModel;
		const thinking = batchDecision.executedThinkingLevel ?? batchDecision.selectedThinkingLevel ?? batchDecision.baselineThinkingLevel;
		const requestId = options.requestId ?? this.newRouteId();
		const routeRequest: RouteRequest = {
			...(original ?? {
				host: "subagent_batch" as const,
				granularity: "run" as const,
				taskName: "batch-worker",
				prompt: "batch worker",
				candidates: [],
			}),
			requestId,
			host: "subagent_batch",
			currentModel: model,
			currentThinkingLevel: thinking,
			explicitModel: model,
			explicitThinkingLevel: thinking,
			forceMode: "auto",
			metadata: { batchDecisionId: batchDecisionId ? "linked" : undefined },
		};
		try {
			const decision = await this.engine.route(routeRequest);
			this.routeRequests.set(decision.routeId, routeRequest);
			this.rawDecisions.set(decision.routeId, decision);
			const classification = classifyTaskIntent(routeRequest);
			const legacy = toLegacyDecision(decision, {
				cwd: "",
				taskName: routeRequest.taskName ?? "batch-worker",
				prompt: routeRequest.prompt ?? "",
				explicitModel: model,
				explicitThinkingLevel: thinking,
				routingMode: batchDecision.mode,
				routingProfile: batchDecision.objective,
			}, classification, routeRequest.candidates.length, { batchDecisionId });
			// The worker is part of the job's rollout arm even though its bookkeeping
			// route is forced to retain the route-once model choice.
			legacy.arm = batchDecision.arm ?? raw?.arm ?? legacy.arm;
			legacy.rolloutStage = batchDecision.rolloutStage ?? raw?.stage ?? legacy.rolloutStage;
			legacy.reason = batchDecision.reason;
			return legacy;
		} catch {
			return {
				...batchDecision,
				routeId: requestId,
				batchDecisionId,
				failureDomain: "router",
				reason: "router_error",
			};
		}
	}

	async observeTerminal(observation: SubagentTerminalObservation): Promise<void> {
		if (!observation.routeId) return;
		const routeObservation: RouteObservation = {
			routeId: observation.routeId,
			outcome: observation.outcome,
			failureDomain: observation.failureDomain,
			completedAt: observation.completedAt,
			latencyMs: observation.latencyMs,
			firstTokenMs: observation.firstTokenMs,
			inputTokens: observation.inputTokens,
			outputTokens: observation.outputTokens,
			cacheReadTokens: observation.cacheReadTokens,
			cacheWriteTokens: observation.cacheWriteTokens,
			costUsd: observation.costUsd,
			providerRequests: observation.providerRequests,
			toolCalls: observation.toolCalls,
			contextOverflow: observation.contextOverflow,
		};
		await this.engine.observe(routeObservation);
	}

	async recordQuality(routeId: string, score: number, source: "user" | "validator" = "user"): Promise<void> {
		await this.engine.recordQuality(routeId, score, source);
	}

	async getDecision(routeId: string): Promise<RouteDecision | undefined> {
		return this.engine.getDecision(routeId);
	}
}
