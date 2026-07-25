/**
 * Pure utility functions for the coding-conventions extension.
 * Extracted for testability — no side effects, no Pi API imports.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AttributionConfig {
	enabled: boolean;
	agentName: string;
	tools: string[];
	modelVersion: string; // "auto" or explicit version string
	includeUserBash: boolean;
}

export interface ConventionsConfig {
	enabled: boolean;
	global: boolean;
	commitRules: boolean;
	ecosystemDetection: boolean;
	overridesDir: string | null;
}

export interface ExtensionConfig {
	attribution: AttributionConfig;
	conventions: ConventionsConfig;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
	attribution: {
		enabled: true,
		agentName: "pi-coding-agent",
		tools: [],
		modelVersion: "auto",
		includeUserBash: true,
	},
	conventions: {
		enabled: true,
		global: true,
		commitRules: true,
		ecosystemDetection: true,
		overridesDir: null,
	},
};

const VALID_VALUE_RE = /^[A-Za-z0-9 ._:/,-]+$/;

function isValidValue(v: string): boolean {
	return VALID_VALUE_RE.test(v);
}

export function parseConfig(raw: unknown): { config: ExtensionConfig; errors: string[] } {
	const errors: string[] = [];
	const config = structuredClone(DEFAULT_CONFIG);

	if (raw === null || raw === undefined) return { config, errors };
	if (typeof raw !== "object") {
		errors.push("Config must be a JSON object; using defaults.");
		return { config, errors };
	}

	const obj = raw as Record<string, unknown>;

	// Attribution
	if (obj.attribution && typeof obj.attribution === "object") {
		const a = obj.attribution as Record<string, unknown>;
		if (typeof a.enabled === "boolean") config.attribution.enabled = a.enabled;
		if (typeof a.agentName === "string" && isValidValue(a.agentName))
			config.attribution.agentName = a.agentName;
		else if (typeof a.agentName === "string")
			errors.push("attribution.agentName contains invalid characters; using default.");
		if (Array.isArray(a.tools) && a.tools.every((t) => typeof t === "string" && isValidValue(t)))
			config.attribution.tools = a.tools as string[];
		else if (a.tools !== undefined)
			errors.push("attribution.tools must be an array of safe strings; using default.");
		if (typeof a.modelVersion === "string") {
			if (a.modelVersion === "auto") {
				config.attribution.modelVersion = "auto";
			} else if (isValidValue(a.modelVersion)) {
				config.attribution.modelVersion = a.modelVersion;
			} else {
				errors.push("attribution.modelVersion contains invalid characters; using 'auto'.");
				config.attribution.modelVersion = "auto";
			}
		}
		if (typeof a.includeUserBash === "boolean") config.attribution.includeUserBash = a.includeUserBash;
	}

	// Conventions
	if (obj.conventions && typeof obj.conventions === "object") {
		const c = obj.conventions as Record<string, unknown>;
		if (typeof c.enabled === "boolean") config.conventions.enabled = c.enabled;
		if (typeof c.global === "boolean") config.conventions.global = c.global;
		if (typeof c.commitRules === "boolean") config.conventions.commitRules = c.commitRules;
		if (typeof c.ecosystemDetection === "boolean")
			config.conventions.ecosystemDetection = c.ecosystemDetection;
		if (c.overridesDir === null || typeof c.overridesDir === "string")
			config.conventions.overridesDir = c.overridesDir as string | null;
	}

	return { config, errors };
}

// ---------------------------------------------------------------------------
// Trailer building
// ---------------------------------------------------------------------------

/**
 * Build the Assisted-by trailer string per kernel doc format.
 * Example: "Assisted-by: pi-coding-agent:claude-opus-4-5 coccinelle sparse"
 */
/**
 * Resolve the model-version token(s) used in the Assisted-by trailer.
 *
 * - Static `modelVersion`: a single pinned token.
 * - "auto": the real models used during the session (first-seen order). This is
 *   what makes the trailer reflect the actual model(s) routed to, instead of a
 *   virtual router profile id like "balanced". Falls back to the active model id
 *   when no session models have been recorded yet (e.g. before the first model
 *   response).
 */
