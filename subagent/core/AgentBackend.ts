import type { AgentRecord, AgentResult, WriteMode } from "./AgentTypes.ts";

export interface BackendSpawnRequest {
	record: AgentRecord;
	systemPrompt: string;
	userPrompt: string;
	policy: ChildPolicyConfig;
	timeoutMs: number;
	maxOutputChars: number;
}

export interface ChildPolicyConfig {
	agentId: string;
	writeMode: WriteMode;
	allowedPaths: string[];
	cwd: string;
	maxOutputChars: number;
}

export type BackendObservation =
	| { kind: "process.spawned"; at: number; pid?: number }
	| { kind: "process.exited"; at: number; exitCode: number | null; signal: NodeJS.Signals | null }
	| { kind: "rpc.started"; at: number; requestId: string; command: string }
	| { kind: "rpc.completed"; at: number; requestId: string; command: string; durationMs: number; success: boolean; error?: Error }
	| { kind: "model.first_output"; at: number }
	| { kind: "tool.started"; at: number; toolCallId: string; toolName: string }
	| { kind: "tool.completed"; at: number; toolCallId: string; toolName: string; durationMs?: number; success: boolean; resultChars: number; resultTruncated: boolean; error?: Error }
	| { kind: "compaction.started"; at: number; reason?: string }
	| { kind: "compaction.completed"; at: number; success: boolean; reason?: string; durationMs?: number; error?: Error }
	| { kind: "context_overflow.detected"; at: number }
	| { kind: "context_overflow.recovery"; at: number; phase: "started" | "completed"; success?: boolean; durationMs?: number; error?: Error }
	| { kind: "rpc.malformed"; at: number; error: Error }
	| { kind: "provider.error"; at: number; error: Error };

export interface AgentBackendEvents {
	onStarted?: () => void;
	onOutput?: (text: string) => void;
	onObservation?: (observation: BackendObservation) => void;
	onResult?: (result: AgentResult) => void;
	onError?: (error: Error) => void;
	onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
}

export interface AgentHandle {
	agentId: string;
	prompt(message: string): Promise<void>;
	sendMessage(message: string): Promise<void>;
	followupTask(message: string): Promise<void>;
	interrupt(reason?: string): Promise<void>;
	close(reason?: string): Promise<void>;
	isAlive(): boolean;
}

export interface AgentBackend {
	spawn(request: BackendSpawnRequest, events: AgentBackendEvents, signal?: AbortSignal): Promise<AgentHandle>;
}
