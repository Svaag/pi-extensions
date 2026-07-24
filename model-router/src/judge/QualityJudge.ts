import type { RouterConfig } from "../config/schema.ts";
import type { ComplexityTier, QualityLabel } from "../core/types.ts";
import type { RouterStore } from "../storage/RouterStore.ts";
import {
	buildQualityJudgePrompt,
	parseQualityRubricScores,
	qualityLabelFromRubric,
	qualityScoreFromRubric,
	type QualityRubricScores,
} from "./rubric.ts";

export type QualityJudgeConfig = RouterConfig["judge"];
export type MaybePromise<T> = T | Promise<T>;

export interface JudgeInvokeRequest {
	model: string;
	prompt: string;
	signal: AbortSignal;
	timeoutMs: number;
}

export interface JudgeInvokeResult {
	text: string;
	costUsd?: number;
}

export type JudgeInvoke = (request: JudgeInvokeRequest) => Promise<string | JudgeInvokeResult>;

export interface JudgeBudgetCheck {
	estimatedCostUsd: number;
	limitUsd: number;
	dayKey: string;
}

export interface JudgeBudgetRecord {
	costUsd: number;
	dayKey: string;
}

/** Budget callbacks contain numeric accounting only; no prompt or output is exposed. */
export interface JudgeBudgetCallbacks {
	allowPerEvaluation?: (check: JudgeBudgetCheck) => MaybePromise<boolean>;
	allowDaily?: (check: JudgeBudgetCheck) => MaybePromise<boolean>;
	recordSpend?: (record: JudgeBudgetRecord) => MaybePromise<void>;
}

export interface JudgeCalibrationSeed {
	pairCount: number;
	mae: number;
	bias: number;
	updatesEnabled?: boolean;
}

export interface JudgeCalibrationState {
	pairCount: number;
	mae: number;
	bias: number;
	updatesEnabled: boolean;
	disabledReason?: "mae" | "bias" | "manual";
}

export function createStoreJudgeBudgetCallbacks(store: RouterStore, maxDailyUsd: number): JudgeBudgetCallbacks {
	const reservations = new Map<string, string[]>();
	return {
		allowDaily(check) {
			const result = store.reserveJudgeBudget({ day: check.dayKey, amountUsd: check.estimatedCostUsd, maxDailyUsd });
			if (!result.ok || !result.value) return false;
			const queue = reservations.get(check.dayKey) ?? [];
			queue.push(result.value.reservationId);
			reservations.set(check.dayKey, queue);
			return true;
		},
		recordSpend(record) {
			const queue = reservations.get(record.dayKey) ?? [];
			const reservationId = queue.shift();
			if (queue.length) reservations.set(record.dayKey, queue); else reservations.delete(record.dayKey);
			if (reservationId) store.recordJudgeBudget(reservationId, record.costUsd);
		},
	};
}

export interface QualityJudgeOptions {
	config: QualityJudgeConfig;
	invoke: JudgeInvoke;
	/** Returns a stable value in [0, 1) for a sampling key. */
	sampleValue?: (key: string) => number;
	budget?: JudgeBudgetCallbacks;
	now?: () => number;
	initialCalibration?: JudgeCalibrationSeed;
	onCalibrationChange?: (state: JudgeCalibrationState) => void;
}

export interface QualityJudgeRequest {
	routeId?: string;
	sampleKey?: string;
	evaluatedModel: string;
	complexityTier: ComplexityTier;
	sensitive: boolean;
	prompt: string;
	output: string;
	/** Reserve this amount before invocation. The configured per-call maximum is used when omitted. */
	estimatedCostUsd?: number;
}

export type JudgeSkipReason =
	| "disabled"
	| "judge_model_missing"
	| "judge_model_synthetic"
	| "judge_model_not_concrete"
	| "same_model"
	| "critical"
	| "excluded_tier"
	| "sensitive"
	| "sample_key_missing"
	| "not_sampled"
	| "per_evaluation_budget"
	| "daily_budget"
	| "budget_callback_failed";

export type JudgeFailureReason = "timeout" | "invoke_failed" | "invalid_json" | "reported_cost_exceeded";