export function resolveTrailerVersions(
	cfg: AttributionConfig,
	modelId: string | undefined,
	sessionModels?: string[],
): string[] {
	if (cfg.modelVersion !== "auto") return [cfg.modelVersion];
	if (sessionModels && sessionModels.length > 0) return [...sessionModels];
	return [modelId || "unknown"];
}

/**
 * Build one Assisted-by trailer line per model used this session, in Linux-kernel
 * style (one trailer per contributor). Tools are attached to the first line only.
 */
export function buildTrailerLines(
	cfg: AttributionConfig,
	modelId: string | undefined,
	sessionModels?: string[],
): string[] {
	if (!cfg.enabled) return [];
	const versions = resolveTrailerVersions(cfg, modelId, sessionModels);
	const toolsPart = cfg.tools.length > 0 ? " " + cfg.tools.join(" ") : "";
	return versions.map((v, i) => {
		const suffix = i === 0 ? toolsPart : "";
		return `Assisted-by: ${cfg.agentName}:${v}${suffix}`;
	});
}

export function buildTrailer(
	cfg: AttributionConfig,
	modelId: string | undefined,
	sessionModels?: string[],
): string {
	return buildTrailerLines(cfg, modelId, sessionModels).join("\n");
}

// ---------------------------------------------------------------------------
// Git-commit detection & rewrite
// ---------------------------------------------------------------------------

export interface CommandRewrite {
	/** Character offset where this command segment starts (after operators) */
	segmentStart: number;
	/** Character offset where this command segment ends */
	segmentEnd: number;
	/** Offset in the original string to insert -c flags (right before 'commit') */
	configInsertPos: number;
	/** Offset to insert --trailer flag (right after 'commit') */
	trailerInsertPos: number;
}

/** Shell operators that split command segments */
const SEGMENT_SPLIT_RE = /(?:&&|\|\||[;|]|\n)/g;

/**
 * Find all git-commit invocations in a shell command string.
 * Skips occurrences inside single/double quotes and skips if the
 * full command already contains "Assisted-by" (idempotent).
 */
export function findGitCommitSegments(command: string): CommandRewrite[] {
	// Idempotency: if the full command already has "Assisted-by", skip entirely
	if (command.includes("Assisted-by")) return [];

	const rewrites: CommandRewrite[] = [];

	// First, find segment boundaries (shell operators outside quotes)
	const segments = splitIntoSegments(command);

	for (const seg of segments) {
		const rw = findGitCommitInSegment(command, seg.start, seg.end);
		if (rw) rewrites.push(rw);
	}

	return rewrites;
}

interface Segment {
	start: number;
	end: number;
}

function splitIntoSegments(command: string): Segment[] {
	const segments: Segment[] = [];
	let segStart = 0;
	let i = 0;

	while (i < command.length) {
		// Skip whitespace at segment start
		while (i < command.length && command[i] === " " && i >= segStart) {
			if (i === segStart) segStart++;
			i++;
		}

		if (i >= command.length) break;

		// Track quote state to avoid splitting inside quotes
		const quote = command[i];
		if (quote === "'") {
			i++;
			while (i < command.length && command[i] !== "'") i++;
			if (i < command.length) i++; // closing quote
			continue;
		}
		if (quote === '"') {
			i++;
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2; // escape sequence
				} else if (command[i] === '"') {
					i++;
					break;
				} else {
					i++;
				}
			}
			continue;
		}

		// Check for shell operators
		if (i + 1 < command.length && command[i] === "&" && command[i + 1] === "&") {
			if (i > segStart) segments.push({ start: segStart, end: i });
			segStart = i + 2;
			i = segStart;
			continue;
		}
		if (i + 1 < command.length && command[i] === "|" && command[i + 1] === "|") {
			if (i > segStart) segments.push({ start: segStart, end: i });
			segStart = i + 2;
			i = segStart;
			continue;
		}
		if (command[i] === ";" || command[i] === "|" || command[i] === "\n") {
			if (i > segStart) segments.push({ start: segStart, end: i });
			segStart = i + 1;
			i = segStart;
			continue;
		}

		i++;
	}

	// Final segment
	if (segStart < command.length) {
		segments.push({ start: segStart, end: command.length });
	}

	return segments;
}

