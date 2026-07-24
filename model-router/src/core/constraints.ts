import type { RouterConfig } from "../config/schema.ts";
import { probabilityDifferenceAtLeast } from "./bandit.ts";
import type {
	ArmPrediction,
	ComplexityAssessment,
	ConstraintEvaluation,
	IntentClassification,
	ModelProfile,
	RoutingProfile,
	ThinkingLevel,
} from "./types.ts";

export interface ArmConstraintInput {
	profile: ModelProfile;
	thinkingLevel: ThinkingLevel;
	prediction: ArmPrediction;
	baseline?: {
		model: string;
		costUsd?: number;
		p95LatencyMs?: number;
		latencySamples: number;
	};
	classification: IntentClassification;
	assessment: ComplexityAssessment;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	modality: "text" | "image";
	routingProfile: RoutingProfile;
	circuitOpen: boolean;
}


export function evaluateArmConstraints(input: ArmConstraintInput, config: RouterConfig): ConstraintEvaluation {
	const reasons: string[] = [];
	const { profile, prediction, assessment, baseline } = input;
	const qualityFloor = config.complexity.qualityFloor[assessment.complexityTier];
	const reliabilityFloor = config.complexity.reliabilityFloor[assessment.complexityTier];
	const needed = input.estimatedInputTokens + input.estimatedOutputTokens;
	if (!profile.input.includes(input.modality)) reasons.push(`modality:${input.modality}`);
	if (profile.contextWindow < needed) reasons.push(`context:${needed}>${profile.contextWindow}`);
	if (profile.maxTokens < input.estimatedOutputTokens) reasons.push(`output:${input.estimatedOutputTokens}>${profile.maxTokens}`);
	if (input.circuitOpen) reasons.push("circuit_open");
	if (prediction.qualityMean < qualityFloor) reasons.push(`quality:${prediction.qualityMean.toFixed(3)}<${qualityFloor.toFixed(3)}`);
	if (prediction.reliabilitySamples >= 20 && prediction.reliabilityMean < reliabilityFloor) reasons.push(`reliability:${prediction.reliabilityMean.toFixed(3)}<${reliabilityFloor.toFixed(3)}`);
	const selectedProfile = config.profiles[input.routingProfile];
	if (selectedProfile.maxCostUsd !== undefined && prediction.estimatedCostUsd !== undefined && prediction.estimatedCostUsd > selectedProfile.maxCostUsd) reasons.push("absolute_cost_cap");
	if (selectedProfile.maxP95LatencyMs !== undefined && prediction.estimatedP95LatencyMs !== undefined && prediction.estimatedP95LatencyMs > selectedProfile.maxP95LatencyMs) reasons.push("absolute_latency_cap");
	if (selectedProfile.maxCostRatio !== undefined && baseline?.costUsd !== undefined && prediction.estimatedCostUsd !== undefined && prediction.estimatedCostUsd > baseline.costUsd * selectedProfile.maxCostRatio) reasons.push("relative_cost_cap");
	if (selectedProfile.maxP95LatencyRatio !== undefined && baseline?.p95LatencyMs !== undefined && prediction.estimatedP95LatencyMs !== undefined && baseline.latencySamples >= 10 && prediction.latencySamples >= 10 && prediction.estimatedP95LatencyMs > baseline.p95LatencyMs * selectedProfile.maxP95LatencyRatio) reasons.push("relative_latency_cap");
	return {
		model: profile.ref,
		thinkingLevel: input.thinkingLevel,
		eligible: reasons.length === 0,
		reasons,
		qualityFloor,
		reliabilityFloor,
		estimatedCostUsd: prediction.estimatedCostUsd,
		estimatedP95LatencyMs: prediction.estimatedP95LatencyMs,
	};
}

export function criticalArmHasEvidence(prediction: ArmPrediction, config: RouterConfig, baseline?: ArmPrediction): boolean {
	if (!(prediction.reliabilitySamples >= config.critical.minimumReliabilityObservations
		&& prediction.humanValidatorLabels >= config.critical.minimumHumanValidatorLabels
		&& prediction.reliabilityMean >= config.critical.minimumReliabilityMean
		&& prediction.qualityMean >= config.critical.minimumQualityMean)) return false;
	if (!baseline || baseline.reliabilitySamples < 1) return true;
	const predictionN = prediction.reliabilitySamples + 2;
	const baselineN = baseline.reliabilitySamples + 2;
	return probabilityDifferenceAtLeast(
		prediction.reliabilityMean * predictionN,
		(1 - prediction.reliabilityMean) * predictionN,
		baseline.reliabilityMean * baselineN,
		(1 - baseline.reliabilityMean) * baselineN,
		-config.rollout.maxReliabilityRegression,
	) >= config.rollout.nonInferiorityProbability;
}
