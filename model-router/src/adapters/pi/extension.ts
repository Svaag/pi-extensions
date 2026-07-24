import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadRouterConfig } from "../../config/load.ts";
import type { RoutingProfile } from "../../core/types.ts";
import { ModelRoutingEngine } from "../../core/ModelRoutingEngine.ts";
import { createStoreJudgeBudgetCallbacks, QualityJudge } from "../../judge/QualityJudge.ts";
import { SqliteRouterStore } from "../../storage/SqliteRouterStore.ts";
import { NOOP_ROUTER_TELEMETRY } from "../../telemetry/NoopRouterTelemetry.ts";
import { createOpenTelemetryRouterTelemetry } from "../../telemetry/OpenTelemetryRouterTelemetry.ts";
import { createRouterTelemetryPrivacy } from "../../telemetry/Privacy.ts";
import { registerRouterCommands } from "./commands.ts";
import { PiModelSource, type PiModelLike, type PiModelRegistryLike } from "./PiModelSource.ts";
import { PiRunRouter, type PiRouterMode } from "./PiRunRouter.ts";
import { registerRouterEntryRenderers } from "./rendering.ts";
import { registerVirtualRouterProvider } from "./VirtualRouterProvider.ts";
import { registerAnalyzeModelRouterTelemetryTool } from "./analyzeTelemetryTool.ts";

const PROFILES: readonly RoutingProfile[] = ["balanced", "quality_first", "cost_first", "latency_first"];
const MODES: readonly PiRouterMode[] = ["off", "managed", "shadow"];

/** Shared runtime exposed to the opt-in model-router/* virtual provider. */
export interface PiVirtualProviderHookContext {
	engine: ModelRoutingEngine;
	modelSource: PiModelSource;
}

export type PiVirtualProviderInstaller = (pi: ExtensionAPI, context: PiVirtualProviderHookContext) => void | Promise<void>;

function textFromResponse(response: { content?: Array<{ type?: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function splitModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 && slash < ref.length - 1 ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) } : undefined;
}