export interface QualityJudgeEvaluation {
	status: "labelled" | "diagnostic" | "skipped" | "failed";
	reason?: JudgeSkipReason | JudgeFailureReason | "calibration_disabled";
	sampled: boolean;
	updatesEnabled: boolean;
	label?: QualityLabel;
	score?: number;
	scores?: QualityRubricScores;
	costUsd?: number;
}

const MAX_SAMPLE_RATE = 0.05;
const TIMEOUT = Symbol("quality-judge-timeout");
type BudgetReservation =
	| { ok: true; dayKey: string }
	| { ok: false; reason: "daily_budget" | "budget_callback_failed" | "per_evaluation_budget" };

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function utcDayKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function canonicalModel(model: string): string {
	return model.trim().toLowerCase();
}

export function isSyntheticRouterModel(model: string): boolean {
	return canonicalModel(model).startsWith("model-router/");
}

export function validateJudgeModel(judgeModel: string | undefined, evaluatedModel: string): JudgeSkipReason | undefined {
	if (!judgeModel?.trim()) return "judge_model_missing";
	const canonical = canonicalModel(judgeModel);
	if (isSyntheticRouterModel(canonical)) return "judge_model_synthetic";
	if (/[?*\s]/.test(canonical)) return "judge_model_not_concrete";
	if (canonical === canonicalModel(evaluatedModel)) return "same_model";
	return undefined;
}

/** Stable FNV-1a sampling value. It never uses process randomness. */
export function deterministicJudgeSampleValue(key: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	// Additional avalanche avoids poor low-bit distribution for similar route IDs.
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return (hash >>> 0) / 0x1_0000_0000;
}

export class QualityJudge {
	private readonly config: QualityJudgeConfig;
	private readonly invoke: JudgeInvoke;
	private readonly sampleValue: (key: string) => number;
	private readonly budget?: JudgeBudgetCallbacks;
	private readonly now: () => number;
	private readonly onCalibrationChange?: (state: JudgeCalibrationState) => void;
	private dailyKey = "";
	private dailySpent = 0;
	private dailyReserved = 0;
	private calibrationCount = 0;
	private calibrationAbsoluteError = 0;
	private calibrationSignedError = 0;
	private updatesEnabled = true;
	private disabledReason?: JudgeCalibrationState["disabledReason"];

	constructor(options: QualityJudgeOptions) {
		this.config = options.config;
		this.invoke = options.invoke;
		this.sampleValue = options.sampleValue ?? deterministicJudgeSampleValue;
		this.budget = options.budget;
		this.now = options.now ?? Date.now;
		this.onCalibrationChange = options.onCalibrationChange;
		const initial = options.initialCalibration;
		if (initial && Number.isFinite(initial.pairCount) && initial.pairCount > 0) {
			this.calibrationCount = Math.floor(initial.pairCount);
			this.calibrationAbsoluteError = clamp01(initial.mae) * this.calibrationCount;
			this.calibrationSignedError = Math.max(-1, Math.min(1, initial.bias)) * this.calibrationCount;
			this.updatesEnabled = initial.updatesEnabled ?? true;
			if (!this.updatesEnabled) this.disabledReason = "manual";
			this.applyCalibrationGate();
		}
	}

	shouldSample(key: string): boolean {
		const rate = Math.max(0, Math.min(MAX_SAMPLE_RATE, this.config.sampleRate));
		if (rate === 0) return false;
		try {
			const value = this.sampleValue(key);
			return Number.isFinite(value) && value >= 0 && value < 1 && value < rate;
		} catch {
			return false;
		}
	}

	getCalibrationState(): JudgeCalibrationState {
		const count = this.calibrationCount;
		return {
			pairCount: count,
			mae: count ? this.calibrationAbsoluteError / count : 0,
			bias: count ? this.calibrationSignedError / count : 0,
			updatesEnabled: this.updatesEnabled,
			disabledReason: this.disabledReason,
		};
	}

	/** Add a paired judge/reference score. Inputs are normalized to [0, 1]. */
	recordCalibration(judgeScore: number, referenceScore: number): JudgeCalibrationState {
		if (!Number.isFinite(judgeScore) || !Number.isFinite(referenceScore)) return this.getCalibrationState();
		const error = clamp01(judgeScore) - clamp01(referenceScore);
		this.calibrationCount += 1;
		this.calibrationAbsoluteError += Math.abs(error);
		this.calibrationSignedError += error;
		this.applyCalibrationGate();
		this.notifyCalibrationChange();
		return this.getCalibrationState();
	}

