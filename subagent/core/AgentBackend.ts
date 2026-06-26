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

export interface AgentBackendEvents {
	onStarted?: () => void;
	onOutput?: (text: string) => void;
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
