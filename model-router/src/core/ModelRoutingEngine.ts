import { createHash, randomUUID } from "node:crypto";
import type { RouterConfig } from "../config/schema.ts";
import { DEFAULT_ROUTER_CONFIG } from "../config/defaults.ts";
import type { RouterStore } from "../storage/RouterStore.ts";
import { rolloutScopeKey } from "../storage/RouterStore.ts";
import { createMetricHistogram, DEFAULT_HISTOGRAM_BOUNDARIES, histogramQuantile, observeMetric } from "../storage/histograms.ts";
import type { RouterTelemetry, RouterTelemetryDimensions } from "../telemetry/RouterTelemetry.ts";
import { sampleBeta, SeededRandom } from "./bandit.ts";
import { applyPreviewDiscount, estimateModelCostUsd, filterConfiguredCandidates, modelRef, profileCandidate, thinkingLevelsFor } from "./candidates.ts";
import { criticalArmHasEvidence, evaluateArmConstraints } from "./constraints.ts";
import { assessTaskComplexity, classifyTaskIntent, cohortKey, estimateRoutingTokens } from "./features.ts";
import { normalizeQualityLabel, qualityPosteriorUpdate, reliabilityUpdate } from "./feedback.ts";
import { objectiveScore } from "./objectives.ts";
import { blendPrediction, priorPrediction } from "./priors.ts";
import { evaluateRollout, type RolloutEvidence } from "./rollout.ts";
import type {
	ArmPrediction,
	ArmStatistics,
	ModelProfile,
	QualitySource,
	RouteCandidateDecision,
	RouteDecision,
	RouteObservation,
	RolloutScope,
	RolloutState,
	RouterClock,
	RouterHealth,
	RouterStatus,
	RoutingCandidate,
	RoutingProfile,
	RoutingStage,
	ThinkingLevel,
} from "./types.ts";

const POLICY_VERSION = "1.0.0";
const CIRCUIT_COOLDOWN_MS = 15 * 60_000;

export interface ModelRoutingEngineOptions {
	config?: RouterConfig;
	store?: RouterStore;
	telemetry?: RouterTelemetry;
	clock?: RouterClock;
	/** HMAC-backed host callback. Without it project overlays are disabled. */
	hashProject?: (projectKey: string) => string;
	newRouteId?: () => string;
}

interface EvaluatedArm {
	candidate: RoutingCandidate;
	profile: ModelProfile;
	thinkingLevel: ThinkingLevel;
	prediction: ArmPrediction;
	decision: RouteCandidateDecision;
	armKey: string;
	projectArmKey?: string;
	score: number;
}

function armKey(fingerprint: string, thinkingLevel: ThinkingLevel, cohort: string, projectHash?: string): string {
	return [fingerprint, thinkingLevel, cohort, projectHash ?? "global"].join("|");
}

function fallbackFingerprint(model: string): string {
	return createHash("sha256").update(`unprofiled:${model}`).digest("hex");
}

function providerFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const slash = ref.indexOf("/");
	return slash > 0 ? ref.slice(0, slash) : undefined;
}

function initialStatistics(key: string, profile: ModelProfile, thinkingLevel: ThinkingLevel, cohort: string, projectHash: string | undefined, config: RouterConfig, now: number): ArmStatistics {
	return {
		armKey: key,
		modelFingerprint: profile.fingerprint,
		model: profile.ref,
		thinkingLevel,
		cohortKey: cohort,
		projectHash,
		updatedAt: now,
		reliabilityAlpha: profile.reliabilityPrior * config.learning.reliabilityPriorStrength,
		reliabilityBeta: (1 - profile.reliabilityPrior) * config.learning.reliabilityPriorStrength,
		qualityAlpha: profile.quality * config.learning.qualityPriorStrength,
		qualityBeta: (1 - profile.quality) * config.learning.qualityPriorStrength,
		attributableCount: 0,
		qualityLabelCount: 0,
		humanValidatorLabelCount: 0,
		completedCount: 0,
		costCount: 0,
		costMean: 0,
		latencyCount: 0,
		latencyMean: 0,
		firstTokenCount: 0,
		firstTokenMean: 0,
		consecutiveFailures: 0,
	};
}

