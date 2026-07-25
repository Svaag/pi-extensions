/**
 * Workflow Dashboard — custom TUI component for rendering live workflow
 * progress as a two-panel overlay (phases on the left, active tasks on the right).
 */

import {
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Minimal theme interface for fg/bg helpers. */
interface ThemeLike {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
}

import type {
  PhaseState,
  TaskState,
  WorkflowRunState,
} from "./types.ts";

// ── formatting helpers ────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m${s.toString().padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function taskStatusIcon(status: TaskState["status"], theme: ThemeLike): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "running":
      return theme.fg("accent", "●");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
  }
}

function phaseStatusIcon(status: PhaseState["status"], theme: ThemeLike): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", " ");
    case "running":
      return theme.fg("accent", "❯");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
  }
}

function phaseProgress(phase: PhaseState): string {
  const done = phase.tasks.filter(
    (t) => t.status === "completed" || t.status === "failed",
  ).length;
  return `${done}/${phase.tasks.length}`;
}

// ── dashboard component ───────────────────────────────────────────────

export interface DashboardOptions {
  /** Minimum terminal width for two-panel layout. */
  minTwoPanelWidth?: number;
  /** Title shown at the top of the dashboard. */
  title?: string;
}

export class WorkflowDashboard {
  private state: WorkflowRunState | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private options: DashboardOptions;

  constructor(options: DashboardOptions = {}) {
    this.options = { minTwoPanelWidth: 80, ...options };
  }

  setState(state: WorkflowRunState): void {
    this.state = state;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number, theme: ThemeLike): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const { state, options } = this;
    if (!state) {
      this.cachedLines = [theme.fg("muted", "No workflow running.")];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const lines: string[] = [];

    // ── header ──
    const wf = state.workflow;
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const totalDone = state.phases.reduce(
      (sum, p) =>
        sum +
        p.tasks.filter(
          (t) => t.status === "completed" || t.status === "failed",
        ).length,
      0,
    );
    const totalTasks = state.phases.reduce((sum, p) => sum + p.tasks.length, 0);

    let header = theme.fg("accent", theme.bold(wf.name));
    header += theme.fg("dim", ` · ${wf.description}`);
    header += theme.fg("muted", ` · ${totalDone}/${totalTasks} agents`);
    header += theme.fg("dim", ` · ${elapsed}`);
    lines.push(truncateToWidth(header, width));
    lines.push(""); // blank separator

    // ── decide layout ──
    if (width < (options.minTwoPanelWidth ?? 80)) {
      // Single-column stacked layout
      this.renderStacked(lines, width, theme);
    } else {
      // Two-panel layout
      this.renderTwoPanel(lines, width, theme);
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  // ── stacked (narrow terminal) ──────────────────────────────────────

  private renderStacked(
    lines: string[],
    width: number,
    theme: ThemeLike,
  ): void {
    const { state } = this;
    if (!state) return;

    for (const phase of state.phases) {
      const icon = phaseStatusIcon(phase.status, theme);
      const progress = phaseProgress(phase);
      lines.push(
        truncateToWidth(
          ` ${icon} ${theme.fg("accent", phase.name)} ${theme.fg("dim", progress)}`,
          width,
        ),
      );

      for (const task of phase.tasks) {
        lines.push(this.taskLine(task, theme, width));
      }
      lines.push("");
    }
  }

  // ── two-panel layout ───────────────────────────────────────────────

  private renderTwoPanel(
    lines: string[],
    width: number,
    theme: ThemeLike,
  ): void {
    const { state } = this;
    if (!state) return;

    const leftWidth = Math.min(28, Math.floor(width * 0.35));
    const rightWidth = width - leftWidth - 1; // -1 for separator

    // Collect all lines for left and right panels
    const leftLines: string[] = [];
    const rightLines: string[] = [];

    // Left panel header
    leftLines.push(
      truncateToWidth(
        theme.fg("accent", theme.bold(" Phases ")) +
          theme.fg("dim", `─`.repeat(Math.max(0, leftWidth - 8))),
        leftWidth,
      ),
    );

    // Right panel header — find active phase
    const activePhase = state.phases.find((p) => p.status === "running");
    const activeLabel = activePhase
      ? `${activePhase.name} · ${phaseProgress(activePhase)} agents`
      : "pending";

    rightLines.push(
      truncateToWidth(
        theme.fg("accent", theme.bold(` ${activeLabel} `)) +
          theme.fg("dim", `─`.repeat(Math.max(0, rightWidth - activeLabel.length - 3))),
        rightWidth,
      ),
    );

    // Build left panel: phases
    for (const phase of state.phases) {
      const icon = phaseStatusIcon(phase.status, theme);
      const progress = phaseProgress(phase);
      leftLines.push(
        truncateToWidth(
          ` ${icon} ${theme.fg("accent", phase.name)} ${theme.fg("dim", progress)}`,
          leftWidth,
        ),
      );
    }

    // Build right panel: tasks from the active (or last) phase
    // If a phase is running, show its tasks. Otherwise show the last phase.
    let displayPhase = activePhase;
    if (!displayPhase) {
      // Find most recently active phase
      for (let i = state.phases.length - 1; i >= 0; i--) {
        if (state.phases[i].status !== "pending") {
          displayPhase = state.phases[i];
          break;
        }
      }
    }

    if (displayPhase) {
      for (const task of displayPhase.tasks) {
        rightLines.push(this.taskLine(task, theme, rightWidth));
      }
    } else {
      rightLines.push(theme.fg("muted", " Waiting to start..."));
    }

    // Pad to same height
    const maxH = Math.max(leftLines.length, rightLines.length);
    while (leftLines.length < maxH) leftLines.push("");
    while (rightLines.length < maxH) rightLines.push("");

    // Combine
    for (let i = 0; i < maxH; i++) {
      const sep = theme.fg("dim", "│");
      lines.push(
        truncateToWidth(leftLines[i] ?? "", leftWidth) +
          theme.fg("dim", " │") +
          truncateToWidth(rightLines[i] ?? "", rightWidth),
      );
    }
  }

  // ── single task line ───────────────────────────────────────────────

  private taskLine(
    task: TaskState,
    theme: ThemeLike,
    width: number,
  ): string {
    const icon = taskStatusIcon(task.status, theme);
    let line = `  ${icon} ${theme.fg("accent", task.label)}`;

    // Timing
    if (task.startTime && task.status === "running") {
      const elapsed = formatDuration(Date.now() - task.startTime);
      line += theme.fg("dim", ` · ${elapsed}`);
    } else if (task.startTime && task.endTime) {
      const dur = formatDuration(task.endTime - task.startTime);
      line += theme.fg("dim", ` · ${dur}`);
    }

    // Model
    if (task.model) {
      line += theme.fg("muted", ` · ${task.model}`);
    }

    // Tokens
    if (task.tokens && task.tokens > 0) {
      line += theme.fg("dim", ` · ${formatTokens(task.tokens)} tok`);
    }

    // Idle note (no token activity for a while, but we don't track that
    // precisely here — the subagent example doesn't either)
    if (task.status === "running" && task.tokens === 0 && task.startTime) {
      const idleSec = Math.floor((Date.now() - task.startTime) / 1000);
      if (idleSec > 30) {
        line += theme.fg("muted", ` · idle ${formatDuration(idleSec * 1000)}`);
      }
    }

    // Error
    if (task.error) {
      line += ` ${theme.fg("error", task.error)}`;
    }

    return truncateToWidth(line, width);
  }
}