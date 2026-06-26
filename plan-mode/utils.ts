/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bruff\b[^\n;|&]*\s--(?:fix|fix-only|unsafe-fixes)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|am|apply|bisect|checkout|cherry-pick|clean|clone|commit|fetch|gc|init|merge|mv|notes|pull|push|rebase|reset|restore|revert|rm|stash|switch)/i,
	/\bgit\s+branch\s+(?!(?:-[^-\s]*[alrvv]|--all|--remotes|--verbose|--list|--show-current|--contains|--merged|--no-merged)(?:\s|$))\S/i,
	/\bgit\s+config\s+(?!--(?:get|get-all|list|name-only)\b)/i,
	/\bgit\s+diff\b[^\n;|&]*\s--output(?:=|\s+)/i,
	/\bgit\s+reflog\s+(delete|expire)/i,
	/\bgit\s+remote\s+(add|remove|rename|set-|prune\b(?!\s+--dry-run))/i,
	/\bgit\s+submodule\s+(add|update|init|deinit|sync)/i,
	/\bgit\s+tag\s+(?!(?:-[ln]|--list|--contains|--points-at)(?:\s|$))\S/i,
	/\bgit\s+worktree\s+(add|move|remove|prune|repair)/i,
	/\bgh\s+(pr\s+(create|checkout|close|comment|edit|lock|merge|ready|reopen|review|update-branch)|issue\s+(create|close|comment|delete|develop|edit|lock|reopen|transfer)|repo\s+(archive|clone|create|delete|edit|fork|rename|sync)|release\s+(create|delete|delete-asset|edit|upload)|run\s+(cancel|delete|rerun)|workflow\s+(disable|enable|run)|secret\s+(set|delete)|variable\s+(set|delete)|label\s+(create|delete|edit)|milestone\s+(create|close|delete|edit)|gist\s+(clone|create|delete|edit)|auth\s+(login|logout|refresh|setup-git))/i,
	/\bgh\s+api\b.*(?:^|\s)(?:-X|--method)(?:=|\s+)(?!GET(?:\s|$))\S+/i,
	/\bgh\s+api\b.*(?:^|\s)(?:-F|--field|-f|--raw-field|--input)(?:=|\s+)\S+/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*(?:(?:timeout\s+(?:--preserve-status\s+)?(?:-k\s+\S+\s+)?\S+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:[~./\w-]+\/)*pytest(?:\s|$)/i,
	/^\s*(?:(?:timeout\s+(?:--preserve-status\s+)?(?:-k\s+\S+\s+)?\S+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:[~./\w-]+\/)*python(?:3(?:\.\d+)?)?\s+-m\s+pytest(?:\s|$)/i,
	/^\s*(?:(?:timeout\s+(?:--preserve-status\s+)?(?:-k\s+\S+\s+)?\S+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:[~./\w-]+\/)*ruff\s+check(?:\s|$)/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
	/^\s*dig\b/,
	/^\s*host\b/,
	/^\s*nslookup\b/,
];

function stripKnownGlobalOptions(rest: string, flagPatterns: RegExp[]): string {
	let remaining = rest.trim();
	let changed = true;
	while (changed) {
		changed = false;
		for (const pattern of flagPatterns) {
			const match = remaining.match(pattern);
			if (match) {
				remaining = remaining.slice(match[0].length).trimStart();
				changed = true;
				break;
			}
		}
	}
	return remaining;
}

const GIT_GLOBAL_FLAG_PATTERNS = [
	/^(?:--no-pager|--paginate|--no-optional-locks|--literal-pathspecs)\s+/i,
	/^(?:-C|-c|--git-dir|--work-tree|--namespace)(?:=\S+|\s+\S+)\s*/i,
];

const READ_ONLY_GIT_PATTERNS = [
	/^(?:status|log|diff|show|shortlog|whatchanged|blame|grep|describe|rev-parse|rev-list|merge-base|cat-file|ls-files|ls-tree|ls-remote|for-each-ref)(?:\s|$)/i,
	/^branch(?:\s*$|\s+(?:-[^-\s]*[alrvv]|--all|--remotes|--verbose|--list|--show-current|--contains|--merged|--no-merged)(?:\s|$))/i,
	/^config\s+(?:--get|--get-all|--list|--name-only)(?:\s|$)/i,
	/^remote(?:\s*$|\s+-v(?:\s|$)|\s+(?:show|get-url)(?:\s|$)|\s+prune\s+--dry-run(?:\s|$))/i,
	/^reflog(?:\s*$|\s+show(?:\s|$))/i,
	/^submodule\s+status(?:\s|$)/i,
	/^tag(?:\s*$|\s+(?:-[ln]|--list|--contains|--points-at)(?:\s|$))/i,
	/^worktree\s+list(?:\s|$)/i,
];

function isReadOnlyGitCommand(command: string): boolean {
	const match = command.trimStart().match(/^git(?:\s+|$)(.*)$/i);
	if (!match) return false;
	const rest = stripKnownGlobalOptions(match[1] ?? "", GIT_GLOBAL_FLAG_PATTERNS);
	return READ_ONLY_GIT_PATTERNS.some((pattern) => pattern.test(rest));
}

const GH_GLOBAL_FLAG_PATTERNS = [
	/^(?:--repo|--hostname|-R)(?:=\S+|\s+\S+)\s*/i,
	/^(?:--help|--version)\s*/i,
];

const READ_ONLY_GH_PATTERNS = [
	/^pr\s+(?:list|view|diff|status|checks)(?:\s|$)/i,
	/^issue\s+(?:list|view|status)(?:\s|$)/i,
	/^repo\s+(?:list|view)(?:\s|$)/i,
	/^release\s+(?:list|view)(?:\s|$)/i,
	/^run\s+(?:list|view|watch)(?:\s|$)/i,
	/^workflow\s+(?:list|view)(?:\s|$)/i,
	/^label\s+list(?:\s|$)/i,
	/^milestone\s+list(?:\s|$)/i,
	/^search\s+(?:repos|issues|prs|commits|code)(?:\s|$)/i,
	/^gist\s+(?:list|view)(?:\s|$)/i,
	/^auth\s+status(?:\s|$)/i,
	/^status(?:\s|$)/i,
];

function isReadOnlyGhApiCommand(rest: string): boolean {
	if (!/^api(?:\s|$)/i.test(rest)) return false;
	if (/(?:^|\s)(?:-X|--method)(?:=|\s+)(?!GET(?:\s|$))\S+/i.test(rest)) return false;
	if (/(?:^|\s)(?:-F|--field|-f|--raw-field|--input)(?:=|\s+)\S+/i.test(rest)) return false;
	return true;
}

function isReadOnlyGhCommand(command: string): boolean {
	const match = command.trimStart().match(/^gh(?:\s+|$)(.*)$/i);
	if (!match) return false;
	const rest = stripKnownGlobalOptions(match[1] ?? "", GH_GLOBAL_FLAG_PATTERNS);
	return READ_ONLY_GH_PATTERNS.some((pattern) => pattern.test(rest)) || isReadOnlyGhApiCommand(rest);
}

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command)) || isReadOnlyGitCommand(command) || isReadOnlyGhCommand(command);
	return !isDestructive && isSafe;
}

