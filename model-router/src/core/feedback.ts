import type { QualityLabel, QualitySource } from "./types.ts";

const DEFAULT_WEIGHTS: Record<QualitySource, number> = {
	user: 1,
	validator: 1,
	judge: 0.35,
	correction: 0.2,
};

export function normalizeQualityLabel(score: number, source: QualitySource, weight?: number): QualityLabel {
	if (!Number.isFinite(score)) throw new TypeError("Quality score must be finite");
	return {
		score: Math.max(0, Math.min(1, score)),
		source,
		weight: weight === undefined ? DEFAULT_WEIGHTS[source] : Math.max(0, Math.min(1, weight)),
	};
}

export function qualityPosteriorUpdate(alpha: number, beta: number, label: QualityLabel): { alpha: number; beta: number } {
	const weight = label.weight ?? DEFAULT_WEIGHTS[label.source];
	return { alpha: alpha + weight * label.score, beta: beta + weight * (1 - label.score) };
}

export function reliabilityUpdate(
	alpha: number,
	beta: number,
	outcome: string,
	failureDomain: string | undefined,
	contextOverflow = false,
): { alpha: number; beta: number; attributable: boolean } {
	if (outcome === "succeeded") return { alpha: alpha + 1, beta, attributable: true };
	if (failureDomain === "model" || failureDomain === "provider") return { alpha, beta: beta + (contextOverflow ? 0.5 : 1), attributable: true };
	return { alpha, beta, attributable: false };
}
