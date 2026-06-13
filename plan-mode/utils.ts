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
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
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
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
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

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
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
	let cleaned = stripMarkdownInline(text)
		.replace(/^\s*\[[ xX]\]\s+/, "")
		.replace(/^\s*(?:step\s*)?\d+\s*[:.)-]\s*/i, "")
		.replace(/^\s*[-*+]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();

	// Remove trailing explanation separators on very long list entries. This keeps the widget usable.
	if (cleaned.length > 90) {
		const split = cleaned.match(/^(.{25,90}?)(?:\s+[—–-]\s+|:\s+)/);
		if (split?.[1]) cleaned = split[1].trim();
	}

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 60) {
		cleaned = `${cleaned.slice(0, 57)}...`;
	}
	return cleaned;
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

	if (/\bimplementation\b|\bimplement\b|\bexecution\b|\bexecute\b/.test(normalized)) return 100;
	if (/\baction\b|\bwork\s+plan\b/.test(normalized)) return 95;
	if (/\bsteps?\b|\btasks?\b|\btodos?\b|\btodo\b/.test(normalized)) return 90;
	if (/^(proposed\s+)?plan$/.test(normalized)) return 80;
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
		if (header) headers.push({ index: i, level: header.level, title: header.title, score: scoreActionSection(header.title) });
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
		// If there is a strong implementation/execution section, ignore weaker generic sections like "Key Changes".
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
	let extracted = preferred.length > 0 ? preferred : plainPlan.length > 0 ? plainPlan : extractFallbackTopLevelItems(lines);

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

/**
 * Heuristic completion detection: looks for step numbers or step text
 * near completion markers (✅, ✓, ✔, ☑, [x], "completed", "done").
 * Returns indices of items that appear completed.
 */
export function heuristicCompletedSteps(text: string, items: TodoItem[]): number[] {
	const completed: number[] = [];
	const lines = text.split("\n");

	for (const item of items) {
		if (item.completed) continue; // already marked

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

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let marked = 0;

	// Primary: explicit [DONE:n] tags and natural-language step summaries
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			marked++;
		}
	}

	// Fallback: heuristic detection
	const heuristicSteps = heuristicCompletedSteps(text, items);
	for (const step of heuristicSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			marked++;
		}
	}

	return marked;
}
