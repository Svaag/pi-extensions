import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "../subagent/agents.ts";

test("agent frontmatter parses thinking and model without router fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-frontmatter-test-"));
	try {
		await mkdir(join(dir, ".pi", "agents"), { recursive: true });
		await writeFile(join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Scout
model: local-llamacpp/local-model
thinking: minimal
---

Scout prompt.
`, "utf8");
		const agents = discoverAgents(dir, "project").agents;
		assert.equal(agents[0].thinkingLevel, "minimal");
		assert.equal(agents[0].model, "local-llamacpp/local-model");
		assert.equal(agents[0].routingMode, undefined);
		assert.equal(agents[0].routingProfile, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
