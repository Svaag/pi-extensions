import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBackend, AgentBackendEvents, AgentHandle, BackendSpawnRequest } from "./AgentBackend.ts";
import type { AgentRecord, AgentResult } from "./AgentTypes.ts";
import { RpcClient } from "./RpcClient.ts";
import { appendOutputTail, summarizeText, truncateMiddle } from "./utils.ts";

const STDERR_TAIL_CAP = 16_384;
const TOOL_RESULT_TEXT_CAP = 4_000;

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

		let stderrTail = "";
		let sawTerminalResult = false;
		let outputChars = 0;
		let lastAssistantText = "";
		let lastAssistant: any | undefined;

		const rpc = new RpcClient(proc, {
			onMalformedLine: (line, error) => {
				events.onOutput?.(`\n[Malformed child RPC JSON ignored: ${error.message}; line=${line.slice(0, 160)}]\n`);
			},
			onEvent: (event) => {
				if (event.type === "agent_start") events.onStarted?.();
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						outputChars += delta.delta.length;
						events.onOutput?.(delta.delta);
					}
					if (delta?.type === "error") {
						events.onOutput?.(`\n[Child model error: ${delta.errorMessage ?? "unknown error"}]\n`);
					}
				}
				if (event.type === "tool_execution_start") {
					const preview = JSON.stringify(event.args ?? {});
					events.onOutput?.(`\n→ ${event.toolName ?? "tool"} ${preview.length > 300 ? `${preview.slice(0, 300)}…` : preview}\n`);
				}
				if (event.type === "tool_execution_end") {
					const toolText = textFromToolResult(event.result);
					const status = event.isError ? " error" : " result";
					const body = toolText ? `\n${truncateMiddle(toolText, TOOL_RESULT_TEXT_CAP)}` : "";
					events.onOutput?.(`\n← ${event.toolName ?? "tool"}${status}${body}\n`);
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					lastAssistant = event.message;
					lastAssistantText = textFromMessage(event.message);
				}
				if (event.type === "agent_end") {
					sawTerminalResult = true;
					const messages = Array.isArray(event.messages) ? event.messages : [];
					lastAssistant = finalAssistantMessage(messages) ?? lastAssistant;
					lastAssistantText = textFromMessage(lastAssistant) || lastAssistantText;
					const stopReason = lastAssistant?.stopReason;
					const errorMessage = lastAssistant?.errorMessage;
					const status: AgentResult["status"] = stopReason === "aborted" ? "interrupted" : stopReason === "error" ? "failed" : "succeeded";
					const summary = errorMessage || summarizeText(lastAssistantText, 800) || "(no output)";
					events.onResult?.({
						agentId: record.agentId,
						status,
						summary,
						output: lastAssistantText,
						metrics: { outputChars },
					});
				}
			},
		});

		proc.stderr.on("data", (chunk) => {
			stderrTail = appendOutputTail(stderrTail, chunk.toString(), STDERR_TAIL_CAP);
		});
		proc.on("error", (error) => events.onError?.(error instanceof Error ? error : new Error(String(error))));
		proc.on("close", (code, closeSignal) => {
			cleanupTemp(tempPrompt);
			if (!sawTerminalResult && code !== 0) {
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
		await handle.prompt(userPrompt);
		return handle;
	}
}
