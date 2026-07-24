import type { RouterConfig } from "../config/schema.ts";
import type { ArmPrediction, ModelProfile, RoutingProfile } from "./types.ts";

export interface ObjectiveArm {
	profile: ModelProfile;
	prediction: ArmPrediction;
	rolePreferred: boolean;
	tierPreferred: boolean;
	cacheAffinity: boolean;
}

function saving(value: number | undefined, baseline: number | undefined): number {
	if (value === undefined || baseline === undefined) return 0.5;
	if (baseline <= 0) return value <= 0 ? 1 : 0;
	return Math.max(0, Math.min(1, (baseline - value) / baseline * 0.5 + 0.5));
}

export function objectiveScore(
	arm: ObjectiveArm,
	profileName: RoutingProfile,
	config: RouterConfig,
	baseline?: { costUsd?: number; p95LatencyMs?: number },
	qualityFloor = 0,
): number {
	const weights = config.profiles[profileName].weights;
	const cost = saving(arm.prediction.estimatedCostUsd, baseline?.costUsd);
	const latency = saving(arm.prediction.estimatedP95LatencyMs, baseline?.p95LatencyMs);
	const preference = (arm.rolePreferred ? 0.04 : 0) + (arm.tierPreferred ? 0.03 : 0) + (arm.cacheAffinity ? config.virtualProvider.switchMinimumUtilityGain : 0);
	const qualityUtility = profileName === "quality_first" ? arm.prediction.qualityMean
		: arm.prediction.qualityMean >= qualityFloor
			? Math.max(0, 1 - Math.max(0, arm.prediction.qualityMean - qualityFloor - 0.25) * 0.25)
			: Math.max(0, 1 - (qualityFloor - arm.prediction.qualityMean) * 2.2);
	return Math.max(0, Math.min(1,
		qualityUtility * weights.quality
		+ arm.prediction.reliabilityMean * weights.reliability
		+ cost * weights.cost
		+ latency * weights.latency
		+ preference,
	));
}
