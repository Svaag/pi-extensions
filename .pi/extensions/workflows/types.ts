/**
 * Workflow types — shared type definitions for the workflows extension.
 */

/** A single task within a workflow phase. */
export interface WorkflowTask {
  /** Machine-friendly task id (used for output references). */
  id: string;

  /** Display label (shown in TUI). */
  label: string;

  /** Prompt text sent to the subagent. May reference {phase.N.id.output}. */
  prompt: string;

  /** Optional model override for this task. */
  model?: string;

  /** Optional tools override for this task. */
  tools?: string[];

  /** Optional working directory for this task. */
  cwd?: string;
}

/** A workflow phase containing parallel tasks. */
export interface WorkflowPhase {
  /** Phase name. */
  name: string;

  /** Human-readable phase description. */
  description?: string;

  /** Tasks that run in parallel within this phase. */
  tasks: WorkflowTask[];
}

/** Top-level workflow definition. */
export interface WorkflowDefinition {
  /** Machine-friendly workflow name (a-z, 0-9, hyphens). */
  name: string;

  /** Human-readable description. */
  description: string;

  /** Ordered phases. Each phase completes before the next begins. */
  phases: WorkflowPhase[];
}

/** Runtime state for a single task. */
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskState {
  id: string;
  label: string;
  status: TaskStatus;
  startTime?: number;
  endTime?: number;
  /** Accumulated token count from streaming updates. */
  tokens?: number;
  /** Final output text. */
  output?: string;
  /** Error message if failed. */
  error?: string;
  /** Model used (resolved after start). */
  model?: string;
}

/** Runtime state for a phase. */
export type PhaseStatus = "pending" | "running" | "completed" | "failed";

export interface PhaseState {
  name: string;
  status: PhaseStatus;
  startTime?: number;
  endTime?: number;
  tasks: TaskState[];
}

/** Complete runtime workflow state. */
export interface WorkflowRunState {
  workflow: WorkflowDefinition;
  startedAt: number;
  phases: PhaseState[];
}