export type TodoStatus = "pending" | "done" | "skipped" | "deferred" | "blocked";

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
	status?: TodoStatus;
}

export function getTodoStatus(item: TodoItem): TodoStatus {
	if (item.status) return item.status;
	return item.completed ? "done" : "pending";
}

export function setTodoStatus(item: TodoItem, status: TodoStatus): void {
	item.status = status;
	item.completed = status === "done";
}

export function isTodoDone(item: TodoItem): boolean {
	return getTodoStatus(item) === "done";
}

export function isTodoClosed(item: TodoItem): boolean {
	const status = getTodoStatus(item);
	return status === "done" || status === "skipped" || status === "deferred";
}

export function isTodoOpen(item: TodoItem): boolean {
	return !isTodoClosed(item);
}

function statusLabel(status: TodoStatus): string {
	switch (status) {
		case "done":
			return "done";
		case "skipped":
			return "skipped";
		case "deferred":
			return "deferred";
		case "blocked":
			return "blocked";
		default:
			return "pending";
	}
}

function statusCheckbox(status: TodoStatus): string {
	switch (status) {
		case "done":
			return "[x]";
		case "skipped":
			return "[-]";
		case "deferred":
			return "[>]";
		case "blocked":
			return "[!]";
		default:
			return "[ ]";
	}
}

export function renderPlanProgressMarkdown(items: TodoItem[]): string {
	const lines = [
		"<!-- pi-plan-progress:start -->",
		"## Progress",
		"",
		"Status legend: `[x]` done, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.",
		"",
	];
	for (const item of items) {
		const status = getTodoStatus(item);
		lines.push(`- ${statusCheckbox(status)} ${item.step}. ${item.text} _(${statusLabel(status)})_`);
	}
	lines.push("", "<!-- pi-plan-progress:end -->", "");
	return lines.join("\n");
}

export function upsertPlanProgressSection(planMarkdown: string, items: TodoItem[]): string {
	const section = renderPlanProgressMarkdown(items).trimEnd();
	const pattern = /\n?<!-- pi-plan-progress:start -->[\s\S]*?<!-- pi-plan-progress:end -->\n?/;
	if (pattern.test(planMarkdown)) {
		return `${planMarkdown.replace(pattern, `\n\n${section}\n`)}`;
	}
	return `${planMarkdown.trimEnd()}\n\n${section}\n`;
}

