import type { RouterConfig, RouterModelProfileOverride } from "./RouterConfig.ts";
import type {
	ContextMode,
	RoutingCandidateScore,
	RoutingDecision,
	RoutingMode,
	RoutingObjective,
	TaskIntent,
	ThinkingLevel,
	WriteMode,
} from "./AgentTypes.ts";
import {
	getAvailableScopedModels,
	isExactPattern,
	matchesModelPattern,
	modelRef,
	type LoadScopedModelPatternOptions,
	type ModelCostLike,
	type ModelLike,
	type ModelRegistryLike,
	type ScopedModelMatch,
} from "./ScopedModels.ts";
import { truncateMiddle } from "./utils.ts";

export interface ModelProfile {
	ref: string;
	provider?: string;
	id: string;
	name?: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: Required<ModelCostLike>;
	quality: number;
	speed: number;
	preferredIntents: TaskIntent[];
	notes: string[];
	profilePattern?: string;
}

export interface ProfiledScopedModel extends ScopedModelMatch {
	profile: ModelProfile;
}

interface ModelProfileRule extends RouterModelProfileOverride {
	pattern: string;
}

export const DEFAULT_MODEL_PROFILE_RULES: ModelProfileRule[] = [
	{
		pattern: "local-llamacpp/local-model",
		quality: 0.2,
		speed: 0.85,
		preferredIntents: ["lookup", "summarize"],
		notes: ["local/cheap", "best for low-risk lookup and simple summarization"],
	},
	{
		pattern: "openrouter/google/gemini-*-flash",
		quality: 0.45,
		speed: 0.9,
		preferredIntents: ["batch_simple", "lookup", "scout"],
		notes: ["fast flash-class model", "good for batch/simple scout work"],
	},
	{
		pattern: "openrouter/minimax/minimax-m3",
		quality: 0.55,
		speed: 0.75,
		preferredIntents: ["scout", "summarize", "batch_simple"],
		notes: ["large-context economy model"],
	},
	{
		pattern: "kimi-coding/kimi-for-coding",
		quality: 0.68,
		speed: 0.7,
		preferredIntents: ["scout", "debug", "summarize"],
		notes: ["coding-specialized mid-tier model"],
	},
	{
		pattern: "zai-official/glm-5.2",
		quality: 0.72,
		speed: 0.7,
		preferredIntents: ["scout", "plan", "summarize"],
		notes: ["large-context planning/scout model"],
	},
	{
		pattern: "openrouter/deepseek/deepseek-v4-pro",
		quality: 0.78,
		speed: 0.6,
		preferredIntents: ["debug", "plan", "review"],
		notes: ["reasoning-heavy debug/plan model"],
	},
	{
		pattern: "anthropic/claude-sonnet-*",
		quality: 0.9,
		speed: 0.55,
		preferredIntents: ["review", "implement", "complex", "debug", "plan"],
		notes: ["high-quality coding/review model"],
	},
	{
		pattern: "anthropic/claude-opus-*",
		quality: 0.98,
		speed: 0.4,
		preferredIntents: ["complex", "review", "implement"],
		notes: ["premium expert model", "reserve for high-risk work"],
	},
	{
		pattern: "openai-codex/gpt-*",
		quality: 0.95,
		speed: 0.45,
		preferredIntents: ["complex", "implement", "debug", "review"],
		notes: ["premium code-heavy model"],
	},
];

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizedCost(cost: ModelCostLike | undefined): Required<ModelCostLike> {
	return {
		input: typeof cost?.input === "number" && Number.isFinite(cost.input) ? cost.input : 0,
		output: typeof cost?.output === "number" && Number.isFinite(cost.output) ? cost.output : 0,
		cacheRead: typeof cost?.cacheRead === "number" && Number.isFinite(cost.cacheRead) ? cost.cacheRead : 0,
		cacheWrite: typeof cost?.cacheWrite === "number" && Number.isFinite(cost.cacheWrite) ? cost.cacheWrite : 0,
	};
}

function exactModelPatternMatch(model: ModelLike, pattern: string): boolean {
	const lower = pattern.toLowerCase();
	return [modelRef(model), model.id, model.name ?? ""].some((field) => field.toLowerCase() === lower);
}

function ruleSpecificity(rule: ModelProfileRule): number {
	return (isExactPattern(rule.pattern) ? 10_000 : 0) + rule.pattern.length;
}