function predictionFromStatistics(stats: ArmStatistics, cost: number | undefined, p95LatencyMs?: number, p95FirstTokenMs?: number): ArmPrediction {
	return {
		qualityMean: stats.qualityAlpha / Math.max(Number.EPSILON, stats.qualityAlpha + stats.qualityBeta),
		reliabilityMean: stats.reliabilityAlpha / Math.max(Number.EPSILON, stats.reliabilityAlpha + stats.reliabilityBeta),
		qualitySamples: stats.qualityLabelCount,
		reliabilitySamples: stats.attributableCount,
		humanValidatorLabels: stats.humanValidatorLabelCount,
		costSamples: stats.costCount,
		latencySamples: stats.latencyCount,
		estimatedCostUsd: stats.costCount > 0 ? stats.costMean : cost,
		estimatedP95LatencyMs: p95LatencyMs,
		estimatedP95FirstTokenMs: p95FirstTokenMs,
	};
}

export class ModelRoutingEngine {
	readonly config: RouterConfig;
	private readonly store?: RouterStore;
	private readonly telemetry?: RouterTelemetry;
	private readonly clock: RouterClock;
	private readonly hashProject?: (projectKey: string) => string;
	private readonly newRouteId: () => string;
	private storeAvailable = false;
	private warnings: string[] = [];
	private lastDecision?: RouteDecision;

	constructor(options: ModelRoutingEngineOptions = {}) {
		this.config = structuredClone(options.config ?? DEFAULT_ROUTER_CONFIG);
		this.store = options.store;
		this.telemetry = options.telemetry;
		this.clock = options.clock ?? { now: () => Date.now() };
		this.hashProject = options.hashProject;
		this.newRouteId = options.newRouteId ?? randomUUID;
		if (this.store && this.config.storage.enabled) {
			const initialized = this.store.initialize();
			this.storeAvailable = initialized.ok;
			if (!initialized.ok) this.warnings.push("router_store_unavailable");
		}
	}

	async route(request: import("./types.ts").RouteRequest): Promise<RouteDecision> {
		const now = this.clock.now();
		const routeId = request.requestId ?? this.newRouteId();
		const profileName = request.profile ?? this.config.profile;
		const granularity = request.granularity ?? (request.host === "pi_provider_request" ? "request" : "run");
		const classification = classifyTaskIntent(request);
		const assessment = assessTaskComplexity(request, classification, this.config.complexity.thresholds);
		const estimate = estimateRoutingTokens(request, classification.intent, request.estimatedContextTokens, request.estimatedOutputTokens);
		const cohort = cohortKey(request.host, classification, assessment, request, estimate.inputTokens);
		const projectHash = request.projectKey && this.hashProject ? this.hashProject(request.projectKey) : undefined;
		const scopeKey = rolloutScopeKey({ host: request.host, granularity, profile: profileName });
		const rollout = this.rolloutState(scopeKey, now);
		const forced = Boolean(request.explicitModel || request.explicitThinkingLevel || request.forceMode === "auto");
		const baselineModel = request.explicitModel ?? request.currentModel;
		const baselineThinking = request.explicitThinkingLevel ?? request.currentThinkingLevel;
		const disabled = !this.config.enabled || request.forceMode === "off" || rollout.stage === "off";
		const explainOnly = request.forceMode === "explain";

		const candidates = filterConfiguredCandidates(request.candidates, this.config);
		const profiles = candidates.map((c) => profileCandidate(c, this.config));
		applyPreviewDiscount(profiles);
		const evaluated: EvaluatedArm[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i]!;
			const modelProfile = profiles[i]!;
			for (const thinkingLevel of thinkingLevelsFor(candidate, assessment.complexityTier, request.explicitModel && modelRef(candidate).toLowerCase() === request.explicitModel.toLowerCase() ? request.explicitThinkingLevel : undefined)) {
				const key = armKey(modelProfile.fingerprint, thinkingLevel, cohort);
				const projectKey = projectHash ? armKey(modelProfile.fingerprint, thinkingLevel, cohort, projectHash) : undefined;
				const metadataCost = estimateModelCostUsd(modelProfile, estimate.inputTokens, estimate.outputTokens);
				const prediction = this.armPrediction(key, projectKey, modelProfile, metadataCost);
				const circuit = this.storeAvailable ? this.store!.getCircuitBreaker(modelProfile.fingerprint) : undefined;
				const circuitOpen = Boolean(circuit?.ok && circuit.value?.openedAt && (!circuit.value.openUntil || circuit.value.openUntil > now));
				evaluated.push({
					candidate,
					profile: modelProfile,
					thinkingLevel,
					prediction,
					armKey: key,
					projectArmKey: projectKey,
					score: 0,
					decision: {
						model: modelProfile.ref,
						thinkingLevel,
						fingerprint: modelProfile.fingerprint,
						eligible: true,
						score: 0,
						quality: prediction.qualityMean,
						reliability: prediction.reliabilityMean,
						speed: modelProfile.speed,
						estimatedCostUsd: prediction.estimatedCostUsd,
						estimatedP95LatencyMs: prediction.estimatedP95LatencyMs,
						observations: prediction.reliabilitySamples,
						notes: [...modelProfile.notes],
					},
				});
				const current = evaluated.at(-1)!;
				const baseline = evaluated.find((arm) => arm.profile.ref === baselineModel && (!baselineThinking || arm.thinkingLevel === baselineThinking));
				const constraint = evaluateArmConstraints({
					profile: modelProfile,
					thinkingLevel,
					prediction,
					baseline: baseline ? { model: baseline.profile.ref, costUsd: baseline.prediction.estimatedCostUsd, p95LatencyMs: baseline.prediction.estimatedP95LatencyMs, latencySamples: baseline.prediction.latencySamples } : undefined,
					classification,
					assessment,
					estimatedInputTokens: estimate.inputTokens,
					estimatedOutputTokens: estimate.outputTokens,
					modality: request.modality ?? "text",
					routingProfile: profileName,
					circuitOpen,
				}, this.config);
				current.decision.eligible = constraint.eligible;
				current.decision.notes.push(...constraint.reasons);
			}
		}

