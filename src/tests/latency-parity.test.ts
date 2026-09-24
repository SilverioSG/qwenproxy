/**
 * Output parity of the existing delta emitter with the latency flag off and on.
 * No upstream and no second reader. The emitter is the same shape as
 * writeDeltaEvent: first real text marks FIRST, later text updates LAST.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginLatencyTrace,
  endLatencyTrace,
  markLatency,
  noteLatency,
  resetLatencyTracesForTesting,
} from "../core/latency-trace.ts";

const dir = mkdtempSync(path.join(tmpdir(), "qwen-parity-"));

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.QWEN_LATENCY_TRACE;
  delete process.env.QWEN_LATENCY_TRACE_PATH;
  resetLatencyTracesForTesting();
});

interface Delta {
  content?: string;
  reasoning_content?: string;
}

function emit(deltas: Delta[], flag: "0" | "1", reqId: string) {
  process.env.QWEN_LATENCY_TRACE = flag;
  process.env.QWEN_LATENCY_TRACE_PATH = path.join(dir, `${reqId}.jsonl`);
  beginLatencyTrace({
    requestId: reqId,
    model: "qwen3.7-plus",
    stream: true,
    tools: false,
    success: null,
    retryCount: 0,
    handoffCount: 0,
    sessionReused: true,
    captcha: false,
    createdSession: false,
  })?.mark("T0_REQUEST_ACCEPTED");
  markLatency(reqId, "T3_COMPLETION_HEADERS");
  const chunks: string[] = [];
  const head = `data: ${JSON.stringify({
    choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }],
  })}\n\n`;
  chunks.push(head);
  for (const delta of deltas) {
    const real = Boolean(delta.content || delta.reasoning_content);
    if (real) {
      markLatency(reqId, "T4_FIRST_CONTENT");
      markLatency(reqId, "T5_LAST_CONTENT");
    }
    chunks.push(
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
    );
  }
  chunks.push("data: [DONE]\n\n");
  markLatency(reqId, "T6_DONE");
  noteLatency(reqId, { success: true });
  endLatencyTrace(reqId);
  const encoder = new TextEncoder();
  return {
    chunks,
    bytes: chunks.reduce((sum, chunk) => sum + encoder.encode(chunk).byteLength, 0),
    status: 200,
    toolCalls: 0,
  };
}

test("content stream: ON matches OFF", () => {
  const deltas: Delta[] = [{ content: "hola" }, { content: " mundo" }, { reasoning_content: "pienso" }];
  const off = emit(deltas, "0", "offcontent");
  const on = emit(deltas, "1", "oncontent");
  assert.equal(on.bytes, off.bytes);
  assert.equal(on.chunks.length, off.chunks.length);
  assert.deepEqual(on.chunks, off.chunks);
  assert.equal(on.status, off.status);
  assert.equal(on.toolCalls, off.toolCalls);
  const row = JSON.parse(readFileSync(path.join(dir, "oncontent.jsonl"), "utf8"));
  assert.equal(row.success, true);
  assert.equal(typeof row.durations.GENERATION_MS, "number");
  assert.equal(row.tools, false);
});

test("empty stream: no content marks, bytes still match", () => {
  const off = emit([], "0", "offempty");
  const on = emit([], "1", "onempty");
  assert.deepEqual(on.chunks, off.chunks);
  assert.equal(on.bytes, off.bytes);
  const row = JSON.parse(readFileSync(path.join(dir, "onempty.jsonl"), "utf8"));
  assert.equal(row.durations.HEADERS_TO_FIRST_CONTENT_MS, null);
  assert.equal(row.durations.GENERATION_MS, null);
});

test("abort before headers and error after headers", () => {
  process.env.QWEN_LATENCY_TRACE = "1";
  process.env.QWEN_LATENCY_TRACE_PATH = path.join(dir, "abort.jsonl");
  beginLatencyTrace({
    requestId: "abortreq",
    model: "qwen3.7-plus",
    stream: true,
    tools: false,
    success: null,
    retryCount: 0,
    handoffCount: 0,
    sessionReused: null,
    captcha: false,
    createdSession: false,
  })?.mark("T0_REQUEST_ACCEPTED");
  noteLatency("abortreq", { success: false });
  endLatencyTrace("abortreq");
  const abort = JSON.parse(readFileSync(path.join(dir, "abort.jsonl"), "utf8"));
  assert.equal(abort.success, false);
  assert.equal(abort.durations.COMPLETION_HEADERS_MS, null);

  process.env.QWEN_LATENCY_TRACE_PATH = path.join(dir, "after.jsonl");
  beginLatencyTrace({
    requestId: "afterreq",
    model: "qwen3.7-plus",
    stream: true,
    tools: true,
    success: null,
    retryCount: 1,
    handoffCount: 0,
    sessionReused: false,
    captcha: false,
    createdSession: true,
  })?.mark("T0_REQUEST_ACCEPTED");
  markLatency("afterreq", "T2_COMPLETION_START", 5);
  markLatency("afterreq", "T3_COMPLETION_HEADERS", 20);
  noteLatency("afterreq", { success: false });
  endLatencyTrace("afterreq", 30);
  const after = JSON.parse(readFileSync(path.join(dir, "after.jsonl"), "utf8"));
  assert.equal(after.durations.COMPLETION_HEADERS_MS, 15);
  assert.equal(after.durations.HEADERS_TO_FIRST_CONTENT_MS, null);
  assert.equal(after.tools, true);
  assert.equal(after.createdSession, true);
  assert.equal(after.retryCount, 1);
  assert.equal(after.handoffCount, 0);
});
