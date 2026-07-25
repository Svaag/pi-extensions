import type { RouterConfig, RouterModelProfileOverride } from "../config/schema.ts";
import { modelFingerprint } from "./modelFingerprint.ts";
import type { ModelCost, ModelProfile, RoutingCandidate, ThinkingLevel } from "./types.ts";

export function modelRef(model: Pick<RoutingCandidate, "provider" | "id">): string {
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function patternRegex(pattern: string): RegExp {
	let source = "";
	for (const ch of pattern.trim()) source += ch === "*" ? ".*" : ch === "?" ? "." : escapeRegex(ch);
	return new RegExp(`^${source}$`, "i");
}

export function matchesModelPattern(model: Pick<RoutingCandidate, "provider" | "id" | "name">, pattern: string): boolean {
	const fields = [modelRef(model), model.id, model.name ?? ""];
	if (/[*?]/.test(pattern)) {
		const regex = patternRegex(pattern);
		return fields.some((field) => regex.test(field));
	}
	const lower = pattern.trim().toLowerCase();
	return lower.length > 0 && fields.some((field) => field.toLowerCase() === lower || field.toLowerCase().includes(lower));
}

function normalizedCost(cost?: ModelCost): Required<ModelCost> | undefined {
	if (!cost) return undefined;
	const value = (entry: number | undefined) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? entry : 0;
	return { input: value(cost.input), output: value(cost.output), cacheRead: value(cost.cacheRead), cacheWrite: value(cost.cacheWrite) };
}

function inferProfile(model: RoutingCandidate, reliabilityPrior: number): ModelProfile {
	const ref = modelRef(model);
	const label = `${ref} ${model.name ?? ""}`.toLowerCase();
	const notes = ["metadata-inferred prior"];
	let quality = 0.55;
	let speed = 0.55;
	let preferredIntents: ModelProfile["preferredIntents"] = ["scout", "summarize"];
	let preferredTiers: ModelProfile["preferredTiers"] = ["simple", "moderate"];
	if (model.reasoning) { quality += 0.1; notes.push("reasoning-capable"); }
	if (/\b(local|llama|8b|7b|small|mini|haiku)\b/.test(label)) {
		quality -= 0.16; speed += 0.22;
		preferredIntents = ["lookup", "summarize", "batch_simple"];
		preferredTiers = ["trivial", "simple"];
		notes.push("small/local-class heuristic");
	}
	if (/flash/.test(label)) {
		quality = Math.min(quality, 0.5); speed = Math.max(speed, 0.85);
		preferredIntents = ["lookup", "batch_simple", "scout"];
		preferredTiers = ["trivial", "simple"];
		notes.push("flash-class heuristic");
	}
	if (/sonnet|deepseek|glm|kimi/.test(label)) {
		quality = Math.max(quality, 0.72); speed = Math.max(speed, 0.55);
		preferredIntents = ["scout", "debug", "plan", "review"];
		preferredTiers = ["moderate", "complex"];
		notes.push("strong coding/reasoning heuristic");
	}
	if (/opus|gpt-5|codex|\bpro\b/.test(label)) {
		quality = Math.max(quality, 0.88); speed = Math.min(speed, 0.55);
		preferredIntents = ["complex", "implement", "review", "debug"];
		preferredTiers = ["complex", "critical"];
		notes.push("premium-class heuristic");
	}
	return {
		ref,
		fingerprint: modelFingerprint(model),
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: Boolean(model.reasoning),
		input: [...(model.input ?? ["text"])],
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
		cost: normalizedCost(model.cost),
		quality: Math.max(0, Math.min(1, quality)),
		speed: Math.max(0, Math.min(1, speed)),
		reliabilityPrior,
		preferredIntents,
		preferredTiers,
		notes,
	};
}

const DEFAULT_RULES: Array<{ pattern: string; override: RouterModelProfileOverride }> = [
	{ pattern: "local-llamacpp/local-model", override: { quality: 0.2, speed: 0.85, preferredIntents: ["lookup", "summarize"], preferredTiers: ["trivial", "simple"], notes: ["legacy local prior"] } },
	{ pattern: "openrouter/google/gemini-*-flash", override: { quality: 0.45, speed: 0.9, preferredIntents: ["batch_simple", "lookup", "scout"], preferredTiers: ["trivial", "simple"] } },
	{ pattern: "openrouter/minimax/minimax-m3", override: { quality: 0.55, speed: 0.75, preferredIntents: ["scout", "summarize", "batch_simple"], preferredTiers: ["simple", "moderate"] } },
	{ pattern: "kimi-coding/kimi-for-coding", override: { quality: 0.68, speed: 0.7, preferredIntents: ["scout", "debug", "summarize"], preferredTiers: ["simple", "moderate", "complex"] } },
	{ pattern: "zai-official/glm-5.2", override: { quality: 0.72, speed: 0.7, preferredIntents: ["scout", "plan", "summarize"], preferredTiers: ["moderate", "complex"] } },
	{ pattern: "openrouter/deepseek/deepseek-v4-pro", override: { quality: 0.78, speed: 0.6, preferredIntents: ["debug", "plan", "review"], preferredTiers: ["moderate", "complex"] } },
	{ pattern: "anthropic/claude-sonnet-*", override: { quality: 0.9, speed: 0.55, preferredIntents: ["review", "implement", "complex", "debug", "plan"], preferredTiers: ["complex", "critical"] } },
	{ pattern: "anthropic/claude-opus-*", override: { quality: 0.98, speed: 0.4, preferredIntents: ["complex", "review", "implement"], preferredTiers: ["critical"] } },
	{ pattern: "openai-codex/gpt-*", override: { quality: 0.95, speed: 0.45, preferredIntents: ["complex", "implement", "debug", "review"], preferredTiers: ["complex", "critical"] } },
];

function applyOverride(profile: ModelProfile, pattern: string, override: RouterModelProfileOverride, source: string): ModelProfile {
	return {
		...profile,
		quality: override.quality ?? profile.quality,
		speed: override.speed ?? profile.speed,
		reliabilityPrior: override.reliabilityPrior ?? profile.reliabilityPrior,
		preferredIntents: override.preferredIntents ? [...override.preferredIntents] : profile.preferredIntents,
		preferredTiers: override.preferredTiers ? [...override.preferredTiers] : profile.preferredTiers,
		notes: [...profile.notes, ...(override.notes ?? []), `${source}:${pattern}`],
		profilePattern: pattern,
	};
}

export function profileCandidate(candidate: RoutingCandidate, config: RouterConfig): ModelProfile {
	let profile = inferProfile(candidate, config.learning.reliabilityPriorMean);
	for (const rule of DEFAULT_RULES.filter((item) => matchesModelPattern(candidate, item.pattern)).sort((a, b) => a.pattern.length - b.pattern.length)) {
		profile = applyOverride(profile, rule.pattern, rule.override, "default");
	}
	for (const [pattern, override] of Object.entries(config.modelProfiles).filter(([pattern]) => matchesModelPattern(candidate, pattern)).sort(([a], [b]) => a.length - b.length)) {
		profile = applyOverride(profile, pattern, override, "config");
	}
	return profile;
}

/** Detect models like "tencent/hy3-preview" / "gemini-3.1-pro-preview" that have a
 *  released counterpart in the candidate set, and exclude the preview version.
 *  No-op when no non-preview counterpart exists. */
export function excludePreviewCandidates(candidates: RoutingCandidate[]): RoutingCandidate[] {
	const previewRE = /(?<=[^a-z0-9]|^)preview(?=[^a-z0-9]|$)/i;
	const previews = new Map<string, RoutingCandidate>();
	const nonPreviews = new Set<string>();

	for (const c of candidates) {
		const ref = modelRef(c);
		if (previewRE.test(ref)) {
			previews.set(ref.replace(previewRE, "").replace(/-+/g, "-").replace(/-$/, "").replace(/^-/, "").toLowerCase(), c);
		} else {
			nonPreviews.add(ref.toLowerCase());
		}
	}

	const excluded = new Set<RoutingCandidate>();
	for (const [strippedRef, candidate] of previews) {
		if (nonPreviews.has(strippedRef)) {
			excluded.add(candidate);
		}
	}

	return excluded.size > 0 ? candidates.filter((c) => !excluded.has(c)) : candidates;
}

/** Detect models like "tencent/hy3-preview" / "gemini-3.1-pro-preview" that have a
 *  released counterpart in the candidate set, and dock their quality so the router
 *  prefers the full version. No-op when no non-preview counterpart exists. */
export function applyPreviewDiscount(profiles: ModelProfile[]): void {
	const previewRE = /(?<=[^a-z0-9]|^)preview(?=[^a-z0-9]|$)/i;
	const previews = new Map<string, ModelProfile>();
	const nonPreviews = new Set<string>();

	for (const p of profiles) {
		if (previewRE.test(p.ref)) {
			previews.set(p.ref.replace(previewRE, "").replace(/-+/g, "-").replace(/-$/, "").replace(/^-/, "").toLowerCase(), p);
		} else {
			nonPreviews.add(p.ref.toLowerCase());
		}
	}

	for (const [strippedRef, profile] of previews) {
		if (nonPreviews.has(strippedRef)) {
			profile.quality = Math.max(0.1, profile.quality - 0.2);
			profile.notes.push("preview discount (released counterpart available)");
		}
	}
}

export function filterConfiguredCandidates(candidates: RoutingCandidate[], config: RouterConfig): RoutingCandidate[] {
	return candidates.filter((candidate) => {
		if (candidate.provider === "model-router" || modelRef(candidate).startsWith("model-router/")) return false;
		if (candidate.available === false || candidate.authenticated === false) return false;
		if (config.includeModels.length > 0 && !config.includeModels.some((pattern) => matchesModelPattern(candidate, pattern))) return false;
		if (config.excludeModels.some((pattern) => matchesModelPattern(candidate, pattern))) return false;
		return true;
	});
}

export function thinkingLevelsFor(candidate: RoutingCandidate, tier: string, explicit?: ThinkingLevel): ThinkingLevel[] {
	if (explicit) return [explicit];
	if (candidate.scopedThinkingLevel) return [candidate.scopedThinkingLevel];
	if (!candidate.reasoning) return ["off"];
	const allowed = candidate.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
	const preferred: ThinkingLevel[] = tier === "trivial" ? ["off"]
		: tier === "simple" ? ["off", "minimal"]
			: tier === "moderate" ? ["minimal", "low", "medium"]
				: tier === "complex" ? ["low", "medium", "high"]
					: ["medium", "high", "xhigh"];
	return preferred.filter((level) => allowed.includes(level));
}

export function estimateModelCostUsd(profile: ModelProfile, inputTokens: number, outputTokens: number): number | undefined {
	if (!profile.cost) return undefined;
	return (profile.cost.input * Math.max(0, inputTokens) + profile.cost.output * Math.max(0, outputTokens)) / 1_000_000;
}