export default function piModelRouterExtension(pi: ExtensionAPI): void {
	let router: PiRunRouter | undefined;
	let activeContext: ExtensionContext | undefined;
	let initializing: Promise<PiRunRouter> | undefined;
	const virtualProvider = registerVirtualRouterProvider(pi, () => router && activeContext
		? { engine: router.engine, modelSource: router.modelSource, context: activeContext }
		: undefined);

	pi.registerFlag("router-mode", {
		description: "Per-run router mode: off, managed, or shadow",
		type: "string",
	});
	pi.registerFlag("router-profile", {
		description: "Router profile: balanced, quality_first, cost_first, or latency_first",
		type: "string",
	});

	registerRouterEntryRenderers(pi);
	registerAnalyzeModelRouterTelemetryTool(pi);

	async function initialize(ctx: ExtensionContext): Promise<PiRunRouter> {
		if (router) return router;
		if (initializing) return initializing;
		initializing = (async () => {
			const agentDir = getAgentDir();
			const requestedProfile = pi.getFlag("router-profile");
			const profile = typeof requestedProfile === "string" && PROFILES.includes(requestedProfile as RoutingProfile)
				? requestedProfile as RoutingProfile
				: undefined;
			const loaded = loadRouterConfig(ctx.cwd, {
				agentDir,
				configDirName: CONFIG_DIR_NAME,
				projectTrusted: ctx.isProjectTrusted(),
				runtime: profile ? { profile } : undefined,
			});
			const warnings = [...loaded.warnings];
			if (requestedProfile && !profile) warnings.push("invalid_router_profile_flag");
			const requestedMode = pi.getFlag("router-mode");
			const mode = typeof requestedMode === "string" && MODES.includes(requestedMode as PiRouterMode)
				? requestedMode as PiRouterMode
				: "managed";
			if (requestedMode && mode === "managed" && requestedMode !== "managed") warnings.push("invalid_router_mode_flag");

			const privacy = await createRouterTelemetryPrivacy({ agentDir });
			const storePath = loaded.config.storage.path ?? join(agentDir, "model-router", "router.db");
			const store = new SqliteRouterStore({
				path: storePath,
				busyTimeoutMs: loaded.config.storage.busyTimeoutMs,
				halfLifeDays: loaded.config.learning.halfLifeDays,
				rawRetentionDays: loaded.config.learning.rawRetentionDays,
			});
			if (!loaded.config.virtualProvider.enabled) pi.unregisterProvider("model-router");
			const telemetry = loaded.config.telemetry.enabled
				? await createOpenTelemetryRouterTelemetry({ enabled: true, requestedEnabled: true }, { privacy })
				: NOOP_ROUTER_TELEMETRY;
			const engine = new ModelRoutingEngine({
				config: loaded.config,
				store,
				telemetry,
				hashProject: (projectKey) => privacy.hashIdentifier("project", projectKey),
			});
			const modelSource = new PiModelSource({ agentDir, configDirName: CONFIG_DIR_NAME });

			let judge: QualityJudge | undefined;
			if (loaded.config.judge.enabled) {
				judge = new QualityJudge({
					config: loaded.config.judge,
					budget: createStoreJudgeBudgetCallbacks(store, loaded.config.judge.maxDailyCostUsd),
					invoke: async (request) => {
						const registry = ctx.modelRegistry as unknown as PiModelRegistryLike;
						const parsed = splitModelRef(request.model);
						const model = parsed ? registry.find(parsed.provider, parsed.id) : undefined;
						if (!model) throw new Error("judge_model_unavailable");
						const auth = await registry.getApiKeyAndHeaders(model);
						if (!auth.ok) throw new Error("judge_auth_unavailable");
						const response = await complete(
							model as Parameters<typeof complete>[0],
							{
								systemPrompt: "Return only the requested JSON quality rubric.",
								messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
							},
							{ apiKey: auth.apiKey ?? "", headers: auth.headers, env: auth.env, signal: request.signal },
						);
						return { text: textFromResponse(response), costUsd: response.usage?.cost?.total };
					},
				});
			}

			router = new PiRunRouter({
				pi,
				engine,
				modelSource,
				mode,
				profile: profile ?? loaded.config.profile,
				judge,
				startupWarnings: warnings,
			});
			return router;
		})();
		try {
			return await initializing;
		} finally {
			initializing = undefined;
		}
	}

	registerRouterCommands(pi, { get: initialize });

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		virtualProvider.resetSession();
		const current = await initialize(ctx);
		current.onSessionStart(ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		activeContext = ctx;
		await (await initialize(ctx)).beforeAgentStart(event, ctx);
	});
	pi.on("message_update", (event) => { router?.onMessageUpdate(event as Parameters<PiRunRouter["onMessageUpdate"]>[0]); });
	pi.on("turn_end", (event) => { router?.onTurnEnd(event as Parameters<PiRunRouter["onTurnEnd"]>[0]); });
	pi.on("agent_end", (event) => { router?.onAgentEnd(event as Parameters<PiRunRouter["onAgentEnd"]>[0]); });
	pi.on("agent_settled", async () => { await router?.onAgentSettled(); });
	pi.on("tool_execution_start", () => { router?.onToolExecutionStart(); });
	pi.on("tool_execution_end", (event) => { router?.onToolExecutionEnd(event); });
	pi.on("model_select", async (event, ctx) => {
		(await initialize(ctx)).onModelSelect(event.model as PiModelLike, event.source);
	});
	pi.on("thinking_level_select", async (event, ctx) => {
		(await initialize(ctx)).onThinkingLevelSelect(event.level);
	});
	pi.on("session_shutdown", async (event) => {
		if (initializing) await initializing.catch(() => undefined);
		await router?.close(event.reason);
		router = undefined;
		activeContext = undefined;
		virtualProvider.resetSession();
	});
}
