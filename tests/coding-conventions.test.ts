import assert from "node:assert/strict";
import test from "node:test";
import {
	applyRewrites,
	assembleConventionBlock,
	buildTrailer,
	buildTrailerLines,
	detectEcosystems,
	DEFAULT_CONFIG,
	findGitCommitSegments,
	parseConfig,
	resolveConventionLayer,
	resolveTrailerVersions,
	type ConventionLayer,
	type Ecosystem,
	type FsAccess,
} from "../coding-conventions/utils.ts";

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

test("parseConfig returns defaults for null/undefined", () => {
	const { config, errors } = parseConfig(null);
	assert.deepStrictEqual(config, DEFAULT_CONFIG);
	assert.deepStrictEqual(errors, []);
});

test("parseConfig returns defaults for invalid JSON types", () => {
	const { config, errors } = parseConfig("not an object");
	assert.deepStrictEqual(config, DEFAULT_CONFIG);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /must be a JSON object/i);
});

test("parseConfig merges partial attribution overrides", () => {
	const { config, errors } = parseConfig({
		attribution: { agentName: "my-agent", tools: ["coccinelle", "sparse"] },
	});
	assert.equal(config.attribution.agentName, "my-agent");
	assert.deepStrictEqual(config.attribution.tools, ["coccinelle", "sparse"]);
	assert.equal(config.attribution.modelVersion, "auto"); // default preserved
	assert.equal(config.attribution.enabled, true);
	assert.deepStrictEqual(errors, []);
});

test("parseConfig merges partial conventions overrides", () => {
	const { config, errors } = parseConfig({
		conventions: { global: false, overridesDir: "/custom/path" },
	});
	assert.equal(config.conventions.global, false);
	assert.equal(config.conventions.overridesDir, "/custom/path");
	assert.equal(config.conventions.commitRules, true); // default preserved
	assert.deepStrictEqual(errors, []);
});

test("parseConfig rejects invalid characters in agentName", () => {
	const { config, errors } = parseConfig({
		attribution: { agentName: "bad;name" },
	});
	assert.equal(config.attribution.agentName, DEFAULT_CONFIG.attribution.agentName);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /invalid characters/i);
});

test("parseConfig rejects non-array tools", () => {
	const { config, errors } = parseConfig({
		attribution: { tools: "not-an-array" },
	});
	assert.deepStrictEqual(config.attribution.tools, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /must be an array/i);
});

test("parseConfig allows static modelVersion", () => {
	const { config, errors } = parseConfig({
		attribution: { modelVersion: "static-4.5" },
	});
	assert.equal(config.attribution.modelVersion, "static-4.5");
	assert.deepStrictEqual(errors, []);
});

test("parseConfig rejects invalid modelVersion characters", () => {
	const { config, errors } = parseConfig({
		attribution: { modelVersion: "bad'; rm -rf /" },
	});
	// Should fall back to "auto" since the string has unsafe characters
	assert.equal(config.attribution.modelVersion, "auto");
	assert.equal(errors.length, 1);
});

test("parseConfig allows conventions.overridesDir null", () => {
	const { config, errors } = parseConfig({
		conventions: { overridesDir: null },
	});
	assert.equal(config.conventions.overridesDir, null);
	assert.deepStrictEqual(errors, []);
});

test("parseConfig allows full config", () => {
	const full = {
		attribution: {
			enabled: true,
			agentName: "pi",
			tools: ["coccinelle"],
			modelVersion: "auto",
			includeUserBash: false,
		},
		conventions: {
			enabled: true,
			global: true,
			commitRules: true,
			ecosystemDetection: false,
			overridesDir: "/tmp/overrides",
		},
	};
	const { config, errors } = parseConfig(full);
	assert.deepStrictEqual(config, full);
	assert.deepStrictEqual(errors, []);
});

// ---------------------------------------------------------------------------
// buildTrailer
// ---------------------------------------------------------------------------

