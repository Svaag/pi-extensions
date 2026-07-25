/**
 * Workflow store — discovers and loads workflow definitions from
 * ~/.pi/workflows/ and .pi/workflows/ directories.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import type { WorkflowDefinition } from "./types.ts";

// ── parsing ───────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { data: Record<string, any>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };

  const data: Record<string, any> = {};
  const yaml = match[1]!;
  let currentKey: string | null = null;

  for (const line of yaml.split("\n")) {
    // Simple YAML-ish parser: key: value, or key: (start of nested)
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      currentKey = kv[1]!;
      const val = kv[2]!.trim();
      if (val === "") {
        data[currentKey] = undefined; // will be filled by nested
      } else if (val === "true" || val === "false") {
        data[currentKey] = val === "true";
      } else if (/^\d+(\.\d+)?$/.test(val)) {
        data[currentKey] = Number(val);
      } else if (val.startsWith('"') && val.endsWith('"')) {
        data[currentKey] = val.slice(1, -1);
      } else if (val.startsWith("'") && val.endsWith("'")) {
        data[currentKey] = val.slice(1, -1);
      } else {
        data[currentKey] = val;
      }
    } else if (currentKey) {
      // List item or continuation
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        if (!Array.isArray(data[currentKey])) data[currentKey] = [];
        (data[currentKey] as any[]).push(trimmed.slice(2).trim());
      }
    }
  }

  return { data, body: match[2] ?? "" };
}

/**
 * Parse the body of a workflow markdown file into structured phases/tasks.
 *
 * Expected format:
 *
 *   # Workflow Name (optional, frontmatter name takes precedence)
 *
 *   ## Phase 1: Name
 *   Phase description text (optional)
 *
 *   | ID | Label | Prompt |
 *   |----|-------|--------|
 *   | id | Label | Prompt text |
 *
 *   ## Phase 2: Name
 *   ...
 *
 * Or a simple list format:
 *
 *   ## Phase 1: Name
 *   - task-id: Label — Prompt text
 *   - task-id2: Label — Prompt text
 */
function parseBodyPhases(
  body: string,
): WorkflowDefinition["phases"] {
  const phases: WorkflowDefinition["phases"] = [];
  const sections = body.split(/^##\s+/m);

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0]?.trim() ?? "";
    // header is like "1. Name" or "Phase 1: Name" or just "Name"
    const phaseNameMatch = header.match(
      /^(?:\d+\.?\s*|Phase\s*\d+[:.]?\s*)?(.+)$/i,
    );
    if (!phaseNameMatch) continue;

    const phaseName = phaseNameMatch[1]!.trim();
    const bodyText = lines.slice(1).join("\n").trim();
    if (!bodyText) continue;

    const tasks: WorkflowDefinition["phases"][number]["tasks"] = [];

    // Try table format first
    const tableRowRe = /^\|\s*`?([\w-]+)`?\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/;
    for (const line of bodyText.split("\n")) {
      const m = line.match(tableRowRe);
      if (m) {
        const id = m[1]!.trim();
        const label = m[2]!.trim();
        const prompt = m[3]!.trim();
        if (id && !id.match(/^-+$/)) {
          // skip separator rows
          tasks.push({ id, label, prompt });
        }
      }
    }

    // Fallback: bullet list format
    if (tasks.length === 0) {
      const bulletRe = /^[-*]\s+(?:`?([\w-]+)`?\s*:\s*)?(.+?)(?:\s*[-—]\s*(.+))?$/;
      for (const line of bodyText.split("\n")) {
        const m = line.match(bulletRe);
        if (m) {
          const id = (m[1] ?? m[2])?.trim() ?? `task-${tasks.length}`;
          const label = (m[2] ?? m[1])?.trim() ?? id;
          const prompt = (m[3] ?? m[2])?.trim() ?? line.trim();
          tasks.push({ id, label, prompt });
        }
      }
    }

    if (tasks.length > 0) {
      phases.push({ name: phaseName, tasks });
    }
  }

  return phases;
}

function parseWorkflowFile(filePath: string): WorkflowDefinition | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, body } = parseFrontmatter(raw);

    const name =
      (data.name as string) ||
      path.basename(filePath, path.extname(filePath));

    const description =
      (data.description as string) || name;

    // If phases are in frontmatter (advanced format)
    let phases: WorkflowDefinition["phases"] = [];
    if (Array.isArray(data.phases)) {
      phases = (data.phases as any[]).map((p: any) => ({
        name: String(p.name ?? "Unnamed"),
        description: p.description ? String(p.description) : undefined,
        tasks: Array.isArray(p.tasks)
          ? (p.tasks as any[]).map((t: any) => ({
              id: String(t.id ?? t.agent ?? `task-${Math.random().toString(36).slice(2, 8)}`),
              label: String(t.label ?? t.id ?? t.agent ?? "Unnamed"),
              prompt: String(t.task ?? t.prompt ?? ""),
              model: t.model ? String(t.model) : undefined,
              tools: Array.isArray(t.tools) ? t.tools.map(String) : undefined,
              cwd: t.cwd ? String(t.cwd) : undefined,
            }))
          : [],
      }));
    } else {
      // Parse from markdown body
      phases = parseBodyPhases(body);
    }

    if (phases.length === 0) return null;

    return { name, description, phases };
  } catch {
    return null;
  }
}

// ── discovery ─────────────────────────────────────────────────────────

export function discoverWorkflows(cwd: string): WorkflowDefinition[] {
  const dirs: string[] = [];

  // Global
  const homeDir = os.homedir();
  if (homeDir) {
    dirs.push(path.join(homeDir, CONFIG_DIR_NAME, "workflows"));
  }

  // Project-local
  dirs.push(path.join(cwd, CONFIG_DIR_NAME, "workflows"));

  const workflows: WorkflowDefinition[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".md" && ext !== ".yaml" && ext !== ".yml") continue;

      const filePath = path.join(dir, entry.name);
      const wf = parseWorkflowFile(filePath);
      if (wf && !seen.has(wf.name)) {
        seen.add(wf.name);
        workflows.push(wf);
      }
    }
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return workflows;
}

