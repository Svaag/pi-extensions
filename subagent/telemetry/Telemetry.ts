import type { AgentProcessState, AgentStatus, ComplexityTier, ContextMode, RoutingMode, RoutingObjective, ThinkingLevel, WriteMode } from "../core/AgentTypes.ts";

export type TelemetryOutcome = "succeeded" | "failed" | "interrupted" | "cancelled" | "lost" | "closed" | "timeout" | "unknown";
export type TelemetryTurnKind = "initial" | "live_followup" | "spawned_followup" | "recovery";
export type TelemetryRecoveryType = "context_overflow" | "runtime_timeout" | "compaction";
export type TelemetryMessageKind = "message" | "correction" | "constraint" | "note" | "followup";
export type TelemetryDeliveryMode = "rpc_steer" | "rpc_follow_up" | "rpc_prompt" | "spawn_followup" | "mailbox_only" | "unavailable";
export type TelemetryBatchSource = "csv" | "jsonl";

export interface SessionTelemetryInput {
	sessionId?: string;
	projectPath: string;
	startedAt?: number;
}

export interface SessionEndTelemetryInput {
	endedAt?: number;
	reason?: "shutdown" | "reload" | "new" | "resume" | "fork" | "unknown";
}

export interface AgentTelemetryDescriptor {
	agentId: string;
	parentAgentId?: string | null;
	jobId?: string;
	taskPath: string;
	projectPath: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	intent?: string;
	complexityTier?: ComplexityTier;
	complexityScore?: number;
	writeMode: WriteMode;
	contextMode: ContextMode;
	promptChars: number;
	createdAt: number;
}

export interface AgentStateTelemetryInput {
	agentId: string;
	status: AgentStatus;
	processState: AgentProcessState;
	controllable: boolean;
	at?: number;
	error?: unknown;
}

export interface AgentCompletionTelemetryInput extends AgentStateTelemetryInput {
	outcome: TelemetryOutcome;
	outputChars?: number;
	durationMs?: number;
	queueDurationMs?: number;
	startupDurationMs?: number;
	firstProgressMs?: number;
	turns?: number;
	toolCalls?: number;
	providerRequests?: number;
	compactions?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface TurnTelemetryInput {
	agentId: string;
	turnId: string;
	kind: TelemetryTurnKind;
	at?: number;
}

export interface TurnCompletionTelemetryInput extends TurnTelemetryInput {
	outcome: TelemetryOutcome;
	durationMs?: number;
	outputChars?: number;
	toolCalls?: number;
	providerRequests?: number;
	compactions?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	error?: unknown;
}

export interface RpcTelemetryInput {
	agentId: string;
	turnId?: string;
	requestId: string;
	command: string;
	at?: number;
}

export interface RpcCompletionTelemetryInput extends RpcTelemetryInput {
	outcome: TelemetryOutcome;
	durationMs?: number;
	error?: unknown;
}

export interface ToolTelemetryInput {
	agentId: string;
	turnId?: string;
	toolCallId: string;
	toolName: string;
	at?: number;
}

export interface ToolCompletionTelemetryInput extends ToolTelemetryInput {
	outcome: TelemetryOutcome;
	durationMs?: number;
	resultChars?: number;
	resultTruncated?: boolean;
	error?: unknown;
}

export interface RecoveryTelemetryInput {
	agentId: string;
	turnId?: string;
	type: TelemetryRecoveryType;
	phase: "started" | "completed";
	outcome?: TelemetryOutcome;
	at?: number;
	durationMs?: number;
	error?: unknown;
}

export interface RoutingTelemetryInput {
	agentId: string;
	routeId?: string;
	mode: RoutingMode;
	profile: RoutingObjective;
	intent: string;
	complexityTier: ComplexityTier;
	complexityScore: number;
	selectedModel?: string;
	selectedThinkingLevel?: ThinkingLevel;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	applied: boolean;
	at?: number;
}

export interface MessageTelemetryInput {
	agentId: string;
	kind: TelemetryMessageKind;
	deliveryMode: TelemetryDeliveryMode;
	delivered: boolean;
	queued: boolean;
	at?: number;
}

export interface BatchTelemetryDescriptor {
	jobId: string;
	nameHashSource: string;
	projectPath: string;
	source: TelemetryBatchSource;
	maxConcurrency: number;
	itemCount: number;
	createdAt: number;
}

export interface BatchItemTelemetryInput {
	jobId: string;
	itemId: string;
	agentId?: string;
	phase: "queued" | "started" | "completed";
	outcome?: TelemetryOutcome;
	queueDurationMs?: number;
	durationMs?: number;
	at?: number;
	error?: unknown;
}

export interface BatchCompletionTelemetryInput {
	jobId: string;
	outcome: TelemetryOutcome;
	durationMs?: number;
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	lost: number;
	at?: number;
	error?: unknown;
}

export interface TelemetryHealth {
	enabled: boolean;
	requestedEnabled: boolean;
	degraded: boolean;
	lastSuccessfulExportAt?: number;
	lastErrorCategory?: string;
	droppedRecords: number;
	traceSampleRatio: number;
	collectorOrigin?: string;
	configurationIssues: readonly string[];
}

/**
 * Harness-facing telemetry boundary. Implementations must be non-blocking for all
 * record methods and must sanitize raw paths/errors before export. Core managers
 * depend on this interface, never on OpenTelemetry packages.
 */
export interface SubagentTelemetry {
	startSession(input: SessionTelemetryInput): void;
	endSession(input?: SessionEndTelemetryInput): void;
	agentQueued(input: AgentTelemetryDescriptor): void;
	agentStarted(input: AgentStateTelemetryInput): void;
	agentFirstProgress(agentId: string, at?: number): void;
	agentCompleted(input: AgentCompletionTelemetryInput): void;
	processSpawned(input: { agentId: string; at?: number; pid?: number }): void;
	processExited(input: AgentStateTelemetryInput & { exitCode?: number; signal?: string }): void;
	protocolError(input: { agentId: string; at?: number; error: unknown }): void;
	providerError(input: { agentId: string; turnId?: string; at?: number; error: unknown }): void;
	turnStarted(input: TurnTelemetryInput): void;
	turnCompleted(input: TurnCompletionTelemetryInput): void;
	routingResolved(input: RoutingTelemetryInput): void;
	rpcStarted(input: RpcTelemetryInput): void;
	rpcCompleted(input: RpcCompletionTelemetryInput): void;
	toolStarted(input: ToolTelemetryInput): void;
	toolCompleted(input: ToolCompletionTelemetryInput): void;
	recovery(input: RecoveryTelemetryInput): void;
	messageDelivered(input: MessageTelemetryInput): void;
	batchStarted(input: BatchTelemetryDescriptor): void;
	batchItem(input: BatchItemTelemetryInput): void;
	batchCompleted(input: BatchCompletionTelemetryInput): void;
	getHealth(): TelemetryHealth;
	forceFlush(): Promise<void>;
	shutdown(timeoutMs?: number): Promise<void>;
}
