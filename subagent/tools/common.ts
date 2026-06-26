import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../core/AgentManager.ts";

export type ManagerGetter = (ctx: ExtensionContext) => AgentManager;

export function textResult(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], details };
}

export function preview(text: unknown, max = 80): string {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
