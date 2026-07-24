import type { AgentGraphEdge, AgentGraphEdgeStatus, AgentRecord } from "./AgentTypes.ts";
import { nowMs } from "./utils.ts";

export class AgentGraph {
	private readonly edgesByChild = new Map<string, AgentGraphEdge>();

	constructor(edges: AgentGraphEdge[] = []) {
		for (const edge of edges) this.edgesByChild.set(edge.childAgentId, { ...edge });
	}

	openEdge(record: AgentRecord): AgentGraphEdge {
		const existing = this.edgesByChild.get(record.agentId);
		const createdAt = existing?.createdAt ?? record.createdAt;
		const edge: AgentGraphEdge = {
			parentAgentId: record.parentAgentId,
			childAgentId: record.agentId,
			taskName: record.taskName,
			taskPath: record.taskPath,
			status: "open",
			createdAt,
			updatedAt: nowMs(),
		};
		this.edgesByChild.set(record.agentId, edge);
		return { ...edge };
	}

	closeEdge(childAgentId: string, status: AgentGraphEdgeStatus = "closed"): AgentGraphEdge | undefined {
		const edge = this.edgesByChild.get(childAgentId);
		if (!edge) return undefined;
		edge.status = status;
		edge.updatedAt = nowMs();
		return { ...edge };
	}

	get(childAgentId: string): AgentGraphEdge | undefined {
		const edge = this.edgesByChild.get(childAgentId);
		return edge ? { ...edge } : undefined;
	}

	list(): AgentGraphEdge[] {
		return [...this.edgesByChild.values()].map((edge) => ({ ...edge })).sort((a, b) => a.createdAt - b.createdAt);
	}

	childrenOf(parentAgentId: string | null): AgentGraphEdge[] {
		return this.list().filter((edge) => edge.parentAgentId === parentAgentId);
	}

	replace(edges: AgentGraphEdge[]): void {
		this.edgesByChild.clear();
		for (const edge of edges) this.edgesByChild.set(edge.childAgentId, { ...edge });
	}
}