export function hasHandoffClaim(text: string): boolean {
	const normalized = stripMarkdownInline(text).replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	return /\b(?:ready\s+for\s+(?:human\s+)?review|ready\s+to\s+(?:merge|review)|handoff|hand\s+off|leav(?:e|ing)\s+(?:it\s+)?for\s+(?:human\s+)?review|ci\s+(?:is\s+)?clean|checks?\s+(?:are\s+)?green|pr\s+(?:is\s+)?clean)\b/i.test(normalized);
}

export function promptContainsProposedPlan(text: string): boolean {
	return /<proposed_plan\b/i.test(text);
}

export function shouldUsePlanRefinementContext(prompt: string, hasExistingPlan: boolean): boolean {
	if (!hasExistingPlan) return false;
	const normalized = stripMarkdownInline(prompt).replace(/\s+/g, " ").trim();
	if (!promptContainsProposedPlan(prompt)) return true;

	// A pasted complete <proposed_plan> is often a fresh plan/evaluation prompt, not
	// feedback on the previous stored plan. Only enter refinement mode when the user
	// explicitly asks to revise/refine, and let implementation/evaluation requests win.
	const asksForEvaluation = /\b(?:check|inspect|evaluate|compare|audit|status|implemented|implementation\s+status|complete|completion|done|remaining|what\s+is\s+left|how\s+much\s+is\s+left|is\s+this\s+(?:done|implemented|complete))\b/i.test(
		normalized,
	);
	if (asksForEvaluation) return false;

	return /\b(?:refine|revise|update|modify|edit|tighten|incorporate|feedback|replacement\s+plan|complete\s+replacement\s+plan|return\s+(?:a\s+)?revised\s+plan)\b/i.test(
		normalized,
	);
}

interface MarkdownHeader {
	index: number;
	level: number;
	title: string;
	score: number;
}

interface ListCandidate {
	indent: number;
	ordered: boolean;
	text: string;
}

const ACTION_SECTION_EXCLUDES = [
	/\b(test|testing|tests)\b/i,
	/\bacceptance\b/i,
	/\bcriteria\b/i,
	/\bsummary\b/i,
	/\b(current\s+)?(repo\s+)?facts?\b/i,
	/\bdecisions?\b/i,
	/\bassumptions?\b/i,
	/\brequirements?\b/i,
	/\bquestions?\b/i,
	/\bcontext\b/i,
	/\bbackground\b/i,
	/\bconstraints?\b/i,
	/\bscope\b/i,
	/\bgoals?\b/i,
	/\btarget\s+config\b/i,
	/\bsecret\s+handling\b/i,
];

function stripMarkdownInline(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
		.replace(/<[^>]+>/g, "");
}

export function cleanStepText(text: string): string {
	const cleaned = stripMarkdownInline(text)
		.replace(/^\s*\[[ xX]\]\s+/, "")
		.replace(/^\s*(?:step\s*)?\d+\s*[:.)-]\s*/i, "")
		.replace(/^\s*[-*+]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length === 0) return cleaned;
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function dedentMarkdown(content: string): string {
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	let inFence = false;
	let minIndent = Number.POSITIVE_INFINITY;

	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || line.trim() === "") continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		minIndent = Math.min(minIndent, indent);
	}

	if (!Number.isFinite(minIndent) || minIndent <= 0) return lines.join("\n");
	return lines.map((line) => (line.trim() === "" ? line : line.slice(Math.min(minIndent, line.length)))).join("\n");
}

function headingForLine(line: string): { level: number; title: string } | null {
	const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
	if (!match) return null;
	return { level: match[1].length, title: stripMarkdownInline(match[2]).trim() };
}

function normalizeHeading(title: string): string {
	return stripMarkdownInline(title)
		.replace(/^\s*(?:step\s*)?\d+\s*[:.)-]\s*/i, "")
		.replace(/[^a-z0-9]+/gi, " ")
		.toLowerCase()
		.trim();
}

