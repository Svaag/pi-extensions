// Runtime-agnostic SQLite driver for pi extensions.
//
// pi ships as a Bun-compiled binary whose module resolver exposes `bun:sqlite`
// but not Node's `node:sqlite` built-in (loading `node:sqlite` under Bun fails
// with "No such built-in module: node:sqlite"). When this module runs under Bun
// (inside pi) we adapt `bun:sqlite` to the subset of the `node:sqlite` surface
// that the router store and migrations actually use: `DatabaseSync` with
// `prepare`/`exec`/`close` and statements with `all`/`get`/`run`. Under plain
// Node (the test suite and local development) we re-export `node:sqlite`
// directly so behaviour is unchanged.
//
// Top-level await preloads the driver once at module load so that the existing
// `new DatabaseSync(path)` call site stays synchronous.

import type {
	DatabaseSync as NodeDatabaseSync,
	StatementSync as NodeStatementSync,
} from "node:sqlite";

export type DatabaseSync = NodeDatabaseSync;
export type StatementSync = NodeStatementSync;

type DatabaseSyncCtor = new (location: string) => NodeDatabaseSync;

// Minimal structural view of the bun:sqlite driver we depend on. Kept local so
// this file compiles under Node without bun:sqlite type declarations.
interface BunStatement {
	all(...params: unknown[]): Record<string, unknown>[];
	get(...params: unknown[]): Record<string, unknown> | null;
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface BunDatabase {
	prepare(sql: string): BunStatement;
	exec(sql: string): unknown;
	close(): void;
}
interface BunSqliteModule {
	Database: new (filename: string, options?: Record<string, unknown>) => BunDatabase;
}

const bunGlobal = globalThis as unknown as { Bun?: unknown };
const isBunRuntime = typeof bunGlobal.Bun !== "undefined";

let ctor: DatabaseSyncCtor;

if (isBunRuntime) {
	// Non-literal specifier: tsc types this as Promise<any> and does not try to
	// resolve `bun:sqlite` (which has no type declarations under Node).
	const bunSqliteSpecifier = "bun:sqlite";
	const sqlite = (await import(bunSqliteSpecifier)) as BunSqliteModule;

	class BunDatabaseSync {
		private readonly db: BunDatabase;

		constructor(location: string) {
			this.db = new sqlite.Database(location);
		}

		prepare(sql: string): NodeStatementSync {
			const stmt = this.db.prepare(sql);
			// Adapt to node:sqlite semantics: get() returns undefined (not null)
			// when no row matches; run() exposes changes/lastInsertRowid, which
			// is all the store reads off the result.
			return {
				all: (...params: unknown[]) => stmt.all(...params),
				get: (...params: unknown[]) => {
					const row = stmt.get(...params);
					return row ?? undefined;
				},
				run: (...params: unknown[]) => stmt.run(...params),
			} as unknown as NodeStatementSync;
		}

		exec(sql: string): void {
			this.db.exec(sql);
		}

		close(): void {
			this.db.close();
		}
	}

	ctor = BunDatabaseSync as unknown as DatabaseSyncCtor;
} else {
	const nodeSqlite = await import("node:sqlite");
	ctor = nodeSqlite.DatabaseSync as DatabaseSyncCtor;
}

export const DatabaseSync: DatabaseSyncCtor = ctor;
