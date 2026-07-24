import type { ArmStatistics } from "../core/types.ts";

export type RouterMetric = "latency_ms" | "first_token_ms" | "cost_usd" | (string & {});

export interface MetricHistogramKey {
	armKey: string;
	metric: RouterMetric;
}

/** counts has boundaries.length + 1 entries (the final entry is overflow). */
export interface MetricHistogram extends MetricHistogramKey {
	boundaries: number[];
	counts: number[];
	totalCount: number;
	sum: number;
	updatedAt: number;
}

export const DEFAULT_HISTOGRAM_BOUNDARIES: Readonly<Record<"latency_ms" | "first_token_ms" | "cost_usd", readonly number[]>> = {
	latency_ms: [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 120_000, 300_000],
	first_token_ms: [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 120_000, 300_000],
	cost_usd: [0, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
};

const DAY_MS = 86_400_000;

export function exponentialDecayFactor(from: number, to: number, halfLifeDays = 30): number {
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 1;
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
	return Math.pow(0.5, (to - from) / (halfLifeDays * DAY_MS));
}

export function createMetricHistogram(key: MetricHistogramKey, boundaries: readonly number[], now = Date.now()): MetricHistogram {
	const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
	if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
		throw new Error("Histogram boundaries must be unique");
	}
	return { ...key, boundaries: sorted, counts: Array(sorted.length + 1).fill(0), totalCount: 0, sum: 0, updatedAt: now };
}

export function observeMetric(histogram: MetricHistogram, value: number, weight = 1, now = Date.now()): MetricHistogram {
	if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return histogram;
	const counts = [...histogram.counts];
	if (counts.length !== histogram.boundaries.length + 1) throw new Error("Malformed histogram");
	let bucket = histogram.boundaries.findIndex((boundary) => value <= boundary);
	if (bucket < 0) bucket = histogram.boundaries.length;
	counts[bucket] = (counts[bucket] ?? 0) + weight;
	return {
		...histogram,
		counts,
		totalCount: histogram.totalCount + weight,
		sum: histogram.sum + value * weight,
		updatedAt: now,
	};
}

export function decayMetricHistogram(histogram: MetricHistogram, at: number, halfLifeDays = 30): MetricHistogram {
	const factor = exponentialDecayFactor(histogram.updatedAt, at, halfLifeDays);
	if (factor === 1) return { ...histogram, boundaries: [...histogram.boundaries], counts: [...histogram.counts] };
	return {
		...histogram,
		counts: histogram.counts.map((count) => count * factor),
		totalCount: histogram.totalCount * factor,
		sum: histogram.sum * factor,
		updatedAt: at,
	};
}

export function histogramQuantile(histogram: MetricHistogram, quantile: number): number | undefined {
	if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1 || histogram.totalCount <= 0) return undefined;
	const target = histogram.totalCount * quantile;
	let cumulative = 0;
	for (let index = 0; index < histogram.counts.length; index += 1) {
		cumulative += histogram.counts[index] ?? 0;
		if (cumulative >= target) {
			if (index < histogram.boundaries.length) return histogram.boundaries[index];
			return histogram.boundaries.at(-1);
		}
	}
	return histogram.boundaries.at(-1);
}

export function decayArmStatistics(statistics: ArmStatistics, at: number, halfLifeDays = 30): ArmStatistics {
	const factor = exponentialDecayFactor(statistics.updatedAt, at, halfLifeDays);
	if (factor === 1) return { ...statistics };
	return {
		...statistics,
		updatedAt: at,
		reliabilityAlpha: statistics.reliabilityAlpha * factor,
		reliabilityBeta: statistics.reliabilityBeta * factor,
		qualityAlpha: statistics.qualityAlpha * factor,
		qualityBeta: statistics.qualityBeta * factor,
		attributableCount: statistics.attributableCount * factor,
		qualityLabelCount: statistics.qualityLabelCount * factor,
		humanValidatorLabelCount: statistics.humanValidatorLabelCount * factor,
		completedCount: statistics.completedCount * factor,
		costCount: statistics.costCount * factor,
		costMean: statistics.costMean,
		latencyCount: statistics.latencyCount * factor,
		latencyMean: statistics.latencyMean,
		firstTokenCount: statistics.firstTokenCount * factor,
		firstTokenMean: statistics.firstTokenMean,
		consecutiveFailures: Math.floor(statistics.consecutiveFailures * factor),
	};
}