function scoreActionSection(title: string): number {
	const normalized = normalizeHeading(title);
	if (!normalized) return 0;
	if (ACTION_SECTION_EXCLUDES.some((pattern) => pattern.test(normalized))) return 0;

	const hasImplementation = /\bimplementation\b|\bimplement\b/.test(normalized);
	const hasExecution = /\bexecution\b|\bexecute\b/.test(normalized);
	const hasAction = /\baction\b/.test(normalized);
	const hasStepWord = /\bsteps?\b|\btasks?\b|\btodos?\b|\btodo\b|\bchecklists?\b|\bmilestones?\b|\bplan\b|\broadmap\b/.test(normalized);

	// Sections like "Execution Prompt" describe role behavior. They are not
	// tracker-level execution steps and frequently contain checklist bullets.
	if (/\bprompts?\b/.test(normalized) && !/\bsteps?\b|\btasks?\b|\btodos?\b|\btodo\b|\bplan\b/.test(normalized)) {
		return 0;
	}

	if (/^(?:final\s+)?(?:implementation|execution|action)\s+(?:steps?|tasks?|todos?|todo|plan|checklists?|milestones?)$/.test(normalized)) return 125;
	if (/^work\s+plan$/.test(normalized)) return 120;
	if ((hasImplementation || hasExecution || hasAction) && hasStepWord) return 115;
	if (/^(?:implementation|execution|action)$/.test(normalized)) return 105;
	if (/\bsteps?\b|\btasks?\b|\btodos?\b|\btodo\b/.test(normalized)) return 90;
	if (/^(proposed\s+)?plan$/.test(normalized)) return 80;
	if (hasImplementation) return 70;
	if (/\bkey\s+changes\b|\bchanges\b|\bapproach\b|\broadmap\b/.test(normalized)) return 50;
	return 0;
}

function findMarkdownHeaders(lines: string[]): MarkdownHeader[] {
	const headers: MarkdownHeader[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const header = headingForLine(line);
		if (header) {
			// The document H1 is usually a title (for example "Foo Implementation Plan"),
			// not the tracker section. Require actionable subsections for todo extraction.
			const score = header.level === 1 ? 0 : scoreActionSection(header.title);
			headers.push({ index: i, level: header.level, title: header.title, score });
		}
	}
	return headers;
}

function sectionEnd(headers: MarkdownHeader[], headerIndex: number, lineCount: number): number {
	const header = headers[headerIndex];
	for (let i = headerIndex + 1; i < headers.length; i++) {
		if (headers[i].level <= header.level) return headers[i].index;
	}
	return lineCount;
}

function parseNumberedHeading(title: string): string | null {
	const stripped = stripMarkdownInline(title).trim();
	if (/^\s*(?:step\s*)?\d+\s*[:.)-]\s+/i.test(stripped)) {
		return cleanStepText(stripped);
	}
	return null;
}

function shouldSkipStepText(text: string): boolean {
	const normalized = text.trim();
	if (normalized.length < 4) return true;
	if (/^[A-Z0-9_./:-]+$/.test(normalized) && !/\s/.test(normalized)) return true;
	if (/^(old|new|primary|fallback|optional|required):?$/i.test(normalized)) return true;
	if (/^[A-Z0-9_]+(?:\s+or\s+[A-Z0-9_]+)*$/.test(normalized)) return true;
	return false;
}

function pushUniqueStep(items: string[], rawText: string): void {
	const cleaned = cleanStepText(rawText);
	if (shouldSkipStepText(cleaned)) return;
	const key = cleaned.toLowerCase();
	if (!items.some((item) => item.toLowerCase() === key)) items.push(cleaned);
}

function extractTopLevelListItems(lines: string[], start: number, end: number): string[] {
	const candidates: ListCandidate[] = [];
	let inFence = false;

	for (let i = start; i < end; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (headingForLine(line)) continue;

		const match = line.match(/^(\s*)(?:(\d+)[.)]|[-*+])\s+(.+)$/);
		if (!match) continue;
		const text = match[3].trim();
		if (!text || /^\[[ xX]\]\s*$/.test(text)) continue;
		candidates.push({ indent: match[1].length, ordered: Boolean(match[2]), text });
	}

	if (candidates.length === 0) return [];
	const minIndent = Math.min(...candidates.map((candidate) => candidate.indent));
	const topLevel = candidates.filter((candidate) => candidate.indent <= minIndent + 1);
	const orderedTopLevel = topLevel.filter((candidate) => candidate.ordered);
	const source = orderedTopLevel.length >= 2 ? orderedTopLevel : topLevel;

	const items: string[] = [];
	for (const candidate of source) {
		pushUniqueStep(items, candidate.text);
	}
	return items;
}