function bestMatchingRule(model: ModelLike, rules: ModelProfileRule[]): ModelProfileRule | undefined {
	return rules
		.filter((rule) => matchesModelPattern(model, rule.pattern))
		.sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a))[0];
}

function matchingOverrides(model: ModelLike, overrides: Record<string, RouterModelProfileOverride>): ModelProfileRule[] {
	const entries = Object.entries(overrides).map(([pattern, override]) => ({ pattern, ...override }));
	const globMatches = entries.filter((rule) => !isExactPattern(rule.pattern) && matchesModelPattern(model, rule.pattern));
	const exactMatches = entries.filter((rule) => isExactPattern(rule.pattern) && exactModelPatternMatch(model, rule.pattern));
	return [...globMatches.sort((a, b) => a.pattern.length - b.pattern.length), ...exactMatches.sort((a, b) => a.pattern.length - b.pattern.length)];
}

function inferBaseProfile(model: ModelLike): ModelProfile {
	const ref = modelRef(model);
	const label = `${ref} ${model.name ?? ""}`.toLowerCase();
	const notes: string[] = ["metadata-inferred profile"];
	let quality = 0.55;
	let speed = 0.55;
	let preferredIntents: TaskIntent[] = ["scout", "summarize"];

	if (model.reasoning) {
		quality += 0.1;
		notes.push("reasoning-capable");
	}
	if (/\b(local|llama|8b|7b|small|mini|haiku)\b/.test(label)) {
		quality -= 0.16;
		speed += 0.22;
		preferredIntents = ["lookup", "summarize", "batch_simple"];
		notes.push("small/local-class heuristic");
	}
	if (/flash/.test(label)) {
		quality = Math.min(quality, 0.5);
		speed = Math.max(speed, 0.85);
		preferredIntents = ["lookup", "batch_simple", "scout"];
		notes.push("flash-class heuristic");
	}
	if (/sonnet|deepseek|glm|kimi/.test(label)) {
		quality = Math.max(quality, 0.72);
		speed = Math.max(speed, 0.55);
		preferredIntents = ["scout", "debug", "plan", "review"];
		notes.push("strong coding/reasoning heuristic");
	}
	if (/opus|gpt-5|codex|pro/.test(label)) {
		quality = Math.max(quality, 0.88);
		speed = Math.min(speed, 0.55);
		preferredIntents = ["complex", "implement", "review", "debug"];
		notes.push("premium-class heuristic");
	}

	return {
		ref,
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: Boolean(model.reasoning),
		input: Array.isArray(model.input) ? [...model.input] : ["text"],
		contextWindow: typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? model.contextWindow : 128_000,
		maxTokens: typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) ? model.maxTokens : 16_384,
		cost: normalizedCost(model.cost),
		quality: clamp01(quality),
		speed: clamp01(speed),
		preferredIntents,
		notes,
	};
}

function applyProfileRule(profile: ModelProfile, rule: ModelProfileRule, source: "default" | "override"): ModelProfile {
	return {
		...profile,
		quality: typeof rule.quality === "number" ? clamp01(rule.quality) : profile.quality,
		speed: typeof rule.speed === "number" ? clamp01(rule.speed) : profile.speed,
		preferredIntents: rule.preferredIntents ? [...rule.preferredIntents] : profile.preferredIntents,
		notes: [...profile.notes, ...(rule.notes ?? []), `${source} profile: ${rule.pattern}`],
		profilePattern: rule.pattern,
	};
}

export function profileModel(
	model: ModelLike,
	overrides: Record<string, RouterModelProfileOverride> = {},
): ModelProfile {
	let profile = inferBaseProfile(model);
	const defaultRule = bestMatchingRule(model, DEFAULT_MODEL_PROFILE_RULES);
	if (defaultRule) profile = applyProfileRule(profile, defaultRule, "default");
	for (const override of matchingOverrides(model, overrides)) profile = applyProfileRule(profile, override, "override");
	return profile;
}

export function profileScopedModel(
	match: ScopedModelMatch,
	overrides: Record<string, RouterModelProfileOverride> = {},
): ProfiledScopedModel {
	return { ...match, profile: profileModel(match.model, overrides) };
}

export function profileScopedModels(
	matches: ScopedModelMatch[],
	overrides: Record<string, RouterModelProfileOverride> = {},
): ProfiledScopedModel[] {
	return matches.map((match) => profileScopedModel(match, overrides));
}

