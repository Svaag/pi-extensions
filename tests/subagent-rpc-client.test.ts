import assert from "node:assert/strict";
import test from "node:test";
import { JsonlParser } from "../subagent/core/RpcClient.ts";

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
