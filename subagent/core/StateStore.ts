import type { AgentGraphEdge, AgentRecord, SubagentEvent, SubagentEventType } from "./AgentTypes.ts";
import { createId, nowMs, shallowCloneRecord } from "./utils.ts";

export const SUBAGENT_EVENT_ENTRY = "subagent-event";
export const SUBAGENT_AGENT_STATE_ENTRY = "subagent-agent-state";
export const SUBAGENT_EDGE_STATE_ENTRY = "subagent-graph-edge-state";

export interface EntryAppender {
	appendEntry(customType: string, data?: unknown): void;
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: any;
}

export interface RestoredSubagentState {
	records: AgentRecord[];
	edges: AgentGraphEdge[];
	events: SubagentEvent[];
	lostAgentIds: string[];
}

function cloneEdge(edge: AgentGraphEdge): AgentGraphEdge {
	return { ...edge };
}

function reconcileRecordOnRestore(record: AgentRecord): AgentRecord {
	const restored = shallowCloneRecord(record);
	if (restored.status === "running" || restored.status === "queued") {
		restored.status = "lost";
		restored.processState = "unknown";
		restored.controllable = false;
		restored.updatedAt = nowMs();
		restored.error = restored.error ?? "Agent was running before extension/session restart and cannot be reattached.";
	}
	return restored;
}

export class StateStore {
	private readonly appender: EntryAppender;

	constructor(appender: EntryAppender) {
		this.appender = appender;
	}

	appendEvent(type: SubagentEventType, event: Omit<SubagentEvent, "eventId" | "type" | "createdAt"> = {}): SubagentEvent {
		const full: SubagentEvent = {
			eventId: createId("evt"),
			type,
			createdAt: nowMs(),
			...event,
		};
		this.appender.appendEntry(SUBAGENT_EVENT_ENTRY, full);
		return full;
	}

	appendAgentState(record: AgentRecord): void {
		this.appender.appendEntry(SUBAGENT_AGENT_STATE_ENTRY, { record: shallowCloneRecord(record), savedAt: nowMs() });
	}

	appendEdgeState(edge: AgentGraphEdge): void {
		this.appender.appendEntry(SUBAGENT_EDGE_STATE_ENTRY, { edge: cloneEdge(edge), savedAt: nowMs() });
	}

	static restore(entries: SessionEntryLike[]): RestoredSubagentState {
		const records = new Map<string, AgentRecord>();
		const edges = new Map<string, AgentGraphEdge>();
		const events: SubagentEvent[] = [];
		const reconciledLostIds = new Set<string>();

		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === SUBAGENT_AGENT_STATE_ENTRY && entry.data?.record?.agentId) {
				const rawRecord = entry.data.record as AgentRecord;
				const restored = reconcileRecordOnRestore(rawRecord);
				records.set(rawRecord.agentId, restored);
				if (rawRecord.status === "running" || rawRecord.status === "queued") reconciledLostIds.add(rawRecord.agentId);
				else reconciledLostIds.delete(rawRecord.agentId);
			} else if (entry.customType === SUBAGENT_EDGE_STATE_ENTRY && entry.data?.edge?.childAgentId) {
				const edge = cloneEdge(entry.data.edge as AgentGraphEdge);
				const record = records.get(edge.childAgentId);
				if (record?.status === "lost" && edge.status === "open") {
					edge.status = "lost";
					edge.updatedAt = Math.max(edge.updatedAt, record.updatedAt);
				}
				edges.set(edge.childAgentId, edge);
			} else if (entry.customType === SUBAGENT_EVENT_ENTRY && entry.data?.type) {
				events.push(entry.data as SubagentEvent);
			}
		}

		for (const record of records.values()) {
			const edge = edges.get(record.agentId);
			if (record.status === "lost" && edge?.status === "open") {
				edges.set(record.agentId, { ...edge, status: "lost", updatedAt: record.updatedAt });
			}
		}

		return {
			records: [...records.values()].sort((a, b) => a.createdAt - b.createdAt),
			edges: [...edges.values()].sort((a, b) => a.createdAt - b.createdAt),
			events: events.sort((a, b) => a.createdAt - b.createdAt),
			lostAgentIds: [...reconciledLostIds].filter((id) => records.get(id)?.status === "lost").sort(),
		};
	}
}