	/** Manual re-enable starts a fresh calibration window by default. */
	enableUpdates(resetCalibration = true): JudgeCalibrationState {
		if (resetCalibration) {
			this.calibrationCount = 0;
			this.calibrationAbsoluteError = 0;
			this.calibrationSignedError = 0;
		}
		this.updatesEnabled = true;
		this.disabledReason = undefined;
		this.notifyCalibrationChange();
		return this.getCalibrationState();
	}

	disableUpdates(): JudgeCalibrationState {
		this.updatesEnabled = false;
		this.disabledReason = "manual";
		this.notifyCalibrationChange();
		return this.getCalibrationState();
	}

	async evaluateLabel(request: QualityJudgeRequest): Promise<QualityLabel | undefined> {
		return (await this.evaluate(request)).label;
	}

	/**
	 * Evaluate transient excerpts. Failures and budget exhaustion are represented
	 * as bounded statuses and never throw into the routed user call.
	 */
	async evaluate(request: QualityJudgeRequest): Promise<QualityJudgeEvaluation> {
		const base = (): Pick<QualityJudgeEvaluation, "sampled" | "updatesEnabled"> => ({
			sampled: false,
			updatesEnabled: this.updatesEnabled,
		});
		if (!this.config.enabled) return { status: "skipped", reason: "disabled", ...base() };
		const modelReason = validateJudgeModel(this.config.model, request.evaluatedModel);
		if (modelReason) return { status: "skipped", reason: modelReason, ...base() };
		if (request.complexityTier === "critical") return { status: "skipped", reason: "critical", ...base() };
		if (this.config.excludeTiers.includes(request.complexityTier)) return { status: "skipped", reason: "excluded_tier", ...base() };
		if (request.sensitive) return { status: "skipped", reason: "sensitive", ...base() };

		const key = request.sampleKey ?? request.routeId;
		if (!key) return { status: "skipped", reason: "sample_key_missing", ...base() };
		if (!this.shouldSample(key)) return { status: "skipped", reason: "not_sampled", ...base() };

		const sampledBase = (): Pick<QualityJudgeEvaluation, "sampled" | "updatesEnabled"> => ({
			sampled: true,
			updatesEnabled: this.updatesEnabled,
		});
		const reserveCost = finiteNonNegative(request.estimatedCostUsd, this.config.maxCostPerEvaluationUsd);
		if (reserveCost > this.config.maxCostPerEvaluationUsd) {
			return { status: "skipped", reason: "per_evaluation_budget", ...sampledBase() };
		}

		let reservation: BudgetReservation;
		try {
			reservation = await this.reserveBudget(reserveCost);
		} catch {
			return { status: "skipped", reason: "budget_callback_failed", ...sampledBase() };
		}
		if (!reservation.ok) return { status: "skipped", reason: reservation.reason, ...sampledBase() };

		let invoked: string | JudgeInvokeResult | typeof TIMEOUT;
		let invokeFailed = false;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const transientPrompt = buildQualityJudgePrompt(
				request.prompt,
				request.output,
				this.config.maxPromptChars,
				this.config.maxOutputChars,
			);
			const timeout = new Promise<typeof TIMEOUT>((resolve) => {
				timer = setTimeout(() => {
					// Settle the timeout branch before abort listeners can reject the
					// invocation, preserving an accurate bounded failure reason.
					resolve(TIMEOUT);
					controller.abort();
				}, this.config.timeoutMs);
			});
			invoked = await Promise.race([
				this.invoke({ model: this.config.model!, prompt: transientPrompt, signal: controller.signal, timeoutMs: this.config.timeoutMs }),
				timeout,
			]);
		} catch {
			invokeFailed = true;
			invoked = "";
		} finally {
			if (timer) clearTimeout(timer);
		}

		const reportedCost = typeof invoked === "object" && invoked !== null && "costUsd" in invoked
			? finiteNonNegative(invoked.costUsd, reserveCost)
			: reserveCost;
		await this.commitBudget(reservation.dayKey, reserveCost, reportedCost);