export function estimateModelCostUsd(profile: Pick<ModelProfile, "cost">, inputTokens: number, outputTokens: number): number {
	const input = Math.max(0, inputTokens);
	const output = Math.max(0, outputTokens);
	return (profile.cost.input * input + profile.cost.output * output) / 1_000_000;
}

export function totalCostPerMillion(profile: Pick<ModelProfile, "cost">): number {
	return profile.cost.input + profile.cost.output;
}

export function isLocalOrZeroCostProfile(profile: ModelProfile): boolean {
	const ref = profile.ref.toLowerCase();
	return ref.includes("local") || totalCostPerMillion(profile) === 0;
}

export interface DeterministicIntentInput {
	taskName: string;
	prompt: string;
	agentName?: string;
	agentDefinition?: string;
	contextSummary?: string;
	contextMode?: ContextMode;
	writeMode?: WriteMode;
	tools?: string[];
	batch?: {
		sourceType?: string;
		rowCount?: number;
		samplePrompts?: string[];
	};
}

export interface IntentClassification {
	intent: TaskIntent;
	risk: number;
	complexity: number;
	confidence: number;
	reason: string;
	signals: string[];
}

export interface RoutingTokenEstimate {
	inputTokens: number;
	outputTokens: number;
}

export interface ClassifierDecision {
	intent: TaskIntent;
	risk: number;
	complexity: number;
	confidence: number;
	reason: string;
}

export interface RouterClassifierInput {
	model: ProfiledScopedModel;
	prompt: string;
	classification: IntentClassification;
	estimate: RoutingTokenEstimate;
	metadata: Record<string, unknown>;
}

export type RouterClassifier = (input: RouterClassifierInput) => Promise<ClassifierDecision | undefined>;

export interface RouteSubagentRequest extends DeterministicIntentInput {
	cwd: string;
	config: RouterConfig;
	modelRegistry?: ModelRegistryLike;
	currentModel?: ModelLike;
	explicitModel?: string;
	explicitThinkingLevel?: ThinkingLevel;
	routingMode?: RoutingMode;
	routingProfile?: RoutingObjective;
	projectTrusted?: boolean;
	scopedModelOptions?: LoadScopedModelPatternOptions;
	classifier?: RouterClassifier;
}

export interface RouteSubagentResult {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	decision: RoutingDecision;
	classification: IntentClassification;
	profiles: ProfiledScopedModel[];
}

const HIGH_RISK_KEYWORDS = [
	"security",
	"auth",
	"authentication",
	"authorization",
	"crypto",
	"wallet",
	"payment",
	"permission",
	"secret",
	"migration",
	"schema",
	"prod",
	"production",
	"data loss",
	"concurrency",
	"race",
	"refactor",
	"architecture",
	"failing",
	"review",
];

const LOW_RISK_KEYWORDS = ["list", "find", "locate", "grep", "search", "summarize", "inventory", "inspect", "read-only", "map"];

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function containsKeyword(text: string, keyword: string): boolean {
	const lower = keyword.toLowerCase();
	if (/\s/.test(lower)) return text.includes(lower);
	return new RegExp(`\\b${escapeRegExp(lower)}\\b`, "i").test(text);
}

function countKeywords(text: string, keywords: string[]): number {
	return keywords.reduce((count, keyword) => count + (containsKeyword(text, keyword) ? 1 : 0), 0);
}

function taskText(input: DeterministicIntentInput): string {
	return [
		input.taskName,
		input.agentName ?? "",
		input.prompt,
		input.agentDefinition ?? "",
		input.contextSummary ?? "",
		...(input.batch?.samplePrompts ?? []),
	].join("\n");
}

function hasAny(text: string, keywords: string[]): boolean {
	return keywords.some((keyword) => containsKeyword(text, keyword));
}

function hasWriteCapability(input: DeterministicIntentInput): boolean {
	return input.writeMode !== undefined && input.writeMode !== "read_only" || Boolean(input.tools?.some((tool) => tool === "edit" || tool === "write"));
}

