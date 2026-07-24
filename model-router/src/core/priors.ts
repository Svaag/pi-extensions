import type { RouterConfig } from "../config/schema.ts";
import type { ArmPrediction, ModelProfile } from "./types.ts";

export function priorPrediction(profile: ModelProfile, config: RouterConfig, estimatedCostUsd?: number): ArmPrediction {
	return {
		qualityMean: profile.quality,
		reliabilityMean: profile.reliabilityPrior,
		qualitySamples: 0,
		reliabilitySamples: 0,
		humanValidatorLabels: 0,
		costSamples: estimatedCostUsd === undefined ? 0 : 1,
		latencySamples: 0,
		estimatedCostUsd,
		estimatedP95LatencyMs: undefined,
		estimatedP95FirstTokenMs: undefined,
	};
}

export function blendPrediction(global: ArmPrediction, project: ArmPrediction | undefined, config: RouterConfig): ArmPrediction {
	if (!project || project.reliabilitySamples < config.learning.projectOverlayMinSamples) return global;
	const denominator = Math.max(1, config.learning.projectOverlayFullWeightSamples - config.learning.projectOverlayMinSamples);
	const weight = Math.max(0, Math.min(1, (project.reliabilitySamples - config.learning.projectOverlayMinSamples) / denominator));
	const blend = (a: number, b: number) => a * (1 - weight) + b * weight;
	return {
		qualityMean: blend(global.qualityMean, project.qualityMean),
		reliabilityMean: blend(global.reliabilityMean, project.reliabilityMean),
		qualitySamples: blend(global.qualitySamples, project.qualitySamples),
		reliabilitySamples: blend(global.reliabilitySamples, project.reliabilitySamples),
		humanValidatorLabels: project.humanValidatorLabels,
		costSamples: project.costSamples,
		latencySamples: project.latencySamples,
		estimatedCostUsd: project.estimatedCostUsd ?? global.estimatedCostUsd,
		estimatedP95LatencyMs: project.estimatedP95LatencyMs ?? global.estimatedP95LatencyMs,
		estimatedP95FirstTokenMs: project.estimatedP95FirstTokenMs ?? global.estimatedP95FirstTokenMs,
	};
}
