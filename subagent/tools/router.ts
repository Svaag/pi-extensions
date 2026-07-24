import { ModelRoutingEngine, loadRouterConfig } from "@svaag/pi-model-router";
import { SubagentRouterAdapter, type LegacySubagentRoutingDecision, type SubagentRouteResult } from "@svaag/pi-model-router/subagent";
import type { RoutingMode, RoutingObjective, ThinkingLevel } from "../core/AgentTypes.ts";
import type { DeterministicIntentInput } from "../core/SmartRouter.ts";

export interface ResolveRoutingOptions extends DeterministicIntentInput {
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
}

let installedAdapter: SubagentRouterAdapter | undefined;
let fallbackAdapter: SubagentRouterAdapter | undefined;

/** Session wiring owns the adapter; the fallback keeps direct/tool tests non-fatal. */
export function installSubagentRouterAdapter(adapter: SubagentRouterAdapter | undefined): void {
	installedAdapter = adapter;
	if (adapter) fallbackAdapter = undefined;
}

export function getSubagentRouterAdapter(): SubagentRouterAdapter | undefined {
	return installedAdapter ?? fallbackAdapter;
}

export function isProjectTrustedForRouting(ctx: any): boolean {
	try {
		return typeof ctx.isProjectTrusted === "function" ? Boolean(ctx.isProjectTrusted()) : false;
	} catch {
		return false;
	}
}

function adapterFor(ctx: any): SubagentRouterAdapter {
	if (installedAdapter) return installedAdapter;
	if (!fallbackAdapter) {
		const loaded = loadRouterConfig(ctx.cwd, { projectTrusted: isProjectTrustedForRouting(ctx) });
		const engine = new ModelRoutingEngine({ config: loaded.config });
		fallbackAdapter = new SubagentRouterAdapter({ engine, config: loaded.config });
	}
	return fallbackAdapter;
}

function currentThinkingLevel(ctx: any): ThinkingLevel | undefined {
	const value = ctx?.thinkingLevel;
	return typeof value === "string" ? value as ThinkingLevel : undefined;
}

function requestFor(ctx: any, options: ResolveRoutingOptions) {
	return {
		...options,
		cwd: ctx.cwd,
		projectTrusted: isProjectTrustedForRouting(ctx),
		modelRegistry: ctx.modelRegistry,
		currentModel: ctx.model,
		currentThinkingLevel: currentThinkingLevel(ctx),
	};
}

/** Legacy-compatible result backed by the shared ModelRoutingEngine. */
export async function resolveRouting(ctx: any, options: ResolveRoutingOptions): Promise<SubagentRouteResult> {
	return adapterFor(ctx).resolve(requestFor(ctx, options) as any);
}

/** A new route/observation for a turn that must retain its existing process/model. */
export async function resolveInheritedRouting(ctx: any, options: ResolveRoutingOptions): Promise<SubagentRouteResult> {
	return adapterFor(ctx).routeInherited(requestFor(ctx, options) as any);
}

export async function forkBatchRouting(decision: LegacySubagentRoutingDecision): Promise<LegacySubagentRoutingDecision> {
	const adapter = installedAdapter ?? fallbackAdapter;
	return adapter ? adapter.forkBatchDecision(decision) : decision;
}
