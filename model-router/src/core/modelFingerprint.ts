import { createHash } from "node:crypto";
import type { RoutingCandidate } from "./types.ts";

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !/key|token|secret|header|url|path/i.test(key))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, stable(item)]));
	}
	return value;
}

export function modelFingerprint(candidate: RoutingCandidate): string {
	const safe = {
		provider: candidate.provider ?? "",
		id: candidate.id,
		api: candidate.api ?? "",
		baseUrlFingerprint: candidate.baseUrlFingerprint ?? "",
		reasoning: Boolean(candidate.reasoning),
		input: [...(candidate.input ?? ["text"])].sort(),
		contextWindow: candidate.contextWindow ?? null,
		maxTokens: candidate.maxTokens ?? null,
		cost: candidate.cost ?? null,
		thinkingLevels: candidate.thinkingLevels ?? null,
		capabilities: stable(candidate.capabilities ?? {}),
	};
	return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
}
