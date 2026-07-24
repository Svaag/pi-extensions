import type { RouterConfig } from "../config/schema.ts";
import { TASK_INTENTS, type DeterministicTaskInput, type IntentClassification, type ModelProfile, type TaskIntent } from "./types.ts";

export interface ClassifierDecision {
	intent: TaskIntent;
	risk: number;
	complexity: number;
	confidence: number;
	reason: string;
}

export interface ClassifierRequest {
	model: ModelProfile;
	prompt: string;
	base: IntentClassification;
	metadata: Record<string, unknown>;
}

export type RouterClassifier = (request: ClassifierRequest) => Promise<ClassifierDecision | undefined>;

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function truncateMiddle(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const edge = Math.max(1, Math.floor((maxChars - 20) / 2));
	return `${value.slice(0, edge)}\n...[truncated]...\n${value.slice(-edge)}`;
}

export function buildClassifierPrompt(input: DeterministicTaskInput, config: RouterConfig): string {
	const metadata = {
		taskName: input.taskName,
		agentName: input.agentName,
		writeMode: input.writeMode,
		tools: input.tools,
		contextMode: input.contextMode,
		batch: input.batch ? { source: input.batch.source, itemCount: input.batch.itemCount } : undefined,
		promptChars: input.prompt?.length ?? 0,
	};
	return [
		"Classify this task for model routing. Return strict JSON only.",
		`Allowed intents: ${TASK_INTENTS.join(", ")}.`,
		"Keys: intent, risk, complexity, confidence, reason. Numeric fields are 0 through 1.",
		`Metadata: ${JSON.stringify(metadata)}`,
		`Task: ${truncateMiddle(input.prompt ?? "", config.classifier.maxPromptChars)}`,
	].join("\n\n");
}

export function parseClassifierDecision(text: string): ClassifierDecision | undefined {
	const json = text.trim().startsWith("{") ? text.trim() : text.match(/\{[\s\S]*\}/)?.[0];
	if (!json) return undefined;
	try {
		const value = JSON.parse(json) as Record<string, unknown>;
		if (typeof value.intent !== "string" || !TASK_INTENTS.includes(value.intent as TaskIntent)) return undefined;
		if (![value.risk, value.complexity, value.confidence].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
		return {
			intent: value.intent as TaskIntent,
			risk: clamp(value.risk as number),
			complexity: clamp(value.complexity as number),
			confidence: clamp(value.confidence as number),
			reason: typeof value.reason === "string" ? value.reason : "classifier result",
		};
	} catch {
		return undefined;
	}
}

export function applyClassifierDecision(base: IntentClassification, decision: ClassifierDecision): IntentClassification {
	return {
		...base,
		intent: decision.intent,
		risk: decision.risk,
		complexity: decision.complexity,
		confidence: Math.max(base.confidence, decision.confidence),
		reason: `classifier: ${decision.reason}`,
		signals: [...base.signals, `classifier:${decision.confidence.toFixed(2)}`],
	};
}