test("buildTrailer with auto model version", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution };
	const result = buildTrailer(cfg, "claude-opus-4-5");
	assert.equal(result, "Assisted-by: pi-coding-agent:claude-opus-4-5");
});

test("buildTrailer with unknown model", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution };
	const result = buildTrailer(cfg, undefined);
	assert.equal(result, "Assisted-by: pi-coding-agent:unknown");
});

test("buildTrailer with static model version", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, modelVersion: "pinned-v1" };
	const result = buildTrailer(cfg, "ignored-model");
	assert.equal(result, "Assisted-by: pi-coding-agent:pinned-v1");
});

test("buildTrailer with tools", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, tools: ["coccinelle", "sparse"] };
	const result = buildTrailer(cfg, "claude-opus-4-5");
	assert.equal(result, "Assisted-by: pi-coding-agent:claude-opus-4-5 coccinelle sparse");
});

test("buildTrailer with one tool", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, tools: ["clang-tidy"] };
	const result = buildTrailer(cfg, "claude-opus-4-5");
	assert.equal(result, "Assisted-by: pi-coding-agent:claude-opus-4-5 clang-tidy");
});

test("buildTrailer returns empty when disabled", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, enabled: false };
	assert.equal(buildTrailer(cfg, "claude-opus-4-5"), "");
});

test("buildTrailer with custom agentName", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, agentName: "custom-agent" };
	const result = buildTrailer(cfg, "gpt-5");
	assert.equal(result, "Assisted-by: custom-agent:gpt-5");
});

// ---------------------------------------------------------------------------
// resolveTrailerVersions / buildTrailerLines
// ---------------------------------------------------------------------------

test("resolveTrailerVersions auto uses active model when no session models", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution };
	assert.deepStrictEqual(resolveTrailerVersions(cfg, "balanced", []), ["balanced"]);
	assert.deepStrictEqual(resolveTrailerVersions(cfg, undefined, []), ["unknown"]);
});

test("resolveTrailerVersions auto lists all session models in first-seen order", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution };
	const result = resolveTrailerVersions(cfg, "balanced", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
	assert.deepStrictEqual(result, ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
});

test("resolveTrailerVersions static ignores session models", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, modelVersion: "pinned-v1" };
	assert.deepStrictEqual(resolveTrailerVersions(cfg, "balanced", ["a", "b"]), ["pinned-v1"]);
});

test("buildTrailerLines emits one Assisted-by per model (kernel style)", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution };
	const lines = buildTrailerLines(cfg, "balanced", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
	assert.deepStrictEqual(lines, [
		"Assisted-by: pi-coding-agent:anthropic/claude-sonnet-4-5",
		"Assisted-by: pi-coding-agent:openai/gpt-5",
	]);
});

test("buildTrailerLines attaches tools only to the first line", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, tools: ["coccinelle", "sparse"] };
	const lines = buildTrailerLines(cfg, "balanced", ["a", "b"]);
	assert.deepStrictEqual(lines, [
		"Assisted-by: pi-coding-agent:a coccinelle sparse",
		"Assisted-by: pi-coding-agent:b",
	]);
});

test("buildTrailerLines returns empty when disabled", () => {
	const cfg = { ...DEFAULT_CONFIG.attribution, enabled: false };
	assert.deepStrictEqual(buildTrailerLines(cfg, "x", ["a", "b"]), []);
});

// ---------------------------------------------------------------------------
// findGitCommitSegments — basic cases
// ---------------------------------------------------------------------------

test("finds simple git commit", () => {
	const segments = findGitCommitSegments('git commit -m "hello"');
	assert.equal(segments.length, 1);
	const cmd = 'git commit -m "hello"';
	// configInsertPos where 'commit' starts
	assert.equal(cmd[segments[0].configInsertPos], "c");
});

test("finds git commit with global options", () => {
	const segments = findGitCommitSegments("git -C /tmp -c user.name=test commit --amend");
	assert.equal(segments.length, 1);
});