/**
 * Find a single git commit invocation within a known command segment.
 * Returns insertion positions or null if not found.
 */
function findGitCommitInSegment(
	command: string,
	segmentStart: number,
	segmentEnd: number,
): CommandRewrite | null {
	let pos = segmentStart;
	const end = segmentEnd;

	// Skip leading env assignments: VAR=value or VAR="value" or VAR='value'
	while (pos < end) {
		const envEnd = skipEnvAssignment(command, pos, end);
		if (envEnd > pos) {
			pos = envEnd;
			continue;
		}
		break;
	}

	// Optionally skip 'sudo' prefix
	if (pos + 4 <= end && command.slice(pos, pos + 4) === "sudo" &&
		(pos + 4 === end || command[pos + 4] === " " || command[pos + 4] === "\t")) {
		pos = skipWhitespace(command, pos + 4, end);
		// After sudo, there may be more env assignments
		while (pos < end) {
			const envEnd = skipEnvAssignment(command, pos, end);
			if (envEnd > pos) { pos = envEnd; continue; }
			break;
		}
	}

	// Expect 'git' token
	const gitEnd = skipToken(command, pos, end, "git");
	if (gitEnd < 0) return null;
	pos = skipWhitespace(command, gitEnd, end);

	// Consume git global options: -C <path>, -c <k=v>, --git-dir[=<p>], --work-tree[=<p>],
	// --namespace[=<n>], -P, --no-pager, --no-replace-objects, --literal-pathspecs, etc.
	const globalOptsEnd = consumeGitGlobalOptions(command, pos, end);
	pos = skipWhitespace(command, globalOptsEnd, end);

	// Match subcommand 'commit' — word boundary, exclude commit-tree, commit-graph, etc.
	const commitEnd = skipToken(command, pos, end, "commit");
	if (commitEnd < 0) return null;
	// Ensure it's not "commit-" (exclude commit-tree, commit-graph, etc.)
	if (commitEnd < end && command[commitEnd] === "-") return null;

	return {
		segmentStart,
		segmentEnd,
		configInsertPos: pos,  // right before 'commit'
		trailerInsertPos: commitEnd, // right after 'commit'
	};
}

/** Skip whitespace, return new position. */
function skipWhitespace(s: string, pos: number, end: number): number {
	while (pos < end && (s[pos] === " " || s[pos] === "\t")) pos++;
	return pos;
}

/** Skip a literal token with word-boundary check. Returns position after token, or -1. */
function skipToken(s: string, pos: number, end: number, token: string): number {
	const tlen = token.length;
	if (pos + tlen > end) return -1;
	if (s.slice(pos, pos + tlen) !== token) return -1;
	const after = pos + tlen;
	// Word boundary: end of segment or whitespace/hyphen (but hyphen handled by caller for commit)
	if (after < end && s[after] !== " " && s[after] !== "\t") return -1;
	return after;
}

/** Skip a KEY=value (or KEY="val" or KEY='val') env assignment. Returns position after it. */
function skipEnvAssignment(s: string, pos: number, end: number): number {
	const start = pos;
	// KEY: letters, digits, underscore
	while (pos < end && /[A-Za-z0-9_]/.test(s[pos])) pos++;
	if (pos === start) return start; // no key
	if (pos >= end || s[pos] !== "=") return start; // no equals
	pos++; // skip =
	// Value: could be quoted
	if (pos < end && s[pos] === "'") {
		pos++;
		while (pos < end && s[pos] !== "'") pos++;
		if (pos < end) pos++; // closing quote
	} else if (pos < end && s[pos] === '"') {
		pos++;
		while (pos < end) {
			if (s[pos] === "\\") { pos += 2; }
			else if (s[pos] === '"') { pos++; break; }
			else { pos++; }
		}
	} else {
		// Unquoted value — ends at space/tab/shell operator
		while (pos < end && s[pos] !== " " && s[pos] !== "\t" &&
			   s[pos] !== ";" && s[pos] !== "|" && s[pos] !== "&" && s[pos] !== "\n") pos++;
	}
	if (pos < end && (s[pos] === " " || s[pos] === "\t")) pos++;
	return pos;
}

