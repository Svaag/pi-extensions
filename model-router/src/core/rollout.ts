import type { RouterConfig } from "../config/schema.ts";
import { probabilityDifferenceAtLeast } from "./bandit.ts";
import type { RolloutState, RoutingStage } from "./types.ts";

export interface RolloutEvidence {
	completed: number;
	qualityLabels: number;
	outcomesKnown: number;
	costKnown: number;
	latencyKnown: number;
	candidateArms: number;
	treatment: number;
	control: number;
	treatmentQualityLabels: number;
	controlQualityLabels: number;
	treatmentReliabilityAlpha: number;
	treatmentReliabilityBeta: number;
	controlReliabilityAlpha: number;
	controlReliabilityBeta: number;
	treatmentQualityAlpha: number;
	treatmentQualityBeta: number;
	controlQualityAlpha: number;
	controlQualityBeta: number;
	treatmentCostPerSuccess?: number;
	controlCostPerSuccess?: number;
	treatmentP95LatencyMs?: number;
	controlP95LatencyMs?: number;
	dataIntegrityOk: boolean;
}

export interface RolloutEvaluation {
	stage: RoutingStage;
	nextStage: RoutingStage;
	transition: boolean;
	reasons: string[];
}

function coverage(known: number, completed: number): number {
	return completed > 0 ? known / completed : 0;
}

function improvement(treatment: number | undefined, control: number | undefined): number | undefined {
	if (treatment === undefined || control === undefined || control <= 0) return undefined;
	return (control - treatment) / control;
}

export function evaluateRollout(state: RolloutState, aggregate: RolloutEvidence, config: RouterConfig, now = Date.now()): RolloutEvaluation {
	if (!config.enabled || state.stage === "off") return { stage: state.stage, nextStage: "off", transition: state.stage !== "off", reasons: ["router_disabled"] };
	const reasons: string[] = [];
	if (!config.rollout.automatic) return { stage: state.stage, nextStage: state.stage, transition: false, reasons: ["automatic_promotion_disabled"] };
	if (!aggregate.dataIntegrityOk) return { stage: state.stage, nextStage: "shadow", transition: state.stage !== "shadow", reasons: ["data_integrity"] };
	if (state.stage === "shadow") {
		if (aggregate.completed < config.rollout.shadowMinCompleted) reasons.push("completed_samples");
		if (aggregate.qualityLabels < config.rollout.shadowMinQualityLabels) reasons.push("quality_labels");
		if (coverage(aggregate.outcomesKnown, aggregate.completed) < 1) reasons.push("outcome_completeness");
		if (aggregate.completed === 0 || Math.min(coverage(aggregate.costKnown, aggregate.completed), coverage(aggregate.latencyKnown, aggregate.completed)) < config.rollout.minimumObservationCompleteness) reasons.push("cost_latency_completeness");
		if (aggregate.candidateArms < 2) reasons.push("candidate_arms");
		return { stage: state.stage, nextStage: reasons.length ? "shadow" : "explore", transition: reasons.length === 0, reasons };
	}
	if (state.stage === "explore") {
		if (aggregate.treatment < config.rollout.exploreMinTreatment) reasons.push("treatment_samples");
		if (aggregate.control < config.rollout.exploreMinControl) reasons.push("control_samples");
		if (aggregate.treatmentQualityLabels < config.rollout.exploreMinQualityLabelsPerArm) reasons.push("treatment_quality_labels");
		if (aggregate.controlQualityLabels < config.rollout.exploreMinQualityLabelsPerArm) reasons.push("control_quality_labels");
		if (now - state.enteredAt < config.rollout.exploreMinDays * 86_400_000) reasons.push("minimum_duration");
		const reliabilityProbability = probabilityDifferenceAtLeast(
			aggregate.treatmentReliabilityAlpha, aggregate.treatmentReliabilityBeta,
			aggregate.controlReliabilityAlpha, aggregate.controlReliabilityBeta,
			-config.rollout.maxReliabilityRegression,
		);
		const qualityProbability = probabilityDifferenceAtLeast(
			aggregate.treatmentQualityAlpha, aggregate.treatmentQualityBeta,
			aggregate.controlQualityAlpha, aggregate.controlQualityBeta,
			-config.rollout.maxQualityRegression,
		);
		if (reliabilityProbability < config.rollout.nonInferiorityProbability) reasons.push("reliability_noninferiority");
		if (qualityProbability < config.rollout.nonInferiorityProbability) reasons.push("quality_noninferiority");
		const costImprovement = improvement(aggregate.treatmentCostPerSuccess, aggregate.controlCostPerSuccess);
		const latencyImprovement = improvement(aggregate.treatmentP95LatencyMs, aggregate.controlP95LatencyMs);
		if ((costImprovement ?? -Infinity) < config.rollout.requiredCostOrLatencyImprovement && (latencyImprovement ?? -Infinity) < config.rollout.requiredCostOrLatencyImprovement) reasons.push("cost_or_latency_improvement");
		return { stage: state.stage, nextStage: reasons.length ? "explore" : "auto", transition: reasons.length === 0, reasons };
	}
	if (state.stage === "auto") {
		const reliabilityProbability = probabilityDifferenceAtLeast(
			aggregate.treatmentReliabilityAlpha, aggregate.treatmentReliabilityBeta,
			aggregate.controlReliabilityAlpha, aggregate.controlReliabilityBeta,
			-config.rollout.maxReliabilityRegression,
		);
		const qualityProbability = probabilityDifferenceAtLeast(
			aggregate.treatmentQualityAlpha, aggregate.treatmentQualityBeta,
			aggregate.controlQualityAlpha, aggregate.controlQualityBeta,
			-config.rollout.maxQualityRegression,
		);
		if (aggregate.completed >= 20 && (reliabilityProbability < 1 - config.rollout.nonInferiorityProbability || qualityProbability < 1 - config.rollout.nonInferiorityProbability)) return { stage: "auto", nextStage: "shadow", transition: true, reasons: ["quality_or_reliability_regression"] };
		const costRegression = -(improvement(aggregate.treatmentCostPerSuccess, aggregate.controlCostPerSuccess) ?? 0);
		const latencyRegression = -(improvement(aggregate.treatmentP95LatencyMs, aggregate.controlP95LatencyMs) ?? 0);
		if (Math.max(costRegression, latencyRegression) > config.rollout.softCostLatencyRegression) {
			if (state.softRegressionWindows >= 1) return { stage: "auto", nextStage: "explore", transition: true, reasons: ["cost_or_latency_regression"] };
			return { stage: "auto", nextStage: "auto", transition: false, reasons: ["soft_cost_or_latency_regression"] };
		}
	}
	return { stage: state.stage, nextStage: state.stage, transition: false, reasons };
}
