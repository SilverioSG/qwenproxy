/**
 * Passive per-request latency trace (diagnostics only).
 *
 * Flag QWEN_LATENCY_TRACE defaults OFF. While OFF every call returns
 * immediately and nothing is allocated for the request path beyond one env
 * read. Marks never do I/O. The single JSONL append happens AFTER
 * T7_REQUEST_FINISHED has been frozen, so its cost is outside TOTAL_MS.
 *
 * Never store prompts, responses, account ids, emails, cookies or headers.
 * Never feed recordAIRequest / dashboard-stats: the Monitor contract stays
 * exactly as it is.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLAG = "QWEN_LATENCY_TRACE";
const PATH_OVERRIDE = "QWEN_LATENCY_TRACE_PATH";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function latencyTraceEnabled(): boolean {
  const raw = process.env[FLAG];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function latencyTracePath(): string {
  const override = process.env[PATH_OVERRIDE]?.trim();
  if (override) return override;
  return resolve(PROJECT_ROOT, "logs", "qwenproxy-latency.jsonl");
}

/**
 * Common marks. LAST_CONTENT is the only one that keeps updating.
 * Everything else records the first observation.
 */
export const TRACE_MARKS = [
  "T0_REQUEST_ACCEPTED",
  "CONTEXT_PREP_START",
  "CONTEXT_PREP_END",
  "ACCOUNT_SELECTION_START",
  "ACCOUNT_SELECTED",
  "ACCOUNT_ACQUIRE_START",
  "ACCOUNT_READY",
  "CHAT_PREP_START",
  "CHAT_PREP_END",
  "CAPTCHA_START",
  "CAPTCHA_END",
  "T2_COMPLETION_START",
  "T3_COMPLETION_HEADERS",
  "T4_FIRST_CONTENT",
  "T5_LAST_CONTENT",
  "T6_DONE",
  "T7_REQUEST_FINISHED",
] as const;

export type TraceMark = (typeof TRACE_MARKS)[number];

const FIRST_ONLY = new Set<TraceMark>(TRACE_MARKS.filter((name) => name !== "T5_LAST_CONTENT"));

export interface LatencyTraceMeta {
  requestId: string;
  model: string;
  stream: boolean;
  tools: boolean;
  success: boolean | null;
  retryCount: number;
  handoffCount: number;
  sessionReused: boolean | null;
  captcha: boolean;
  createdSession: boolean;
}

export interface LatencyTraceRecord {
  requestId: string;
  gate: "qwenproxy";
  model: string;
  stream: boolean;
  tools: boolean;
  success: boolean | null;
  retryCount: number;
  handoffCount: number;
  sessionReused: boolean | null;
  captcha: boolean;
  createdSession: boolean;
  /** Monotonic ms (performance.now). Missing phases stay absent, never 0. */
  timestamps: Partial<Record<TraceMark, number>>;
  durations: Record<string, number | null>;
  classes: Record<string, "LOCAL" | "UPSTREAM" | "MIXED" | "UNCLASSIFIED">;
}

function span(marks: Partial<Record<TraceMark, number>>, from: TraceMark, to: TraceMark): number | null {
  const a = marks[from];
  const b = marks[to];
  if (a === undefined || b === undefined) return null;
  return b - a;
}

function add(parts: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const part of parts) {
    if (part === null) continue;
    sum += part;
    any = true;
  }
  return any ? sum : null;
}

/**
 * Durations whose two endpoints were both observed. A phase that never ran
 * (no captcha, no new chat, no content) is null — not zero.
 */
export function computeQwenDurations(
  marks: Partial<Record<TraceMark, number>>,
): LatencyTraceRecord["durations"] {
  const accountSelection = span(marks, "ACCOUNT_SELECTION_START", "ACCOUNT_SELECTED");
  const accountAcquire = span(marks, "ACCOUNT_ACQUIRE_START", "ACCOUNT_READY");
  const contextPrep = span(marks, "CONTEXT_PREP_START", "CONTEXT_PREP_END");
  const chatPrep = span(marks, "CHAT_PREP_START", "CHAT_PREP_END");
  const captcha = span(marks, "CAPTCHA_START", "CAPTCHA_END");
  const completionHeaders = span(marks, "T2_COMPLETION_START", "T3_COMPLETION_HEADERS");
  const headersToFirst = span(marks, "T3_COMPLETION_HEADERS", "T4_FIRST_CONTENT");
  const generation = span(marks, "T4_FIRST_CONTENT", "T5_LAST_CONTENT");
  const streamTail = span(marks, "T5_LAST_CONTENT", "T6_DONE");
  const localPost = span(marks, "T6_DONE", "T7_REQUEST_FINISHED");
  const preCompletion = span(marks, "T0_REQUEST_ACCEPTED", "T2_COMPLETION_START");
  const classifiedPre = add([accountSelection, accountAcquire, contextPrep, chatPrep, captcha]);
  const unclassifiedPre =
    preCompletion !== null && classifiedPre !== null ? preCompletion - classifiedPre : null;

  return {
    ACCOUNT_SELECTION_MS: accountSelection,
    ACCOUNT_ACQUIRE_MS: accountAcquire,
    ACCOUNT_READY_MS: span(marks, "T0_REQUEST_ACCEPTED", "ACCOUNT_READY"),
    CONTEXT_PREP_MS: contextPrep,
    CHAT_PREP_MS: chatPrep,
    CAPTCHA_MS: captcha,
    PRE_COMPLETION_MS: preCompletion,
    UNCLASSIFIED_PRE_MS: unclassifiedPre,
    COMPLETION_HEADERS_MS: completionHeaders,
    HEADERS_TO_FIRST_CONTENT_MS: headersToFirst,
    TTFC_COMPLETION_MS: span(marks, "T2_COMPLETION_START", "T4_FIRST_CONTENT"),
    TTFC_TOTAL_MS: span(marks, "T0_REQUEST_ACCEPTED", "T4_FIRST_CONTENT"),
    GENERATION_MS: generation,
    STREAM_TAIL_MS: streamTail,
    LOCAL_POST_MS: localPost,
    TOTAL_MS: span(marks, "T0_REQUEST_ACCEPTED", "T7_REQUEST_FINISHED"),
  };
}

