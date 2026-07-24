import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiModelSource } from "../model-router/src/adapters/pi/PiModelSource.ts";

const models = [
	{ provider: "test", id: "cheap", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000 },
	{ provider: "test", id: "strong", reasoning: true, input: ["text", "image"], contextWindow: 100_000, maxTokens: 10_000, thinkingLevelMap: { xhigh: "max" } },
	{ provider: "model-router", id: "balanced", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 10_000 },
];

test("Pi model source intersects trusted enabled patterns, availability, and auth", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-model-source-"));
	const project = join(root, "project", "nested");
	try {
		await mkdir(project, { recursive: true });
		await writeFile(join(root, "settings.json"), JSON.stringify({ enabledModels: ["test/*"] }));
		await mkdir(join(root, "project", ".pi"), { recursive: true });
		await writeFile(join(root, "project", ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/strong:xhigh", "model-router/*"] }));
		const source = new PiModelSource({ agentDir: root });
		const registry = {
			getAvailable: async () => models,
			getApiKeyAndHeaders: async (model: any) => ({ ok: model.id !== "cheap" }),
			find: () => undefined,
		};
		const global = await source.snapshot({ cwd: project, projectTrusted: false, modelRegistry: registry });
		assert.deepEqual(global.candidates.map((item) => item.id), ["strong"]);
		const trusted = await source.snapshot({ cwd: project, projectTrusted: true, modelRegistry: registry });
		assert.deepEqual(trusted.candidates.map((item) => item.id), ["strong"]);
		assert.equal(trusted.candidates[0]?.scopedThinkingLevel, "xhigh");
		assert(!trusted.candidates.some((item) => item.provider === "model-router"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi model source fails closed when effective enabled scope is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-model-source-empty-"));
	try {
		const source = new PiModelSource({ agentDir: root });
		const snapshot = await source.snapshot({
			cwd: root,
			projectTrusted: false,
			modelRegistry: { getAvailable: async () => models, getApiKeyAndHeaders: async () => ({ ok: true }), find: () => undefined },
		});
		assert.deepEqual(snapshot.candidates, []);
		assert(snapshot.warnings.includes("enabled_models_not_configured"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