/**
 * Consume git global options (flags that can appear before the subcommand).
 * These are safe to consume: -C, -c, --git-dir, --work-tree, --namespace,
 * -P, --no-pager, --no-replace-objects, --literal-pathspecs, --glob-pathspecs,
 * --noglob-pathspecs, --icase-pathspecs, -p, --paginate, etc.
 * For simplicity, eat any short flags that don't take args and well-known long opts.
 */
function consumeGitGlobalOptions(s: string, pos: number, end: number): number {
	while (pos < end) {
		const ch = s[pos];
		if (ch !== "-") break;

		// Long options
		if (pos + 1 < end && s[pos + 1] === "-") {
			const optStart = pos;
			pos += 2;
			while (pos < end && /[A-Za-z0-9-]/.test(s[pos])) pos++;
			const opt = s.slice(optStart, pos);

			// Options that take a value (=value or next arg)
			const takesValue = ["--git-dir", "--work-tree", "--namespace"];
			if (takesValue.includes(opt)) {
				pos = skipWhitespace(s, pos, end);
				if (pos < end && s[pos] === "=") {
					pos++;
					// skip value
					while (pos < end && s[pos] !== " " && s[pos] !== "\t") pos++;
				} else {
					// skip next token as value
					while (pos < end && s[pos] !== " " && s[pos] !== "\t") pos++;
				}
				pos = skipWhitespace(s, pos, end);
				continue;
			}

			// Options without value — just skip
			pos = skipWhitespace(s, pos, end);
			continue;
		}

		// Short options
		pos++; // skip '-'
		while (pos < end && /[A-Za-z]/.test(s[pos])) {
			const shortOpt = s[pos];
			pos++;
			// Options that take an argument
			if (shortOpt === "C" || shortOpt === "c") {
				pos = skipWhitespace(s, pos, end);
				// Value could be key=value for -c, or path for -C
				while (pos < end && s[pos] !== " " && s[pos] !== "\t") pos++;
				break; // stop parsing short flags after one that takes arg
			}
			// Single flags without args (e.g., -P): continue loop
		}
		pos = skipWhitespace(s, pos, end);
	}

	return pos;
}

/**
 * Apply rewrite positions to a command string, inserting -c trailer.ifExists=addIfDifferent
 * and one --trailer flag per model line. Trailer values are single-quoted, with any
 * internal single quotes escaped.
 *
 * `addIfDifferent` (rather than `doNothing`) keeps the trailer idempotent across
 * --amend while still allowing several distinct Assisted-by lines (one per model
 * used this session) to be added to a single commit.
 */