export function classifyTaskIntent(input: DeterministicIntentInput): IntentClassification {
	const text = taskText(input).toLowerCase();
	const signals: string[] = [];
	const highRiskCount = countKeywords(text, HIGH_RISK_KEYWORDS);
	const lowRiskCount = countKeywords(text, LOW_RISK_KEYWORDS);
	const writeCapable = hasWriteCapability(input);
	const promptChars = input.prompt.length + (input.agentDefinition?.length ?? 0) + (input.contextSummary?.length ?? 0);
	const multiStep = hasAny(text, ["multi-step", "end-to-end", "architecture", "design", "system", "across", "all usages"]);
	const complexity = clamp01(promptChars / 18_000 + (multiStep ? 0.25 : 0) + Math.min(0.35, highRiskCount * 0.06));
	const risk = clamp01(highRiskCount * 0.12 + (writeCapable ? 0.25 : 0) + (multiStep ? 0.08 : 0) - lowRiskCount * 0.04);
	let intent: TaskIntent = "scout";
	let confidence = 0.58;
	let reason = "defaulted to scout-style reconnaissance";

	const agentName = input.agentName?.toLowerCase() ?? "";
	if (input.batch && !writeCapable && risk < 0.55) {
		intent = "batch_simple";
		confidence = 0.82;
		reason = "structured batch fan-out with read-only/low-risk metadata";
		signals.push("batch");
	} else if (agentName.includes("review") || hasAny(text, ["review", "audit", "security analysis", "vulnerability", "quality analysis"])) {
		intent = "review";
		confidence = 0.82;
		reason = "review/audit/security language detected";
		signals.push("review");
	} else if (writeCapable || hasAny(text, ["implement", "modify", "change", "edit", "write", "create", "add support", "fix bug", "make changes"])) {
		intent = writeCapable || risk >= 0.45 ? "implement" : "plan";
		confidence = writeCapable ? 0.86 : 0.72;
		reason = writeCapable ? "write-capable subagent or edit/write tools requested" : "implementation language detected without explicit write capability";
		signals.push(writeCapable ? "write-capable" : "implementation-language");
	} else if (agentName.includes("plan") || hasAny(text, ["plan", "design", "architecture", "approach", "proposal", "roadmap"])) {
		intent = "plan";
		confidence = 0.78;
		reason = "planning/design language detected";
		signals.push("planning");
	} else if (hasAny(text, ["debug", "diagnose", "failing", "failure", "error", "stack trace", "test failure", "regression"])) {
		intent = "debug";
		confidence = 0.76;
		reason = "debug/failure language detected";
		signals.push("debug");
	} else if (hasAny(text, ["summarize", "summary", "compress", "extract notes", "rewrite", "transform"])) {
		intent = "summarize";
		confidence = 0.78;
		reason = "summarization/transformation language detected";
		signals.push("summarize");
	} else if (hasAny(text, ["find", "locate", "grep", "search", "list", "where is", "which file", "show me"]) && promptChars < 8_000) {
		intent = "lookup";
		confidence = 0.8;
		reason = "targeted lookup/search language detected";
		signals.push("lookup");
	} else if (agentName.includes("scout") || hasAny(text, ["scout", "inspect", "inventory", "map", "explore", "codebase", "trace", "recon"])) {
		intent = "scout";
		confidence = 0.74;
		reason = "scout/reconnaissance language detected";
		signals.push("scout");
	}

	if (intent === "scout" && risk >= 0.65 && complexity >= 0.55) {
		intent = "complex";
		confidence = Math.max(confidence, 0.7);
		reason = "high-risk, high-complexity task promoted to complex";
		signals.push("complexity-promotion");
	}
	if (highRiskCount > 0) signals.push(`high-risk-keywords:${highRiskCount}`);
	if (lowRiskCount > 0) signals.push(`low-risk-keywords:${lowRiskCount}`);
	if (input.contextMode && input.contextMode !== "fresh") signals.push(`context:${input.contextMode}`);

	const ambiguityPenalty = Math.min(0.22, Math.max(0, signals.length - 3) * 0.04);
	return { intent, risk, complexity, confidence: clamp01(confidence - ambiguityPenalty), reason, signals };
}

export function estimateRoutingTokens(input: DeterministicIntentInput, intent: TaskIntent): RoutingTokenEstimate {
	const chars = input.prompt.length + (input.agentDefinition?.length ?? 0) + (input.contextSummary?.length ?? 0) + (input.batch?.samplePrompts?.join("\n").length ?? 0);
	const inputTokens = Math.ceil(chars / 4) + 1000;
	const outputTokens = intent === "lookup" || intent === "summarize"
		? 1000
		: intent === "scout" || intent === "batch_simple"
			? 2000
			: intent === "debug" || intent === "plan" || intent === "review"
				? 3000
				: 4000;
	return { inputTokens, outputTokens };
}

