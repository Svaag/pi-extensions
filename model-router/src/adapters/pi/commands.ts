import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RoutingProfile } from "../../core/types.ts";
import { PiRunRouter } from "./PiRunRouter.ts";
import { formatRouterStatus } from "./rendering.ts";

const PROFILES: readonly RoutingProfile[] = ["balanced", "quality_first", "cost_first", "latency_first"];
const SUBCOMMANDS = ["status", "profile", "pin", "unpin", "feedback", "rollout", "reset-rollout", "telemetry"];

export interface PiRunRouterAccessor {
	get(ctx: ExtensionCommandContext): Promise<PiRunRouter>;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function parseScore(value: string | undefined): number | undefined {
	if (value === "up") return 1;
	if (value === "down") return 0;
	if (!value) return undefined;
	const score = Number(value);
	return Number.isFinite(score) && score >= 0 && score <= 1 ? score : undefined;
}

export function registerRouterCommands(pi: ExtensionAPI, accessor: PiRunRouterAccessor): void {
	pi.registerCommand("router", {
		description: "Model router status, pins, rollout, profile, and feedback",
		getArgumentCompletions(prefix) {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1) {
				return SUBCOMMANDS.filter((item) => item.startsWith(parts[0] ?? "")).map((item) => ({ value: item, label: item }));
			}
			if (parts[0] === "profile" && parts.length === 2) {
				return PROFILES.filter((item) => item.startsWith(parts[1] ?? "")).map((item) => ({ value: `profile ${item}`, label: item }));
			}
			if (parts[0] === "feedback" && parts.length === 2) {
				return ["up", "down"].filter((item) => item.startsWith(parts[1] ?? "")).map((item) => ({ value: `feedback ${item}`, label: item }));
			}
			return null;
		},
		async handler(args, ctx) {
			const router = await accessor.get(ctx);
			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			const [rawCommand, first, second] = parts;
			const command = rawCommand || "status";

			switch (command) {
				case "status": {
					const status = await router.status();
					notify(ctx, formatRouterStatus(status, {
						mode: router.getMode(),
						profile: router.getProfile(),
						modelPin: router.getModelPin(),
						thinkingPin: router.getThinkingPin(),
						latestSettledRouteId: router.getLatestSettledRouteId(),
						warnings: router.getWarnings(),
					}), status.health.storeAvailable ? "info" : "warning");
					return;
				}
				case "profile": {
					if (!first || !router.setProfile(first as RoutingProfile, ctx)) {
						notify(ctx, `Usage: /router profile ${PROFILES.join("|")}`, "warning");
						return;
					}
					notify(ctx, `Router profile: ${first}`, "info");
					return;
				}
				case "pin":
					router.pinCurrent(ctx);
					notify(ctx, `Pinned ${router.getModelPin() ?? "current model"}:${router.getThinkingPin() ?? "off"}`, "info");
					return;
				case "unpin":
					router.unpin(ctx);
					notify(ctx, "Router model and thinking pins cleared", "info");
					return;
				case "feedback": {
					const score = parseScore(first);
					if (score === undefined || parts.length > 3 || second && second.length > 128) {
						notify(ctx, "Usage: /router feedback up|down|<0..1> [routeId]", "warning");
						return;
					}
					if (ctx.mode !== "tui") {
						notify(ctx, "Interactive router feedback is accepted only in TUI mode", "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm("Record model-router feedback?", `Score ${score} for ${second ?? router.getLatestSettledRouteId() ?? "latest settled route"}`);
					if (!confirmed) return;
					const routeId = await router.recordFeedback(score, second);
					notify(ctx, routeId ? `Feedback recorded for ${routeId}` : "No matching settled route", routeId ? "info" : "warning");
					return;
				}
				case "rollout": {
					const status = await router.status();
					const lines = status.stages.length > 0
						? status.stages.map((stage) => `${stage.scopeKey}: ${stage.stage}${stage.reason ? ` (${stage.reason})` : ""}`)
						: ["No persisted rollout state yet; managed routing remains conservatively shadowed."];
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "reset-rollout":
					if (ctx.mode === "tui" && !await ctx.ui.confirm("Reset router rollout?", `Reset pi_run/run/${router.getProfile()} to its configured initial stage?`)) return;
					await router.resetRollout();
					notify(ctx, "Router rollout reset", "info");
					return;
				case "telemetry": {
					const status = await router.status();
					notify(ctx, `telemetry=${status.health.telemetryAvailable ? "enabled" : "disabled"} store=${status.health.storeAvailable ? "available" : "unavailable"} warnings=${status.health.warnings.join(",") || "none"}`, status.health.telemetryAvailable ? "info" : "warning");
					return;
				}
				default:
					notify(ctx, `Usage: /router ${SUBCOMMANDS.join("|")}`, "warning");
			}
		},
	});
}
