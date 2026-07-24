export type AgentStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "closed" | "lost";

export type AgentProcessState = "not_started" | "live_running" | "live_idle" | "exited" | "killed" | "unknown";

export type ContextMode = "fresh" | "summary" | "last_n_turns" | "full_sanitized";

export type WriteMode = "read_only" | "disjoint_scope" | "git_worktree";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RoutingMode = "auto" | "off" | "explain";

export type RoutingObjective = "balanced" | "cost_first" | "quality_first" | "latency_first";

export type FailureDomain = "model" | "provider" | "host" | "rpc" | "tool" | "policy" | "user" | "router" | "unknown";
export type RolloutStage = "off" | "shadow" | "explore" | "auto";
export type RouteArm = "control" | "treatment" | "forced";

export type ComplexityTier = "trivial" | "simple" | "moderate" | "complex" | "critical";

export type TaskIntent =
	| "lookup"
	| "scout"
	| "summarize"
	| "batch_simple"
	| "plan"
	| "review"
	| "debug"
	| "implement"
	| "complex";

export type RoutingDecisionReason = string;

export interface RoutingCandidateScore {
	model: string;
	score: number;
	estimatedCostUsd: number;
	quality: number;
	notes: string[];
}

export interface RoutingDecision {
	mode: RoutingMode;
	objective: RoutingObjective;
	applied: boolean;
	reason: RoutingDecisionReason;
	selectedModel?: string;
	selectedThinkingLevel?: ThinkingLevel;
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	intent: TaskIntent | string;
	risk: number;
	complexity: number;
	complexityTier: ComplexityTier;
	complexityScore: number;
	confidence: number;
	classificationReason: string;
	signals: string[];
	classifierUsed?: boolean;
	classifierModel?: string;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	explanation: string;
	candidates: RoutingCandidateScore[];
	/** Shared-router v1 fields; optional for legacy session entries. */
	routeId?: string;
	batchDecisionId?: string;
	policyVersion?: string;
	baselineModel?: string;
	baselineThinkingLevel?: ThinkingLevel;
	rolloutStage?: RolloutStage;
	arm?: RouteArm;
	executedModel?: string;
	executedThinkingLevel?: ThinkingLevel;
	failureDomain?: FailureDomain;
}

export type AgentMessageRole = "parent" | "child" | "system";

export type AgentMessageKind = "task" | "message" | "followup" | "status" | "result" | "error";

export interface AgentMessage {
	id: string;
	from: string;
	to: string;
	role: AgentMessageRole;
	kind: AgentMessageKind;
	content: string;
	createdAt: number;
	delivered?: boolean;
	deliveryMode?: string;
}

export interface AgentMetrics {
	durationMs?: number;
	queueDurationMs?: number;
	startupDurationMs?: number;
	firstProgressMs?: number;
	outputChars?: number;
	exitCode?: number;
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

export interface AgentResult {
	agentId: string;
	status: "succeeded" | "failed" | "interrupted";
	summary: string;
	output?: string;
	artifacts?: string[];
	changedFiles?: string[];
	metrics?: AgentMetrics;
}

export interface AgentRecord {
	agentId: string;
	taskName: string;
	taskPath: string;
	parentAgentId: string | null;
	jobId?: string;
	status: AgentStatus;
	processState: AgentProcessState;
	cwd: string;
	prompt: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	timeoutMs?: number;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	routingDecision?: RoutingDecision;
	routeId?: string;
	batchDecisionId?: string;
	policyVersion?: string;
	baselineModel?: string;
	baselineThinkingLevel?: ThinkingLevel;
	rolloutStage?: RolloutStage;
	arm?: RouteArm;
	failureDomain?: FailureDomain;
	actualModel?: string;
	actualThinkingLevel?: ThinkingLevel;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
	contextMode: ContextMode;
	writeMode: WriteMode;
	allowedPaths: string[];
	outputTail: string;
	outputChars: number;
	result?: AgentResult;
	error?: string;
	exitCode?: number;
	controllable: boolean;
	agentName?: string;
	agentSource?: "user" | "project" | "inline" | "file" | "none";
}

export type AgentGraphEdgeStatus = "open" | "closed" | "interrupted" | "failed" | "lost";

export interface AgentGraphEdge {
	parentAgentId: string | null;
	childAgentId: string;
	taskName: string;
	taskPath: string;
	status: AgentGraphEdgeStatus;
	createdAt: number;
	updatedAt: number;
}

export type SubagentEventType =
	| "agent.spawned"
	| "agent.started"
	| "agent.output_tail"
	| "agent.succeeded"
	| "agent.failed"
	| "agent.interrupted"
	| "agent.timeout_recovery"
	| "agent.closed"
	| "agent.lost"
	| "agent.message"
	| "agent.followup"
	| "graph.edge_opened"
	| "graph.edge_closed"
	| "graph.edge_lost";

export interface SubagentEvent {
	eventId: string;
	type: SubagentEventType;
	agentId?: string;
	parentAgentId?: string | null;
	childAgentId?: string;
	taskPath?: string;
	createdAt: number;
	data?: Record<string, unknown>;
}

export interface SpawnAgentRequest {
	taskName: string;
	prompt: string;
	cwd?: string;
	parentAgentId?: string;
	taskPath?: string;
	agentName?: string;
	agentSource?: "user" | "project" | "inline" | "file" | "none";
	agentDefinition?: string;
	contextMode?: ContextMode;
	contextTurns?: number;
	contextSummary?: string;
	writeMode?: WriteMode;
	allowedPaths?: string[];
	timeoutMs?: number;
	maxOutputChars?: number;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	routingDecision?: RoutingDecision;
	routeId?: string;
	batchDecisionId?: string;
	jobId?: string;
}

export interface AgentSummary {
	agentId: string;
	taskName: string;
	taskPath: string;
	parentAgentId: string | null;
	status: AgentStatus;
	processState: AgentProcessState;
	cwd: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
	ageMs: number;
	durationMs?: number;
	controllable: boolean;
	outputTail?: string;
	summary?: string;
	output?: string;
	error?: string;
	metrics: AgentMetrics;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	routingDecision?: RoutingDecision;
	routeId?: string;
	batchDecisionId?: string;
	policyVersion?: string;
	baselineModel?: string;
	baselineThinkingLevel?: ThinkingLevel;
	rolloutStage?: RolloutStage;
	arm?: RouteArm;
	failureDomain?: FailureDomain;
	actualModel?: string;
	actualThinkingLevel?: ThinkingLevel;
}

export interface WaitAgentOptions {
	agentId?: string;
	agentIds?: string[];
	all?: boolean;
	timeoutMs?: number;
	returnMode?: "summary" | "full" | "events";
}

export interface WaitAgentResult {
	agents: AgentSummary[];
	timedOut: boolean;
}