export function applyRewrites(
	command: string,
	segments: CommandRewrite[],
	trailer: string | string[],
): string {
	if (segments.length === 0) return command;

	// Normalize to an array of trailer lines.
	const lines = Array.isArray(trailer) ? trailer : [trailer];

	// Build the combined --trailer insertion (one flag per line, in order).
	const insert = lines
		.map((line) => {
			// Escape single quotes in trailer value: replace ' with '\'' (close quote, escaped quote, reopen)
			const escaped = line.replace(/'/g, "'\\''");
			return ` --trailer '${escaped}'`;
		})
		.join("");

	// Sort segments by insertion positions descending so earlier insertions don't shift later ones
	const sorted = [...segments].sort((a, b) => b.configInsertPos - a.configInsertPos);

	let result = command;
	for (const seg of sorted) {
		// Insert --trailer after 'commit' (note: trailerInsertPos is later in the string,
		// so we process it before the config insert to keep offsets stable)
		result = result.slice(0, seg.trailerInsertPos) + insert + result.slice(seg.trailerInsertPos);

		// Insert -c flag right before 'commit'
		result = result.slice(0, seg.configInsertPos) + "-c trailer.ifExists=addIfDifferent " + result.slice(seg.configInsertPos);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Ecosystem detection
// ---------------------------------------------------------------------------

export type Ecosystem = "kernel" | "c" | "rust" | "go" | "python" | "typescript";

export interface FsAccess {
	/** Check if a path (relative to git root) exists. */
	exists(relPath: string): boolean;
	/** Read file contents, or null if unreadable. */
	readFile(relPath: string): string | null;
	/** List file/dir names in a directory at git root. Empty array if not a dir. */
	listDir(relPath: string): string[];
}

/**
 * Detect which ecosystems are present at the git repo root.
 * All matching ecosystems are returned. Kernel detection suppresses generic C.
 */
export function detectEcosystems(fs: FsAccess): Ecosystem[] {
	const results: Ecosystem[] = [];

	const isKernel = fs.exists("MAINTAINERS") && fs.exists("scripts/checkpatch.pl");

	if (isKernel) {
		results.push("kernel");
	} else {
		// Detect generic C: *.c or *.h files at root, or CMakeLists.txt, or Makefile
		const rootFiles = fs.listDir(".");
		const hasCFile = rootFiles.some((f) => f.endsWith(".c") || f.endsWith(".h"));
		if (hasCFile || fs.exists("CMakeLists.txt") || fs.exists("Makefile")) {
			results.push("c");
		}
	}

	if (fs.exists("Cargo.toml")) results.push("rust");
	if (fs.exists("go.mod")) results.push("go");
	if (fs.exists("pyproject.toml") || fs.exists("setup.py") || fs.exists("setup.cfg"))
		results.push("python");

	// TypeScript: tsconfig.json OR package.json with devDependencies.typescript
	if (fs.exists("tsconfig.json")) {
		results.push("typescript");
	} else if (fs.exists("package.json")) {
		const pkgRaw = fs.readFile("package.json");
		if (pkgRaw) {
			try {
				const pkg = JSON.parse(pkgRaw);
				if (pkg?.devDependencies?.typescript) {
					results.push("typescript");
				}
			} catch {
				// invalid JSON — not TypeScript
			}
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Convention-layer resolution
// ---------------------------------------------------------------------------

export interface ConventionLayer {
	name: string;
	content: string;
}

/**
 * Resolve a single convention layer.
 * - If overridePath is provided and the file exists and is non-empty → use override.
 * - If overridePath is provided and the file is empty → return null (layer disabled).
 * - If overridePath is provided but file doesn't exist → fall back to builtinPath.
 * - If builtinPath doesn't exist either → return null.
 */
export function resolveConventionLayer(
	builtinPath: string,
	overridePath: string | null,
	readFileFn: (path: string) => string | null,
): ConventionLayer | null {
	// Try override first
	if (overridePath !== null) {
		const overrideContent = readFileFn(overridePath);
		if (overrideContent !== null) {
			const trimmed = overrideContent.trim();
			if (trimmed.length === 0) return null; // empty → disabled
			return { name: layerNameFromPath(overridePath), content: trimmed };
		}
		// Override file doesn't exist → fall through to builtin
	}

	// Fall back to built-in
	const builtinContent = readFileFn(builtinPath);
	if (builtinContent === null) return null;
	const trimmed = builtinContent.trim();
	if (trimmed.length === 0) return null;
	return { name: layerNameFromPath(builtinPath), content: trimmed };
}

function layerNameFromPath(path: string): string {
	// Extract the basename without extension
	const parts = path.split("/");
	const filename = parts[parts.length - 1];
	const dotIdx = filename.lastIndexOf(".");
	return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

/**
 * Assemble all active convention layers into a single block for injection
 * into the system prompt.
 */
export function assembleConventionBlock(layers: ConventionLayer[]): string {
	if (layers.length === 0) return "";
	return layers.map((l) => `## ${l.name} Conventions\n${l.content}`).join("\n\n");
}
