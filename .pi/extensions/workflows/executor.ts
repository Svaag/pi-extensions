/**
 * Workflow executor — spawns pi subprocesses for each task, tracks progress,
 * and resolves cross-phase output references.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Message } from "@earendil-works/pi-ai";

import type {
  PhaseState,
  TaskState,
  WorkflowDefinition,
  WorkflowRunState,
} from "./types.ts";

// ── helpers ──────────────────────────────────────────────────────────

function getPiCommand(): { command: string; argsPrefix: string[] } {
  // Try to reuse the current pi script path when available.
  const currentScript = process.argv[1];
  const isBunFake = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunFake && fs.existsSync(currentScript)) {
    return { command: process.execPath, argsPrefix: [currentScript] };
  }
  return { command: "pi", argsPrefix: [] };
}

function resolveOutputRefs(
  template: string,
  phases: PhaseState[],
): string {
  // Replace {phase.N.id.output} with the actual output of completed tasks.
  return template.replace(
    /\{phase\.(\d+)\.([\w-]+)\.output\}/g,
    (_match, phaseIdx: string, taskId: string) => {
      const idx = Number(phaseIdx) - 1; // 1-indexed in templates
      if (idx < 0 || idx >= phases.length) return _match;
      const phase = phases[idx];
      const task = phase.tasks.find((t) => t.id === taskId);
      if (!task || task.status !== "completed") return _match;
      return task.output ?? "(no output)";
    },
  );
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

async function writeTempPrompt(
  taskId: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-workflow-"),
  );
  const filePath = path.join(tmpDir, `prompt-${taskId}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// ── task runner ──────────────────────────────────────────────────────

export interface TaskRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate: (state: TaskState) => void;
}

export async function runTask(
  state: TaskState,
  resolvedPrompt: string,
  model: string | undefined,
  tools: string[] | undefined,
  taskCwd: string | undefined,
  options: TaskRunOptions,
): Promise<TaskState> {
  const { cwd, signal, onUpdate } = options;

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));

  let tmpDir: string | null = null;
  let tmpPath: string | null = null;

  const result: TaskState = {
    ...state,
    status: "running",
    startTime: Date.now(),
    tokens: 0,
  };
  onUpdate(result);

  try {
    const tmp = await writeTempPrompt(state.id, resolvedPrompt);
    tmpDir = tmp.dir;
    tmpPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPath);
    args.push(`Task: ${resolvedPrompt}`);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiCommand();
      const proc: ChildProcess = spawn(
        invocation.command,
        [...invocation.argsPrefix, ...args],
        {
          cwd: taskCwd ?? cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let buffer = "";
      let totalTokens = 0;
      let resolvedModel = model;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          if (msg.role === "assistant" || msg.role === "toolResult") {
            if (msg.usage) totalTokens += msg.usage.totalTokens || 0;
            if (!resolvedModel && msg.model) resolvedModel = msg.model;
          }
        }

        // Capture final assistant output for live preview.
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          const text = getFinalOutput([event.message]);
          if (text) {
            result.output = text;
            result.model = resolvedModel;
            result.tokens = totalTokens;
            onUpdate({ ...result, status: "running" });
          }
        }
      };

      proc.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      let stderr = "";
      proc.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    if (wasAborted) {
      result.status = "failed";
      result.error = "Aborted";
    } else if (exitCode !== 0) {
      result.status = "failed";
      result.error = `Exit code ${exitCode}`;
    } else {
      result.status = "completed";
      result.tokens = result.tokens || totalTokens;
      result.model = result.model || model;
    }
  } catch (err: any) {
    result.status = "failed";
    result.error = err.message ?? "Unknown error";
  } finally {
    if (tmpPath)
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (tmpDir)
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    result.endTime = Date.now();
    onUpdate(result);
  }

  return result;
}

// ── async concurrency limit ───────────────────────────────────────────

export async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── phase runner ──────────────────────────────────────────────────────

export async function runPhase(
  phaseIndex: number,
  phases: PhaseState[],
  workflow: WorkflowDefinition,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: (state: WorkflowRunState) => void,
  maxConcurrency: number,
): Promise<PhaseState> {
  const phaseDef = workflow.phases[phaseIndex];
  const phase: PhaseState = {
    name: phaseDef.name,
    status: "running",
    startTime: Date.now(),
    tasks: phaseDef.tasks.map((t) => ({
      id: t.id,
      label: t.label,
      status: "pending" as const,
    })),
  };

  // Update phases array in-place
  phases[phaseIndex] = phase;
  onUpdate({ workflow, startedAt: 0, phases: [...phases] });

  await mapWithConcurrency(
    phase.tasks.map((task, i) => ({ task, def: phaseDef.tasks[i] })),
    maxConcurrency,
    async ({ task, def }) => {
      // Resolve cross-phase references in the prompt
      const resolvedPrompt = resolveOutputRefs(def.prompt, phases);

      const finalState = await runTask(
        task,
        resolvedPrompt,
        def.model,
        def.tools,
        def.cwd,
        {
          cwd,
          signal,
          onUpdate: (ts) => {
            // Merge updated task state back
            const idx = phase.tasks.findIndex((t) => t.id === ts.id);
            if (idx >= 0) phase.tasks[idx] = ts;
            phases[phaseIndex] = { ...phase };
            onUpdate({
              workflow,
              startedAt: 0, // set by caller
              phases: phases.map((p) => ({ ...p })),
            });
          },
        },
      );

      const idx = phase.tasks.findIndex((t) => t.id === finalState.id);
      if (idx >= 0) phase.tasks[idx] = finalState;
      return finalState;
    },
  );

  const allOk = phase.tasks.every((t) => t.status === "completed");
  phase.status = allOk ? "completed" : "failed";
  phase.endTime = Date.now();
  phases[phaseIndex] = phase;
  onUpdate({ workflow, startedAt: 0, phases: [...phases] });

  return phase;
}

// ── full workflow runner ──────────────────────────────────────────────

export async function runWorkflow(
  workflow: WorkflowDefinition,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: (state: WorkflowRunState) => void,
  maxConcurrency: number = 4,
): Promise<WorkflowRunState> {
  const startedAt = Date.now();

  const phases: PhaseState[] = workflow.phases.map((p) => ({
    name: p.name,
    status: "pending" as const,
    tasks: p.tasks.map((t) => ({
      id: t.id,
      label: t.label,
      status: "pending" as const,
    })),
  }));

  const runState: WorkflowRunState = { workflow, startedAt, phases };

  for (let i = 0; i < workflow.phases.length; i++) {
    if (signal?.aborted) break;

    const result = await runPhase(
      i,
      runState.phases,
      workflow,
      cwd,
      signal,
      onUpdate,
      maxConcurrency,
    );

    if (result.status === "failed") break;
  }

  return runState;
}