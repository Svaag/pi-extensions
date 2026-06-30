import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentManager } from "./AgentManager.ts";
import type { AgentRecord } from "./AgentTypes.ts";
import type {
	BatchInputRow,
	BatchJob,
	BatchJobCounts,
	BatchJobItem,
	BatchJobStatus,
	BatchJobSummary,
	CreateBatchJobRequest,
	ExportBatchResult,
} from "./BatchTypes.ts";
import { createId, isPathInside, nowMs, slugifyTaskName, summarizeText, truncateMiddle } from "./utils.ts";

export const SUBAGENT_BATCH_EVENT_ENTRY = "subagent-batch-event";
export const SUBAGENT_BATCH_JOB_STATE_ENTRY = "subagent-batch-job-state";

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_MAX_CONCURRENCY = 16;
const MAX_ITEM_OUTPUT_CHARS = 20_000;

export interface BatchEntryAppender {
	appendEntry(customType: string, data?: unknown): void;
}

export interface BatchSessionEntryLike {
	type?: string;
	customType?: string;
	data?: any;
}

export interface BatchJobManagerOptions {
	agentManager: AgentManager;
	appender: BatchEntryAppender;
	rootCwd: string;
	restoredJobs?: BatchJob[];
	onChange?: (manager: BatchJobManager) => void;
}

function emptyCounts(total: number): BatchJobCounts {
	return { total, queued: total, running: 0, succeeded: 0, failed: 0, cancelled: 0, lost: 0 };
}

function computeCounts(items: BatchJobItem[]): BatchJobCounts {
	return {
		total: items.length,
		queued: items.filter((item) => item.status === "queued").length,
		running: items.filter((item) => item.status === "running").length,
		succeeded: items.filter((item) => item.status === "succeeded").length,
		failed: items.filter((item) => item.status === "failed").length,
		cancelled: items.filter((item) => item.status === "cancelled").length,
		lost: items.filter((item) => item.status === "lost").length,
	};
}

function cloneJob(job: BatchJob, includeItems = true): BatchJob {
	return {
		...job,
		allowedPaths: [...job.allowedPaths],
		counts: { ...job.counts },
		routingDecision: job.routingDecision
			? {
					...job.routingDecision,
					candidates: job.routingDecision.candidates.map((candidate) => ({
						...candidate,
						notes: [...candidate.notes],
					})),
				}
			: undefined,
		items: includeItems ? job.items.map((item) => ({ ...item, data: { ...item.data } })) : [],
	};
}

