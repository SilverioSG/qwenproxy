const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_STALL_MS = 5_000;

interface CaptureTraceState {
  id: string;
  account: string;
  startedAt: number;
  stage: string;
  stageEnteredAt: number;
  interceptCount: number;
  attempt: number;
  captureEnded: boolean;
}

let trace: CaptureTraceState | null = null;
let captureActive = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

function enabled(): boolean {
  return process.env.CAPTURE_PROBE !== "0";
}

function heartbeatIntervalMs(): number {
  const parsed = parseInt(process.env.CAPTURE_PROBE_HEARTBEAT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS;
}

function stallThresholdMs(): number {
  const parsed = parseInt(process.env.CAPTURE_PROBE_STALL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALL_MS;
}

function isoNow(): string {
  return new Date().toISOString();
}

function shortAccount(accountId: string | undefined): string {
  if (!accountId) return "global";
  return accountId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "acct";
}

function newTraceId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function emit(fields: Record<string, string | number>): void {
  if (!enabled() || !trace) return;
  const base: Record<string, string | number> = {
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    account: trace.account,
    ...fields,
  };
  if (fields.intercept_count === undefined) {
    base.intercept_count = trace.interceptCount;
  }
  if (fields.attempt === undefined) {
    base.attempt = trace.attempt;
  }
  const parts = Object.entries(base)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[CAPTURE-PROBE] ${parts}`);
}

export function captureProbeEnabled(): boolean {
  return enabled();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  if (!enabled() || heartbeatTimer || !trace) return;
  const intervalMs = heartbeatIntervalMs();
  const stallMs = stallThresholdMs();
  heartbeatTimer = setInterval(() => {
    if (!trace || !captureActive) return;
    const stageAgeMs = Date.now() - trace.stageEnteredAt;
    emit({
      event: stageAgeMs >= stallMs ? "STALL" : "HEARTBEAT",
      stage: trace.stage,
      stage_age_ms: stageAgeMs,
    });
  }, intervalMs);
  heartbeatTimer.unref();
}

export function beginCaptureTrace(accountId: string | undefined): string {
  if (!enabled()) return "";
  if (trace) {
    stopHeartbeat();
    captureActive = false;
  }
  trace = {
    id: newTraceId(),
    account: shortAccount(accountId),
    startedAt: Date.now(),
    stage: "recovery_returned",
    stageEnteredAt: Date.now(),
    interceptCount: 0,
    attempt: 0,
    captureEnded: false,
  };
  return trace.id;
}

export function currentCaptureTraceId(): string | null {
  if (!trace || trace.captureEnded) return null;
  return trace.id;
}

export function endCaptureTrace(traceId: string, reason: string): void {
  if (!enabled() || !trace || trace.id !== traceId) return;
  stopHeartbeat();
  captureActive = false;
  trace = null;
  void reason;
}

export function captureSetActive(active: boolean): void {
  if (!enabled() || !trace) return;
  captureActive = active;
  if (active) {
    trace.captureEnded = false;
    startHeartbeat();
  } else {
    trace.captureEnded = true;
    stopHeartbeat();
  }
}

export function captureSetAttempt(attempt: number): void {
  if (!enabled() || !trace) return;
  trace.attempt = attempt;
}

export function captureBumpIntercept(): number {
  if (!enabled() || !trace) return 0;
  trace.interceptCount += 1;
  return trace.interceptCount;
}

export function captureStageEnter(
  stage: string,
  fields: Record<string, string | number> = {},
): void {
  if (!enabled() || !trace) return;
  trace.stage = stage;
  trace.stageEnteredAt = Date.now();
  emit({ stage, event: "ENTER", ...fields });
}

export function captureStageExit(
  stage: string,
  fields: Record<string, string | number> = {},
): void {
  if (!enabled() || !trace) return;
  emit({
    stage,
    event: "EXIT",
    duration_ms: Date.now() - trace.stageEnteredAt,
    ...fields,
  });
}

export function captureStageError(
  stage: string,
  errorKind: string,
  fields: Record<string, string | number> = {},
): void {
  if (!enabled() || !trace) return;
  emit({
    stage,
    event: "ERROR",
    duration_ms: Date.now() - trace.stageEnteredAt,
    error: errorKind,
    ...fields,
  });
}

export function capturePoint(
  stage: string,
  fields: Record<string, string | number> = {},
): void {
  if (!enabled() || !trace) return;
  emit({ stage, event: "EXIT", duration_ms: 0, ...fields });
}

export async function withCaptureStage<T>(
  stage: string,
  fn: () => Promise<T>,
  fields: Record<string, string | number> = {},
): Promise<T> {
  if (!enabled() || !trace) return fn();
  captureStageEnter(stage, fields);
  try {
    const result = await fn();
    captureStageExit(stage);
    return result;
  } catch (error) {
    captureStageError(stage, error instanceof Error ? error.name : "Error");
    throw error;
  }
}
