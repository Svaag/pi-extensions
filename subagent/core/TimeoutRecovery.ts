export const RUNTIME_TIMEOUT_RECOVERY_COMMAND = "subagent-runtime-timeout-recovery";
export const RUNTIME_TIMEOUT_RECOVERY_MARKER = "[SUBAGENT_RUNTIME_TIMEOUT_RECOVERY]";

export const RUNTIME_TIMEOUT_RECOVERY_COMMAND_TEXT = `/${RUNTIME_TIMEOUT_RECOVERY_COMMAND}`;

export const RUNTIME_TIMEOUT_RECOVERY_PROMPT = `${RUNTIME_TIMEOUT_RECOVERY_MARKER}
The delegated task exceeded its runtime budget. Do not call tools. Return a concise partial report using only context and results already available. Include findings, useful file paths, commands or results seen, uncertainty, blockers, and recommended next checks.`;
