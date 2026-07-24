import type {
	AgentCompletionTelemetryInput,
	AgentStateTelemetryInput,
	AgentTelemetryDescriptor,
	BatchCompletionTelemetryInput,
	BatchItemTelemetryInput,
	BatchTelemetryDescriptor,
	MessageTelemetryInput,
	RecoveryTelemetryInput,
	RoutingTelemetryInput,
	RpcCompletionTelemetryInput,
	RpcTelemetryInput,
	SessionEndTelemetryInput,
	SessionTelemetryInput,
	SubagentTelemetry,
	TelemetryHealth,
	ToolCompletionTelemetryInput,
	ToolTelemetryInput,
	TurnCompletionTelemetryInput,
	TurnTelemetryInput,
} from "./Telemetry.ts";

const DISABLED_HEALTH: TelemetryHealth = Object.freeze({
	enabled: false,
	requestedEnabled: false,
	degraded: false,
	droppedRecords: 0,
	traceSampleRatio: 0,
	configurationIssues: Object.freeze([]),
});

/** Allocation-free, side-effect-free telemetry implementation used by default. */
export class NoopSubagentTelemetry implements SubagentTelemetry {
	startSession(_input: SessionTelemetryInput): void {}
	endSession(_input?: SessionEndTelemetryInput): void {}
	agentQueued(_input: AgentTelemetryDescriptor): void {}
	agentStarted(_input: AgentStateTelemetryInput): void {}
	agentFirstProgress(_agentId: string, _at?: number): void {}
	agentCompleted(_input: AgentCompletionTelemetryInput): void {}
	processSpawned(_input: { agentId: string; at?: number; pid?: number }): void {}
	processExited(_input: AgentStateTelemetryInput & { exitCode?: number; signal?: string }): void {}
	protocolError(_input: { agentId: string; at?: number; error: unknown }): void {}
	providerError(_input: { agentId: string; turnId?: string; at?: number; error: unknown }): void {}
	turnStarted(_input: TurnTelemetryInput): void {}
	turnCompleted(_input: TurnCompletionTelemetryInput): void {}
	routingResolved(_input: RoutingTelemetryInput): void {}
	rpcStarted(_input: RpcTelemetryInput): void {}
	rpcCompleted(_input: RpcCompletionTelemetryInput): void {}
	toolStarted(_input: ToolTelemetryInput): void {}
	toolCompleted(_input: ToolCompletionTelemetryInput): void {}
	recovery(_input: RecoveryTelemetryInput): void {}
	messageDelivered(_input: MessageTelemetryInput): void {}
	batchStarted(_input: BatchTelemetryDescriptor): void {}
	batchItem(_input: BatchItemTelemetryInput): void {}
	batchCompleted(_input: BatchCompletionTelemetryInput): void {}
	getHealth(): TelemetryHealth { return DISABLED_HEALTH; }
	forceFlush(): Promise<void> { return Promise.resolve(); }
	shutdown(_timeoutMs?: number): Promise<void> { return Promise.resolve(); }
}

export const NOOP_SUBAGENT_TELEMETRY: SubagentTelemetry = Object.freeze(new NoopSubagentTelemetry());
