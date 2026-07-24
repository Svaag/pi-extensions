import type { DatabaseSync } from "node:sqlite";

export interface RouterMigration {
	version: number;
	name: string;
	sql: string;
}

export const ROUTER_MIGRATIONS: readonly RouterMigration[] = [
	{
		version: 1,
		name: "initial_privacy_safe_router_store",
		sql: `
CREATE TABLE route_decisions (
  route_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  decision_json TEXT NOT NULL
) STRICT;
CREATE INDEX route_decisions_created_at ON route_decisions(created_at);

CREATE TABLE route_observations (
  route_id TEXT PRIMARY KEY REFERENCES route_decisions(route_id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  failure_domain TEXT,
  latency_ms REAL,
  first_token_ms REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  provider_requests INTEGER,
  tool_calls INTEGER,
  context_overflow INTEGER
) STRICT;
CREATE INDEX route_observations_completed_at ON route_observations(completed_at);

CREATE TABLE quality_labels (
  route_id TEXT NOT NULL REFERENCES route_decisions(route_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
  weight REAL NOT NULL CHECK(weight >= 0),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(route_id, source)
) STRICT, WITHOUT ROWID;
CREATE INDEX quality_labels_recorded_at ON quality_labels(recorded_at);

CREATE TABLE arm_statistics (
  arm_key TEXT PRIMARY KEY,
  model_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  cohort_key TEXT NOT NULL,
  project_hash TEXT,
  updated_at INTEGER NOT NULL,
  reliability_alpha REAL NOT NULL,
  reliability_beta REAL NOT NULL,
  quality_alpha REAL NOT NULL,
  quality_beta REAL NOT NULL,
  attributable_count REAL NOT NULL,
  quality_label_count REAL NOT NULL,
  human_validator_label_count REAL NOT NULL,
  completed_count REAL NOT NULL,
  cost_count REAL NOT NULL,
  cost_mean REAL NOT NULL,
  latency_count REAL NOT NULL,
  latency_mean REAL NOT NULL,
  first_token_count REAL NOT NULL,
  first_token_mean REAL NOT NULL,
  consecutive_failures INTEGER NOT NULL
) STRICT;
CREATE INDEX arm_statistics_cohort ON arm_statistics(cohort_key, project_hash);

CREATE TABLE metric_histograms (
  arm_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  boundaries_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  total_count REAL NOT NULL,
  sum REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(arm_key, metric)
) STRICT, WITHOUT ROWID;

CREATE TABLE rollout_states (
  scope_key TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  soft_regression_windows INTEGER NOT NULL,
  reason TEXT
) STRICT;

CREATE TABLE circuit_breakers (
  circuit_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  opened_at INTEGER,
  open_until INTEGER,
  updated_at INTEGER NOT NULL,
  reason TEXT
) STRICT;
CREATE INDEX circuit_breakers_open_until ON circuit_breakers(open_until);

CREATE TABLE judge_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  budget_day TEXT NOT NULL,
  reserved_usd REAL NOT NULL CHECK(reserved_usd >= 0),
  actual_usd REAL CHECK(actual_usd >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'recorded')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX judge_budget_day_status ON judge_budget_reservations(budget_day, status);
`,
	},
	{
		version: 2,
		name: "rollout_aggregate_dimensions",
		sql: `
ALTER TABLE route_decisions ADD COLUMN scope_key TEXT;
ALTER TABLE route_decisions ADD COLUMN route_arm TEXT;
CREATE INDEX route_decisions_scope_arm ON route_decisions(scope_key, route_arm);
`,
	},
];

export const LATEST_ROUTER_SCHEMA_VERSION = ROUTER_MIGRATIONS.at(-1)?.version ?? 0;

/** Applies all pending migrations in one immediate transaction. */
export function migrateRouterDatabase(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
	const current = Number(row?.user_version ?? 0);
	if (!Number.isSafeInteger(current) || current < 0 || current > LATEST_ROUTER_SCHEMA_VERSION) {
		throw new Error(`Unsupported router database schema version: ${current}`);
	}
	const pending = ROUTER_MIGRATIONS.filter((migration) => migration.version > current);
	if (pending.length === 0) return;
	let expected = current + 1;
	for (const migration of pending) {
		if (migration.version !== expected) throw new Error(`Missing router migration ${expected}`);
		expected += 1;
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const migration of pending) {
			db.exec(migration.sql);
			db.exec(`PRAGMA user_version = ${migration.version}`);
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the migration error.
		}
		throw error;
	}
}