function extractStepsFromSection(lines: string[], start: number, end: number, parentLevel: number): string[] {
	const numberedHeadingSteps: string[] = [];
	const directChildHeadingSteps: string[] = [];
	let inFence = false;

	for (let i = start + 1; i < end; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const header = headingForLine(line);
		if (!header || header.level <= parentLevel) continue;
		const numberedStep = parseNumberedHeading(header.title);
		if (numberedStep) pushUniqueStep(numberedHeadingSteps, numberedStep);
		if (header.level === parentLevel + 1) pushUniqueStep(directChildHeadingSteps, header.title);
	}

	// Numbered subheadings are the clearest signal for implementation steps.
	if (numberedHeadingSteps.length > 0) return numberedHeadingSteps;

	const listItems = extractTopLevelListItems(lines, start + 1, end);

	// If an implementation section is organized by unnumbered child headings with many
	// detail bullets under each, prefer the child headings as tracker-level steps.
	if (
		directChildHeadingSteps.length >= 2 &&
		directChildHeadingSteps.length <= 30 &&
		(listItems.length === 0 || listItems.length >= directChildHeadingSteps.length * 2)
	) {
		return directChildHeadingSteps;
	}

	return listItems;
}

function extractFromPreferredMarkdownSections(lines: string[]): string[] {
	const headers = findMarkdownHeaders(lines);
	const actionable = headers.filter((header) => header.score > 0);
	if (actionable.length === 0) return [];

	const maxScore = Math.max(...actionable.map((header) => header.score));
	const selected = actionable.filter((header) => {
		// If there is a strong explicit implementation/execution/action-plan section,
		// use only equally strong sections. This prevents lower-confidence sections
		// such as role "Execution Prompt" or generic "Tasks" from being merged into
		// the tracker when a dedicated implementation section already exists.
		if (maxScore >= 100) return header.score === maxScore;
		if (maxScore >= 90) return header.score >= 90;
		return header.score === maxScore;
	});

	const items: string[] = [];
	for (const header of selected) {
		const headerIndex = headers.findIndex((candidate) => candidate.index === header.index);
		const end = sectionEnd(headers, headerIndex, lines.length);
		for (const item of extractStepsFromSection(lines, header.index, end, header.level)) {
			pushUniqueStep(items, item);
		}
	}
	return items;
}

function extractFromPlainPlanBlock(lines: string[]): string[] {
	const planHeaderIndex = lines.findIndex((line) => /^\s*(?:implementation\s+steps?|execution\s+steps?|action\s+plan|plan)\s*:\s*$/i.test(line));
	if (planHeaderIndex === -1) return [];

	let end = lines.length;
	for (let i = planHeaderIndex + 1; i < lines.length; i++) {
		if (/^\s*(?:test\s+plan|acceptance\s+criteria|assumptions?|summary)\s*:\s*$/i.test(lines[i])) {
			end = i;
			break;
		}
	}
	return extractTopLevelListItems(lines, planHeaderIndex + 1, end);
}

function extractFallbackTopLevelItems(lines: string[]): string[] {
	const ordered = extractTopLevelListItems(lines, 0, lines.length).filter(Boolean);
	if (ordered.length > 0) return ordered;
	return [];
}

function extractNumberedHeadingsAnywhere(lines: string[]): string[] {
	const items: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const header = headingForLine(line);
		if (!header) continue;
		const step = parseNumberedHeading(header.title);
		if (step) pushUniqueStep(items, step);
	}
	return items;
}

/**
 * Extracts proposed plan content wrapped in <proposed_plan>...</proposed_plan>
 */
export function extractProposedPlan(message: string): string | null {
	const startTag = "<proposed_plan>";
	const endTag = "</proposed_plan>";
	const startIndex = message.indexOf(startTag);
	if (startIndex === -1) return null;

	const endIndex = message.indexOf(endTag, startIndex + startTag.length);
	if (endIndex === -1) {
		// If it's streaming or not completely closed, extract everything after the opening tag
		return message.slice(startIndex + startTag.length).trim();
	}

	return message.slice(startIndex + startTag.length, endIndex).trim();
}

/**
 * Extracts actionable todo items from a proposed plan markdown content.
 *
 * Important: this intentionally prefers Implementation/Execution/Steps sections and extracts
 * only numbered subheadings or top-level list entries from those sections. It avoids turning
 * facts, config examples, test matrices, env var lists, and acceptance criteria into hundreds
 * of fake todos.
 */
export function extractTodoItemsFromProposedPlan(planContent: string): TodoItem[] {
	const normalized = dedentMarkdown(planContent);
	const lines = normalized.split("\n");

	const preferred = extractFromPreferredMarkdownSections(lines);
	const plainPlan = preferred.length > 0 ? [] : extractFromPlainPlanBlock(lines);
	let extracted = preferred.length > 0 ? preferred : plainPlan.length > 0 ? plainPlan : [];

	// Do not fall back to harvesting every top-level list item from a structured
	// markdown document. If the model omitted an actionable Implementation/Execution/
	// Action Plan section, broad fallback turns requirements, tests, evidence checks,
	// and rollout notes into bogus todos. Only use whole-message fallback for simple
	// unheaded list responses.
	if (extracted.length === 0 && findMarkdownHeaders(lines).length === 0) {
		extracted = extractFallbackTopLevelItems(lines);
	}

	// Last-resort safety valve: if a model emits a verbose plan shape we did not
	// anticipate and the list explodes, prefer numbered markdown headings over
	// hundreds of nested detail bullets.
	if (extracted.length > 40) {
		const numberedHeadings = extractNumberedHeadingsAnywhere(lines);
		if (numberedHeadings.length >= 2 && numberedHeadings.length < extracted.length) extracted = numberedHeadings;
	}

	return extracted.map((text, index) => ({
		step: index + 1,
		text,
		completed: false,
		status: "pending" as const,
	}));
}

