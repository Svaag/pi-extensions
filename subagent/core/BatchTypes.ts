import type { ContextMode, RoutingDecision, RoutingMode, RoutingObjective, ThinkingLevel, WriteMode } from "./AgentTypes.ts";

export type BatchSourceType = "csv" | "jsonl";
export type BatchJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type BatchItemStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost";

export interface BatchInputRow {
	itemId: string;
	rowIndex: number;
	data: Record<string, unknown>;
}

export interface BatchJobItem {
	itemId: string;
	rowIndex: number;
	data: Record<string, unknown>;
	status: BatchItemStatus;
	agentId?: string;
	taskPath?: string;
	prompt?: string;
	summary?: string;
	output?: string;
	error?: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
}

export interface BatchJobCounts {
	total: number;
	queued: number;
	running: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	lost: number;
}

export interface BatchJob {
	jobId: string;
	name: string;
	sourceType: BatchSourceType;
	sourcePath?: string;
	promptTemplate: string;
	idColumn?: string;
	status: BatchJobStatus;
	counts: BatchJobCounts;
	maxConcurrency: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	timeoutMs?: number;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	routingDecision?: RoutingDecision;
	writeMode: WriteMode;
	allowedPaths: string[];
	contextMode: ContextMode;
	cancelRequested?: boolean;
	resultPath?: string;
	items: BatchJobItem[];
}

export interface BatchJobSummary extends Omit<BatchJob, "items"> {
	items?: BatchJobItem[];
}

export interface CreateBatchJobRequest {
	name?: string;
	sourceType: BatchSourceType;
	sourcePath?: string;
	rows: BatchInputRow[];
	promptTemplate: string;
	idColumn?: string;
	maxConcurrency?: number;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	timeoutMs?: number;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	routingDecision?: RoutingDecision;
	writeMode?: WriteMode;
	allowedPaths?: string[];
	contextMode?: ContextMode;
	resultPath?: string;
}

export interface ExportBatchResult {
	jobId: string;
	path: string;
	format: "jsonl" | "csv";
	rows: number;
}
