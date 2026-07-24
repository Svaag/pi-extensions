import { createHash } from "node:crypto";
import type { RandomSource } from "./types.ts";

export class SeededRandom implements RandomSource {
	private state: number;
	constructor(seed: string | number) {
		if (typeof seed === "number") this.state = seed >>> 0;
		else this.state = createHash("sha256").update(seed).digest().readUInt32LE(0);
		if (this.state === 0) this.state = 0x9e3779b9;
	}
	next(): number {
		let value = this.state;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		this.state = value >>> 0;
		return (this.state + 0.5) / 0x1_0000_0000;
	}
}

function normal(random: RandomSource): number {
	const u1 = Math.max(Number.EPSILON, random.next());
	const u2 = random.next();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function sampleGamma(shape: number, random: RandomSource): number {
	if (!(shape > 0)) return 0;
	if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(Math.max(Number.EPSILON, random.next()), 1 / shape);
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	while (true) {
		const x = normal(random);
		const v0 = 1 + c * x;
		if (v0 <= 0) continue;
		const v = v0 ** 3;
		const u = random.next();
		if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
	}
}

export function sampleBeta(alpha: number, beta: number, random: RandomSource): number {
	const x = sampleGamma(Math.max(0.001, alpha), random);
	const y = sampleGamma(Math.max(0.001, beta), random);
	return x + y > 0 ? x / (x + y) : alpha / (alpha + beta);
}

/** Normal approximation used only for conservative rollout comparisons once gates have sufficient samples. */
export function probabilityDifferenceAtLeast(
	leftAlpha: number,
	leftBeta: number,
	rightAlpha: number,
	rightBeta: number,
	minimumDifference: number,
): number {
	const leftN = leftAlpha + leftBeta;
	const rightN = rightAlpha + rightBeta;
	const leftMean = leftAlpha / leftN;
	const rightMean = rightAlpha / rightN;
	const variance = (leftAlpha * leftBeta) / (leftN ** 2 * (leftN + 1)) + (rightAlpha * rightBeta) / (rightN ** 2 * (rightN + 1));
	if (variance <= 0) return leftMean - rightMean >= minimumDifference ? 1 : 0;
	const z = (leftMean - rightMean - minimumDifference) / Math.sqrt(variance);
	return normalCdf(z);
}

function normalCdf(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const abs = Math.abs(x) / Math.sqrt(2);
	const t = 1 / (1 + 0.3275911 * abs);
	const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs);
	return 0.5 * (1 + sign * erf);
}
