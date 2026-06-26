import assert from "node:assert/strict";
import test from "node:test";
import { isPathAllowed, isReadOnlyShellCommand, isReadPathAllowed, loadPolicy } from "../subagent/child-policy.ts";

test("child policy allows common read-only commands", () => {
	assert.equal(isReadOnlyShellCommand("git status --short"), true);
	assert.equal(isReadOnlyShellCommand("rg TODO src"), true);
	assert.equal(isReadOnlyShellCommand("sed -n '1,20p' file.ts"), true);
});

test("child policy blocks mutating and sensitive shell commands", () => {
	assert.equal(isReadOnlyShellCommand("rm -rf node_modules"), false);
	assert.equal(isReadOnlyShellCommand("git checkout main"), false);
	assert.equal(isReadOnlyShellCommand("python script.py"), false);
	assert.equal(isReadOnlyShellCommand("cat .env"), false);
	assert.equal(isReadOnlyShellCommand("head config/.npmrc"), false);
});

test("child policy enforces disjoint write paths and denied files", () => {
	const policy = { agentId: "a", writeMode: "disjoint_scope" as const, cwd: "/repo", allowedPaths: ["/repo/src"] };
	assert.equal(isPathAllowed("/repo/src/a.ts", policy), true);
	assert.equal(isPathAllowed("/repo/test/a.ts", policy), false);
	assert.equal(isPathAllowed("/repo/src/.env", policy), false);
});

test("child policy constrains read paths to cwd or allowed paths", () => {
	const policy = { agentId: "a", writeMode: "read_only" as const, cwd: "/repo", allowedPaths: ["/shared/docs"] };
	assert.equal(isReadPathAllowed("/repo/src/a.ts", policy), true);
	assert.equal(isReadPathAllowed("/shared/docs/ref.md", policy), true);
	assert.equal(isReadPathAllowed("/other/ref.md", policy), false);
	assert.equal(isReadPathAllowed("/repo/.env", policy), false);
});

test("loadPolicy falls back safely", () => {
	assert.equal(loadPolicy({ PI_SUBAGENT_POLICY: "not-json" }).writeMode, "read_only");
});
