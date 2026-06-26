import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonlParser, RpcClient } from "../subagent/core/RpcClient.ts";

test("JsonlParser handles partial LF-delimited JSON lines", () => {
	const lines: string[] = [];
	const parser = new JsonlParser((line) => lines.push(line));
	parser.push('{"type":"a"');
	parser.push('}\n{"type":"b"}\n');
	assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}']);
});

test("JsonlParser strips CR in CRLF records", () => {
	const lines: string[] = [];
	const parser = new JsonlParser((line) => lines.push(line));
	parser.push("one\r\ntwo\r\n");
	assert.deepEqual(lines, ["one", "two"]);
});

test("JsonlParser flushes final unterminated line", () => {
	const lines: string[] = [];
	const parser = new JsonlParser((line) => lines.push(line));
	parser.push("last");
	parser.end();
	assert.deepEqual(lines, ["last"]);
});

function fakeProcess(): any {
	const proc = new EventEmitter() as any;
	proc.stdin = new PassThrough();
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.exitCode = null;
	proc.killed = false;
	proc.kill = () => {
		proc.killed = true;
		proc.exitCode = 143;
		proc.emit("close", 143, "SIGTERM");
		return true;
	};
	return proc;
}

test("RpcClient resolves successful responses by id", async () => {
	const proc = fakeProcess();
	const client = new RpcClient(proc, {}, 1000);
	let sent = "";
	proc.stdin.on("data", (chunk: Buffer) => {
		sent += chunk.toString();
		const command = JSON.parse(sent.trim());
		proc.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { ok: true } })}\n`);
	});
	const response = await client.send({ type: "get_state" });
	assert.equal(response.success, true);
	assert.deepEqual(response.data, { ok: true });
});

test("RpcClient rejects failed responses", async () => {
	const proc = fakeProcess();
	const client = new RpcClient(proc, {}, 1000);
	proc.stdin.on("data", (chunk: Buffer) => {
		const command = JSON.parse(chunk.toString().trim());
		proc.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "boom" })}\n`);
	});
	await assert.rejects(() => client.send({ type: "set_model" }), /boom/);
});

test("RpcClient reports malformed lines and keeps reading", async () => {
	const proc = fakeProcess();
	const malformed: string[] = [];
	const events: any[] = [];
	new RpcClient(proc, {
		onMalformedLine: (line) => malformed.push(line),
		onEvent: (event) => events.push(event),
	}, 1000);
	proc.stdout.write("not-json\n");
	proc.stdout.write('{"type":"agent_start"}\n');
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(malformed, ["not-json"]);
	assert.deepEqual(events, [{ type: "agent_start" }]);
});
