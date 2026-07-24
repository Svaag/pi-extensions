import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RouteDecision, RouterStatus, RoutingProfile, ThinkingLevel } from "../../core/types.ts";

export const ROUTE_ENTRY_TYPE = "model-router.route.v1";
export const OBSERVATION_ENTRY_TYPE = "model-router.observation.v1";
export const PREFERENCES_ENTRY_TYPE = "model-router.preferences.v1";

export interface PiRouteEntryData {
	schemaVersion: 1;
	routeId: string;
	createdAt: number;
	stage: string;
	profile: RoutingProfile;
	applied: boolean;
	arm: string;
	intent: string;
	complexityTier: string;
	recommendedModel?: string;
	recommendedThinkingLevel?: ThinkingLevel;
	executedModel?: string;
	executedThinkingLevel?: ThinkingLevel;
	reason: string;
}

export interface PiObservationEntryData {
	schemaVersion: 1;
	routeId: string;
	completedAt: number;
	outcome: string;
	latencyMs?: number;
	providerRequests: number;
	toolCalls: number;
	toolErrors: number;
}

export interface PiPreferencesEntryData {
	schemaVersion: 1;
	modelPin?: string;
	thinkingPin?: ThinkingLevel;
	profile?: RoutingProfile;
	updatedAt: number;
}

export function privacySafeRouteEntry(decision: RouteDecision): PiRouteEntryData {
	return {
		schemaVersion: 1,
		routeId: decision.routeId,
		createdAt: decision.createdAt,
		stage: decision.stage,
		profile: decision.profile,
		applied: decision.applied,
		arm: decision.arm,
		intent: decision.intent,
		complexityTier: decision.complexityTier,
		recommendedModel: decision.selectedModel,
		recommendedThinkingLevel: decision.selectedThinkingLevel,
		executedModel: decision.executedModel,
		executedThinkingLevel: decision.executedThinkingLevel,
		reason: decision.reason,
	};
}

export function formatDecision(decision: RouteDecision): string {
	const recommended = decision.selectedModel
		? `${decision.selectedModel}${decision.selectedThinkingLevel ? `:${decision.selectedThinkingLevel}` : ""}`
		: "current model";
	const verb = decision.applied ? "routed" : decision.stage === "shadow" ? "shadow recommends" : "kept";
	return `router ${verb} ${recommended} · ${decision.profile} · ${decision.complexityTier}`;
}

export function formatRouterStatus(status: RouterStatus, details: {
	mode: string;
	profile: RoutingProfile;
	modelPin?: string;
	thinkingPin?: ThinkingLevel;
	latestSettledRouteId?: string;
	warnings?: readonly string[];
}): string {
	const stages = status.stages.length > 0
		? status.stages.map((stage) => `${stage.scopeKey}=${stage.stage}`).join(", ")
		: "not initialized";
	const warnings = [...status.health.warnings, ...(details.warnings ?? [])];
	return [
		`mode=${details.mode} profile=${details.profile}`,
		`pin=${details.modelPin ?? "none"} thinking=${details.thinkingPin ?? "none"}`,
		`rollout=${stages}`,
		`routes=${status.totalRoutes} observations=${status.totalObservations} qualityLabels=${status.qualityLabels}`,
		`store=${status.health.storeAvailable ? "available" : "unavailable"} learning=${status.health.learningEnabled ? "enabled" : "disabled"} telemetry=${status.health.telemetryAvailable ? "enabled" : "disabled"}`,
		`latestSettled=${details.latestSettledRouteId ?? "none"}`,
		warnings.length > 0 ? `warnings=${[...new Set(warnings)].join(",")}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function updateRouterStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("model-router", text ? ctx.ui.theme.fg("dim", text) : undefined);
}

export function registerRouterEntryRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PiRouteEntryData>(ROUTE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("dim", "router decision unavailable"), 0, 0);
		const target = data.recommendedModel
			? `${data.recommendedModel}${data.recommendedThinkingLevel ? `:${data.recommendedThinkingLevel}` : ""}`
			: "current model";
		const label = data.applied ? theme.fg("success", "router") : theme.fg("accent", "router shadow");
		let text = `${label} ${target} · ${data.profile} · ${data.complexityTier}`;
		if (expanded) text += `\n${theme.fg("dim", `route ${data.routeId} · ${data.arm} · ${data.reason}`)}`;
		return new Text(text, 0, 0);
	});

	pi.registerEntryRenderer<PiObservationEntryData>(OBSERVATION_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text("", 0, 0);
		const color = data.outcome === "succeeded" ? "success" : "warning";
		let text = theme.fg(color, `router observation ${data.outcome}`);
		if (expanded) text += `\n${theme.fg("dim", `${data.latencyMs ?? "?"}ms · ${data.providerRequests} requests · ${data.toolCalls} tools · ${data.toolErrors} tool errors`)}`;
		return new Text(text, 0, 0);
	});
}
