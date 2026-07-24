import assert from "node:assert/strict";
import test from "node:test";
import { capToolResultText, isPathAllowed, isRawBinaryPath, isReadOnlyShellCommand, isReadPathAllowed, loadPolicy, looksLikeBinaryText } from "../subagent/child-policy.ts";

test("child policy allows common read-only commands", () => {
	assert.equal(isReadOnlyShellCommand("git status --short"), true);
	assert.equal(isReadOnlyShellCommand("rg TODO src"), true);
	assert.equal(isReadOnlyShellCommand("sed -n '1,20p' file.ts"), true);
	assert.equal(isReadOnlyShellCommand("pwd && ls -la && find . -maxdepth 2 -type f | head -50"), true);
	assert.equal(isReadOnlyShellCommand("sqlite3 -readonly data/hunter.db 'select count(*) from audit_targets'"), true);
});

test("child policy blocks mutating and sensitive shell commands", () => {
	assert.equal(isReadOnlyShellCommand("rm -rf node_modules"), false);
	assert.equal(isReadOnlyShellCommand("git checkout main"), false);
	assert.equal(isReadOnlyShellCommand("python script.py"), false);
	assert.equal(isReadOnlyShellCommand("cat .env"), false);
	assert.equal(isReadOnlyShellCommand("head config/.npmrc"), false);
	assert.equal(isReadOnlyShellCommand("sqlite3 data/hunter.db 'select 1'"), false);
	assert.equal(isReadOnlyShellCommand("sqlite3 -readonly data/hunter.db 'drop table audit_targets'"), false);
	assert.equal(isReadOnlyShellCommand("rg TODO src > out.txt"), false);
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

test("child policy identifies raw binary paths", () => {
	assert.equal(isRawBinaryPath("/repo/data/hunter.db"), true);
	assert.equal(isRawBinaryPath("/repo/audit-artifacts/summary.json"), false);
});

test("child policy caps huge and binary-looking tool result text", () => {
	const huge = capToolResultText("a".repeat(10_000), 4_000);
	assert.equal(huge.changed, true);
	assert(huge.text.includes("tool output truncated"));
	assert(huge.text.length <= 4_200);

	const binary = "SQLite format 3\u0000" + "\u0000".repeat(100);
	assert.equal(looksLikeBinaryText(binary), true);
	const capped = capToolResultText(binary, 4_000);
	assert.equal(capped.changed, true);
	assert(capped.text.includes("likely binary"));
});

test("loadPolicy falls back safely", () => {
	assert.equal(loadPolicy({ PI_SUBAGENT_POLICY: "not-json" }).writeMode, "read_only");
});