		const baselineArm = evaluated.find((arm) => arm.profile.ref.toLowerCase() === baselineModel?.toLowerCase() && (!baselineThinking || arm.thinkingLevel === baselineThinking))
			?? evaluated.find((arm) => arm.profile.ref.toLowerCase() === baselineModel?.toLowerCase());
		const constraints = evaluated.map((arm) => evaluateArmConstraints({
			profile: arm.profile,
			thinkingLevel: arm.thinkingLevel,
			prediction: arm.prediction,
			baseline: baselineArm ? { model: baselineArm.profile.ref, costUsd: baselineArm.prediction.estimatedCostUsd, p95LatencyMs: baselineArm.prediction.estimatedP95LatencyMs, latencySamples: baselineArm.prediction.latencySamples } : undefined,
			classification,
			assessment,
			estimatedInputTokens: estimate.inputTokens,
			estimatedOutputTokens: estimate.outputTokens,
			modality: request.modality ?? "text",
			routingProfile: profileName,
			circuitOpen: this.isCircuitOpen(arm.profile.fingerprint, now),
		}, this.config));
		for (let index = 0; index < evaluated.length; index += 1) evaluated[index]!.decision.eligible = constraints[index]!.eligible;
		let eligible = evaluated.filter((arm) => arm.decision.eligible);
		if (assessment.complexityTier === "critical") {
			eligible = eligible.filter((arm) => arm.profile.ref === baselineModel || criticalArmHasEvidence(arm.prediction, this.config, baselineArm?.prediction));
		}
		const baseline = baselineArm ? { costUsd: baselineArm.prediction.estimatedCostUsd, p95LatencyMs: baselineArm.prediction.estimatedP95LatencyMs } : undefined;
		for (const arm of eligible) {
			arm.score = objectiveScore({
				profile: arm.profile,
				prediction: arm.prediction,
				rolePreferred: arm.profile.preferredIntents.includes(classification.intent),
				tierPreferred: arm.profile.preferredTiers.includes(assessment.complexityTier),
				cacheAffinity: arm.profile.ref === request.cacheAffinityModel,
			}, profileName, this.config, baseline, this.config.complexity.qualityFloor[assessment.complexityTier]);
			arm.decision.score = arm.score;
		}
		const random = new SeededRandom(routeId);
		const managedTreatment = rollout.stage === "auto" || (rollout.stage === "explore" && assessment.complexityTier !== "critical" && random.next() < this.config.rollout.exploreTreatmentRate);
		const usePosteriorSample = managedTreatment && assessment.complexityTier !== "critical" && (rollout.stage === "explore" || random.next() < this.config.learning.autoExplorationRate);
		if (usePosteriorSample) {
			for (const arm of eligible) {
				const qn = Math.max(2, arm.prediction.qualitySamples + this.config.learning.qualityPriorStrength);
				const rn = Math.max(2, arm.prediction.reliabilitySamples + this.config.learning.reliabilityPriorStrength);
				const sampled = { ...arm.prediction,
					qualityMean: sampleBeta(arm.prediction.qualityMean * qn, (1 - arm.prediction.qualityMean) * qn, random),
					reliabilityMean: sampleBeta(arm.prediction.reliabilityMean * rn, (1 - arm.prediction.reliabilityMean) * rn, random),
				};
				arm.score = objectiveScore({ profile: arm.profile, prediction: sampled, rolePreferred: arm.profile.preferredIntents.includes(classification.intent), tierPreferred: arm.profile.preferredTiers.includes(assessment.complexityTier), cacheAffinity: arm.profile.ref === request.cacheAffinityModel }, profileName, this.config, baseline, this.config.complexity.qualityFloor[assessment.complexityTier]);
				arm.decision.score = arm.score;
				arm.decision.notes.push("conservative-thompson-sample");
			}
		}
		eligible.sort((a, b) => b.score - a.score || (a.prediction.estimatedCostUsd ?? Infinity) - (b.prediction.estimatedCostUsd ?? Infinity) || a.profile.ref.localeCompare(b.profile.ref));
		const recommended = eligible[0] ?? baselineArm;
		const criticalExploitationAllowed = assessment.complexityTier === "critical" && rollout.stage === "auto" && Boolean(recommended && criticalArmHasEvidence(recommended.prediction, this.config, baselineArm?.prediction));
		const applyManaged = managedTreatment && rollout.stage !== "shadow" && (assessment.complexityTier !== "critical" || criticalExploitationAllowed);
		const applyForced = request.forceMode === "auto" && !request.explicitModel;
		const applied = !disabled && !explainOnly && Boolean(recommended) && (forced || applyManaged || applyForced);
		const selectedModel = request.explicitModel ?? recommended?.profile.ref ?? baselineModel;
		const selectedThinking = request.explicitThinkingLevel ?? recommended?.thinkingLevel ?? baselineThinking;
		const executedModel = applied ? selectedModel : baselineModel;
		const executedThinking = applied ? selectedThinking : baselineThinking;
		const routeArm = forced ? "forced" : applyManaged ? "treatment" : "control";
		const reason = disabled ? "disabled" : explainOnly ? "explain_only" : candidates.length === 0 ? "no_available_models" : applied ? "selected" : "shadow_recommendation";
		const decision: RouteDecision = {
			schemaVersion: 1,
			routeId,
			policyVersion: POLICY_VERSION,
			createdAt: now,
			stage: rollout.stage,
			host: request.host,
			granularity,
			profile: profileName,
			applied,
			arm: routeArm,
			reason,
			intent: classification.intent,
			complexityTier: assessment.complexityTier,
			complexityScore: assessment.complexityScore,
			riskScore: classification.risk,
			confidence: classification.confidence,
			selectedModel,
			selectedThinkingLevel: selectedThinking,
			executedModel,
			executedThinkingLevel: executedThinking,
			baselineModel,
			baselineThinkingLevel: baselineThinking,
			estimatedInputTokens: estimate.inputTokens,
			estimatedOutputTokens: estimate.outputTokens,
			estimatedCostUsd: recommended?.prediction.estimatedCostUsd,
			estimatedP95LatencyMs: recommended?.prediction.estimatedP95LatencyMs,
			candidates: evaluated.map((arm) => arm.decision).sort((a, b) => b.score - a.score),
			constraints,
			explanation: `${classification.reason}; ${reason}; ${recommended ? `recommended ${recommended.profile.ref}:${recommended.thinkingLevel}` : "no safe candidate"}.`,
			projectHash,
			cohortKey: cohort,
			forced,
		};
		this.lastDecision = decision;
		if (this.storeAvailable) {
			const saved = this.store!.saveDecision(decision);
			if (!saved.ok) this.degradeStore();
		}
		try { this.telemetry?.recordDecision({ decision }); } catch { /* non-fatal */ }
		return decision;
	}

	async observe(observation: RouteObservation): Promise<void> {
		if (!this.storeAvailable) return;
		const decisionResult = this.store!.getDecision(observation.routeId);
		if (!decisionResult.ok || !decisionResult.value) { if (!decisionResult.ok) this.degradeStore(); return; }
		const decision = decisionResult.value;
		const stored = this.store!.saveObservation(observation);
		if (!stored.ok) { this.degradeStore(); return; }
		const model = decision.executedModel;
		if (model) {
			const candidate = decision.candidates.find((entry) => entry.model === model && (!decision.executedThinkingLevel || entry.thinkingLevel === decision.executedThinkingLevel));
			const fingerprint = candidate?.fingerprint ?? fallbackFingerprint(model);
			const thinking = decision.executedThinkingLevel ?? candidate?.thinkingLevel ?? "off";
			this.updateArm(decision, observation, model, fingerprint, thinking, undefined);
			if (decision.projectHash) this.updateArm(decision, observation, model, fingerprint, thinking, decision.projectHash);
			this.updateCircuit(fingerprint, observation);
		}
		this.maybeTransitionRollout(decision);
		try { this.telemetry?.recordObservation({ ...this.dimensions(decision), routeId: decision.routeId, observation }); } catch { /* non-fatal */ }
	}

	async recordQuality(routeId: string, score: number, source: QualitySource, weight?: number): Promise<void> {
		if (!this.storeAvailable) return;
		const quality = normalizeQualityLabel(score, source, weight);
		const decision = this.store!.getDecision(routeId);
		if (!decision.ok || !decision.value) return;
		const written = this.store!.recordQuality(routeId, quality, this.clock.now());
		if (!written.ok) { this.degradeStore(); return; }
		const model = decision.value.executedModel;
		if (!model) return;
		const candidate = decision.value.candidates.find((entry) => entry.model === model && (!decision.value!.executedThinkingLevel || entry.thinkingLevel === decision.value!.executedThinkingLevel));
		const observation: RouteObservation = { routeId, outcome: "succeeded", quality };
		this.updateArm(decision.value, observation, model, candidate?.fingerprint ?? fallbackFingerprint(model), decision.value.executedThinkingLevel ?? "off", undefined, true);
		if (decision.value.projectHash) this.updateArm(decision.value, observation, model, candidate?.fingerprint ?? fallbackFingerprint(model), decision.value.executedThinkingLevel ?? "off", decision.value.projectHash, true);
	}

	recordFallback(decision: RouteDecision, fallback: string, outcome: import("./types.ts").RouteOutcome): void {
		try { this.telemetry?.recordFallback({ ...this.dimensions(decision), routeId: decision.routeId, fallback, outcome, at: this.clock.now() }); } catch { /* non-fatal */ }
	}

	async getDecision(routeId: string): Promise<RouteDecision | undefined> {
		if (!this.storeAvailable) return this.lastDecision?.routeId === routeId ? this.lastDecision : undefined;
		const result = this.store!.getDecision(routeId);
		return result.ok ? result.value : undefined;
	}

	async getStatus(): Promise<RouterStatus> {
		const summary = this.storeAvailable ? this.store!.getSummary() : undefined;
		const rollouts = this.storeAvailable ? this.store!.listRollouts() : undefined;
		return {
			policyVersion: POLICY_VERSION,
			profile: this.config.profile,
			stages: rollouts?.ok ? rollouts.value : [],
			health: this.health(),
			totalRoutes: summary?.ok ? summary.value.totalRoutes : Number(Boolean(this.lastDecision)),
			totalObservations: summary?.ok ? summary.value.totalObservations : 0,
			qualityLabels: summary?.ok ? summary.value.qualityLabels : 0,
			lastDecision: this.lastDecision ?? (this.storeAvailable && this.store!.getLatestDecision().ok ? (this.store!.getLatestDecision() as any).value : undefined),
		};
	}

	async resetRollout(scope: RolloutScope = {}): Promise<void> {
		if (!this.storeAvailable) return;
		const now = this.clock.now();
		for (const state of this.store!.listRollouts().ok ? (this.store!.listRollouts() as any).value as RolloutState[] : []) {
			const [host, granularity, profile] = state.scopeKey.split(":");
			if (scope.host && scope.host !== host || scope.granularity && scope.granularity !== granularity || scope.profile && scope.profile !== profile) continue;
			this.store!.setRollout({ ...state, stage: this.config.rollout.initialStage, enteredAt: now, updatedAt: now, softRegressionWindows: 0, reason: "manual_reset" });
		}
	}

	async close(): Promise<void> {
		try { await this.telemetry?.shutdown(); } catch { /* non-fatal */ }
		if (this.store) this.store.close();
	}

	private health(): RouterHealth {
		return {
			storeAvailable: this.storeAvailable,
			learningEnabled: this.config.learning.enabled && this.storeAvailable,
			telemetryAvailable: this.telemetry?.getHealth().enabled ?? false,
			warnings: [...this.warnings],
		};
	}

	private degradeStore(): void {
		this.storeAvailable = false;
		if (!this.warnings.includes("router_store_unavailable")) this.warnings.push("router_store_unavailable");
	}

	private rolloutState(scopeKey: string, now: number): RolloutState {
		if (!this.storeAvailable) return { scopeKey, stage: "shadow", enteredAt: now, updatedAt: now, softRegressionWindows: 0, reason: "store_unavailable" };
		const existing = this.store!.getRollout(scopeKey);
		if (existing.ok && existing.value) return existing.value;
		const state: RolloutState = { scopeKey, stage: this.config.enabled ? this.config.rollout.initialStage : "off", enteredAt: now, updatedAt: now, softRegressionWindows: 0, reason: "initialized" };
		if (!this.store!.setRollout(state).ok) this.degradeStore();
		return state;
	}

	private armPrediction(key: string, projectKey: string | undefined, profile: ModelProfile, metadataCost: number | undefined): ArmPrediction {
		const prior = priorPrediction(profile, this.config, metadataCost);
		if (!this.storeAvailable || !this.config.learning.enabled) return prior;
		const globalStats = this.store!.getArmStatistics(key, this.clock.now());
		if (!globalStats.ok || !globalStats.value) return prior;
		const latency = this.store!.getMetricHistogram({ armKey: key, metric: "latency_ms" }, this.clock.now());
		const firstToken = this.store!.getMetricHistogram({ armKey: key, metric: "first_token_ms" }, this.clock.now());
		const global = predictionFromStatistics(globalStats.value, metadataCost, latency.ok && latency.value ? histogramQuantile(latency.value, 0.95) : undefined, firstToken.ok && firstToken.value ? histogramQuantile(firstToken.value, 0.95) : undefined);
		if (!projectKey) return global;
		const projectStats = this.store!.getArmStatistics(projectKey, this.clock.now());
		return projectStats.ok && projectStats.value ? blendPrediction(global, predictionFromStatistics(projectStats.value, metadataCost), this.config) : global;
	}

	private updateArm(decision: RouteDecision, observation: RouteObservation, model: string, fingerprint: string, thinking: ThinkingLevel, projectHash?: string, qualityOnly = false): void {
		if (!this.storeAvailable) return;
		const key = armKey(fingerprint, thinking, decision.cohortKey, projectHash);
		const candidate = decision.candidates.find((entry) => entry.fingerprint === fingerprint && entry.thinkingLevel === thinking);
		const pseudoProfile: ModelProfile = {
			ref: model, fingerprint, id: model.split("/").at(-1) ?? model, provider: providerFromRef(model), reasoning: thinking !== "off", input: ["text"], contextWindow: 128_000, maxTokens: 16_384,
			quality: candidate?.quality ?? 0.55, speed: candidate?.speed ?? 0.55, reliabilityPrior: candidate?.reliability ?? this.config.learning.reliabilityPriorMean,
			preferredIntents: [], preferredTiers: [], notes: [],
		};
		const existing = this.store!.getArmStatistics(key, this.clock.now());
		let stats = existing.ok && existing.value ? existing.value : initialStatistics(key, pseudoProfile, thinking, decision.cohortKey, projectHash, this.config, this.clock.now());
		if (qualityOnly) {
			if (observation.quality) {
				const updated = qualityPosteriorUpdate(stats.qualityAlpha, stats.qualityBeta, observation.quality);
				stats = { ...stats, qualityAlpha: updated.alpha, qualityBeta: updated.beta, qualityLabelCount: stats.qualityLabelCount + 1,
					humanValidatorLabelCount: stats.humanValidatorLabelCount + Number(observation.quality.source === "user" || observation.quality.source === "validator"), updatedAt: this.clock.now() };
			}
			this.store!.upsertArmStatistics(stats);
			return;
		}
		const reliability = reliabilityUpdate(stats.reliabilityAlpha, stats.reliabilityBeta, observation.outcome, observation.failureDomain, observation.contextOverflow);
		stats.reliabilityAlpha = reliability.alpha;
		stats.reliabilityBeta = reliability.beta;
		stats.attributableCount += Number(reliability.attributable);
		stats.completedCount += 1;
		stats.consecutiveFailures = reliability.attributable && observation.outcome !== "succeeded" ? stats.consecutiveFailures + 1 : observation.outcome === "succeeded" ? 0 : stats.consecutiveFailures;
		if (observation.quality) {
			const quality = qualityPosteriorUpdate(stats.qualityAlpha, stats.qualityBeta, observation.quality);
			stats.qualityAlpha = quality.alpha; stats.qualityBeta = quality.beta; stats.qualityLabelCount += 1;
			if (observation.quality.source === "user" || observation.quality.source === "validator") stats.humanValidatorLabelCount += 1;
		}
		const mean = (current: number, count: number, value: number) => current + (value - current) / (count + 1);
		if (observation.costUsd !== undefined) { stats.costMean = mean(stats.costMean, stats.costCount, observation.costUsd); stats.costCount += 1; this.observeHistogram(key, "cost_usd", observation.costUsd); }
		if (observation.latencyMs !== undefined) { stats.latencyMean = mean(stats.latencyMean, stats.latencyCount, observation.latencyMs); stats.latencyCount += 1; this.observeHistogram(key, "latency_ms", observation.latencyMs); }
		if (observation.firstTokenMs !== undefined) { stats.firstTokenMean = mean(stats.firstTokenMean, stats.firstTokenCount, observation.firstTokenMs); stats.firstTokenCount += 1; this.observeHistogram(key, "first_token_ms", observation.firstTokenMs); }
		stats.updatedAt = this.clock.now();
		if (!this.store!.upsertArmStatistics(stats).ok) this.degradeStore();
	}

	private observeHistogram(key: string, metric: "cost_usd" | "latency_ms" | "first_token_ms", value: number): void {
		if (!this.storeAvailable) return;
		const existing = this.store!.getMetricHistogram({ armKey: key, metric }, this.clock.now());
		const histogram = existing.ok && existing.value ? existing.value : createMetricHistogram({ armKey: key, metric }, DEFAULT_HISTOGRAM_BOUNDARIES[metric], this.clock.now());
		this.store!.upsertMetricHistogram(observeMetric(histogram, value, 1, this.clock.now()));
	}

	private isCircuitOpen(fingerprint: string, now: number): boolean {
		if (!this.storeAvailable) return false;
		const circuit = this.store!.getCircuitBreaker(fingerprint);
		return Boolean(circuit.ok && circuit.value?.openedAt && (!circuit.value.openUntil || circuit.value.openUntil > now));
	}

	private updateCircuit(fingerprint: string, observation: RouteObservation): void {
		if (!this.storeAvailable) return;
		const current = this.store!.getCircuitBreaker(fingerprint);
		const now = this.clock.now();
		const state = current.ok && current.value ? current.value : { key: fingerprint, failureCount: 0, updatedAt: now };
		if (observation.outcome === "succeeded") {
			if (state.failureCount || state.openedAt) {
				this.store!.setCircuitBreaker({ key: fingerprint, failureCount: 0, updatedAt: now });
				try { this.telemetry?.recordCircuitBreaker({ model: fingerprint, outcome: "closed", at: now }); } catch { /* non-fatal */ }
			}
			return;
		}
		if (observation.failureDomain !== "model" && observation.failureDomain !== "provider") return;
		const failures = state.failureCount + 1;
		const opened = failures >= 3;
		this.store!.setCircuitBreaker({ key: fingerprint, failureCount: failures, openedAt: opened ? now : state.openedAt, openUntil: opened ? now + CIRCUIT_COOLDOWN_MS : state.openUntil, updatedAt: now, reason: observation.failureDomain });
		if (opened) try { this.telemetry?.recordCircuitBreaker({ model: fingerprint, outcome: "opened", failureDomain: observation.failureDomain, at: now }); } catch { /* non-fatal */ }
	}

	private maybeTransitionRollout(decision: RouteDecision): void {
		if (!this.storeAvailable || decision.arm === "forced") return;
		const scopeKey = rolloutScopeKey(decision);
		const state = this.store!.getRollout(scopeKey);
		const aggregate = this.store!.getRolloutAggregate(scopeKey);
		if (!state.ok || !state.value || !aggregate.ok) return;
		const stats = this.store!.listArmStatistics();
		const control = aggregate.value.control;
		const treatment = aggregate.value.treatment;
		const completed = control.completed + treatment.completed;
		const mapped: RolloutEvidence = {
			completed,
			qualityLabels: control.qualityLabels + treatment.qualityLabels,
			outcomesKnown: completed,
			costKnown: control.costKnown + treatment.costKnown,
			latencyKnown: control.latencyKnown + treatment.latencyKnown,
			candidateArms: stats.ok ? new Set(stats.value.map((item) => item.modelFingerprint)).size : 0,
			treatment: treatment.completed,
			control: control.completed,
			treatmentQualityLabels: treatment.qualityLabels,
			controlQualityLabels: control.qualityLabels,
			treatmentReliabilityAlpha: treatment.succeeded + 1,
			treatmentReliabilityBeta: Math.max(0, treatment.completed - treatment.succeeded) + 1,
			controlReliabilityAlpha: control.succeeded + 1,
			controlReliabilityBeta: Math.max(0, control.completed - control.succeeded) + 1,
			treatmentQualityAlpha: treatment.qualityAlpha + 1,
			treatmentQualityBeta: treatment.qualityBeta + 1,
			controlQualityAlpha: control.qualityAlpha + 1,
			controlQualityBeta: control.qualityBeta + 1,
			treatmentCostPerSuccess: treatment.costPerSuccessUsd,
			controlCostPerSuccess: control.costPerSuccessUsd,
			treatmentP95LatencyMs: treatment.latencyP95Ms,
			controlP95LatencyMs: control.latencyP95Ms,
			dataIntegrityOk: this.store!.health().available && Math.min(control.observationCompleteness || 1, treatment.observationCompleteness || 1) >= this.config.rollout.minimumObservationCompleteness,
		};
		const evaluated = evaluateRollout(state.value, mapped, this.config, this.clock.now());
		if (!evaluated.transition) {
			const softRegression = evaluated.reasons.includes("soft_cost_or_latency_regression");
			if (softRegression || state.value.softRegressionWindows > 0) {
				this.store!.setRollout({ ...state.value, updatedAt: this.clock.now(), softRegressionWindows: softRegression ? state.value.softRegressionWindows + 1 : 0, reason: softRegression ? "soft_cost_or_latency_regression" : state.value.reason });
			}
			return;
		}
		const next: RolloutState = { ...state.value, stage: evaluated.nextStage, enteredAt: this.clock.now(), updatedAt: this.clock.now(), softRegressionWindows: 0, reason: evaluated.reasons.join(",") || "gates_passed" };
		if (this.store!.setRollout(next).ok) {
			try { this.telemetry?.recordRolloutTransition({ ...this.dimensions(decision), from: state.value.stage, to: next.stage, transition: next.reason ?? "transition", completedCount: completed, qualityLabelCount: mapped.qualityLabels, outcomeCoverageCount: mapped.outcomesKnown, costCoverageCount: mapped.costKnown, latencyCoverageCount: mapped.latencyKnown }); } catch { /* non-fatal */ }
		}
	}

	private dimensions(decision: RouteDecision): RouterTelemetryDimensions {
		return {
			host: decision.host,
			granularity: decision.granularity,
			profile: decision.profile,
			stage: decision.stage,
			arm: decision.arm,
			provider: providerFromRef(decision.executedModel),
			model: decision.executedModel,
			thinkingLevel: decision.executedThinkingLevel,
			intent: decision.intent,
			complexityTier: decision.complexityTier,
		};
	}
}