test("finds git commit with env assignments", () => {
	const segments = findGitCommitSegments('GIT_EDITOR=true GIT_AUTHOR_NAME="Foo Bar" git commit -m x');
	assert.equal(segments.length, 1);
});

test("finds git commit with sudo", () => {
	const segments = findGitCommitSegments("sudo git commit -m x");
	assert.equal(segments.length, 1);
});

test("finds git commit with sudo and env assignments", () => {
	const segments = findGitCommitSegments("sudo GIT_DIR=/tmp git commit -m x");
	assert.equal(segments.length, 1);
});

test("does NOT match commit-tree", () => {
	const segments = findGitCommitSegments("git commit-tree abc123");
	assert.equal(segments.length, 0);
});

test("does NOT match commit-graph", () => {
	const segments = findGitCommitSegments("git commit-graph write");
	assert.equal(segments.length, 0);
});

test("skips when Assisted-by already present", () => {
	const segments = findGitCommitSegments('git commit -m "Assisted-by: already here"');
	assert.equal(segments.length, 0);
});

// ---------------------------------------------------------------------------
// findGitCommitSegments — chained commands
// ---------------------------------------------------------------------------

test("finds commit in chained command with &&", () => {
	const segments = findGitCommitSegments('git add -A && git commit -m "x" && git push');
	assert.equal(segments.length, 1);
});

test("finds commit in chained command with ||", () => {
	const segments = findGitCommitSegments('git commit -m "a" || git commit -m "b"');
	assert.equal(segments.length, 2);
});

test("finds commit in chained command with ;", () => {
	const segments = findGitCommitSegments('git add .; git commit -m "x"; git push');
	assert.equal(segments.length, 1);
});

test("finds commit in chained command with |", () => {
	const segments = findGitCommitSegments('git log -1 | cat; git commit -m "x"');
	assert.equal(segments.length, 1);
});

test("finds commit in multi-line command", () => {
	const segments = findGitCommitSegments('git add -A\ngit commit -m "x"\ngit push');
	assert.equal(segments.length, 1);
});

// ---------------------------------------------------------------------------
// findGitCommitSegments — quoted strings
// ---------------------------------------------------------------------------

test("does not match git commit inside single quotes", () => {
	const segments = findGitCommitSegments("echo 'git commit -m x'");
	assert.equal(segments.length, 0);
});

test("does not match git commit inside double quotes", () => {
	const segments = findGitCommitSegments('echo "git commit -m x"');
	assert.equal(segments.length, 0);
});

test('git commit inside commit message string counts once', () => {
	const segments = findGitCommitSegments('git commit -m "fix git commit parsing"');
	assert.equal(segments.length, 1);
});

test("escaped double quote in message", () => {
	const segments = findGitCommitSegments('git commit -m "escaped \\"quote\\" here"');
	assert.equal(segments.length, 1);
});

// ---------------------------------------------------------------------------
// findGitCommitSegments — non-git commands
// ---------------------------------------------------------------------------

test("does not match non-git commands", () => {
	assert.equal(findGitCommitSegments("npm test").length, 0);
	assert.equal(findGitCommitSegments("cargo build").length, 0);
	assert.equal(findGitCommitSegments("ls -la").length, 0);
	assert.equal(findGitCommitSegments("echo hello").length, 0);
});

// ---------------------------------------------------------------------------
// applyRewrites
// ---------------------------------------------------------------------------

test("applyRewrites inserts trailer and dedup flag", () => {
	const segments = findGitCommitSegments('git commit -m "hello"');
	assert.equal(segments.length, 1);
	const result = applyRewrites(
		'git commit -m "hello"',
		segments,
		"Assisted-by: pi-coding-agent:claude-opus-4-5",
	);
	// Should contain the dedup flag and the trailer flag
	assert.match(result, /-c trailer\.ifExists=addIfDifferent/);
	assert.match(result, /--trailer 'Assisted-by: pi-coding-agent:claude-opus-4-5'/);
	// Original args preserved
	assert.match(result, /-m "hello"/);
	// git commit still there
	assert.match(result, /git .* commit/);
});

