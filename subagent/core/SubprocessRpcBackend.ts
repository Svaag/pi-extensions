import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBackend, AgentBackendEvents, AgentHandle, BackendSpawnRequest } from "./AgentBackend.ts";
import type { AgentRecord, AgentResult } from "./AgentTypes.ts";
import { RpcClient } from "./RpcClient.ts";
import { aggregateAssistantUsage } from "../telemetry/Usage.ts";
import { appendOutputTail, summarizeText, truncateMiddle } from "./utils.ts";

const STDERR_TAIL_CAP = 16_384;
const TOOL_RESULT_TEXT_CAP = 4_000;

export function isContextWindowError(message: unknown): boolean {
	if (typeof message !== "string") return false;
	return /context window|context length|maximum context|too many tokens|input exceeds/i.test(message);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writeTempPrompt(agentId: string, text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-rpc-"));
	const filePath = path.join(dir, `${agentId}.md`);
	await fs.promises.writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function cleanupTemp(temp: { dir: string; filePath: string } | undefined): void {
	if (!temp) return;
	try {
		fs.unlinkSync(temp.filePath);
	} catch {
		// ignore
	}
	try {
		fs.rmdirSync(temp.dir);
	} catch {
		// ignore
	}
}

function textFromContentParts(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function textFromMessage(message: any): string {
	if (!message) return "";
	return textFromContentParts(message.content);
}

function executedModelRef(message: any): string | undefined {
	const model = typeof message?.model === "string" ? message.model : typeof message?.modelId === "string" ? message.modelId : undefined;
	const provider = typeof message?.provider === "string" ? message.provider : undefined;
	if (!model) return undefined;
	return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

export function textFromToolResult(result: any): string {
	const text = textFromContentParts(result?.content).trimEnd();
	const fullOutputPath = result?.details?.fullOutputPath;
	const suffix = typeof fullOutputPath === "string" && fullOutputPath
		? `\n[Full output saved by child at ${fullOutputPath}]`
		: "";
	return `${text}${suffix}`.trimEnd();
}

export function buildSubprocessRpcArgs(record: AgentRecord, childPolicyPath: string, tempPromptFilePath: string): string[] {
	const tools = record.tools && record.tools.length > 0
		? record.tools
		: record.writeMode === "read_only"
			? ["read", "bash"]
			: ["read", "bash", "edit", "write"];
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--name",
		`subagent:${record.taskPath}`,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-approve",
		"-e",
		childPolicyPath,
		"--append-system-prompt",
		tempPromptFilePath,
		"--tools",
		tools.join(","),
	];
	if (record.model) args.push("--model", record.model);
	if (record.thinkingLevel) args.push("--thinking", record.thinkingLevel);
	return args;
}

function finalAssistantMessage(messages: any[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

class SubprocessRpcHandle implements AgentHandle {
	readonly agentId: string;
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly rpc: RpcClient;
	private readonly tempPrompt: { dir: string; filePath: string } | undefined;

	constructor(
		agentId: string,
		proc: ChildProcessWithoutNullStreams,
		rpc: RpcClient,
		tempPrompt: { dir: string; filePath: string } | undefined,
	) {
		this.agentId = agentId;
		this.proc = proc;
		this.rpc = rpc;
		this.tempPrompt = tempPrompt;
	}

	prompt(message: string): Promise<void> {
		return this.rpc.send({ type: "prompt", message }).then(() => undefined);
	}

	sendMessage(message: string): Promise<void> {
		return this.rpc.send({ type: "steer", message }).then(() => undefined);
	}

	followupTask(message: string): Promise<void> {
		return this.rpc.send({ type: "follow_up", message }).then(() => undefined);
	}

	async interrupt(_reason?: string): Promise<void> {
		if (!this.isAlive()) return;
		try {
			await this.rpc.send({ type: "abort" }, 5_000);
		} catch {
			// Fall through to process signal.
		}
		if (this.isAlive()) this.proc.kill("SIGTERM");
	}

	async close(reason?: string): Promise<void> {
		await this.interrupt(reason);
		this.rpc.closeInput();
		setTimeout(() => {
			if (this.isAlive()) this.proc.kill("SIGKILL");
		}, 5_000).unref?.();
		cleanupTemp(this.tempPrompt);
	}

	isAlive(): boolean {
		return this.proc.exitCode === null && !this.proc.killed;
	}
}

export class SubprocessRpcBackend implements AgentBackend {
	private readonly childPolicyPath: string;

	constructor(childPolicyPath: string) {
		this.childPolicyPath = childPolicyPath;
	}

	async spawn(request: BackendSpawnRequest, events: AgentBackendEvents, signal?: AbortSignal): Promise<AgentHandle> {
		const { record, systemPrompt, userPrompt, policy } = request;
		const tempPrompt = await writeTempPrompt(record.agentId, systemPrompt);
		const args = buildSubprocessRpcArgs(record, this.childPolicyPath, tempPrompt.filePath);

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: record.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_POLICY: JSON.stringify(policy),
			},
		}) as ChildProcessWithoutNullStreams;

		const observe = (observation: Parameters<NonNullable<typeof events.onObservation>>[0]) => {
			try { events.onObservation?.(observation); } catch { /* telemetry must not affect the child */ }
		};
		observe({ kind: "process.spawned", at: Date.now(), pid: proc.pid });

		let stderrTail = "";
		let sawTerminalResult = false;
		let outputChars = 0;
		let turnOutputChars = 0;
		let turnToolCalls = 0;
		let turnProviderRequests = 0;
		let turnCompactions = 0;
		let lastAssistantText = "";
		let lastAssistant: any | undefined;
		let sawContextOverflow = false;
		let sawFirstModelOutput = false;
		let overflowRecoveryAttempted = false;
		let overflowRecoveryActive = false;
		let overflowRecoveryStartedAt: number | undefined;
		let compactionStartedAt: number | undefined;
		const toolStartedAt = new Map<string, number>();
		const fallbackToolCallIds = new Map<string, string[]>();
		let generatedToolCallId = 0;
		let rpc: RpcClient;

		const eventToolCallId = (event: any, phase: "start" | "end"): string => {
			const candidate = event?.toolCallId ?? event?.toolCall?.id ?? event?.id;
			if (typeof candidate === "string" && candidate) return candidate;
			const toolName = String(event?.toolName ?? "tool");
			if (phase === "end") {
				const queued = fallbackToolCallIds.get(toolName);
				const existing = queued?.shift();
				if (queued?.length === 0) fallbackToolCallIds.delete(toolName);
				if (existing) return existing;
			}
			generatedToolCallId += 1;
			const generated = `${toolName}-${generatedToolCallId}`;
			if (phase === "start") {
				const queued = fallbackToolCallIds.get(toolName) ?? [];
				queued.push(generated);
				fallbackToolCallIds.set(toolName, queued);
			}
			return generated;
		};

		const finishContextOverflowFailure = (message: string, recoveryError?: unknown) => {
			const recoverySuffix = recoveryError ? ` Overflow recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` : "";
			sawTerminalResult = true;
			events.onResult?.({
				agentId: record.agentId,
				status: "failed",
				summary: `${message}${recoverySuffix}`,
				output: lastAssistantText,
				metrics: { outputChars: turnOutputChars, turns: 1, toolCalls: turnToolCalls, providerRequests: turnProviderRequests, compactions: turnCompactions },
			});
		};

		const recoverFromContextOverflow = async (message: string): Promise<void> => {
			if (overflowRecoveryAttempted) return;
			overflowRecoveryAttempted = true;
			overflowRecoveryActive = true;
			overflowRecoveryStartedAt = Date.now();
			observe({ kind: "context_overflow.recovery", at: overflowRecoveryStartedAt, phase: "started" });
			events.onOutput?.("\n[Child context window overflow detected; requesting manual compaction and one no-tools partial-report retry.]\n");
			try {
				try {
					await rpc.send({ type: "set_auto_compaction", enabled: true }, 10_000);
				} catch {
					// Manual compaction below is the important recovery path.
				}
				await rpc.send({
					type: "compact",
					customInstructions: "Recover a failed subagent turn that exceeded the context window. Preserve the delegated task, files inspected, commands/results seen, partial findings, blockers, and safest next steps. Omit raw large/binary tool output.",
				}, 120_000);
				events.onOutput?.("\n[Child compaction completed after overflow; asking for a concise partial report without more tools.]\n");
				await rpc.send({
					type: "prompt",
					message: "Your previous turn exceeded the context window and has now been compacted. Do not call tools. Return a concise partial final report using only retained context and outputs already inspected: summary, evidence/files/commands seen, validation status, blockers, and next safe actions.",
				}, 10_000);
				const finishedAt = Date.now();
				observe({ kind: "context_overflow.recovery", at: finishedAt, phase: "completed", success: true, durationMs: overflowRecoveryStartedAt ? finishedAt - overflowRecoveryStartedAt : undefined });
			} catch (error) {
				overflowRecoveryActive = false;
				const finishedAt = Date.now();
				const recoveryError = error instanceof Error ? error : new Error(String(error));
				observe({ kind: "context_overflow.recovery", at: finishedAt, phase: "completed", success: false, durationMs: overflowRecoveryStartedAt ? finishedAt - overflowRecoveryStartedAt : undefined, error: recoveryError });
				finishContextOverflowFailure(message, error);
			}
		};

		rpc = new RpcClient(proc, {
			onMalformedLine: (line, error) => {
				observe({ kind: "rpc.malformed", at: Date.now(), error });
				events.onOutput?.(`\n[Malformed child RPC JSON ignored: ${error.message}; line=${line.slice(0, 160)}]\n`);
			},
			onRequestStarted: (request) => observe({ kind: "rpc.started", at: request.startedAt, requestId: request.requestId, command: request.command }),
			onRequestCompleted: (request) => observe({ kind: "rpc.completed", at: request.finishedAt, requestId: request.requestId, command: request.command, durationMs: request.durationMs, success: request.success, error: request.error }),
			onEvent: (event) => {
				if (event.type === "agent_start") {
					sawFirstModelOutput = false;
					turnOutputChars = 0;
					turnToolCalls = 0;
					turnProviderRequests = 0;
					turnCompactions = 0;
					events.onStarted?.();
				}
				if (event.type === "compaction_start") {
					turnCompactions += 1;
					compactionStartedAt = Date.now();
					observe({ kind: "compaction.started", at: compactionStartedAt, reason: typeof event.reason === "string" ? event.reason : undefined });
					events.onOutput?.(`\n[Child compaction started: ${event.reason ?? "unknown"}]\n`);
				}
				if (event.type === "compaction_end") {
					const result = event.result;
					const status = event.aborted ? "aborted" : result ? "completed" : "failed";
					const estimate = result?.estimatedTokensAfter ? `; estimatedTokensAfter=${result.estimatedTokensAfter}` : "";
					const error = event.errorMessage ? `; error=${event.errorMessage}` : "";
					const finishedAt = Date.now();
					observe({
						kind: "compaction.completed",
						at: finishedAt,
						success: !event.aborted && Boolean(result),
						reason: typeof event.reason === "string" ? event.reason : undefined,
						durationMs: compactionStartedAt ? finishedAt - compactionStartedAt : undefined,
						error: event.errorMessage ? new Error(String(event.errorMessage)) : undefined,
					});
					compactionStartedAt = undefined;
					events.onOutput?.(`\n[Child compaction ${status}: ${event.reason ?? "unknown"}${estimate}${error}]\n`);
				}
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						if (!sawFirstModelOutput) {
							sawFirstModelOutput = true;
							observe({ kind: "model.first_output", at: Date.now() });
						}
						outputChars += delta.delta.length;
						turnOutputChars += delta.delta.length;
						events.onOutput?.(delta.delta);
					}
					if (delta?.type === "error") {
						const modelError = new Error(String(delta.errorMessage ?? "unknown model error"));
						if (isContextWindowError(delta.errorMessage)) {
							sawContextOverflow = true;
							observe({ kind: "context_overflow.detected", at: Date.now() });
						}
						observe({ kind: "provider.error", at: Date.now(), error: modelError });
						events.onOutput?.(`\n[Child model error: ${delta.errorMessage ?? "unknown error"}]\n`);
					}
				}
				if (event.type === "tool_execution_start") {
					turnToolCalls += 1;
					const toolCallId = eventToolCallId(event, "start");
					const startedAt = Date.now();
					toolStartedAt.set(toolCallId, startedAt);
					observe({ kind: "tool.started", at: startedAt, toolCallId, toolName: String(event.toolName ?? "tool") });
					const preview = JSON.stringify(event.args ?? {});
					events.onOutput?.(`\n→ ${event.toolName ?? "tool"} ${preview.length > 300 ? `${preview.slice(0, 300)}…` : preview}\n`);
				}
				if (event.type === "tool_execution_end") {
					const toolCallId = eventToolCallId(event, "end");
					const finishedAt = Date.now();
					const toolText = textFromToolResult(event.result);
					const status = event.isError ? " error" : " result";
					const body = toolText ? `\n${truncateMiddle(toolText, TOOL_RESULT_TEXT_CAP)}` : "";
					const resultTruncated = Boolean(event.result?.details?.subagentPolicy?.toolResultTruncated) || toolText.length > TOOL_RESULT_TEXT_CAP;
					const policyRejected = Boolean(event.isError) && /subagent .*policy|not allowed|blocked by read-only|blocked by disjoint/i.test(toolText);
					observe({
						kind: "tool.completed",
						at: finishedAt,
						toolCallId,
						toolName: String(event.toolName ?? "tool"),
						durationMs: toolStartedAt.has(toolCallId) ? finishedAt - toolStartedAt.get(toolCallId)! : undefined,
						success: !event.isError,
						resultChars: toolText.length,
						resultTruncated,
						policyRejected,
						error: event.isError ? new Error(policyRejected ? "Child policy rejected tool execution" : "Child tool execution failed") : undefined,
					});
					toolStartedAt.delete(toolCallId);
					events.onOutput?.(`\n← ${event.toolName ?? "tool"}${status}${body}\n`);
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					turnProviderRequests += 1;
					lastAssistant = event.message;
					lastAssistantText = textFromMessage(event.message);
					observe({
						kind: "model.executed",
						at: Date.now(),
						model: executedModelRef(event.message),
						thinkingLevel: typeof event.message?.thinkingLevel === "string" ? event.message.thinkingLevel : undefined,
					});
				}
				if (event.type === "agent_end") {
					sawTerminalResult = true;
					const messages = Array.isArray(event.messages) ? event.messages : [];
					const usage = aggregateAssistantUsage(messages);
					lastAssistant = finalAssistantMessage(messages) ?? lastAssistant;
					lastAssistantText = textFromMessage(lastAssistant) || lastAssistantText;
					const stopReason = lastAssistant?.stopReason;
					const errorMessage = lastAssistant?.errorMessage;
					const status: AgentResult["status"] = stopReason === "aborted" ? "interrupted" : stopReason === "error" ? "failed" : "succeeded";
					const summary = errorMessage || summarizeText(lastAssistantText, 800) || "(no output)";
					if (status === "failed" && (sawContextOverflow || isContextWindowError(summary)) && !overflowRecoveryAttempted) {
						sawTerminalResult = false;
						void recoverFromContextOverflow(summary);
						return;
					}
					overflowRecoveryActive = false;
					events.onResult?.({
						agentId: record.agentId,
						status,
						summary,
						output: lastAssistantText,
						metrics: {
							...usage,
							outputChars: turnOutputChars,
							turns: 1,
							toolCalls: turnToolCalls,
							providerRequests: Math.max(turnProviderRequests, usage.providerRequests ?? 0),
							compactions: turnCompactions,
						},
					});
				}
			},
		});

		proc.stderr.on("data", (chunk) => {
			stderrTail = appendOutputTail(stderrTail, chunk.toString(), STDERR_TAIL_CAP);
		});
		proc.on("error", (error) => events.onError?.(error instanceof Error ? error : new Error(String(error))));
		proc.on("close", (code, closeSignal) => {
			const exitedAt = Date.now();
			observe({ kind: "process.exited", at: exitedAt, exitCode: code, signal: closeSignal });
			cleanupTemp(tempPrompt);
			if (!sawTerminalResult && !overflowRecoveryActive && code !== 0) {
				events.onError?.(new Error(stderrTail.trim() || `Child process exited before completion with code ${code}`));
			}
			events.onExit?.(code, closeSignal);
		});

		if (signal) {
			const abort = () => {
				if (proc.exitCode === null) proc.kill("SIGTERM");
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}

		const handle = new SubprocessRpcHandle(record.agentId, proc, rpc, tempPrompt);
		try {
			await rpc.send({ type: "set_auto_compaction", enabled: true }, 10_000);
		} catch (error) {
			events.onOutput?.(`\n[Child auto-compaction enable failed: ${error instanceof Error ? error.message : String(error)}]\n`);
		}
		try {
			await handle.prompt(userPrompt);
		} catch (error) {
			if (!sawFirstModelOutput && proc.exitCode !== null) {
				const hostError = error instanceof Error ? error : new Error(String(error));
				(hostError as Error & { failureDomain?: string }).failureDomain = "host";
				throw hostError;
			}
			throw error;
		}
		return handle;
	}
}