function requiredQuality(intent: TaskIntent, risk: number, complexity: number): number {
	const base = intent === "lookup"
		? 0.28
		: intent === "summarize"
			? 0.35
			: intent === "batch_simple"
				? 0.36
				: intent === "scout"
					? 0.55
					: intent === "debug"
						? 0.65
						: intent === "plan"
							? 0.7
							: intent === "review"
								? 0.78
								: intent === "implement"
									? 0.82
									: 0.88;
	return clamp01(base + risk * 0.12 + complexity * 0.08);
}

function scoreWeights(objective: RoutingObjective): { quality: number; cost: number; speed: number; context: number } {
	if (objective === "cost_first") return { quality: 0.35, cost: 0.4, speed: 0.15, context: 0.1 };
	if (objective === "quality_first") return { quality: 0.7, cost: 0.1, speed: 0.1, context: 0.1 };
	return { quality: 0.5, cost: 0.25, speed: 0.15, context: 0.1 };
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function qualityFit(profileQuality: number, required: number): number {
	if (profileQuality >= required) return clamp01(1 - Math.max(0, profileQuality - required - 0.25) * 0.25);
	return clamp01(1 - (required - profileQuality) * 2.2);
}

function costFit(cost: number, costs: number[]): number {
	const min = Math.min(...costs);
	const max = Math.max(...costs);
	if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 1;
	return clamp01(1 - (cost - min) / (max - min));
}

function contextFit(profile: ModelProfile, estimate: RoutingTokenEstimate): number {
	const needed = estimate.inputTokens + estimate.outputTokens;
	return needed <= profile.contextWindow ? 1 : clamp01(profile.contextWindow / needed);
}

export function defaultThinkingLevelForTask(
	classification: IntentClassification,
	profile: ModelProfile | undefined,
	objective: RoutingObjective,
): ThinkingLevel {
	if (profile && !profile.reasoning) return "off";
	const { intent, risk, complexity } = classification;
	let level: ThinkingLevel = intent === "lookup" || intent === "batch_simple"
		? "off"
		: intent === "summarize"
			? "minimal"
			: intent === "scout"
				? "low"
				: intent === "debug" || intent === "plan" || intent === "review"
					? "medium"
					: "high";
	if (intent === "scout" && risk < 0.25 && complexity < 0.35) level = "minimal";
	if (intent === "debug" && risk < 0.35 && complexity < 0.45) level = "low";
	if ((intent === "review" || intent === "plan") && risk >= 0.7) level = "high";
	if (objective === "quality_first" && risk >= 0.85 && complexity >= 0.75) level = "xhigh";
	return level;
}

export function scoreProfilesForTask(
	profiles: ProfiledScopedModel[],
	classification: IntentClassification,
	estimate: RoutingTokenEstimate,
	objective: RoutingObjective,
): RoutingCandidateScore[] {
	const costs = profiles.map((candidate) => estimateModelCostUsd(candidate.profile, estimate.inputTokens, estimate.outputTokens));
	const medianCost = median(costs.filter((cost) => Number.isFinite(cost)));
	const weights = scoreWeights(objective);
	const required = requiredQuality(classification.intent, classification.risk, classification.complexity);
	return profiles
		.map((candidate, index) => {
			const profile = candidate.profile;
			const estimatedCostUsd = costs[index] ?? 0;
			const qFit = qualityFit(profile.quality, required);
			const cFit = costFit(estimatedCostUsd, costs);
			const ctxFit = contextFit(profile, estimate);
			const roleBoost = profile.preferredIntents.includes(classification.intent) ? 0.08 : 0;
			const riskPenalty = profile.quality < required ? (required - profile.quality) * classification.risk * 0.45 : 0;
			const lowRiskIntent = classification.intent === "lookup" || classification.intent === "summarize" || classification.intent === "batch_simple";
			const overkillPenalty = lowRiskIntent && profile.quality > required + 0.3 && medianCost > 0 && estimatedCostUsd > medianCost * 2 ? 0.18 : 0;
			const score = clamp01(
				qFit * weights.quality +
				cFit * weights.cost +
				profile.speed * weights.speed +
				ctxFit * weights.context +
				roleBoost -
				riskPenalty -
				overkillPenalty,
			);
			const notes = [
				...profile.notes,
				`requiredQuality=${required.toFixed(2)}`,
				`qualityFit=${qFit.toFixed(2)}`,
				`costFit=${cFit.toFixed(2)}`,
				`contextFit=${ctxFit.toFixed(2)}`,
			];
			if (roleBoost > 0) notes.push(`roleBoost=${roleBoost.toFixed(2)}`);
			if (riskPenalty > 0) notes.push(`riskPenalty=${riskPenalty.toFixed(2)}`);
			if (overkillPenalty > 0) notes.push(`overkillPenalty=${overkillPenalty.toFixed(2)}`);
			return { model: profile.ref, score, estimatedCostUsd, quality: profile.quality, notes };
		})
		.sort((a, b) => b.score - a.score || a.estimatedCostUsd - b.estimatedCostUsd);
}

function findProfileByRef(profiles: ProfiledScopedModel[], ref: string | undefined): ProfiledScopedModel | undefined {
	if (!ref) return undefined;
	const lower = ref.toLowerCase();
	return profiles.find((candidate) => candidate.profile.ref.toLowerCase() === lower || candidate.profile.id.toLowerCase() === lower);
}

function isAmbiguousRoute(classification: IntentClassification, candidateScores: RoutingCandidateScore[]): boolean {
	if (classification.confidence < 0.62) return true;
	if (candidateScores.length >= 2 && Math.abs(candidateScores[0].score - candidateScores[1].score) < 0.08) return true;
	return false;
}

export function selectClassifierModel(
	profiles: ProfiledScopedModel[],
	config: RouterConfig,
): ProfiledScopedModel | undefined {
	if (config.classifier.enabled === false) return undefined;
	const inputTokens = Math.ceil(config.classifier.maxPromptChars / 4) + 300;
	const outputTokens = 200;
	return profiles
		.map((candidate) => ({
			candidate,
			cost: estimateModelCostUsd(candidate.profile, inputTokens, outputTokens),
		}))
		.filter(({ candidate, cost }) => {
			if (config.classifier.requireLocalOrZeroCost && !isLocalOrZeroCostProfile(candidate.profile)) return false;
			return cost <= config.classifier.maxEstimatedCostUsd;
		})
		.sort((a, b) => a.cost - b.cost || b.candidate.profile.speed - a.candidate.profile.speed)[0]?.candidate;
}

function classifierMetadata(input: DeterministicIntentInput): Record<string, unknown> {
	return {
		taskName: input.taskName,
		agentName: input.agentName,
		writeMode: input.writeMode,
		tools: input.tools,
		contextMode: input.contextMode,
		batch: input.batch ? { sourceType: input.batch.sourceType, rowCount: input.batch.rowCount } : undefined,
		promptChars: input.prompt.length,
	};
}

export function buildClassifierPrompt(input: DeterministicIntentInput, config: RouterConfig): string {
	const prompt = truncateMiddle(input.prompt, config.classifier.maxPromptChars);
	const metadata = classifierMetadata(input);
	return [
		"Classify this Pi subagent task for model routing.",
		"Return strict JSON only with keys: intent, risk, complexity, confidence, reason.",
		"Allowed intents: lookup, scout, summarize, batch_simple, plan, review, debug, implement, complex.",
		"risk, complexity, and confidence must be numbers from 0 to 1.",
		"Metadata:",
		JSON.stringify(metadata, null, 2),
		"Task prompt:",
		prompt,
	].join("\n\n");
}

const TASK_INTENT_SET = new Set<TaskIntent>([
	"lookup",
	"scout",
	"summarize",
	"batch_simple",
	"plan",
	"review",
	"debug",
	"implement",
	"complex",
]);

export function parseClassifierDecision(text: string): ClassifierDecision | undefined {
	const trimmed = text.trim();
	const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) return undefined;
	try {
		const parsed = JSON.parse(jsonText) as Record<string, unknown>;
		if (typeof parsed.intent !== "string" || !TASK_INTENT_SET.has(parsed.intent as TaskIntent)) return undefined;
		const risk = typeof parsed.risk === "number" && Number.isFinite(parsed.risk) ? clamp01(parsed.risk) : undefined;
		const complexity = typeof parsed.complexity === "number" && Number.isFinite(parsed.complexity) ? clamp01(parsed.complexity) : undefined;
		const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? clamp01(parsed.confidence) : undefined;
		if (risk === undefined || complexity === undefined || confidence === undefined) return undefined;
		return {
			intent: parsed.intent as TaskIntent,
			risk,
			complexity,
			confidence,
			reason: typeof parsed.reason === "string" ? parsed.reason : "classifier result",
		};
	} catch {
		return undefined;
	}
}

