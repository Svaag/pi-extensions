import assert from "node:assert/strict";
import test from "node:test";
import { expandSpawnParams } from "../subagent/tools/spawnParams.ts";

test("expandSpawnParams supports multi-task spawning in one tool execution", () => {
	const expanded = expandSpawnParams({
		cwd: "/repo",
		writeMode: "read_only",
		parentAgentId: "agent_parent",
		model: "local-llamacpp/local-model",
		taskPath: "/root/not-shared",
		tasks: [
			{ taskName: "one", prompt: "Inspect one" },
			{ taskName: "two", prompt: "Inspect two", cwd: "/repo/nested" },
		],
	});

	assert.equal(expanded.length, 2);
	assert.deepEqual(expanded.map((item) => item.taskName), ["one", "two"]);
	assert.equal(expanded[0].parentAgentId, "agent_parent");
	assert.equal(expanded[0].model, "local-llamacpp/local-model");
	assert.equal(expanded[0].cwd, "/repo");
	assert.equal(expanded[1].cwd, "/repo/nested");
	assert.equal(expanded[0].taskPath, undefined, "top-level taskPath must not be copied to every task");
});

test("expandSpawnParams validates single and multi-task shapes", () => {
	assert.deepEqual(expandSpawnParams({ taskName: "one", prompt: "Inspect one" }), [{ taskName: "one", prompt: "Inspect one" }]);
	assert.throws(() => expandSpawnParams({ taskName: "one" }), /requires taskName and prompt/);
	assert.throws(() => expandSpawnParams({ tasks: [] }), /must not be empty/);
	assert.throws(() => expandSpawnParams({ tasks: [{ taskName: "one" }] }), /index 0 requires taskName and prompt/);
});
