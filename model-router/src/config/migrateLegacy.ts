import type { RouterConfig } from "./schema.ts";

export interface LegacyMigrationResult {
	patch: Record<string, unknown>;
	warnings: string[];
}

/** Maps the former Subagent router shape into the shared v1 shape without mutating input. */
export function migrateLegacyRouterConfig(value: unknown): LegacyMigrationResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { patch: {}, warnings: [] };
	const legacy = value as Record<string, unknown>;
	const patch: Record<string, unknown> = {};
	const warnings: string[] = [];
	if (typeof legacy.enabled === "boolean") patch.enabled = legacy.enabled;
	if (typeof legacy.objective === "string") patch.profile = legacy.objective;
	if (typeof legacy.showExplanations === "boolean") patch.showExplanations = legacy.showExplanations;
	if (legacy.complexity && typeof legacy.complexity === "object") {
		const complexity = legacy.complexity as Record<string, unknown>;
		patch.complexity = {
			thresholds: complexity.thresholds,
			qualityFloor: complexity.tierQualityFloor,
		};
	}
	if (legacy.classifier && typeof legacy.classifier === "object") {
		const classifier = { ...(legacy.classifier as Record<string, unknown>) };
		if (classifier.enabled === "auto") classifier.enabled = false;
		delete classifier.requireLocalOrZeroCost;
		patch.classifier = classifier;
	}
	if (legacy.modelProfiles && typeof legacy.modelProfiles === "object") patch.modelProfiles = legacy.modelProfiles;
	if (legacy.profiles && typeof legacy.profiles === "object" && !patch.modelProfiles) patch.modelProfiles = legacy.profiles;
	if (Object.keys(patch).length > 0) warnings.push("Legacy subagent-router.json was loaded; migrate settings to model-router.json.");
	return { patch, warnings };
}

export type { RouterConfig };