function addStepRange(steps: Set<number>, start: number, end: number): void {
	const lo = Math.min(start, end);
	const hi = Math.max(start, end);
	for (let i = lo; i <= hi; i++) steps.add(i);
}

function addNumberList(steps: Set<number>, raw: string): void {
	for (const part of raw.split(/\s*(?:,|and|&)\s*/i)) {
		if (!part.trim()) continue;
		const range = part.match(/^(\d+)\s*(?:-|–|—|\.\.)\s*(\d+)$/);
		if (range) {
			addStepRange(steps, Number(range[1]), Number(range[2]));
			continue;
		}
		const value = Number(part.trim());
		if (Number.isFinite(value)) steps.add(value);
	}
}

export function extractDoneSteps(message: string): number[] {
	const steps = new Set<number>();

	// Explicit tags: [DONE:1], [DONE:1,2], [DONE:1-3]
	for (const match of message.matchAll(/\[DONE:([\d\s,;&and\-–—.]+)\]/gi)) {
		addNumberList(steps, match[1]);
	}

	// Natural language summaries: "completed steps 1-3", "phases 2 and 4 done".
	const unit = "(?:steps?|phases?|tasks?|items?)";
	const status = "(?:complete|completed|finished|done|implemented|resolved|verified)";
	for (const match of message.matchAll(new RegExp(`${status}\\s+${unit}\\s*:?\\s+([\\d\\s,;&and\\-–—.]+)`, "gi"))) {
		addNumberList(steps, match[1]);
	}
	for (const match of message.matchAll(new RegExp(`${unit}\\s*:?\\s+([\\d\\s,;&and\\-–—.]+)\\s+${status}`, "gi"))) {
		addNumberList(steps, match[1]);
	}

	return [...steps].filter((step) => Number.isFinite(step));
}

function explicitDoneStatus(rest: string): boolean {
	return /(?:✅|✓|✔|☑|\[x\]|\[DONE\]|\b(?:complete|completed|done|finished|resolved|implemented|verified)\b)/i.test(rest);
}

function explicitNonDoneStatus(rest: string): TodoStatus | undefined {
	if (/\bskipped\b|\[-\]/i.test(rest)) return "skipped";
	if (/\bdeferred\b|\[>\]/i.test(rest)) return "deferred";
	if (/\bblocked\b|\[!\]/i.test(rest)) return "blocked";
	const nonDoneWords = /\b(?:pending|partial|partially|in[ -]?progress|remaining|todo|to do|not done|not complete|incomplete|still pending|still required|still requires)\b/i;
	const nonDoneMarkers = /(?:🟨|🟧|⚠️?|⏳|⌛|☐|□|⬜|\[ \])/i;
	if (nonDoneMarkers.test(rest) || nonDoneWords.test(rest)) return "pending";
	return undefined;
}

function extractExplicitNonDoneStepStatuses(message: string): Map<number, TodoStatus> {
	const steps = new Map<number, TodoStatus>();
	for (const rawLine of message.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		for (const doneStep of extractDoneSteps(line)) steps.delete(doneStep);

		const numbered = line.match(/^(?:[-*+]\s*)?(\d+)\s*[.)|-]?\s*(.*)$/);
		if (numbered) {
			const step = Number(numbered[1]);
			const rest = numbered[2] ?? "";
			const status = explicitNonDoneStatus(rest);
			if (Number.isFinite(step) && status) {
				steps.set(step, status);
				continue;
			}
			if (Number.isFinite(step) && explicitDoneStatus(rest)) steps.delete(step);
			continue;
		}

		const named = line.match(/(?:step|phase|task|item)\s*(\d+)\b(.*)$/i);
		if (named) {
			const step = Number(named[1]);
			const rest = named[2] ?? "";
			const status = explicitNonDoneStatus(rest);
			if (Number.isFinite(step) && status) {
				steps.set(step, status);
				continue;
			}
			if (Number.isFinite(step) && explicitDoneStatus(rest)) steps.delete(step);
		}
	}
	return steps;
}