test("applyRewrites handles multiple commits in one command", () => {
	const segments = findGitCommitSegments('git commit -m a || git commit -m b');
	assert.equal(segments.length, 2);
	const result = applyRewrites(
		'git commit -m a || git commit -m b',
		segments,
		"Assisted-by: agent:model",
	);
	// Both commits get rewritten (count occurrences)
	const trailerCount = (result.match(/--trailer/g) || []).length;
	assert.equal(trailerCount, 2);
});

test("applyRewrites handles global options", () => {
	const segments = findGitCommitSegments("git -C /tmp -c user.name=x commit --amend");
	assert.equal(segments.length, 1);
	const result = applyRewrites(
		"git -C /tmp -c user.name=x commit --amend",
		segments,
		"Assisted-by: agent:model",
	);
	// -c for dedup inserted before commit
	assert.match(result, /git -C \/tmp -c user\.name=x -c trailer\.ifExists=addIfDifferent commit --trailer/);
});

test("applyRewrites with empty segments returns original", () => {
	const result = applyRewrites("echo hello", [], "Assisted-by: x");
	assert.equal(result, "echo hello");
});

test("applyRewrites accepts multiple trailer lines (one --trailer each)", () => {
	const segments = findGitCommitSegments('git commit -m "hello"');
	assert.equal(segments.length, 1);
	const result = applyRewrites(
		'git commit -m "hello"',
		segments,
		["Assisted-by: pi-coding-agent:a", "Assisted-by: pi-coding-agent:b"],
	);
	const trailerCount = (result.match(/--trailer/g) || []).length;
	assert.equal(trailerCount, 2);
	// Both models appear, in order
	assert.match(result, /--trailer 'Assisted-by: pi-coding-agent:a' --trailer 'Assisted-by: pi-coding-agent:b'/);
	assert.match(result, /-c trailer\.ifExists=addIfDifferent/);
});

