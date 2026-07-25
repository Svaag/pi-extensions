/**
 * coding-conventions Extension
 *
 * Two features:
 * 1. Deterministically appends the kernel-style Assisted-by trailer
 *    to every git commit made through the Pi harness.
 * 2. Injects layered coding conventions into the system prompt:
 *    global base + commit rules + auto-detected ecosystem snippets.
 */

import {
	CONFIG_DIR_NAME,
	createLocalBashOperations,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyRewrites,
	assembleConventionBlock,
	buildTrailer,
	detectEcosystems,
	DEFAULT_CONFIG,
	findGitCommitSegments,
	parseConfig,
	resolveConventionLayer,
	type ConventionLayer,
	type Ecosystem,
	type ExtensionConfig,
	type FsAccess,
} from "./utils.js";

// Paths
const CONFIG_PATH = join(homedir(), ".pi", "agent", "coding-conventions.json");
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_CONVENTIONS_DIR = join(__dirname, "conventions");

const ECOSYSTEM_CONVENTION_FILES: Record<Ecosystem, string> = {
	kernel: "kernel.md",
	c: "c.md",
	rust: "rust.md",
	go: "go.md",
	python: "python.md",
	typescript: "typescript.md",
};

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

interface SessionState {
	config: ExtensionConfig;
	ecosystems: Ecosystem[];
	sessionEnabled: boolean; // toggled via /conventions on|off
	gitRoot: string | null;
	conventionsBlock: string;
}

function loadConfig(): { config: ExtensionConfig; errors: string[] } {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		return parseConfig(JSON.parse(raw));
	} catch {
		return parseConfig(null);
	}
}

function getOverrideDir(config: ConventionsConfig): string | null {
	if (config.overridesDir === null || config.overridesDir === undefined) {
		return join(homedir(), ".pi", "agent", "conventions");
	}
	// Expand ~
	if (config.overridesDir.startsWith("~")) {
		return join(homedir(), config.overridesDir.slice(1));
	}
	return config.overridesDir;
}

function resolveGitRoot(cwd: string): string | null {
	try {
		return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		return null;
	}
}

function makeFsAccess(root: string): FsAccess {
	return {
		exists(relPath: string): boolean {
			return existsSync(join(root, relPath));
		},
		readFile(relPath: string): string | null {
			try {
				return readFileSync(join(root, relPath), "utf-8");
			} catch {
				return null;
			}
		},
		listDir(relPath: string): string[] {
			try {
				return readdirSync(join(root, relPath));
			} catch {
				return [];
			}
		},
	};
}

function resolveConventionLayers(
	config: ConventionsConfig,
	ecosystems: Ecosystem[],
): ConventionLayer[] {
	const layers: ConventionLayer[] = [];
	const overridesDir = getOverrideDir(config);

	const readBuiltin = (filename: string) => {
		try {
			return readFileSync(join(BUILTIN_CONVENTIONS_DIR, filename), "utf-8");
		} catch {
			return null;
		}
	};
	const readOverride = (filename: string) => {
		if (overridesDir === null) return null;
		try {
			return readFileSync(join(overridesDir, filename), "utf-8");
		} catch {
			return null;
		}
	};

	// Global layer
	if (config.global) {
		const layer = resolveConventionLayer(
			join(BUILTIN_CONVENTIONS_DIR, "global.md"),
			overridesDir ? join(overridesDir, "global.md") : null,
			(path) => {
				if (path.startsWith(BUILTIN_CONVENTIONS_DIR)) return readBuiltin("global.md");
				return readOverride("global.md");
			},
		);
		if (layer) layers.push(layer);
	}

	// Commit rules layer
	if (config.commitRules) {
		const layer = resolveConventionLayer(
			join(BUILTIN_CONVENTIONS_DIR, "commit.md"),
			overridesDir ? join(overridesDir, "commit.md") : null,
			(path) => {
				if (path.startsWith(BUILTIN_CONVENTIONS_DIR)) return readBuiltin("commit.md");
				return readOverride("commit.md");
			},
		);
		if (layer) {
			// Rename to "Commit Message" for cleaner display
			layers.push({ name: "Commit Message", content: layer.content });
		}
	}

	// Ecosystem layers
	if (config.ecosystemDetection) {
		for (const eco of ecosystems) {
			const filename = ECOSYSTEM_CONVENTION_FILES[eco];
			if (!filename) continue;
			const layer = resolveConventionLayer(
				join(BUILTIN_CONVENTIONS_DIR, filename),
				overridesDir ? join(overridesDir, filename) : null,
				(path) => {
					if (path.startsWith(BUILTIN_CONVENTIONS_DIR)) return readBuiltin(filename);
					return readOverride(filename);
				},
			);
			if (layer) {
				// Use ecosystem name as display name
				const displayNames: Record<string, string> = {
					kernel: "Linux Kernel",
					c: "C/C++",
					rust: "Rust",
					go: "Go",
					python: "Python",
					typescript: "TypeScript",
				};
				layers.push({ name: displayNames[eco] || eco, content: layer.content });
			}
		}
	}

	return layers;
}

