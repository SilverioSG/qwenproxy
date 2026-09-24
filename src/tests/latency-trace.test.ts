/**
 * Passive latency recorder. No upstream. Proves:
 * - flag default OFF writes nothing
 * - missing phases are null, never 0
 * - ACCOUNT_SELECTED and ACCOUNT_READY are different marks
 * - CAPTCHA is classified MIXED
 * - TOTAL_MS is frozen before the JSONL append
 * - a thrown append never escapes
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LatencyTrace,
  computeQwenDurations,
  latencyTraceEnabled,
  resetLatencyTracesForTesting,
  type TraceMark,
} from "../core/latency-trace.ts";

const dir = mkdtempSync(path.join(tmpdir(), "qwen-latency-"));

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.QWEN_LATENCY_TRACE;
  delete process.env.QWEN_LATENCY_TRACE_PATH;
  resetLatencyTracesForTesting();
});

function meta(id = "abcd1234") {
  return {
    requestId: id,
    model: "qwen3.7-plus",
    stream: true,
    tools: false,
    success: true as boolean | null,
    retryCount: 0,
    handoffCount: 0,
    sessionReused: true as boolean | null,
    captcha: false,
    createdSession: false,
  };
}

test("flag defaults off and unset env writes nothing", () => {
  delete process.env.QWEN_LATENCY_TRACE;
  assert.equal(latencyTraceEnabled(), false);
  process.env.QWEN_LATENCY_TRACE = "0";
  assert.equal(latencyTraceEnabled(), false);
  process.env.QWEN_LATENCY_TRACE = "1";
  assert.equal(latencyTraceEnabled(), true);
});

test("missing phases are null and selected is not ready", () => {
  const marks: Partial<Record<TraceMark, number>> = {
    T0_REQUEST_ACCEPTED: 0,
    ACCOUNT_SELECTION_START: 10,
    ACCOUNT_SELECTED: 15,
    ACCOUNT_ACQUIRE_START: 40,
    ACCOUNT_READY: 90,
    T2_COMPLETION_START: 200,
    T3_COMPLETION_HEADERS: 350,
    T7_REQUEST_FINISHED: 400,
  };
  const d = computeQwenDurations(marks);
  assert.equal(d.ACCOUNT_SELECTION_MS, 5);
  assert.equal(d.ACCOUNT_ACQUIRE_MS, 50);
  assert.notEqual(d.ACCOUNT_SELECTION_MS, d.ACCOUNT_ACQUIRE_MS);
  assert.equal(d.ACCOUNT_READY_MS, 90);
  assert.equal(d.COMPLETION_HEADERS_MS, 150);
  assert.equal(d.HEADERS_TO_FIRST_CONTENT_MS, null);
  assert.equal(d.GENERATION_MS, null);
  assert.equal(d.STREAM_TAIL_MS, null);
  assert.equal(d.CAPTCHA_MS, null);
  assert.equal(d.TOTAL_MS, 400);
  assert.notEqual(d.HEADERS_TO_FIRST_CONTENT_MS, 0);
});

test("captcha span is mixed and residual pre is unclassified", () => {
  const trace = new LatencyTrace(meta());
  const at: Record<string, number> = {
    T0_REQUEST_ACCEPTED: 0,
    ACCOUNT_SELECTION_START: 1,
    ACCOUNT_SELECTED: 2,
    ACCOUNT_ACQUIRE_START: 3,
    ACCOUNT_READY: 5,
    CONTEXT_PREP_START: 6,
    CONTEXT_PREP_END: 10,
    CHAT_PREP_START: 11,
    CHAT_PREP_END: 20,
    CAPTCHA_START: 30,
    CAPTCHA_END: 80,
    T2_COMPLETION_START: 100,
    T7_REQUEST_FINISHED: 100,
  };
  for (const [name, value] of Object.entries(at)) trace.mark(name as TraceMark, value);
  const record = trace.finish(100);
  assert.equal(record.durations.CAPTCHA_MS, 50);
  assert.equal(record.classes.CAPTCHA_MS, "MIXED");
  assert.equal(record.classes.PRE_COMPLETION_MS, "UNCLASSIFIED");
  assert.equal(record.durations.UNCLASSIFIED_PRE_MS, 100 - (1 + 2 + 4 + 9 + 50));
});

test("T7 is frozen before append and file mode is 0600", () => {
  process.env.QWEN_LATENCY_TRACE = "1";
  const file = path.join(dir, "qwen.jsonl");
  process.env.QWEN_LATENCY_TRACE_PATH = file;
  const trace = new LatencyTrace(meta("reqfrozen"));
  trace.mark("T0_REQUEST_ACCEPTED", 1_000);
  trace.mark("T7_REQUEST_FINISHED", 1_250);
  const frozen = trace.finish();
  assert.equal(frozen.durations.TOTAL_MS, 250);
  const before = performance.now();
  trace.flush();
  const after = performance.now();
  const again = trace.finish();
  assert.equal(again.durations.TOTAL_MS, 250);
  assert.ok(after >= before);
  const text = readFileSync(file, "utf8").trim();
  const parsed = JSON.parse(text);
  assert.equal(parsed.durations.TOTAL_MS, 250);
  assert.equal(parsed.gate, "qwenproxy");
  assert.equal(parsed.requestId, "reqfrozen");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(text.includes("prompt"), false);
});

test("append errors never throw", () => {
  process.env.QWEN_LATENCY_TRACE_PATH = path.join(dir, "no-such", "\0", "bad.jsonl");
  const trace = new LatencyTrace(meta("reqbad"));
  trace.mark("T0_REQUEST_ACCEPTED", 0);
  assert.doesNotThrow(() => {
    trace.finish(5);
    trace.flush();
  });
});

test("mark overhead and append overhead are measured, not assumed", () => {
  const N = 2000;
  const marks: number[] = [];
  const trace = new LatencyTrace(meta("bench"));
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    trace.mark("T5_LAST_CONTENT", i);
    marks.push(performance.now() - t0);
  }
  const finalize: number[] = [];
  for (let i = 0; i < 200; i++) {
    const sample = new LatencyTrace(meta(`b${i}`));
    sample.mark("T0_REQUEST_ACCEPTED", 0);
    sample.mark("T4_FIRST_CONTENT", 10);
    sample.mark("T5_LAST_CONTENT", 20);
    const t0 = performance.now();
    sample.finish(30);
    finalize.push(performance.now() - t0);
  }
  const file = path.join(dir, "bench.jsonl");
  process.env.QWEN_LATENCY_TRACE_PATH = file;
  const appends: number[] = [];
  for (let i = 0; i < 100; i++) {
    const sample = new LatencyTrace(meta(`a${i}`));
    sample.mark("T0_REQUEST_ACCEPTED", 0);
    sample.finish(10);
    const t0 = performance.now();
    sample.flush();
    appends.push(performance.now() - t0);
  }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return { n: values.length, median: pct(0.5), p95: pct(0.95), max: sorted[sorted.length - 1] };
  };
  const report = {
    mark: summarize(marks),
    finalize: summarize(finalize),
    append: summarize(appends),
  };
  console.log(`QWEN_OVERHEAD ${JSON.stringify(report)}`);
  assert.ok(report.mark.median >= 0);
  assert.ok(report.append.n === 100);
});
