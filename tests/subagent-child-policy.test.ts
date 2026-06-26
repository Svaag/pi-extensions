import assert from "node:assert/strict";
import test from "node:test";
import { isPathAllowed, isReadOnlyShellCommand, loadPolicy } from "../subagent/child-policy.ts";

test("child policy allows common read-only commands", () => {
	assert.equal(isReadOnlyShellCommand("git status --short"), true);
	assert.equal(isReadOnlyShellCommand("rg TODO src"), true);
	assert.equal(isReadOnlyShellCommand("sed -n '1,20p' file.ts"), true);
});

test("child policy blocks mutating shell commands", () => {
	assert.equal(isReadOnlyShellCommand("rm -rf node_modules"), false);
	assert.equal(isReadOnlyShellCommand("git checkout main"), false);
	assert.equal(isReadOnlyShellCommand("python script.py"), false);
});

test("child policy enforces disjoint write paths and denied files", () => {
	const policy = { agentId: "a", writeMode: "disjoint_scope" as const, cwd: "/repo", allowedPaths: ["/repo/src"] };
	assert.equal(isPathAllowed("/repo/src/a.ts", policy), true);
	assert.equal(isPathAllowed("/repo/test/a.ts", policy), false);
	assert.equal(isPathAllowed("/repo/src/.env", policy), false);
});

test("loadPolicy falls back safely", () => {
	assert.equal(loadPolicy({ PI_SUBAGENT_POLICY: "not-json" }).writeMode, "read_only");
});
