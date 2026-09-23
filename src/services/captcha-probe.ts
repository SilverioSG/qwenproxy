const enabled = process.env.CAPTCHA_PROBE === "1";
const STALL_THRESHOLD_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 1_000;

interface CaptchaTraceState {
  id: string;
  account: string;
  startedAt: number;
  stage: string;
  stageEnteredAt: number;
}

let trace: CaptchaTraceState | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

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
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[CAPTCHA-PROBE] ${parts}`);
}

export function captchaProbeEnabled(): boolean {
  return enabled;
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  if (!enabled || heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!trace) return;
    const stageAgeMs = Date.now() - trace.stageEnteredAt;
    if (stageAgeMs >= STALL_THRESHOLD_MS) {
      emit({
        ts: isoNow(),
        pid: process.pid,
        trace: trace.id,
        event: "STALL",
        stage: trace.stage,
        stage_age_ms: stageAgeMs,
      });
    } else {
      emit({
        ts: isoNow(),
        pid: process.pid,
        trace: trace.id,
        event: "HEARTBEAT",
        stage: trace.stage,
        stage_age_ms: stageAgeMs,
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

export function beginCaptchaTrace(accountId: string | undefined): void {
  if (!enabled) return;
  if (trace) endCaptchaTrace("superseded");
  trace = {
    id: newTraceId(),
    account: shortAccount(accountId),
    startedAt: Date.now(),
    stage: "recovery",
    stageEnteredAt: Date.now(),
  };
  startHeartbeat();
  emit({
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    stage: "recovery",
    event: "ENTER",
    account: trace.account,
  });
}

export function endCaptchaTrace(reason: string = "done"): void {
  if (!enabled || !trace) return;
  stopHeartbeat();
  emit({
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    stage: "recovery",
    event: "EXIT",
    duration_ms: Date.now() - trace.startedAt,
    reason,
  });
  trace = null;
}

export function captchaStageEnter(stage: string): void {
  if (!enabled || !trace) return;
  trace.stage = stage;
  trace.stageEnteredAt = Date.now();
  emit({
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    stage,
    event: "ENTER",
  });
}

export function captchaStageExit(stage: string): void {
  if (!enabled || !trace) return;
  emit({
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    stage,
    event: "EXIT",
    duration_ms: Date.now() - trace.stageEnteredAt,
  });
}

export function captchaStageError(stage: string, errorKind?: string): void {
  if (!enabled || !trace) return;
  emit({
    ts: isoNow(),
    pid: process.pid,
    trace: trace.id,
    stage,
    event: "ERROR",
    duration_ms: Date.now() - trace.stageEnteredAt,
    error: errorKind ?? "Error",
  });
}

export async function withCaptchaStage<T>(
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled || !trace) return fn();
  captchaStageEnter(stage);
  try {
    const result = await fn();
    captchaStageExit(stage);
    return result;
  } catch (error) {
    captchaStageError(stage, error instanceof Error ? error.name : "Error");
    throw error;
  }
}