test("applyRewrites escapes single quotes in trailer", () => {
	const segments = findGitCommitSegments('git commit -m x');
	assert.equal(segments.length, 1);
	const rewritten = applyRewrites("git commit -m x", segments, "O'Brien's fix");
	// The rewrite inserts single-quoted --trailer value; inner quotes must be escaped
	assert.match(rewritten, /--trailer '/);
	assert.match(rewritten, /O'\\''Brien'\\''s fix/);
});

// ---------------------------------------------------------------------------
// detectEcosystems
// ---------------------------------------------------------------------------

function fakeFs(files: Record<string, string | null>): FsAccess {
	return {
		exists(relPath: string): boolean {
			return relPath in files;
		},
		readFile(relPath: string): string | null {
			const val = files[relPath];
			return val ?? null;
		},
		listDir(relPath: string): string[] {
			// Return root-level filenames for "." queries
			if (relPath === "." || relPath === "") {
				return Object.keys(files);
			}
			return [];
		},
	};
}

test("detects kernel tree", () => {
	const fs = fakeFs({ MAINTAINERS: "", "scripts/checkpatch.pl": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["kernel"]);
});

test("kernel suppresses generic C", () => {
	const fs = fakeFs({
		MAINTAINERS: "",
		"scripts/checkpatch.pl": "",
		"main.c": "",
		"Makefile": "",
	});
	const result = detectEcosystems(fs);
	// Should be kernel, NOT ["kernel", "c"]
	assert.deepStrictEqual(result, ["kernel"]);
});

test("detects generic C via .c files", () => {
	const fs = fakeFs({ "main.c": "", "util.h": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["c"]);
});

test("detects generic C via Makefile", () => {
	const fs = fakeFs({ Makefile: "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["c"]);
});

test("detects generic C via CMakeLists.txt", () => {
	const fs = fakeFs({ "CMakeLists.txt": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["c"]);
});

test("detects Rust", () => {
	const fs = fakeFs({ "Cargo.toml": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["rust"]);
});

test("detects Go", () => {
	const fs = fakeFs({ "go.mod": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["go"]);
});

test("detects Python via pyproject.toml", () => {
	const fs = fakeFs({ "pyproject.toml": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["python"]);
});

test("detects Python via setup.py", () => {
	const fs = fakeFs({ "setup.py": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["python"]);
});

test("detects TypeScript via tsconfig.json", () => {
	const fs = fakeFs({ "tsconfig.json": "" });
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["typescript"]);
});

test("detects TypeScript via package.json with devDependencies.typescript", () => {
	const fs = fakeFs({
		"package.json": JSON.stringify({ devDependencies: { typescript: "^5.0" } }),
	});
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["typescript"]);
});

test("does NOT detect TypeScript from package.json without typescript dep", () => {
	const fs = fakeFs({
		"package.json": JSON.stringify({ devDependencies: { jest: "^29" } }),
	});
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, []);
});

test("detects multiple ecosystems (monorepo)", () => {
	const fs = fakeFs({
		"Cargo.toml": "",
		"pyproject.toml": "",
		"tsconfig.json": "",
	});
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, ["rust", "python", "typescript"]);
});

test("empty repo detects nothing", () => {
	const fs = fakeFs({});
	const result = detectEcosystems(fs);
	assert.deepStrictEqual(result, []);
});

// ---------------------------------------------------------------------------
// resolveConventionLayer
// ---------------------------------------------------------------------------

test("resolveConventionLayer uses builtin when no override", () => {
	const readFile = (path: string): string | null => {
		if (path === "/builtin/global.md") return "Builtin content";
		return null;
	};
	const layer = resolveConventionLayer("/builtin/global.md", null, readFile);
	assert.notEqual(layer, null);
	assert.equal(layer!.content, "Builtin content");
	assert.equal(layer!.name, "global");
});

test("resolveConventionLayer uses override when available", () => {
	const readFile = (path: string): string | null => {
		if (path === "/override/global.md") return "Override content";
		if (path === "/builtin/global.md") return "Builtin content";
		return null;
	};
	const layer = resolveConventionLayer("/builtin/global.md", "/override/global.md", readFile);
	assert.notEqual(layer, null);
	assert.equal(layer!.content, "Override content");
});

test("resolveConventionLayer returns null for empty override", () => {
	const readFile = (path: string): string | null => {
		if (path === "/override/global.md") return "   \n  "; // whitespace only
		return null;
	};
	const layer = resolveConventionLayer("/builtin/global.md", "/override/global.md", readFile);
	assert.equal(layer, null);
});

test("resolveConventionLayer returns null when both missing", () => {
	const readFile = (_path: string): string | null => null;
	const layer = resolveConventionLayer("/builtin/missing.md", null, readFile);
	assert.equal(layer, null);
});

// ---------------------------------------------------------------------------
// assembleConventionBlock
// ---------------------------------------------------------------------------

test("assembleConventionBlock assembles single layer", () => {
	const layers: ConventionLayer[] = [
		{ name: "Global", content: "Write clean code." },
	];
	const result = assembleConventionBlock(layers);
	assert.match(result, /## Global Conventions/);
	assert.match(result, /Write clean code/);
});

test("assembleConventionBlock assembles multiple layers", () => {
	const layers: ConventionLayer[] = [
		{ name: "Global", content: "Write clean code." },
		{ name: "Rust", content: "Use cargo fmt." },
	];
	const result = assembleConventionBlock(layers);
	assert.match(result, /## Global Conventions/);
	assert.match(result, /## Rust Conventions/);
	assert.match(result, /Write clean code/);
	assert.match(result, /Use cargo fmt/);
});

test("assembleConventionBlock returns empty for empty layers", () => {
	assert.equal(assembleConventionBlock([]), "");
});