function computeConventionsBlock(config: ConventionsConfig, ecosystems: Ecosystem[]): string {
	const layers = resolveConventionLayers(config, ecosystems);
	return assembleConventionBlock(layers);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ---- Session state ---
	let state: SessionState = {
		config: DEFAULT_CONFIG,
		ecosystems: [],
		sessionEnabled: true,
		gitRoot: null,
		conventionsBlock: "",
	};

	// ---- session_start: load config, detect ecosystems ----
	pi.on("session_start", async (_event, ctx) => {
		const { config, errors } = loadConfig();
		state.config = config;
		state.sessionEnabled = true;

		if (errors.length > 0 && ctx.hasUI) {
			for (const err of errors) {
				ctx.ui.notify(`coding-conventions: ${err}`, "warning");
			}
		}

		// Detect git root + ecosystems
		state.gitRoot = resolveGitRoot(ctx.cwd);
		state.ecosystems = [];

		if (state.gitRoot && config.conventions.ecosystemDetection) {
			const fs = makeFsAccess(state.gitRoot);
			state.ecosystems = detectEcosystems(fs);
		}

		// Assemble convention blocks
		state.conventionsBlock = computeConventionsBlock(config.conventions, state.ecosystems);

		if (ctx.hasUI) {
			const trailer = buildTrailer(
				config.attribution,
				ctx.model?.id,
			);

			const parts: string[] = ["coding-conventions loaded"];
			if (config.attribution.enabled) parts.push(`trailer: ${trailer}`);
			if (config.conventions.enabled) {
				if (state.ecosystems.length > 0)
					parts.push(`ecosystems: ${state.ecosystems.join(", ")}`);
				else
					parts.push("no ecosystems detected");
			}
			ctx.ui.notify(parts.join(" | "), "info");
		}
	});

	// ---- tool_call: intercept bash git commit commands ---
	pi.on("tool_call", async (event, ctx) => {
		if (!state.config.attribution.enabled || !state.sessionEnabled) return;
		if (!isToolCallEventType("bash", event)) return;

		const trailer = buildTrailer(state.config.attribution, ctx.model?.id);
		if (!trailer) return;

		const segments = findGitCommitSegments(event.input.command);
		if (segments.length === 0) return;

		const rewritten = applyRewrites(event.input.command, segments, trailer);
		event.input.command = rewritten;

		if (ctx.hasUI) {
			ctx.ui.notify(`Added Assisted-by trailer to ${segments.length} git commit(s)`, "info");
		}
	});

	// ---- user_bash: intercept !git commit commands ---
	pi.on("user_bash", (event, ctx) => {
		if (!state.config.attribution.enabled || !state.sessionEnabled) return;
		if (!state.config.attribution.includeUserBash) return;

		const trailer = buildTrailer(state.config.attribution, ctx.model?.id);
		if (!trailer) return;

		const segments = findGitCommitSegments(event.command);
		if (segments.length === 0) return;

		const rewritten = applyRewrites(event.command, segments, trailer);
		const local = createLocalBashOperations();

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Added Assisted-by trailer to ${segments.length} git commit(s)`,
				"info",
			);
		}

		return {
			operations: {
				exec(command, cwd, options) {
					return local.exec(rewritten, cwd, options);
				},
				// Passthrough for non-exec operations
				kill: local.kill?.bind(local),
			},
		};
	});

	// ---- before_agent_start: inject conventions into system prompt ---
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.config.conventions.enabled || !state.sessionEnabled) return;
		if (!state.conventionsBlock) return;

		const block = `\n\n${state.conventionsBlock}`;
		return {
			systemPrompt: event.systemPrompt + block,
		};
	});

	// ---- /conventions command ----
	pi.registerCommand("conventions", {
		description: "Show or toggle coding-conventions extension state",
		handler: async (args, ctx) => {
			const normalized = args?.trim().toLowerCase() || "";

			if (normalized === "off") {
				state.sessionEnabled = false;
				if (ctx.hasUI) ctx.ui.notify("coding-conventions disabled for this session", "info");
				return;
			}

			if (normalized === "on") {
				state.sessionEnabled = true;
				if (ctx.hasUI) ctx.ui.notify("coding-conventions enabled", "info");
				return;
			}

			if (normalized === "reload") {
				// Re-read config + conventions from disk
				const { config, errors } = loadConfig();
				state.config = config;

				if (errors.length > 0 && ctx.hasUI) {
					for (const err of errors) ctx.ui.notify(err, "warning");
				}

				state.gitRoot = resolveGitRoot(ctx.cwd);
				state.ecosystems = [];
				if (state.gitRoot && config.conventions.ecosystemDetection) {
					const fs = makeFsAccess(state.gitRoot);
					state.ecosystems = detectEcosystems(fs);
				}
				state.conventionsBlock = computeConventionsBlock(config.conventions, state.ecosystems);

				if (ctx.hasUI) {
					ctx.ui.notify("coding-conventions config reloaded", "info");
					showStatus(state, ctx);
				}
				return;
			}

			if (normalized === "trailer") {
				if (ctx.hasUI) {
					const trailer = buildTrailer(state.config.attribution, ctx.model?.id);
					ctx.ui.notify(`Trailer: ${trailer || "(disabled)"}`, "info");
				}
				return;
			}

			// Default: show full status
			if (ctx.hasUI) showStatus(state, ctx);
		},
	});
}

function showStatus(state: SessionState, ctx: ExtensionContext) {
	const trailer = buildTrailer(state.config.attribution, ctx.model?.id);

	const lines: string[] = [];
	lines.push(`Enabled: ${state.sessionEnabled ? "yes" : "no (session override)"}`);

	// Attribution
	lines.push("");
	lines.push("--- Attribution ---");
	lines.push(`Active: ${state.config.attribution.enabled ? "yes" : "no"}`);
	lines.push(`Trailer: ${trailer || "(disabled)"}`);
	lines.push(`User-bash: ${state.config.attribution.includeUserBash ? "yes" : "no"}`);
	lines.push(`Model version: ${state.config.attribution.modelVersion}`);

	// Conventions
	lines.push("");
	lines.push("--- Conventions ---");
	lines.push(`Active: ${state.config.conventions.enabled ? "yes" : "no"}`);
	lines.push(`Global base: ${state.config.conventions.global ? "yes" : "no"}`);
	lines.push(`Commit rules: ${state.config.conventions.commitRules ? "yes" : "no"}`);
	lines.push(`Ecosystem detection: ${state.config.conventions.ecosystemDetection ? "yes" : "no"}`);
	lines.push(`Git root: ${state.gitRoot || "(none)"}`);
	if (state.ecosystems.length > 0) {
		lines.push(`Detected ecosystems: ${state.ecosystems.join(", ")}`);
	} else {
		lines.push("Detected ecosystems: (none)");
	}

	// Show number of active convention layers
	const layers = resolveConventionLayers(state.config.conventions, state.ecosystems);
	lines.push(`Active layers: ${layers.map((l) => l.name).join(", ") || "(none)"}`);

	const block = assembleConventionBlock(layers);
	lines.push(`Injected block: ${block.length} chars, ~${Math.ceil(block.length / 4)} tokens`);

	ctx.ui.notify(lines.join("\n"), "info");
}