function extractExplicitNonDoneSteps(message: string): Set<number> {
	return new Set(extractExplicitNonDoneStepStatuses(message).keys());
}

export function markExplicitNonDoneSteps(text: string, items: TodoItem[]): number {
	let marked = 0;
	const statuses = extractExplicitNonDoneStepStatuses(text);
	for (const [step, status] of statuses) {
		const item = items.find((t) => t.step === step);
		if (item && getTodoStatus(item) !== status) {
			setTodoStatus(item, status);
			marked++;
		}
	}
	return marked;
}

/**
 * Heuristic completion detection: looks for step numbers or step text
 * near completion markers (✅, ✓, ✔, ☑, [x], "completed", "done").
 * Returns indices of items that appear completed.
 */
function normalizeForProgressMatch(text: string): string {
	return stripMarkdownInline(text)
		.toLowerCase()
		.replace(/\.\.\./g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const PROGRESS_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"into",
	"only",
	"then",
	"that",
	"this",
	"must",
	"will",
	"repo",
	"repos",
	"step",
	"steps",
	"phase",
	"phases",
	"implementation",
	"execution",
	"implement",
	"implemented",
	"create",
	"created",
	"add",
	"added",
	"update",
	"updated",
]);

function progressKeywords(text: string): string[] {
	const normalized = normalizeForProgressMatch(text);
	const words = normalized.split(" ").filter((word) => word.length >= 4 && !PROGRESS_STOPWORDS.has(word));
	const stems = words.map((word) => word.replace(/(?:ing|ed|es|s)$/i, "")).filter((word) => word.length >= 4);
	return [...new Set([...words, ...stems])];
}

const PRIMARY_ACTION_WORDS = new Set([
	"add",
	"apply",
	"build",
	"commit",
	"create",
	"deploy",
	"enable",
	"fix",
	"harden",
	"implement",
	"open",
	"push",
	"refactor",
	"release",
	"roll",
	"run",
	"ship",
	"test",
	"update",
	"validate",
]);

function primaryActionKeyword(text: string): string | undefined {
	for (const word of normalizeForProgressMatch(text).split(" ")) {
		if (PRIMARY_ACTION_WORDS.has(word)) return word;
	}
	return undefined;
}

function completedPortion(text: string): string {
	const split = text.split(/\n\s*#{1,6}\s+(?:current\s+status|status|still\s+requires|remaining|not\s+executed|to\s+do|todo|next\s+steps?|follow-?ups?)\b/i);
	return split[0] ?? text;
}

function fuzzyCompletedSteps(text: string, items: TodoItem[]): number[] {
	const completed: number[] = [];
	const normalizedText = normalizeForProgressMatch(completedPortion(text));
	if (!/\b(?:implemented|completed|finished|created|added|hardened|deployed|validated|passed|opened|merged|pushed)\b/i.test(normalizedText)) {
		return completed;
	}

	for (const item of items) {
		if (!isTodoOpen(item)) continue;
		const action = primaryActionKeyword(item.text);
		if (action && !normalizedText.includes(action)) continue;
		const keywords = progressKeywords(item.text);
		if (keywords.length === 0) continue;
		const hits = keywords.filter((keyword) => normalizedText.includes(keyword));
		const uniqueHitCount = new Set(hits).size;
		const requiredHits = Math.min(3, Math.max(2, Math.ceil(keywords.length * 0.35)));
		if (uniqueHitCount >= requiredHits) completed.push(item.step);
	}
	return completed;
}

export function heuristicCompletedSteps(text: string, items: TodoItem[]): number[] {
	const completed: number[] = [];
	const lines = text.split("\n");

	for (const item of items) {
		if (!isTodoOpen(item)) continue; // already closed

		for (const line of lines) {
			const l = line.trim();
			if (!l) continue;

			// Pattern 1: explicit step/phase number + completion marker/status.
			// e.g. "Step 3 ✅", "Phase 3: completed", "#3 ✓"
			const stepNumMatch = l.match(
				/(?:step|phase|task)\s*(\d+)\s*[:.)-]?\s*(?:is\s+|was\s+|now\s+)?(?:✅|✓|✔|☑|\[x\]|complete|completed|done|finished|resolved|implemented|verified)|#\s*(\d+)\s*[:.)-]?\s*(?:is\s+|was\s+|now\s+)?(?:✅|✓|✔|☑|\[x\]|complete|completed|done|finished|resolved|implemented|verified)/i,
			);
			const stepNum = Number(stepNumMatch?.[1] ?? stepNumMatch?.[2]);
			if (stepNumMatch && stepNum === item.step) {
				completed.push(item.step);
				break;
			}

			// Pattern 2: markdown/checklist numbering + completion marker/status.
			// e.g. "1. ✅ Config", "- 2) [x] API client", "3 - done"
			const numberedListMatch = l.match(
				/^(?:[-*+]\s*)?(\d+)\s*[.)-]?\s*(?:is\s+|was\s+|now\s+)?(?:✅|✓|✔|☑|\[x\]|complete|completed|done|finished|resolved|implemented|verified)/i,
			);
			if (numberedListMatch && Number(numberedListMatch[1]) === item.step) {
				completed.push(item.step);
				break;
			}

			// Pattern 3: completion marker then step/phase/list number
			// e.g. "✅ Step 3", "✓ 3."
			const markerFirstMatch = l.match(/(?:✅|✓|✔|☑|\[x\])\s*(?:(?:step|phase|task)\s*)?(\d+)\s*[:.)]?/i);
			if (markerFirstMatch && Number(markerFirstMatch[1]) === item.step) {
				completed.push(item.step);
				break;
			}

			// Pattern 4: step text appears on a line with a completion marker
			// e.g. "✅ Add IPv4 to SPF", "| 5 | SPF + A record | ✅ Committed",
			// "[DONE] Add IPv4 to SPF", or "- [x] Add IPv4 to SPF"
			const hasMarker = /(?:✅|✓|✔|☑|\[x\]|\[DONE\])/.test(l);
			if (hasMarker) {
				// Normalize both for comparison: lowercase, collapse whitespace, strip markdown
				const normalizeForMatch = (s: string) =>
					stripMarkdownInline(s).toLowerCase().replace(/\s+/g, " ").trim();
				const normLine = normalizeForMatch(l);
				const normStep = normalizeForMatch(item.text);
				// Match if the step text (or a significant prefix) appears in the line
				if (
					normLine.includes(normStep) ||
					(normStep.length > 10 && normLine.includes(normStep.slice(0, Math.floor(normStep.length * 0.6))))
				) {
					completed.push(item.step);
					break;
				}
			}

			// Pattern 5: table row with step number and a check/completed status
			// e.g. "| 3 | ... | ✅ |" or "| 5 | ... | ✅ Verified"
			const tableMatch = l.match(/^\|\s*(\d+)\s*\|.*(?:✅|✓|✔|☑|complete|completed|done|implemented|verified)/i);
			if (tableMatch && Number(tableMatch[1]) === item.step) {
				completed.push(item.step);
				break;
			}
		}
	}

	return completed;
}

