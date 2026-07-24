import type { ModelRoutingEngine } from "../../core/ModelRoutingEngine.ts";
import type { RouteDecision, RouteObservation, RouteRequest } from "../../core/types.ts";

export interface RoutedExecutionResult<T> {
	decision: RouteDecision;
	value: T;
}

export interface RoutedExecutionContext {
	decision: RouteDecision;
	model?: string;
	thinkingLevel?: string;
}

export interface RoutedSessionAdapterOptions<T> {
	engine: ModelRoutingEngine;
	execute: (context: RoutedExecutionContext) => Promise<T>;
	observe: (value: T, elapsedMs: number, decision: RouteDecision) => RouteObservation | Promise<RouteObservation>;
	classifyError?: (error: unknown, elapsedMs: number, decision: RouteDecision) => RouteObservation;
	now?: () => number;
}

/** Host-neutral helper for SDK callers that want routing and outcome accounting around one operation. */
export class RoutedSessionAdapter<T> {
	private readonly options: RoutedSessionAdapterOptions<T>;
	private readonly now: () => number;
	constructor(options: RoutedSessionAdapterOptions<T>) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	async run(request: RouteRequest): Promise<RoutedExecutionResult<T>> {
		const decision = await this.options.engine.route({ ...request, host: request.host ?? "sdk" });
		const startedAt = this.now();
		try {
			const value = await this.options.execute({ decision, model: decision.executedModel, thinkingLevel: decision.executedThinkingLevel });
			const observation = await this.options.observe(value, Math.max(0, this.now() - startedAt), decision);
			await this.options.engine.observe({ ...observation, routeId: decision.routeId });
			return { decision, value };
		} catch (error) {
			const elapsed = Math.max(0, this.now() - startedAt);
			const observation = this.options.classifyError?.(error, elapsed, decision) ?? {
				routeId: decision.routeId,
				outcome: "failed",
				failureDomain: "unknown",
				latencyMs: elapsed,
			};
			await this.options.engine.observe({ ...observation, routeId: decision.routeId });
			throw error;
		}
	}
}