export const QWEN_DURATION_CLASSES: LatencyTraceRecord["classes"] = {
  ACCOUNT_SELECTION_MS: "LOCAL",
  ACCOUNT_ACQUIRE_MS: "LOCAL",
  ACCOUNT_READY_MS: "LOCAL",
  CONTEXT_PREP_MS: "LOCAL",
  CHAT_PREP_MS: "LOCAL",
  CAPTCHA_MS: "MIXED",
  PRE_COMPLETION_MS: "UNCLASSIFIED",
  UNCLASSIFIED_PRE_MS: "UNCLASSIFIED",
  COMPLETION_HEADERS_MS: "MIXED",
  HEADERS_TO_FIRST_CONTENT_MS: "UPSTREAM",
  TTFC_COMPLETION_MS: "MIXED",
  TTFC_TOTAL_MS: "MIXED",
  GENERATION_MS: "UPSTREAM",
  STREAM_TAIL_MS: "MIXED",
  LOCAL_POST_MS: "LOCAL",
  TOTAL_MS: "UNCLASSIFIED",
};

export class LatencyTrace {
  private readonly marks: Partial<Record<TraceMark, number>> = {};
  private frozen: LatencyTraceRecord | null = null;

  constructor(private meta: LatencyTraceMeta) {}

  /** First observation wins, except T5_LAST_CONTENT which tracks the latest. No I/O. */
  mark(name: TraceMark, at: number = performance.now()): void {
    if (this.frozen) return;
    if (FIRST_ONLY.has(name) && this.marks[name] !== undefined) return;
    this.marks[name] = at;
  }

  note(patch: Partial<LatencyTraceMeta>): void {
    if (this.frozen) return;
    this.meta = { ...this.meta, ...patch };
  }

  /**
   * Freeze T7 (if not already marked) and compute durations.
   * Call this BEFORE flush(). flush() must not be inside the measured span.
   */
  finish(at?: number): LatencyTraceRecord {
    if (!this.frozen) {
      if (at !== undefined) this.mark("T7_REQUEST_FINISHED", at);
      else if (this.marks.T7_REQUEST_FINISHED === undefined) this.mark("T7_REQUEST_FINISHED");
      this.frozen = {
        requestId: this.meta.requestId,
        gate: "qwenproxy",
        model: this.meta.model,
        stream: this.meta.stream,
        tools: this.meta.tools,
        success: this.meta.success,
        retryCount: this.meta.retryCount,
        handoffCount: this.meta.handoffCount,
        sessionReused: this.meta.sessionReused,
        captcha: this.meta.captcha,
        createdSession: this.meta.createdSession,
        timestamps: { ...this.marks },
        durations: computeQwenDurations(this.marks),
        classes: QWEN_DURATION_CLASSES,
      };
    }
    return this.frozen;
  }

  /** Append the already-frozen record. Never throws. Cost is outside TOTAL_MS. */
  flush(): void {
    const record = this.frozen ?? this.finish();
    try {
      const path = latencyTracePath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Diagnostics must never break the request path.
    }
  }
}

const active = new Map<string, LatencyTrace>();

export function beginLatencyTrace(meta: LatencyTraceMeta): LatencyTrace | null {
  if (!latencyTraceEnabled()) return null;
  const trace = new LatencyTrace(meta);
  active.set(meta.requestId, trace);
  return trace;
}

export function getLatencyTrace(requestId: string | null | undefined): LatencyTrace | null {
  if (!requestId || !latencyTraceEnabled()) return null;
  return active.get(requestId) ?? null;
}

/** Mark if a trace exists for this request. No-op (and no throw) otherwise. */
export function markLatency(requestId: string | null | undefined, name: TraceMark, at?: number): void {
  try {
    getLatencyTrace(requestId)?.mark(name, at);
  } catch {
    // Diagnostics must never break the request path.
  }
}

export function noteLatency(requestId: string | null | undefined, patch: Partial<LatencyTraceMeta>): void {
  try {
    getLatencyTrace(requestId)?.note(patch);
  } catch {
    // Diagnostics must never break the request path.
  }
}

/**
 * Freeze T7, drop the in-memory span, then append.
 * The append is deliberately outside finish(), so TOTAL_MS excludes it.
 */
export function endLatencyTrace(requestId: string | null | undefined, at?: number): void {
  if (!requestId) return;
  const trace = active.get(requestId);
  if (!trace) return;
  active.delete(requestId);
  try {
    trace.finish(at);
    trace.flush();
  } catch {
    // Diagnostics must never break the request path.
  }
}

/** Test-only: drop every in-flight span. */
export function resetLatencyTracesForTesting(): void {
  active.clear();
}