function indicatesWholePlanCompleted(text: string): boolean {
	const normalized = stripMarkdownInline(text).replace(/\s+/g, " ").trim();
	if (!normalized) return false;

	if (/\b(?:not|n't|cannot|can't|unable|failed)\b.{0,50}\b(?:complete|completed|finish|finished|implement|implemented|deliver|delivered)\b/i.test(normalized)) {
		return false;
	}

	return (
		/\b(?:all|every)\s+(?:\d+\s+)?(?:plan\s+)?(?:steps?|tasks?|items?|phases?)\b.{0,90}\b(?:complete|completed|done|finished|implemented|verified)\b/i.test(normalized) ||
		/\b(?:implemented|completed|finished|delivered|verified)\s+(?:all|every)\s+(?:\d+\s+)?(?:plan\s+)?(?:steps?|tasks?|items?|phases?)\b/i.test(normalized) ||
		/\b(?:implemented|completed|finished|delivered)\b.{0,90}\b(?:plan|implementation|work|task)\b.{0,90}\b(?:end-to-end|fully|successfully|complete)\b/i.test(normalized) ||
		/\b(?:plan|implementation|task|work)\s+(?:is\s+|now\s+)?(?:complete|completed|done|finished|delivered)\b/i.test(normalized)
	);
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let marked = 0;
	const explicitNonDone = extractExplicitNonDoneSteps(text);

	if (items.length > 0 && indicatesWholePlanCompleted(text)) {
		for (const item of items) {
			if (isTodoOpen(item) && !explicitNonDone.has(item.step)) {
				setTodoStatus(item, "done");
				marked++;
			}
		}
	}

	// Primary: explicit [DONE:n] tags and natural-language step summaries
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !isTodoDone(item) && !explicitNonDone.has(step)) {
			setTodoStatus(item, "done");
			marked++;
		}
	}

	// Fallback: heuristic detection. Explicit pending/partial/blocked lines win over fuzzy matches.
	const heuristicSteps = [...heuristicCompletedSteps(text, items), ...fuzzyCompletedSteps(text, items)];
	for (const step of heuristicSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !isTodoDone(item) && !explicitNonDone.has(step)) {
			setTodoStatus(item, "done");
			marked++;
		}
	}

	return marked;
}
