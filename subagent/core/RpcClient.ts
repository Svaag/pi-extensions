import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createId } from "./utils.ts";

export type RpcJson = Record<string, any>;

export interface RpcLineHandlers {
	onEvent?: (event: RpcJson) => void;
	onMalformedLine?: (line: string, error: Error) => void;
	onResponse?: (response: RpcJson) => void;
}

export class JsonlParser {
	private readonly decoder = new StringDecoder("utf8");
	private readonly onLine: (line: string) => void;
	private buffer = "";

	constructor(onLine: (line: string) => void) {
		this.onLine = onLine;
	}

	push(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.drainLines();
	}

	end(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) {
			let line = this.buffer;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.buffer = "";
			this.onLine(line);
		}
	}

	private drainLines(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.onLine(line);
		}
	}
}

interface PendingRequest {
	resolve: (value: RpcJson) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export class RpcClient {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly parser: JsonlParser;
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly handlers: RpcLineHandlers;
	private readonly requestTimeoutMs: number;
	private closed = false;

	constructor(
		proc: ChildProcessWithoutNullStreams,
		handlers: RpcLineHandlers = {},
		requestTimeoutMs = 30_000,
	) {
		this.proc = proc;
		this.handlers = handlers;
		this.requestTimeoutMs = requestTimeoutMs;
		this.parser = new JsonlParser((line) => this.handleLine(line));
		proc.stdout.on("data", (chunk) => this.parser.push(chunk));
		proc.stdout.on("end", () => this.parser.end());
		proc.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
		proc.on("close", () => {
			this.closed = true;
			this.rejectAll(new Error("RPC process closed"));
		});
	}

	send(command: RpcJson, timeoutMs = this.requestTimeoutMs): Promise<RpcJson> {
		if (this.closed || !this.proc.stdin.writable) return Promise.reject(new Error("RPC process is not writable"));
		const id = command.id ?? createId("rpc");
		const payload = { ...command, id };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC command ${command.type ?? "unknown"} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(id);
				}
				reject(error);
			});
		});
	}

	closeInput(): void {
		try {
			this.proc.stdin.end();
		} catch {
			// ignore
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: RpcJson;
		try {
			event = JSON.parse(line);
		} catch (error) {
			this.handlers.onMalformedLine?.(line, error instanceof Error ? error : new Error(String(error)));
			return;
		}

		if (event.type === "response" && event.id && this.pending.has(event.id)) {
			const pending = this.pending.get(event.id)!;
			clearTimeout(pending.timeout);
			this.pending.delete(event.id);
			this.handlers.onResponse?.(event);
			if (event.success === false) pending.reject(new Error(event.error ?? `RPC command ${event.command ?? "unknown"} failed`));
			else pending.resolve(event);
			return;
		}

		this.handlers.onEvent?.(event);
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
