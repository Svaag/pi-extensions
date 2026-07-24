import type { RouterComplexityThresholds } from "../config/schema.ts";
import type {
	ComplexityAssessment,
	ComplexityTier,
	DeterministicTaskInput,
	IntentClassification,
	RoutingTokenEstimate,
	TaskIntent,
} from "./types.ts";

const HIGH_RISK = ["security", "auth", "authentication", "authorization", "crypto", "wallet", "payment", "permission", "secret", "migration", "schema", "prod", "production", "data loss", "concurrency", "race", "refactor", "architecture", "failing", "review"];
const SENSITIVE = ["security", "auth", "authentication", "payment", "wallet", "secret", "credential", "private key", "privacy"];
const LOW_RISK = ["list", "find", "locate", "grep", "search", "summarize", "inventory", "inspect", "read-only", "map"];
const INTENT_COMPLEXITY: Record<TaskIntent, number> = { lookup: 0.05, batch_simple: 0.1, summarize: 0.15, scout: 0.3, debug: 0.45, plan: 0.5, review: 0.6, implement: 0.7, complex: 0.85 };

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function escape(value: string): string { return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"); }
function contains(text: string, keyword: string): boolean {
	return /\s/.test(keyword) ? text.includes(keyword) : new RegExp(`\\b${escape(keyword)}\\b`, "i").test(text);
}
function any(text: string, words: string[]): boolean { return words.some((word) => contains(text, word)); }
function count(text: string, words: string[]): number { return words.reduce((total, word) => total + Number(contains(text, word)), 0); }
function taskText(input: DeterministicTaskInput): string {
	return [input.taskName ?? "", input.agentName ?? "", input.prompt ?? "", input.agentDefinition ?? "", input.contextSummary ?? "", ...(input.batch?.samplePrompts ?? [])].join("\n").toLowerCase();
}
function writeCapable(input: DeterministicTaskInput): boolean {
	return Boolean(input.writeMode && input.writeMode !== "read_only") || Boolean(input.tools?.some((tool) => tool === "edit" || tool === "write"));
}

export function classifyTaskIntent(input: DeterministicTaskInput): IntentClassification {
	const text = taskText(input);
	const signals: string[] = [];
	const highRiskCount = count(text, HIGH_RISK);
	const lowRiskCount = count(text, LOW_RISK);
	const canWrite = writeCapable(input);
	const promptChars = (input.prompt?.length ?? 0) + (input.agentDefinition?.length ?? 0) + (input.contextSummary?.length ?? 0);
	const multiStep = any(text, ["multi-step", "end-to-end", "architecture", "design", "system", "across", "all usages"]);
	const complexity = clamp(promptChars / 18_000 + (multiStep ? 0.25 : 0) + Math.min(0.35, highRiskCount * 0.06));
	const risk = clamp(highRiskCount * 0.12 + (canWrite ? 0.25 : 0) + (multiStep ? 0.08 : 0) - lowRiskCount * 0.04);
	let intent: TaskIntent = "scout";
	let confidence = 0.58;
	let reason = "defaulted to scout-style reconnaissance";
	const agent = input.agentName?.toLowerCase() ?? "";
	if (input.batch && !canWrite && risk < 0.55) { intent = "batch_simple"; confidence = 0.82; reason = "structured low-risk batch fan-out"; signals.push("batch"); }
	else if (agent.includes("review") || any(text, ["review", "audit", "security analysis", "vulnerability", "quality analysis"])) { intent = "review"; confidence = 0.82; reason = "review/audit/security language detected"; signals.push("review"); }
	else if (canWrite || any(text, ["implement", "modify", "change", "edit", "write", "create", "add support", "fix bug", "make changes"])) { intent = canWrite || risk >= 0.45 ? "implement" : "plan"; confidence = canWrite ? 0.86 : 0.72; reason = canWrite ? "write-capable task" : "implementation language without write capability"; signals.push(canWrite ? "write-capable" : "implementation-language"); }
	else if (agent.includes("plan") || any(text, ["plan", "design", "architecture", "approach", "proposal", "roadmap"])) { intent = "plan"; confidence = 0.78; reason = "planning/design language detected"; signals.push("planning"); }
	else if (any(text, ["debug", "diagnose", "failing", "failure", "error", "stack trace", "test failure", "regression"])) { intent = "debug"; confidence = 0.76; reason = "debug/failure language detected"; signals.push("debug"); }
	else if (any(text, ["summarize", "summary", "compress", "extract notes", "rewrite", "transform"])) { intent = "summarize"; confidence = 0.78; reason = "summarization/transformation language detected"; signals.push("summarize"); }
	else if (any(text, ["find", "locate", "grep", "search", "list", "where is", "which file", "show me"]) && promptChars < 8_000) { intent = "lookup"; confidence = 0.8; reason = "targeted lookup/search language detected"; signals.push("lookup"); }
	else if (agent.includes("scout") || any(text, ["scout", "inspect", "inventory", "map", "explore", "codebase", "trace", "recon"])) { intent = "scout"; confidence = 0.74; reason = "scout/reconnaissance language detected"; signals.push("scout"); }
	if (intent === "scout" && risk >= 0.65 && complexity >= 0.55) { intent = "complex"; confidence = Math.max(confidence, 0.7); reason = "high-risk, high-complexity task"; signals.push("complexity-promotion"); }
	if (highRiskCount) signals.push(`high-risk-keywords:${highRiskCount}`);
	if (lowRiskCount) signals.push(`low-risk-keywords:${lowRiskCount}`);
	if (input.contextMode && input.contextMode !== "fresh") signals.push(`context:${input.contextMode}`);
	return { intent, risk, complexity, confidence: clamp(confidence - Math.min(0.22, Math.max(0, signals.length - 3) * 0.04)), reason, signals, sensitive: any(text, SENSITIVE) };
}

export function complexityTierForScore(score: number, thresholds: RouterComplexityThresholds): ComplexityTier {
	if (score < thresholds.trivialMax) return "trivial";
	if (score < thresholds.simpleMax) return "simple";
	if (score < thresholds.moderateMax) return "moderate";
	if (score < thresholds.complexMax) return "complex";
	return "critical";
}

export function assessTaskComplexity(input: DeterministicTaskInput, classification: IntentClassification, thresholds: RouterComplexityThresholds): ComplexityAssessment {
	const contextBoost = input.contextMode && input.contextMode !== "fresh" ? 1 : 0;
	const complexityScore = clamp(0.45 * INTENT_COMPLEXITY[classification.intent] + 0.25 * classification.complexity + 0.25 * classification.risk + 0.05 * contextBoost);
	return { complexityScore, complexityTier: complexityTierForScore(complexityScore, thresholds), contextBoost };
}

export function estimateRoutingTokens(input: DeterministicTaskInput, intent: TaskIntent, suppliedContext?: number, suppliedOutput?: number): RoutingTokenEstimate {
	const chars = (input.prompt?.length ?? 0) + (input.agentDefinition?.length ?? 0) + (input.contextSummary?.length ?? 0) + (input.batch?.samplePrompts?.join("\n").length ?? 0);
	const inputTokens = suppliedContext ?? Math.ceil(chars / 4) + 1_000;
	const outputTokens = suppliedOutput ?? (intent === "lookup" || intent === "summarize" ? 1_000 : intent === "scout" || intent === "batch_simple" ? 2_000 : intent === "debug" || intent === "plan" || intent === "review" ? 3_000 : 4_000);
	return { inputTokens, outputTokens };
}

export function contextSizeBucket(tokens: number): string {
	if (tokens < 8_000) return "xs";
	if (tokens < 32_000) return "s";
	if (tokens < 128_000) return "m";
	if (tokens < 512_000) return "l";
	return "xl";
}

export function cohortKey(host: string, classification: IntentClassification, assessment: ComplexityAssessment, input: DeterministicTaskInput, tokens: number): string {
	const tools = input.tools?.length ? "tools" : "no-tools";
	const write = writeCapable(input) ? "write" : "read";
	return [host, classification.intent, assessment.complexityTier, contextSizeBucket(tokens), input.modality ?? "text", tools, write].join("|");
}