function terminalStatus(status: BatchJobStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

function itemTerminal(status: BatchJobItem["status"]): boolean {
	return status !== "queued" && status !== "running";
}

function safeJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function csvEscape(value: unknown): string {
	const text = String(value ?? "");
	if (!/[",\n\r]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

export function parseCsvRows(text: string, idColumn?: string): BatchInputRow[] {
	const rows: string[][] = [];
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			field = "";
			if (row.some((cell) => cell.trim() !== "")) rows.push(row);
			row = [];
		} else if (ch !== "\r") {
			field += ch;
		}
	}
	row.push(field);
	if (row.some((cell) => cell.trim() !== "")) rows.push(row);
	if (rows.length === 0) return [];
	const headers = rows[0].map((header) => header.trim());
	return rows.slice(1).map((cells, index) => {
		const data: Record<string, unknown> = {};
		for (let i = 0; i < headers.length; i++) data[headers[i] || `column_${i + 1}`] = cells[i] ?? "";
		const rawId = idColumn ? data[idColumn] : undefined;
		return { itemId: slugifyTaskName(String(rawId ?? index + 1)), rowIndex: index + 1, data };
	});
}

export function parseJsonlRows(text: string, idField = "id"): BatchInputRow[] {
	return text
		.split("\n")
		.map((line, index) => ({ line: line.trim(), index }))
		.filter(({ line }) => line.length > 0)
		.map(({ line, index }) => {
			const data = JSON.parse(line) as Record<string, unknown>;
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`JSONL line ${index + 1} must be an object`);
			return { itemId: slugifyTaskName(String(data[idField] ?? index + 1)), rowIndex: index + 1, data };
		});
}

export function interpolatePrompt(template: string, data: Record<string, unknown>): string {
	return template.replace(/\{\{\s*([\w.-]+)\s*\}\}|\{\s*([\w.-]+)\s*\}/g, (_match, mustacheKey, braceKey) => {
		const key = mustacheKey ?? braceKey;
		const value = data[key];
		return value === undefined || value === null ? "" : String(value);
	});
}

export async function readRowsFromCsv(pathOrText: { path?: string; text?: string }, cwd: string, idColumn?: string): Promise<{ rows: BatchInputRow[]; sourcePath?: string }> {
	if (pathOrText.path) {
		const sourcePath = resolve(cwd, pathOrText.path.replace(/^@/, ""));
		return { rows: parseCsvRows(await readFile(sourcePath, "utf8"), idColumn), sourcePath };
	}
	return { rows: parseCsvRows(pathOrText.text ?? "", idColumn) };
}

export async function readRowsFromJsonl(pathOrText: { path?: string; text?: string }, cwd: string, idField?: string): Promise<{ rows: BatchInputRow[]; sourcePath?: string }> {
	if (pathOrText.path) {
		const sourcePath = resolve(cwd, pathOrText.path.replace(/^@/, ""));
		return { rows: parseJsonlRows(await readFile(sourcePath, "utf8"), idField), sourcePath };
	}
	return { rows: parseJsonlRows(pathOrText.text ?? "", idField) };
}

export class BatchJobManager {
	private readonly agentManager: AgentManager;
	private readonly appender: BatchEntryAppender;
	private readonly rootCwd: string;
	private readonly onChange?: (manager: BatchJobManager) => void;
	private readonly jobs = new Map<string, BatchJob>();
	private readonly pumps = new Set<string>();
	private readonly waiters = new Set<() => void>();

	constructor(options: BatchJobManagerOptions) {
		this.agentManager = options.agentManager;
		this.appender = options.appender;
		this.rootCwd = options.rootCwd;
		this.onChange = options.onChange;
		for (const restored of options.restoredJobs ?? []) this.jobs.set(restored.jobId, cloneJob(restored));
	}

	static restore(entries: BatchSessionEntryLike[]): BatchJob[] {
		const jobs = new Map<string, BatchJob>();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_BATCH_JOB_STATE_ENTRY || !entry.data?.job?.jobId) continue;
			const job = cloneJob(entry.data.job as BatchJob);
			if (job.status === "queued" || job.status === "running") {
				const now = nowMs();
				for (const item of job.items) {
					if (item.status === "queued" || item.status === "running") {
						item.status = "lost";
						item.error = item.error ?? "Batch worker was not resumed after session restart.";
						item.finishedAt = now;
						item.updatedAt = now;
					}
				}
				job.status = "failed";
				job.finishedAt = now;
				job.updatedAt = now;
				job.counts = computeCounts(job.items);
			}
			jobs.set(job.jobId, job);
		}
		return [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	createJob(request: CreateBatchJobRequest): BatchJobSummary {
		if (request.rows.length === 0) throw new Error("Batch job requires at least one input row.");
		const now = nowMs();
		const jobId = createId("job");
		const maxConcurrency = Math.max(1, Math.min(Math.floor(request.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY), MAX_MAX_CONCURRENCY));
		const items: BatchJobItem[] = request.rows.map((row) => ({
			itemId: row.itemId,
			rowIndex: row.rowIndex,
			data: { ...row.data },
			status: "queued",
			createdAt: now,
			updatedAt: now,
		}));
		const job: BatchJob = {
			jobId,
			name: request.name || `${request.sourceType}-${jobId.slice(-8)}`,
			sourceType: request.sourceType,
			sourcePath: request.sourcePath,
			promptTemplate: request.promptTemplate,
			idColumn: request.idColumn,
			status: "queued",
			counts: emptyCounts(items.length),
			maxConcurrency,
			createdAt: now,
			updatedAt: now,
			cwd: request.cwd,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			timeoutMs: request.timeoutMs,
			routingMode: request.routingMode,
			routingProfile: request.routingProfile,
			routingDecision: request.routingDecision,
			writeMode: request.writeMode ?? "read_only",
			allowedPaths: request.allowedPaths ?? [],
			contextMode: request.contextMode ?? "fresh",
			resultPath: request.resultPath,
			items,
		};
		this.jobs.set(jobId, job);
		this.appendEvent("batch.started", jobId, { sourceType: job.sourceType, total: items.length, maxConcurrency });
		this.saveJob(job);
		void this.pump(jobId);
		return this.summary(job, true);
	}

	listJobs(opts: { includeCompleted?: boolean; jobId?: string } = {}): BatchJobSummary[] {
		return [...this.jobs.values()]
			.filter((job) => !opts.jobId || job.jobId === opts.jobId)
			.filter((job) => opts.includeCompleted || !terminalStatus(job.status))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((job) => this.summary(job, true));
	}

	getJob(jobId: string): BatchJob | undefined {
		const job = this.jobs.get(jobId);
		return job ? cloneJob(job) : undefined;
	}

	async waitJob(jobId: string, timeoutMs = 60_000): Promise<BatchJobSummary> {
		const deadline = nowMs() + timeoutMs;
		while (true) {
			const job = this.requireJob(jobId);
			this.updateItemsFromAgents(job);
			if (terminalStatus(job.status)) return this.summary(job, true);
			const remaining = deadline - nowMs();
			if (remaining <= 0) return this.summary(job, true);
			await this.waitForChange(Math.min(remaining, 1000));
		}
	}

	async cancelJob(jobId: string, reason = "cancelled by parent"): Promise<BatchJobSummary> {
		const job = this.requireJob(jobId);
		job.cancelRequested = true;
		job.updatedAt = nowMs();
		for (const item of job.items) {
			if (item.status === "queued") this.markItem(job, item, "cancelled", { error: reason });
			else if (item.status === "running" && item.agentId) await this.agentManager.interruptAgent(item.agentId, reason);
		}
		this.updateItemsFromAgents(job);
		if (job.counts.running === 0) this.finishJob(job, "cancelled");
		else this.saveJob(job);
		this.notifyChange();
		return this.summary(job, true);
	}

	async exportResults(jobId: string, outputPath: string | undefined, format: "jsonl" | "csv" = "jsonl"): Promise<ExportBatchResult> {
		const job = this.requireJob(jobId);
		const path = resolve(this.rootCwd, (outputPath ?? job.resultPath ?? `${job.name}-results.${format}`).replace(/^@/, ""));
		if (!isPathInside(path, this.rootCwd)) throw new Error(`Export path ${path} is outside ${this.rootCwd}`);
		await mkdir(dirname(path), { recursive: true });
		const rows = job.items.map((item) => ({
			jobId: job.jobId,
			itemId: item.itemId,
			rowIndex: item.rowIndex,
			status: item.status,
			agentId: item.agentId,
			summary: item.summary,
			output: item.output,
			error: item.error,
			data: item.data,
		}));
		if (format === "jsonl") {
			await writeFile(path, `${rows.map((row) => safeJson(row)).join("\n")}\n`, "utf8");
		} else {
			const headers = ["jobId", "itemId", "rowIndex", "status", "agentId", "summary", "output", "error", "data"];
			const body = rows.map((row) => headers.map((header) => csvEscape((row as any)[header] && typeof (row as any)[header] === "object" ? JSON.stringify((row as any)[header]) : (row as any)[header])).join(","));
			await writeFile(path, `${headers.join(",")}\n${body.join("\n")}\n`, "utf8");
		}
		job.resultPath = path;
		job.updatedAt = nowMs();
		this.appendEvent("batch.exported", jobId, { path, format, rows: rows.length });
		this.saveJob(job);
		return { jobId, path, format, rows: rows.length };
	}

	private async pump(jobId: string): Promise<void> {
		if (this.pumps.has(jobId)) return;
		this.pumps.add(jobId);
		try {
			while (true) {
				const job = this.jobs.get(jobId);
				if (!job || terminalStatus(job.status)) return;
				this.updateItemsFromAgents(job);
				if (job.cancelRequested) {
					if (job.counts.running === 0) this.finishJob(job, "cancelled");
					else this.saveJob(job);
					return;
				}
				while (job.counts.running < job.maxConcurrency) {
					const item = job.items.find((candidate) => candidate.status === "queued");
					if (!item) break;
					await this.startItem(job, item);
					this.updateItemsFromAgents(job);
				}
				if (job.counts.queued === 0 && job.counts.running === 0) {
					this.finishJob(job, job.counts.failed > 0 || job.counts.lost > 0 ? "failed" : job.counts.cancelled > 0 ? "cancelled" : "succeeded");
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} finally {
			this.pumps.delete(jobId);
		}
	}

	private async startItem(job: BatchJob, item: BatchJobItem): Promise<void> {
		const now = nowMs();
		item.prompt = interpolatePrompt(job.promptTemplate, item.data);
		this.markItem(job, item, "running", { startedAt: now });
		job.status = "running";
		job.startedAt = job.startedAt ?? now;
		try {
			const record = await this.agentManager.spawnAgent({
				taskName: `${slugifyTaskName(job.name)}_${item.itemId}`,
				prompt: item.prompt,
				cwd: job.cwd,
				jobId: job.jobId,
				contextMode: job.contextMode,
				writeMode: job.writeMode,
				allowedPaths: job.allowedPaths,
				model: job.model,
				thinkingLevel: job.thinkingLevel,
				timeoutMs: job.timeoutMs,
				routingMode: job.routingMode,
				routingProfile: job.routingProfile,
				routingDecision: job.routingDecision,
			});
			item.agentId = record.agentId;
			item.taskPath = record.taskPath;
			this.appendEvent("batch.worker_started", job.jobId, { itemId: item.itemId, agentId: item.agentId, taskPath: item.taskPath });
			this.saveJob(job);
		} catch (error) {
			this.markItem(job, item, "failed", { error: error instanceof Error ? error.message : String(error), finishedAt: nowMs() });
			this.appendEvent("batch.worker_result", job.jobId, { itemId: item.itemId, status: item.status, error: item.error });
		}
	}

	private updateItemsFromAgents(job: BatchJob): void {
		let changed = false;
		for (const item of job.items) {
			if (item.status !== "running" || !item.agentId) continue;
			const record = this.agentManager.getRecord(item.agentId);
			if (!record) continue;
			if (record.status === "queued" || record.status === "running") continue;
			this.completeItemFromRecord(job, item, record);
			changed = true;
		}
		job.counts = computeCounts(job.items);
		if (changed) this.saveJob(job);
	}

	private completeItemFromRecord(job: BatchJob, item: BatchJobItem, record: AgentRecord): void {
		const output = truncateMiddle(record.result?.output ?? record.outputTail ?? "", MAX_ITEM_OUTPUT_CHARS);
		const summary = record.result?.summary ?? summarizeText(output, 800);
		if (record.status === "succeeded" || record.result?.status === "succeeded") {
			this.markItem(job, item, "succeeded", { output, summary, finishedAt: record.finishedAt ?? nowMs() });
		} else if (record.status === "interrupted" || record.status === "closed") {
			this.markItem(job, item, "cancelled", { output, summary, error: record.error ?? record.result?.summary, finishedAt: record.finishedAt ?? nowMs() });
		} else if (record.status === "lost") {
			this.markItem(job, item, "lost", { output, summary, error: record.error ?? "Agent was lost.", finishedAt: record.finishedAt ?? nowMs() });
		} else {
			this.markItem(job, item, "failed", { output, summary, error: record.error ?? record.result?.summary ?? "Worker failed.", finishedAt: record.finishedAt ?? nowMs() });
		}
		this.appendEvent("batch.worker_result", job.jobId, { itemId: item.itemId, status: item.status, agentId: item.agentId, summary: item.summary, error: item.error });
	}

	private markItem(job: BatchJob, item: BatchJobItem, status: BatchJobItem["status"], patch: Partial<BatchJobItem> = {}): void {
		Object.assign(item, patch);
		item.status = status;
		item.updatedAt = nowMs();
		if (itemTerminal(status)) item.finishedAt = item.finishedAt ?? item.updatedAt;
		job.counts = computeCounts(job.items);
		job.updatedAt = item.updatedAt;
	}

	private finishJob(job: BatchJob, status: BatchJobStatus): void {
		job.status = status;
		job.finishedAt = nowMs();
		job.updatedAt = job.finishedAt;
		job.counts = computeCounts(job.items);
		this.appendEvent(status === "succeeded" ? "batch.completed" : status === "cancelled" ? "batch.cancelled" : "batch.failed", job.jobId, { counts: job.counts });
		this.saveJob(job);
	}

	private saveJob(job: BatchJob): void {
		this.appender.appendEntry(SUBAGENT_BATCH_JOB_STATE_ENTRY, { job: cloneJob(job), savedAt: nowMs() });
		this.notifyChange();
	}

	private appendEvent(type: string, jobId: string, data: Record<string, unknown> = {}): void {
		this.appender.appendEntry(SUBAGENT_BATCH_EVENT_ENTRY, { eventId: createId("batch_evt"), type, jobId, createdAt: nowMs(), data });
	}

	private summary(job: BatchJob, includeItems = false): BatchJobSummary {
		const cloned = cloneJob(job, includeItems);
		if (!includeItems) cloned.items = [];
		return cloned;
	}

	private requireJob(jobId: string): BatchJob {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown jobId: ${jobId}`);
		return job;
	}

	private waitForChange(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(done);
				resolve();
			}, timeoutMs);
			const done = () => {
				clearTimeout(timeout);
				this.waiters.delete(done);
				resolve();
			};
			this.waiters.add(done);
		});
	}

	private notifyChange(): void {
		for (const waiter of [...this.waiters]) waiter();
		this.onChange?.(this);
	}
}