function classifierApplied(base: IntentClassification, decision: ClassifierDecision): IntentClassification {
	return {
		intent: decision.intent,
		risk: decision.risk,
		complexity: decision.complexity,
		confidence: Math.max(base.confidence, decision.confidence),
		reason: `classifier: ${decision.reason}`,
		signals: [...base.signals, `classifier:${decision.confidence.toFixed(2)}`],
	};
}

async function maybeApplyClassifier(
	request: RouteSubagentRequest,
	profiles: ProfiledScopedModel[],
	classification: IntentClassification,
	estimate: RoutingTokenEstimate,
	candidateScores: RoutingCandidateScore[],
): Promise<IntentClassification> {
	if (!request.classifier || request.config.classifier.enabled === false || request.explicitModel) return classification;
	if (!isAmbiguousRoute(classification, candidateScores)) return classification;
	const classifierModel = selectClassifierModel(profiles, request.config);
	if (!classifierModel) return classification;
	try {
		const decision = await request.classifier({
			model: classifierModel,
			prompt: buildClassifierPrompt(request, request.config),
			classification,
			estimate,
			metadata: classifierMetadata(request),
		});
		if (!decision || decision.confidence < 0.55) return classification;
		return classifierApplied(classification, decision);
	} catch {
		return classification;
	}
}