		if (invoked === TIMEOUT) return { status: "failed", reason: "timeout", costUsd: reportedCost, ...sampledBase() };
		if (invokeFailed) return { status: "failed", reason: "invoke_failed", costUsd: reportedCost, ...sampledBase() };
		if (reportedCost > this.config.maxCostPerEvaluationUsd) {
			return { status: "failed", reason: "reported_cost_exceeded", costUsd: reportedCost, ...sampledBase() };
		}
		const text = typeof invoked === "string"
			? invoked
			: invoked && typeof invoked === "object" && "text" in invoked && typeof invoked.text === "string"
				? invoked.text
				: undefined;
		if (text === undefined) return { status: "failed", reason: "invoke_failed", costUsd: reportedCost, ...sampledBase() };
		const scores = parseQualityRubricScores(text);
		if (!scores) return { status: "failed", reason: "invalid_json", costUsd: reportedCost, ...sampledBase() };
		const score = qualityScoreFromRubric(scores);
		if (!this.updatesEnabled) {
			return {
				status: "diagnostic",
				reason: "calibration_disabled",
				sampled: true,
				updatesEnabled: false,
				score,
				scores,
				costUsd: reportedCost,
			};
		}
		return {
			status: "labelled",
			sampled: true,
			updatesEnabled: true,
			label: qualityLabelFromRubric(scores),
			score,
			scores,
			costUsd: reportedCost,
		};
	}

	private applyCalibrationGate(): void {
		if (this.calibrationCount < this.config.minimumCalibrationPairs) return;
		const mae = this.calibrationAbsoluteError / this.calibrationCount;
		const bias = this.calibrationSignedError / this.calibrationCount;
		if (mae > this.config.maxCalibrationMae) {
			this.updatesEnabled = false;
			this.disabledReason = "mae";
		} else if (Math.abs(bias) > this.config.maxCalibrationBias) {
			this.updatesEnabled = false;
			this.disabledReason = "bias";
		}
	}

	private notifyCalibrationChange(): void {
		try {
			this.onCalibrationChange?.(this.getCalibrationState());
		} catch {
			// Calibration persistence/telemetry is host-owned and non-fatal.
		}
	}

	private rollDailyBudget(dayKey: string): void {
		if (this.dailyKey === dayKey) return;
		this.dailyKey = dayKey;
		this.dailySpent = 0;
		this.dailyReserved = 0;
	}

	private async reserveBudget(costUsd: number): Promise<BudgetReservation> {
		const dayKey = utcDayKey(this.now());
		this.rollDailyBudget(dayKey);
		if (this.dailySpent + this.dailyReserved + costUsd > this.config.maxDailyCostUsd) {
			return { ok: false, reason: "daily_budget" };
		}
		// Reserve before awaiting host callbacks so concurrent evaluations cannot
		// jointly pass the local daily cap.
		this.dailyReserved += costUsd;
		const release = (): void => { this.dailyReserved = Math.max(0, this.dailyReserved - costUsd); };
		const check: JudgeBudgetCheck = { estimatedCostUsd: costUsd, limitUsd: this.config.maxCostPerEvaluationUsd, dayKey };
		try {
			if (this.budget?.allowPerEvaluation && !(await this.budget.allowPerEvaluation(check))) {
				release();
				return { ok: false, reason: "per_evaluation_budget" };
			}
			if (this.budget?.allowDaily) {
				const dailyCheck = { ...check, limitUsd: this.config.maxDailyCostUsd };
				if (!(await this.budget.allowDaily(dailyCheck))) {
					release();
					return { ok: false, reason: "daily_budget" };
				}
			}
		} catch {
			release();
			return { ok: false, reason: "budget_callback_failed" };
		}
		return { ok: true, dayKey };
	}

	private async commitBudget(dayKey: string, reservedCostUsd: number, actualCostUsd: number): Promise<void> {
		this.rollDailyBudget(dayKey);
		this.dailyReserved = Math.max(0, this.dailyReserved - reservedCostUsd);
		this.dailySpent += actualCostUsd;
		try {
			await this.budget?.recordSpend?.({ costUsd: actualCostUsd, dayKey });
		} catch {
			// Local accounting remains conservative; host accounting failure is non-fatal.
		}
	}
}

export {
	buildQualityJudgePrompt,
	parseQualityRubricScores,
	qualityLabelFromRubric,
	qualityScoreFromRubric,
	type QualityRubricScores,
} from "./rubric.ts";
