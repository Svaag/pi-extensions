/**
 * Workflows Extension — multi-phase, multi-agent workflow orchestration
 * with a live TUI dashboard.
 *
 * ## Features
 *
 * - Discover workflow definitions from ~/.pi/workflows/ and .pi/workflows/
 * - `/workflow` command: interactive selector → live dashboard overlay
 * - `run_workflow` tool: LLM-callable with custom rendering
 * - Live two-panel dashboard showing phases and parallel task progress
 * - Cross-phase output references: {phase.1.task-id.output}
 * - Model, tools, and cwd per-task overrides
 * - Abort support (Escape or Ctrl+C)
 *
 * ## Workflow definition format
 *
 * YAML frontmatter + markdown body, or pure YAML frontmatter:
 *
 * ```markdown
 * ---
 * name: my-audit
 * description: Deep security audit
 * phases:
 *   - name: Analyze
 *     tasks:
 *       - id: analyze-auth
 *         label: Analyze Auth Module
 *         prompt: Find vulnerabilities in the auth module
 *         model: claude-opus-4-5
 *       - id: analyze-api
 *         label: Analyze API Layer
 *         prompt: Find vulnerabilities in the API layer
 *         model: claude-opus-4-5
 *   - name: Verify
 *     tasks:
 *       - id: verify-auth
 *         label: Verify Auth Findings
 *         prompt: Adversarially verify: {phase.1.analyze-auth.output}
 *         model: claude-opus-4-5
 * ---
 * ```
 *
 * Or table-based markdown body format (simpler, no model overrides):
 *
 * ```markdown
 * ---
 * name: quick-audit
 * description: Quick security scan
 * ---
 *
 * ## 1. Scan
 *
 * | ID | Label | Prompt |
 * |----|-------|--------|
 * | scan-auth | Scan Auth | Scan the auth module for issues |
 * | scan-api | Scan API | Scan the API layer for issues |
 *
 * ## 2. Report
 *
 * | ID | Label | Prompt |
 * |----|-------|--------|
 * | report | Generate Report | Create a report from: {phase.1.scan-auth.output} and {phase.1.scan-api.output} |
 * ```
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { WorkflowDashboard } from "./dashboard.ts";
import { runWorkflow } from "./executor.ts";
import { discoverWorkflows } from "./store.ts";
import type { WorkflowRunState } from "./types.ts";

// FIX: import DynamicBorder from the correct location
// We inline a simple border instead to avoid import issues.

function makeBorder(
  theme: { fg: (color: string, text: string) => string },
  char: string,
  width: number,
): string {
  return theme.fg("dim", char.repeat(Math.max(0, width)));
}

const DEFAULT_MAX_CONCURRENCY = 4;

// ── tool parameter schema ─────────────────────────────────────────────

const WorkflowTaskParam = Type.Object({
  id: Type.String({ description: "Task identifier" }),
  label: Type.String({ description: "Human-readable task label" }),
  prompt: Type.String({ description: "Prompt to delegate to the agent" }),
  model: Type.Optional(Type.String({ description: "Optional model override" })),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional comma-separated tool list override",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Optional working directory" })),
});

const WorkflowPhaseParam = Type.Object({
  name: Type.String({ description: "Phase name" }),
  description: Type.Optional(Type.String()),
  tasks: Type.Array(WorkflowTaskParam),
});

const RunWorkflowParams = Type.Object({
  workflow: Type.Optional(
    Type.String({ description: "Name of a saved workflow to run" }),
  ),
  inline: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      phases: Type.Array(WorkflowPhaseParam),
    }),
  ),
  maxConcurrency: Type.Optional(
    Type.Number({ description: "Maximum parallel agents (default: 4)" }),
  ),
});

// ── extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /workflow command ─────────────────────────────────────────────

  pi.registerCommand("workflow", {
    description:
      "Run a saved multi-phase workflow with live progress dashboard",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/workflow requires interactive mode", "error");
        return;
      }

      const workflows = discoverWorkflows(ctx.cwd);
      if (workflows.length === 0) {
        ctx.ui.notify(
          `No workflows found. Create .md files in ~/${CONFIG_DIR_NAME}/workflows/ or .${CONFIG_DIR_NAME}/workflows/`,
          "warning",
        );
        return;
      }

      // If args provided, try to match a workflow name directly
      let selectedWf = args.trim()
        ? workflows.find(
            (w) =>
              w.name === args.trim() ||
              w.name.toLowerCase() === args.trim().toLowerCase(),
          )
        : undefined;

      if (!selectedWf && args.trim()) {
        ctx.ui.notify(
          `Workflow "${args.trim()}" not found. Available: ${workflows.map((w) => w.name).join(", ")}`,
          "error",
        );
        return;
      }

      if (!selectedWf) {
        // Show selection dialog
        const items: SelectItem[] = workflows.map((w) => ({
          value: w.name,
          label: w.name,
          description: w.description,
        }));

        const chosen = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            const container = new Container();

            // Inline border
            container.addChild(
              new Text(makeBorder(theme, "─", 60), 0, 0),
            );

            container.addChild(
              new Text(
                theme.fg("accent", theme.bold(" Run Workflow ")) +
                  theme.fg("dim", `(${items.length} available)`),
                1,
                0,
              ),
            );

            const selectList = new SelectList(
              items,
              Math.min(items.length, 15),
              {
                selectedPrefix: (t: string) => theme.fg("accent", t),
                selectedText: (t: string) => theme.fg("accent", t),
                description: (t: string) => theme.fg("muted", t),
                scrollInfo: (t: string) => theme.fg("dim", t),
                noMatch: (t: string) => theme.fg("warning", t),
              },
            );
            selectList.onSelect = (item) => done(item.value);
            selectList.onCancel = () => done(null);
            container.addChild(selectList);

            container.addChild(
              new Text(
                theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
                1,
                0,
              ),
            );

            container.addChild(
              new Text(makeBorder(theme, "─", 60), 0, 0),
            );

            return {
              render: (w: number) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => {
                selectList.handleInput(data);
                tui.requestRender();
              },
            };
          },
        );

        if (!chosen) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        selectedWf = workflows.find((w) => w.name === chosen);
      }

      if (!selectedWf) {
        ctx.ui.notify("Workflow not found", "error");
        return;
      }

      // Launch workflow in dashboard overlay
      await launchWorkflowDashboard(selectedWf, ctx);
    },
  });

  // ── run_workflow tool ────────────────────────────────────────────

  pi.registerTool({
    name: "run_workflow",
    label: "Run Workflow",
    description: [
      "Run a multi-phase workflow with parallel agent execution.",
      "Use 'workflow' to reference a saved workflow by name,",
      "or 'inline' to define phases and tasks directly.",
      "Each phase runs its tasks in parallel and completes before the next phase starts.",
      "Use {phase.N.task-id.output} in later phase prompts to reference previous outputs.",
    ].join(" "),
    promptSnippet:
      "Run a multi-phase parallel-agent workflow (saved or inline)",
    promptGuidelines: [
      "Use run_workflow to execute multi-step analysis or code generation pipelines that benefit from parallel subagents.",
      "Reference previous phase outputs with {phase.N.task-id.output} in later phase task prompts.",
    ],
    parameters: RunWorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Resolve workflow: either from store or inline
      let workflowDef;
      if (params.workflow) {
        const workflows = discoverWorkflows(ctx.cwd);
        workflowDef = workflows.find(
          (w) =>
            w.name === params.workflow ||
            w.name.toLowerCase() === params.workflow!.toLowerCase(),
        );
        if (!workflowDef) {
          const available = workflows.map((w) => w.name).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Workflow "${params.workflow}" not found. Available: ${available}`,
              },
            ],
            details: { phases: [] },
          };
        }
      } else if (params.inline) {
        workflowDef = {
          name: params.inline.name || "Inline Workflow",
          description:
            params.inline.description ||
            `${params.inline.phases.length} phase(s)`,
          phases: params.inline.phases.map((p: any) => ({
            name: p.name,
            description: p.description,
            tasks: p.tasks.map((t: any) => ({
              id: t.id,
              label: t.label,
              prompt: t.prompt,
              model: t.model,
              tools: t.tools,
              cwd: t.cwd,
            })),
          })),
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Provide either 'workflow' (saved name) or 'inline' (phases definition).",
            },
          ],
          details: { phases: [] },
        };
      }

      const maxConcurrency = params.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
      let latestState: WorkflowRunState | null = null;

      const result = await runWorkflow(
        workflowDef,
        ctx.cwd,
        signal,
        (state) => {
          latestState = state;
          // Emit live updates so the TUI tool row re-renders
          if (onUpdate) {
            const activePhase = state.phases.find(
              (p) => p.status === "running",
            );
            const runningCount =
              activePhase?.tasks.filter((t) => t.status === "running")
                .length ?? 0;
            const doneTotal = state.phases.reduce(
              (sum, p) =>
                sum +
                p.tasks.filter(
                  (t) =>
                    t.status === "completed" || t.status === "failed",
                ).length,
              0,
            );
            const totalTasks = state.phases.reduce(
              (sum, p) => sum + p.tasks.length,
              0,
            );

            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Workflow: ${doneTotal}/${totalTasks} tasks · ${runningCount} running`,
                },
              ],
              details: state,
            });
          }
        },
        maxConcurrency,
      );

      // Build summary
      const phaseSummaries = result.phases.map((p) => {
        const done = p.tasks.filter(
          (t) => t.status === "completed" || t.status === "failed",
        ).length;
        const failed = p.tasks.filter((t) => t.status === "failed").length;
        let s = `${p.status === "completed" ? "✓" : p.status === "running" ? "⏳" : "✗"} ${p.name}: ${done}/${p.tasks.length} tasks`;
        if (failed > 0) s += ` (${failed} failed)`;
        return s;
      });

      const lastOutput = result.phases
        .flatMap((p) => p.tasks)
        .filter((t) => t.output)
        .pop()?.output;

      return {
        content: [
          {
            type: "text",
            text:
              `Workflow "${result.workflow.name}" complete.\n\n` +
              phaseSummaries.join("\n") +
              (lastOutput
                ? `\n\n## Last Output\n\n${lastOutput.slice(0, 2000)}`
                : ""),
          },
        ],
        details: result,
      };
    },

    // ── renderCall: show workflow plan ─────────────────────────────

    renderCall(args, theme, _context) {
      let title = "run_workflow";
      let phasesPreview = "";

      if (args.workflow) {
        title = `${args.workflow}`;
      }

      if (args.inline) {
        title = args.inline.name || "Inline Workflow";
        phasesPreview = (args.inline.phases ?? [])
          .map(
            (p: any) =>
              `  ${p.name}: ${(p.tasks ?? []).map((t: any) => t.label ?? t.id).join(", ")}`,
          )
          .join("\n");
      }

      const text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", title);
      if (phasesPreview) {
        return new Text(text + "\n" + theme.fg("dim", phasesPreview), 0, 0);
      }
      return new Text(text, 0, 0);
    },

    // ── renderResult: collapsed / expanded dashboard ───────────────

    renderResult(result, { expanded }, theme, _context) {
      const state = result.details as WorkflowRunState | undefined;
      if (!state) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const dashboard = new WorkflowDashboard({
        minTwoPanelWidth: 60,
        title: state.workflow.name,
      });
      dashboard.setState(state);

      if (expanded) {
        // Full dashboard
        const container = new Container();
        const lines = dashboard.render(80, theme);
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold(` ${state.workflow.name} `)),
            0,
            0,
          ),
        );
        for (const line of lines) {
          container.addChild(new Text(line, 0, 0));
        }
        return container;
      }

      // Collapsed: phase summary
      const phaseLines = state.phases.map((p) => {
        const icon =
          p.status === "completed"
            ? theme.fg("success", "✓")
            : p.status === "failed"
              ? theme.fg("error", "✗")
              : p.status === "running"
                ? theme.fg("accent", "⏳")
                : theme.fg("dim", "○");
        const done = p.tasks.filter(
          (t) => t.status === "completed" || t.status === "failed",
        ).length;
        return `  ${icon} ${theme.fg("accent", p.name)} ${theme.fg("dim", `${done}/${p.tasks.length}`)}`;
      });

      return new Text(
        theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("accent", state.workflow.name) +
          "\n" +
          phaseLines.join("\n") +
          "\n" +
          theme.fg("dim", "(Ctrl+O to expand)"),
        0,
        0,
      );
    },
  });
}

// ── interactive dashboard overlay (for /workflow command) ──────────

async function launchWorkflowDashboard(
  workflowDef: ReturnType<typeof discoverWorkflows>[number],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const maxConcurrency = DEFAULT_MAX_CONCURRENCY;

  await ctx.ui.custom<WorkflowRunState | null>(
    (tui, theme, _keybindings, done) => {
      const dashboard = new WorkflowDashboard({
        minTwoPanelWidth: 60,
        title: workflowDef.name,
      });

      // Set initial state
      const initialState: WorkflowRunState = {
        workflow: workflowDef,
        startedAt: Date.now(),
        phases: workflowDef.phases.map((p: any) => ({
          name: p.name,
          status: "pending" as const,
          tasks: p.tasks.map((t: any) => ({
            id: t.id,
            label: t.label,
            status: "pending" as const,
          })),
        })),
      };
      dashboard.setState(initialState);

      // Start workflow execution
      const abortCtrl = new AbortController();

      runWorkflow(
        workflowDef,
        ctx.cwd,
        abortCtrl.signal,
        (state) => {
          dashboard.setState(state);
          tui.requestRender();
        },
        maxConcurrency,
      )
        .then((finalState) => {
          dashboard.setState(finalState);
          tui.requestRender();
          // Keep visible briefly then close
          setTimeout(() => done(finalState), 1500);
        })
        .catch(() => {
          done(null);
        });

      // Close immediately after first render — the workflow runs in the
      // background and updates via the tool's renderResult.
      // Actually no — we want the dashboard to stay visible.
      // So we only call done() from the .then() above.

      return {
        render: (width: number) => {
          // Header border
          const lines: string[] = [];
          lines.push(makeBorder(theme, "─", width));

          // Dashboard content
          const dashLines = dashboard.render(width, theme);
          for (const line of dashLines) {
            lines.push(line);
          }

          // Footer
          lines.push("");
          lines.push(
            theme.fg(
              "dim",
              " esc to abort · workflow running...",
            ),
          );
          lines.push(makeBorder(theme, "─", width));

          return lines;
        },
        invalidate: () => dashboard.invalidate(),
        handleInput: (data: string) => {
          // Escape aborts
          if (data === "\x1b" || data === "\x03") {
            abortCtrl.abort();
            done(null);
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}