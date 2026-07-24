import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ArmStatistics, QualityLabel, RolloutState, RouteDecision, RouteObservation } from "../core/types.ts";
import {
	rolloutScopeKey,
	storeFailure,
	storeSuccess,
	type CircuitBreakerState,
	type JudgeBudgetRequest,
	type JudgeBudgetReservation,
	type JudgeBudgetStatus,
	type PruneResult,
	type RolloutAggregate,
	type RolloutArmAggregate,
	type RouterStore,
	type RouterStoreHealth,
	type RouterStoreSummary,
	type StoreResult,
} from "./RouterStore.ts";
import { decayArmStatistics, decayMetricHistogram, type MetricHistogram, type MetricHistogramKey } from "./histograms.ts";
import { migrateRouterDatabase } from "./migrations.ts";

const DAY_MS = 86_400_000;
const PRIVATE_EXPLANATION = "Routing explanation is intentionally not persisted.";
const PRIVATE_REASON = "details_not_persisted";

type SqlRow = Record<string, unknown>;

export interface SqliteRouterStoreOptions {
	path: string;
	busyTimeoutMs?: number;
	halfLifeDays?: number;
	rawRetentionDays?: number;
	now?: () => number;
}

function finite(value: number, name: string, minimum = 0): number {
	if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a finite number >= ${minimum}`);
	return value;
}

function integer(value: number, name: string, minimum = 0): number {
	finite(value, name, minimum);
	if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
	return value;
}

function nullable(value: string | number | bigint | undefined): string | number | bigint | null {
	return value === undefined ? null : value;
}

function numberFrom(row: SqlRow, key: string): number {
	return Number(row[key] ?? 0);
}

/** Only machine-readable reason codes are retained; arbitrary errors may contain user/provider content. */
function safeReason(reason: string | undefined): string | undefined {
	return reason && reason.length <= 128 && /^[a-zA-Z0-9_.:-]+$/.test(reason) ? reason : undefined;
}

/** Explicit allow-list: runtime-added prompt/output/metadata fields cannot reach SQLite. */
function privacySafeDecision(decision: RouteDecision): RouteDecision {
	return {
		schemaVersion: 1,
		routeId: decision.routeId,
		policyVersion: decision.policyVersion,
		createdAt: decision.createdAt,
		stage: decision.stage,
		host: decision.host,
		granularity: decision.granularity,
		profile: decision.profile,
		applied: decision.applied,
		arm: decision.arm,
		reason: PRIVATE_REASON,
		intent: decision.intent,
		complexityTier: decision.complexityTier,
		complexityScore: decision.complexityScore,
		riskScore: decision.riskScore,
		confidence: decision.confidence,
		selectedModel: decision.selectedModel,
		selectedThinkingLevel: decision.selectedThinkingLevel,
		executedModel: decision.executedModel,
		executedThinkingLevel: decision.executedThinkingLevel,
		baselineModel: decision.baselineModel,
		baselineThinkingLevel: decision.baselineThinkingLevel,
		estimatedInputTokens: decision.estimatedInputTokens,
		estimatedOutputTokens: decision.estimatedOutputTokens,
		estimatedCostUsd: decision.estimatedCostUsd,
		estimatedP95LatencyMs: decision.estimatedP95LatencyMs,
		candidates: decision.candidates.map((candidate) => ({
			model: candidate.model,
			thinkingLevel: candidate.thinkingLevel,
			fingerprint: candidate.fingerprint,
			eligible: candidate.eligible,
			score: candidate.score,
			quality: candidate.quality,
			reliability: candidate.reliability,
			speed: candidate.speed,
			estimatedCostUsd: candidate.estimatedCostUsd,
			estimatedP95LatencyMs: candidate.estimatedP95LatencyMs,
			observations: candidate.observations,
			notes: [],
		})),
		constraints: decision.constraints.map((constraint) => ({
			model: constraint.model,
			thinkingLevel: constraint.thinkingLevel,
			eligible: constraint.eligible,
			reasons: [],
			qualityFloor: constraint.qualityFloor,
			reliabilityFloor: constraint.reliabilityFloor,
			estimatedCostUsd: constraint.estimatedCostUsd,
			estimatedP95LatencyMs: constraint.estimatedP95LatencyMs,
		})),
		explanation: PRIVATE_EXPLANATION,
		projectHash: decision.projectHash,
		cohortKey: decision.cohortKey,
		forced: decision.forced,
	};
}

export class SqliteRouterStore implements RouterStore {
	private readonly options: SqliteRouterStoreOptions;
	private database?: DatabaseSync;
	private initialized = false;
	private available = false;
	private lastError?: string;
	private readonly now: () => number;
	private readonly busyTimeoutMs: number;
	private readonly halfLifeDays: number;
	private readonly rawRetentionDays: number;

	constructor(options: SqliteRouterStoreOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? 250));
		this.halfLifeDays = finite(options.halfLifeDays ?? 30, "halfLifeDays", Number.EPSILON);
		this.rawRetentionDays = finite(options.rawRetentionDays ?? 90, "rawRetentionDays", 1);
	}

	initialize(): StoreResult<void> {
		if (this.database && this.available) return storeSuccess(undefined);
		try {
			if (!this.options.path) throw new Error("SQLite path is required");
			if (this.options.path !== ":memory:") mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
			const db = new DatabaseSync(this.options.path);
			this.database = db;
			db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
			db.exec("PRAGMA foreign_keys = ON");
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			migrateRouterDatabase(db);
			this.initialized = true;
			this.available = true;
			this.lastError = undefined;
			return storeSuccess(undefined);
		} catch (error) {
			try { this.database?.close(); } catch { /* best effort */ }
			this.database = undefined;
			this.initialized = true;
			this.available = false;
			this.lastError = error instanceof Error ? error.message : String(error);
			return storeFailure(error, true);
		}
	}

	health(): RouterStoreHealth {
		return {
			initialized: this.initialized,
			available: this.available,
			persistent: this.options.path !== ":memory:",
			lastError: this.lastError,
		};
	}

	private run<T>(operation: (db: DatabaseSync) => T): StoreResult<T> {
		if (!this.database || !this.available) return storeFailure(this.lastError ?? "Router store is unavailable", true);
		try {
			const value = operation(this.database);
			this.lastError = undefined;
			return storeSuccess(value);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return storeFailure(error, true);
		}
	}

	private transaction<T>(db: DatabaseSync, operation: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		try {
			const value = operation();
			db.exec("COMMIT");
			return value;
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	saveDecision(decision: RouteDecision): StoreResult<void> {
		return this.run((db) => {
			if (!decision.routeId) throw new Error("routeId is required");
			integer(decision.createdAt, "createdAt");
			const json = JSON.stringify(privacySafeDecision(decision));
			const scopeKey = rolloutScopeKey(decision);
			db.prepare(`INSERT INTO route_decisions(route_id, created_at, decision_json, scope_key, route_arm) VALUES(?, ?, ?, ?, ?)
				ON CONFLICT(route_id) DO UPDATE SET created_at=excluded.created_at, decision_json=excluded.decision_json,
				scope_key=excluded.scope_key, route_arm=excluded.route_arm`)
				.run(decision.routeId, decision.createdAt, json, scopeKey, decision.arm);
		});
	}

	getDecision(routeId: string): StoreResult<RouteDecision | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT decision_json FROM route_decisions WHERE route_id = ?").get(routeId) as SqlRow | undefined;
			return row ? JSON.parse(String(row.decision_json)) as RouteDecision : undefined;
		});
	}

	getLatestDecision(): StoreResult<RouteDecision | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT decision_json FROM route_decisions ORDER BY created_at DESC, route_id DESC LIMIT 1").get() as SqlRow | undefined;
			return row ? JSON.parse(String(row.decision_json)) as RouteDecision : undefined;
		});
	}

	private writeQuality(db: DatabaseSync, routeId: string, quality: QualityLabel, recordedAt: number): void {
		finite(quality.score, "quality score");
		if (quality.score > 1) throw new Error("quality score must be <= 1");
		const weight = finite(quality.weight ?? 1, "quality weight");
		integer(recordedAt, "recordedAt");
		db.prepare(`INSERT INTO quality_labels(route_id, source, score, weight, recorded_at) VALUES(?, ?, ?, ?, ?)
			ON CONFLICT(route_id, source) DO UPDATE SET score=excluded.score, weight=excluded.weight, recorded_at=excluded.recorded_at`)
			.run(routeId, quality.source, quality.score, weight, recordedAt);
	}

	saveObservation(observation: RouteObservation): StoreResult<void> {
		return this.run((db) => this.transaction(db, () => {
			const completedAt = observation.completedAt ?? this.now();
			integer(completedAt, "completedAt");
			db.prepare(`INSERT INTO route_observations(
				route_id, completed_at, outcome, failure_domain, latency_ms, first_token_ms, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, cost_usd, provider_requests, tool_calls, context_overflow
			) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(route_id) DO UPDATE SET
				completed_at=excluded.completed_at, outcome=excluded.outcome, failure_domain=excluded.failure_domain,
				latency_ms=excluded.latency_ms, first_token_ms=excluded.first_token_ms, input_tokens=excluded.input_tokens,
				output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
				cache_write_tokens=excluded.cache_write_tokens, cost_usd=excluded.cost_usd,
				provider_requests=excluded.provider_requests, tool_calls=excluded.tool_calls, context_overflow=excluded.context_overflow`)
				.run(
					observation.routeId, completedAt, observation.outcome, nullable(observation.failureDomain),
					nullable(observation.latencyMs), nullable(observation.firstTokenMs), nullable(observation.inputTokens),
					nullable(observation.outputTokens), nullable(observation.cacheReadTokens), nullable(observation.cacheWriteTokens),
					nullable(observation.costUsd), nullable(observation.providerRequests), nullable(observation.toolCalls),
					observation.contextOverflow === undefined ? null : Number(observation.contextOverflow),
				);
			if (observation.quality) this.writeQuality(db, observation.routeId, observation.quality, completedAt);
		}));
	}

	recordQuality(routeId: string, quality: QualityLabel, recordedAt = this.now()): StoreResult<void> {
		return this.run((db) => this.writeQuality(db, routeId, quality, recordedAt));
	}

	private armStatisticsFromRow(row: SqlRow): ArmStatistics {
		return {
			armKey: String(row.arm_key), modelFingerprint: String(row.model_fingerprint), model: String(row.model),
			thinkingLevel: String(row.thinking_level) as ArmStatistics["thinkingLevel"], cohortKey: String(row.cohort_key),
			projectHash: row.project_hash === null ? undefined : String(row.project_hash), updatedAt: numberFrom(row, "updated_at"),
			reliabilityAlpha: numberFrom(row, "reliability_alpha"), reliabilityBeta: numberFrom(row, "reliability_beta"),
			qualityAlpha: numberFrom(row, "quality_alpha"), qualityBeta: numberFrom(row, "quality_beta"),
			attributableCount: numberFrom(row, "attributable_count"), qualityLabelCount: numberFrom(row, "quality_label_count"),
			humanValidatorLabelCount: numberFrom(row, "human_validator_label_count"), completedCount: numberFrom(row, "completed_count"),
			costCount: numberFrom(row, "cost_count"), costMean: numberFrom(row, "cost_mean"),
			latencyCount: numberFrom(row, "latency_count"), latencyMean: numberFrom(row, "latency_mean"),
			firstTokenCount: numberFrom(row, "first_token_count"), firstTokenMean: numberFrom(row, "first_token_mean"),
			consecutiveFailures: numberFrom(row, "consecutive_failures"),
		};
	}

	getArmStatistics(armKey: string, decayAt = this.now()): StoreResult<ArmStatistics | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT * FROM arm_statistics WHERE arm_key = ?").get(armKey) as SqlRow | undefined;
			return row ? decayArmStatistics(this.armStatisticsFromRow(row), decayAt, this.halfLifeDays) : undefined;
		});
	}

	listArmStatistics(decayAt = this.now()): StoreResult<ArmStatistics[]> {
		return this.run((db) => (db.prepare("SELECT * FROM arm_statistics ORDER BY arm_key").all() as SqlRow[])
			.map((row) => decayArmStatistics(this.armStatisticsFromRow(row), decayAt, this.halfLifeDays)));
	}

	upsertArmStatistics(s: ArmStatistics): StoreResult<void> {
		return this.run((db) => {
			db.prepare(`INSERT INTO arm_statistics VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(arm_key) DO UPDATE SET
			model_fingerprint=excluded.model_fingerprint, model=excluded.model, thinking_level=excluded.thinking_level,
			cohort_key=excluded.cohort_key, project_hash=excluded.project_hash, updated_at=excluded.updated_at,
			reliability_alpha=excluded.reliability_alpha, reliability_beta=excluded.reliability_beta,
			quality_alpha=excluded.quality_alpha, quality_beta=excluded.quality_beta, attributable_count=excluded.attributable_count,
			quality_label_count=excluded.quality_label_count, human_validator_label_count=excluded.human_validator_label_count,
			completed_count=excluded.completed_count, cost_count=excluded.cost_count, cost_mean=excluded.cost_mean,
			latency_count=excluded.latency_count, latency_mean=excluded.latency_mean, first_token_count=excluded.first_token_count,
			first_token_mean=excluded.first_token_mean, consecutive_failures=excluded.consecutive_failures`)
				.run(s.armKey, s.modelFingerprint, s.model, s.thinkingLevel, s.cohortKey, nullable(s.projectHash), s.updatedAt,
					s.reliabilityAlpha, s.reliabilityBeta, s.qualityAlpha, s.qualityBeta, s.attributableCount, s.qualityLabelCount,
					s.humanValidatorLabelCount, s.completedCount, s.costCount, s.costMean, s.latencyCount, s.latencyMean,
					s.firstTokenCount, s.firstTokenMean, s.consecutiveFailures);
		});
	}

	getMetricHistogram(key: MetricHistogramKey, decayAt = this.now()): StoreResult<MetricHistogram | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT * FROM metric_histograms WHERE arm_key = ? AND metric = ?").get(key.armKey, key.metric) as SqlRow | undefined;
			if (!row) return undefined;
			const histogram: MetricHistogram = {
				...key, boundaries: JSON.parse(String(row.boundaries_json)) as number[], counts: JSON.parse(String(row.counts_json)) as number[],
				totalCount: numberFrom(row, "total_count"), sum: numberFrom(row, "sum"), updatedAt: numberFrom(row, "updated_at"),
			};
			if (histogram.counts.length !== histogram.boundaries.length + 1) throw new Error("Malformed stored histogram");
			return decayMetricHistogram(histogram, decayAt, this.halfLifeDays);
		});
	}

	upsertMetricHistogram(h: MetricHistogram): StoreResult<void> {
		return this.run((db) => {
			if (h.counts.length !== h.boundaries.length + 1 || !h.boundaries.every(Number.isFinite) || !h.counts.every(Number.isFinite)) {
				throw new Error("Malformed histogram");
			}
			db.prepare(`INSERT INTO metric_histograms VALUES(?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(arm_key, metric) DO UPDATE SET boundaries_json=excluded.boundaries_json, counts_json=excluded.counts_json,
				total_count=excluded.total_count, sum=excluded.sum, updated_at=excluded.updated_at`)
				.run(h.armKey, h.metric, JSON.stringify(h.boundaries), JSON.stringify(h.counts), h.totalCount, h.sum, h.updatedAt);
		});
	}

	getRollout(scopeKey: string): StoreResult<RolloutState | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT * FROM rollout_states WHERE scope_key = ?").get(scopeKey) as SqlRow | undefined;
			return row ? this.rolloutFromRow(row) : undefined;
		});
	}

	private rolloutFromRow(row: SqlRow): RolloutState {
		return { scopeKey: String(row.scope_key), stage: String(row.stage) as RolloutState["stage"], enteredAt: numberFrom(row, "entered_at"),
			updatedAt: numberFrom(row, "updated_at"), softRegressionWindows: numberFrom(row, "soft_regression_windows"),
			reason: row.reason === null ? undefined : String(row.reason) };
	}

	setRollout(state: RolloutState): StoreResult<void> {
		return this.run((db) => {
			db.prepare(`INSERT INTO rollout_states VALUES(?, ?, ?, ?, ?, ?)
				ON CONFLICT(scope_key) DO UPDATE SET stage=excluded.stage, entered_at=excluded.entered_at, updated_at=excluded.updated_at,
				soft_regression_windows=excluded.soft_regression_windows, reason=excluded.reason`)
				.run(state.scopeKey, state.stage, state.enteredAt, state.updatedAt, state.softRegressionWindows, nullable(safeReason(state.reason)));
		});
	}

	listRollouts(): StoreResult<RolloutState[]> {
		return this.run((db) => (db.prepare("SELECT * FROM rollout_states ORDER BY scope_key").all() as SqlRow[]).map((row) => this.rolloutFromRow(row)));
	}

	getRolloutAggregate(scopeKey: string): StoreResult<RolloutAggregate> {
		return this.run((db) => {
			const rows = db.prepare(`SELECT d.route_id, d.route_arm, d.created_at, o.completed_at, o.outcome, o.cost_usd, o.latency_ms,
				q.source quality_source, q.score quality_score, q.weight quality_weight, q.recorded_at quality_recorded_at
				FROM route_decisions d
				LEFT JOIN route_observations o ON o.route_id=d.route_id
				LEFT JOIN quality_labels q ON q.route_id=d.route_id
				WHERE d.scope_key=? AND d.route_arm IN ('control', 'treatment')
				ORDER BY d.route_id`).all(scopeKey) as SqlRow[];
			type MutableArm = RolloutArmAggregate & { latencies: number[] };
			const empty = (): MutableArm => ({ routes: 0, completed: 0, succeeded: 0, qualityAlpha: 0, qualityBeta: 0,
				qualityLabels: 0, humanValidatorLabels: 0, observationCompleteness: 0, costKnown: 0, latencyKnown: 0,
				totalCostUsd: 0, latencies: [] });
			const arms: Record<"control" | "treatment", MutableArm> = { control: empty(), treatment: empty() };
			const seen = new Set<string>();
			let updatedAt: number | undefined;
			for (const row of rows) {
				const armName = String(row.route_arm) as "control" | "treatment";
				const arm = arms[armName];
				const routeId = String(row.route_id);
				if (!seen.has(routeId)) {
					seen.add(routeId);
					arm.routes += 1;
					if (row.completed_at !== null) arm.completed += 1;
					if (row.outcome === "succeeded") arm.succeeded += 1;
					if (row.cost_usd !== null) { arm.totalCostUsd += Number(row.cost_usd); arm.costKnown += 1; }
					if (row.latency_ms !== null) { arm.latencies.push(Number(row.latency_ms)); arm.latencyKnown += 1; }
				}
				updatedAt = Math.max(updatedAt ?? 0, Number(row.quality_recorded_at ?? row.completed_at ?? row.created_at));
				if (row.quality_source !== null) {
					const score = Number(row.quality_score);
					const weight = Number(row.quality_weight);
					arm.qualityAlpha += score * weight;
					arm.qualityBeta += (1 - score) * weight;
					arm.qualityLabels += 1;
					if (row.quality_source === "user" || row.quality_source === "validator") arm.humanValidatorLabels += 1;
				}
			}
			const finish = (arm: MutableArm): RolloutArmAggregate => {
				arm.latencies.sort((a, b) => a - b);
				const latencyP95Ms = arm.latencies.length > 0 ? arm.latencies[Math.max(0, Math.ceil(arm.latencies.length * 0.95) - 1)] : undefined;
				return { routes: arm.routes, completed: arm.completed, succeeded: arm.succeeded,
					qualityAlpha: arm.qualityAlpha, qualityBeta: arm.qualityBeta, qualityLabels: arm.qualityLabels,
					humanValidatorLabels: arm.humanValidatorLabels,
					observationCompleteness: arm.routes > 0 ? arm.completed / arm.routes : 0,
					costKnown: arm.costKnown,
					latencyKnown: arm.latencyKnown,
					totalCostUsd: arm.totalCostUsd,
					costPerSuccessUsd: arm.succeeded > 0 ? arm.totalCostUsd / arm.succeeded : undefined,
					latencyP95Ms };
			};
			return { scopeKey, control: finish(arms.control), treatment: finish(arms.treatment), updatedAt };
		});
	}

	getCircuitBreaker(key: string): StoreResult<CircuitBreakerState | undefined> {
		return this.run((db) => {
			const row = db.prepare("SELECT * FROM circuit_breakers WHERE circuit_key = ?").get(key) as SqlRow | undefined;
			return row ? { key: String(row.circuit_key), failureCount: numberFrom(row, "failure_count"),
				openedAt: row.opened_at === null ? undefined : numberFrom(row, "opened_at"),
				openUntil: row.open_until === null ? undefined : numberFrom(row, "open_until"), updatedAt: numberFrom(row, "updated_at"),
				reason: row.reason === null ? undefined : String(row.reason) } : undefined;
		});
	}

	setCircuitBreaker(state: CircuitBreakerState): StoreResult<void> {
		return this.run((db) => {
			db.prepare(`INSERT INTO circuit_breakers VALUES(?, ?, ?, ?, ?, ?)
				ON CONFLICT(circuit_key) DO UPDATE SET failure_count=excluded.failure_count, opened_at=excluded.opened_at,
				open_until=excluded.open_until, updated_at=excluded.updated_at, reason=excluded.reason`)
				.run(state.key, state.failureCount, nullable(state.openedAt), nullable(state.openUntil), state.updatedAt, nullable(safeReason(state.reason)));
		});
	}

	getSummary(now = this.now()): StoreResult<RouterStoreSummary> {
		return this.run((db) => {
			const row = db.prepare(`SELECT
				(SELECT COUNT(*) FROM route_decisions) total_routes,
				(SELECT COUNT(*) FROM route_observations) total_observations,
				(SELECT COUNT(*) FROM quality_labels) quality_labels,
				(SELECT COUNT(*) FROM arm_statistics) arm_statistics,
				(SELECT COUNT(*) FROM circuit_breakers WHERE opened_at IS NOT NULL AND (open_until IS NULL OR open_until > ?)) open_circuits,
				(SELECT MIN(created_at) FROM route_decisions) oldest_route_at,
				(SELECT MAX(created_at) FROM route_decisions) latest_route_at`).get(now) as SqlRow;
			return { totalRoutes: numberFrom(row, "total_routes"), totalObservations: numberFrom(row, "total_observations"),
				qualityLabels: numberFrom(row, "quality_labels"), armStatistics: numberFrom(row, "arm_statistics"), openCircuits: numberFrom(row, "open_circuits"),
				oldestRouteAt: row.oldest_route_at === null ? undefined : numberFrom(row, "oldest_route_at"),
				latestRouteAt: row.latest_route_at === null ? undefined : numberFrom(row, "latest_route_at") };
		});
	}

	prune(before = this.now() - this.rawRetentionDays * DAY_MS): StoreResult<PruneResult> {
		return this.run((db) => this.transaction(db, () => {
			integer(Math.floor(before), "before");
			const routes = Number(db.prepare("DELETE FROM route_decisions WHERE created_at < ?").run(before).changes);
			const judgeReservations = Number(db.prepare("DELETE FROM judge_budget_reservations WHERE status = 'recorded' AND completed_at < ?").run(before).changes);
			return { before, routes, judgeReservations };
		}));
	}

	reserveJudgeBudget(request: JudgeBudgetRequest): StoreResult<JudgeBudgetReservation | undefined> {
		return this.run((db) => this.transaction(db, () => {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(request.day)) throw new Error("Judge budget day must be YYYY-MM-DD");
			finite(request.amountUsd, "amountUsd");
			finite(request.maxDailyUsd, "maxDailyUsd");
			const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='pending' THEN reserved_usd ELSE actual_usd END), 0) used
				FROM judge_budget_reservations WHERE budget_day = ?`).get(request.day) as SqlRow;
			if (numberFrom(row, "used") + request.amountUsd > request.maxDailyUsd + Number.EPSILON) return undefined;
			const reservation: JudgeBudgetReservation = { reservationId: randomUUID(), day: request.day,
				amountUsd: request.amountUsd, createdAt: request.createdAt ?? this.now() };
			db.prepare("INSERT INTO judge_budget_reservations VALUES(?, ?, ?, NULL, 'pending', ?, NULL)")
				.run(reservation.reservationId, reservation.day, reservation.amountUsd, reservation.createdAt);
			return reservation;
		}));
	}

	recordJudgeBudget(reservationId: string, actualCostUsd: number, completedAt = this.now()): StoreResult<void> {
		return this.run((db) => this.transaction(db, () => {
			finite(actualCostUsd, "actualCostUsd");
			const row = db.prepare("SELECT reserved_usd FROM judge_budget_reservations WHERE reservation_id = ?").get(reservationId) as SqlRow | undefined;
			if (!row) throw new Error("Unknown judge budget reservation");
			const actual = Math.min(actualCostUsd, numberFrom(row, "reserved_usd"));
			db.prepare("UPDATE judge_budget_reservations SET actual_usd=?, status='recorded', completed_at=? WHERE reservation_id=?")
				.run(actual, completedAt, reservationId);
		}));
	}

	getJudgeBudget(day: string): StoreResult<JudgeBudgetStatus> {
		return this.run((db) => {
			const row = db.prepare(`SELECT
				COALESCE(SUM(CASE WHEN status='pending' THEN reserved_usd ELSE 0 END), 0) reserved,
				COALESCE(SUM(CASE WHEN status='recorded' THEN actual_usd ELSE 0 END), 0) spent
				FROM judge_budget_reservations WHERE budget_day=?`).get(day) as SqlRow;
			return { day, reservedUsd: numberFrom(row, "reserved"), spentUsd: numberFrom(row, "spent") };
		});
	}

	close(): StoreResult<void> {
		if (!this.database) {
			this.available = false;
			return storeSuccess(undefined);
		}
		try {
			const db = this.database;
			this.database = undefined;
			db.close();
			this.available = false;
			return storeSuccess(undefined);
		} catch (error) {
			this.available = false;
			this.lastError = error instanceof Error ? error.message : String(error);
			return storeFailure(error, false);
		}
	}
}