function decisionFrom(
	base: {
		mode: RoutingMode;
		objective: RoutingObjective;
		applied: boolean;
		reason: RoutingDecision["reason"];
		selectedModel?: string;
		selectedThinkingLevel?: ThinkingLevel;
		explicitModel?: string;
		explicitThinkingLevel?: ThinkingLevel;
		classification: IntentClassification;
		estimate: RoutingTokenEstimate;
		explanation: string;
		candidates: RoutingCandidateScore[];
	},
): RoutingDecision {
	return {
		mode: base.mode,
		objective: base.objective,
		applied: base.applied,
		reason: base.reason,
		selectedModel: base.selectedModel,
		selectedThinkingLevel: base.selectedThinkingLevel,
		explicitModel: base.explicitModel,
		explicitThinkingLevel: base.explicitThinkingLevel,
		intent: base.classification.intent,
		risk: base.classification.risk,
		complexity: base.classification.complexity,
		estimatedInputTokens: base.estimate.inputTokens,
		estimatedOutputTokens: base.estimate.outputTokens,
		explanation: base.explanation,
		candidates: base.candidates,
	};
}

export async function routeSubagentModel(request: RouteSubagentRequest): Promise<RouteSubagentResult> {
	const mode: RoutingMode = request.routingMode ?? (request.config.enabled ? "auto" : "off");
	const objective = request.routingProfile ?? request.config.objective;
	let classification = classifyTaskIntent(request);
	let estimate = estimateRoutingTokens(request, classification.intent);
	const explicitModel = request.explicitModel;
	const explicitThinkingLevel = request.explicitThinkingLevel;

	if (mode === "off" || !request.config.enabled) {
		const decision = decisionFrom({
			mode,
			objective,
			applied: false,
			reason: "disabled",
			selectedModel: explicitModel,
			selectedThinkingLevel: explicitThinkingLevel,
			explicitModel,
			explicitThinkingLevel,
			classification,
			estimate,
			explanation: "Smart subagent routing is disabled for this request.",
			candidates: [],
		});
		return { model: explicitModel, thinkingLevel: explicitThinkingLevel, decision, classification, profiles: [] };
	}

	let profiles: ProfiledScopedModel[] = [];
	try {
		if (request.modelRegistry) {
			const scoped = await getAvailableScopedModels(request.modelRegistry, request.cwd, {
				...request.scopedModelOptions,
				projectTrusted: request.projectTrusted,
			});
			profiles = profileScopedModels(scoped, request.config.modelProfiles);
		}
	} catch {
		const fallbackModel = explicitModel ?? (request.currentModel ? modelRef(request.currentModel) : undefined);
		const fallbackProfile = request.currentModel ? profileModel(request.currentModel, request.config.modelProfiles) : undefined;
		const thinkingLevel = explicitThinkingLevel ?? defaultThinkingLevelForTask(classification, fallbackProfile, objective);
		const decision = decisionFrom({
			mode,
			objective,
			applied: Boolean(fallbackModel || thinkingLevel),
			reason: "no_available_models",
			selectedModel: fallbackModel,
			selectedThinkingLevel: thinkingLevel,
			explicitModel,
			explicitThinkingLevel,
			classification,
			estimate,
			explanation: "Could not list available scoped models; falling back to the explicit/current model.",
			candidates: [],
		});
		return { model: fallbackModel, thinkingLevel, decision, classification, profiles: [] };
	}

	let candidateScores = scoreProfilesForTask(profiles, classification, estimate, objective);
	classification = await maybeApplyClassifier(request, profiles, classification, estimate, candidateScores);
	estimate = estimateRoutingTokens(request, classification.intent);
	candidateScores = scoreProfilesForTask(profiles, classification, estimate, objective);
	if (explicitModel) {
		const explicitProfile = findProfileByRef(profiles, explicitModel)?.profile;
		const fallbackProfile = explicitProfile ?? (request.currentModel && modelRef(request.currentModel).toLowerCase() === explicitModel.toLowerCase() ? profileModel(request.currentModel, request.config.modelProfiles) : undefined);
		const thinkingLevel = explicitThinkingLevel ?? defaultThinkingLevelForTask(classification, fallbackProfile, objective);
		const decision = decisionFrom({
			mode,
			objective,
			applied: Boolean(!explicitThinkingLevel && thinkingLevel),
			reason: explicitThinkingLevel ? "explicit_thinking" : "explicit_model",
			selectedModel: explicitModel,
			selectedThinkingLevel: thinkingLevel,
			explicitModel,
			explicitThinkingLevel,
			classification,
			estimate,
			explanation: explicitThinkingLevel
				? "Explicit model and thinking level were preserved; model routing was not applied."
				: "Explicit model was preserved; router only selected a task-appropriate thinking level.",
			candidates: candidateScores,
		});
		return { model: explicitModel, thinkingLevel, decision, classification, profiles };
	}

	if (profiles.length === 0) {
		const fallbackModel = request.config.fallbackWhenNoScopedModels === "current_model" && request.currentModel ? modelRef(request.currentModel) : undefined;
		const fallbackProfile = request.currentModel ? profileModel(request.currentModel, request.config.modelProfiles) : undefined;
		const thinkingLevel = explicitThinkingLevel ?? defaultThinkingLevelForTask(classification, fallbackProfile, objective);
		const decision = decisionFrom({
			mode,
			objective,
			applied: Boolean(fallbackModel || thinkingLevel),
			reason: fallbackModel ? "fallback_current_model" : "no_scoped_models",
			selectedModel: fallbackModel,
			selectedThinkingLevel: thinkingLevel,
			explicitModel,
			explicitThinkingLevel,
			classification,
			estimate,
			explanation: fallbackModel
				? "No scoped models were available; falling back to the current parent model."
				: "No scoped models were available and no current-model fallback is configured.",
			candidates: [],
		});
		return { model: fallbackModel, thinkingLevel, decision, classification, profiles };
	}

	const neededTokens = estimate.inputTokens + estimate.outputTokens;
	const fittingProfiles = profiles.filter((candidate) => candidate.profile.contextWindow >= neededTokens);
	const scoredPool = fittingProfiles.length > 0 ? fittingProfiles : profiles;
	const scored = scoreProfilesForTask(scoredPool, classification, estimate, objective);
	const bestScore = scored[0];
	const best = bestScore ? scoredPool.find((candidate) => candidate.profile.ref === bestScore.model) : undefined;
	const selectedThinkingLevel = explicitThinkingLevel ?? best?.scopedThinkingLevel ?? defaultThinkingLevelForTask(classification, best?.profile, objective);
	const selectedModel = best?.profile.ref;
	const explainOnly = mode === "explain";
	const contextWarning = fittingProfiles.length === 0 ? " No candidate fit the estimated context; selected from the largest/available pool." : "";
	const decision = decisionFrom({
		mode,
		objective,
		applied: Boolean(!explainOnly && selectedModel),
		reason: explainOnly ? "explain_only" : "selected",
		selectedModel,
		selectedThinkingLevel,
		explicitModel,
		explicitThinkingLevel,
		classification,
		estimate,
		explanation: `${classification.reason}; selected ${selectedModel ?? "no model"} for ${classification.intent} (${objective}).${contextWarning}`,
		candidates: scored,
	});
	return {
		model: explainOnly ? undefined : selectedModel,
		thinkingLevel: explicitThinkingLevel ?? (explainOnly ? undefined : selectedThinkingLevel),
		decision,
		classification,
		profiles,
	};
}
