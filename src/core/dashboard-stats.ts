/**
 * Dashboard statistics ring (V2).
 *
 * Passive, bounded, in-memory only. No persistence, no business-logic
 * changes: producers call `recordNetworkEvent` / `recordAIRequest` with
 * already-known values; every aggregate below is derived on read.
 *
 * Data window: since process start (exposed as `windowSince` so the UI can
 * label it honestly instead of faking "today / 7 days").
 *
 * Nothing stored here contains prompts, responses, headers, cookies or
 * tokens — error strings are truncated and redacted on ingest.
 */
import { redactLogMessage } from "./logger.ts";

export const DASHBOARD_STATS_VERSION = 2;

/** Max events kept per ring (oldest evicted first). */
export const NETWORK_RING_SIZE = 200;
export const AI_REQUEST_RING_SIZE = 1000;
export const LATENCY_SAMPLES_GLOBAL = 1000;
export const LATENCY_SAMPLES_PER_KEY = 200;
export const RECENT_ERRORS_PER_ACCOUNT = 8;
export const TOP_ERRORS_LIMIT = 10;
export const ERROR_TEXT_MAX = 200;

const bootTime = Date.now();

export interface NetworkEvent {
  id: number;
  timestamp: number;
  requestId: string;
  route: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}

export interface AIRequestRecord {
  id: number;
  timestamp: number;
  /** Short chat-level id (req=........); may differ from the HTTP id. */
  requestId: string;
  /** X-Request-Id of the HTTP request when known (join key for network). */
  httpRequestId: string | null;
  route: string;
  model: string;
  stream: boolean;
  accountId: string | null;
  latencyMs: number;
  success: boolean;
  error: string | null;
  errorReason: string | null;
  retryCount: number;
  attemptedAccounts: number;
}

interface LatencyAccumulator {
  count: number;
  sum: number;
  samples: number[];
}

interface ModelAccumulator {
  requests: number;
  success: number;
  errors: number;
  lastActivity: number;
  latencies: number[];
}

interface AccountAccumulator {
  requests: number;
  success: number;
  errors: number;
  lastActivity: number;
  latencies: number[];
  recentErrors: string[];
}

interface RouteAccumulator {
  requests: number;
  success: number;
  errors: number;
}

let nextId = 1;
const networkRing: NetworkEvent[] = [];
const aiRing: AIRequestRecord[] = [];
const globalLatency: LatencyAccumulator = { count: 0, sum: 0, samples: [] };
const perModel = new Map<string, ModelAccumulator>();
const perAccount = new Map<string, AccountAccumulator>();
const perRoute = new Map<string, RouteAccumulator>();
const errorCounts = new Map<string, number>();

function pushBounded<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) {
    ring.splice(0, ring.length - cap);
  }
}

function pushLatencySample(
  acc: LatencyAccumulator,
  latencyMs: number,
  cap: number,
): void {
  acc.count += 1;
  acc.sum += latencyMs;
  acc.samples.push(latencyMs);
  if (acc.samples.length > cap) {
    acc.samples.splice(0, acc.samples.length - cap);
  }
}

function cleanErrorText(error: string | null | undefined): string | null {
  if (!error) return null;
  const redacted = redactLogMessage(String(error));
  const flat = redacted.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > ERROR_TEXT_MAX
    ? `${flat.substring(0, ERROR_TEXT_MAX)}…`
    : flat;
}

/** QwenGate-compatible percentile definitions. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? null;
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function p95Of(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.95);
}

export function avgOf(count: number, sum: number): number | null {
  if (count <= 0) return null;
  return Math.round(sum / count);
}

export function recordNetworkEvent(event: {
  requestId: string;
  route: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}): NetworkEvent {
  const entry: NetworkEvent = {
    id: nextId++,
    timestamp: Date.now(),
    requestId: event.requestId,
    route: event.route,
    method: event.method,
    path: event.path,
    status: event.status,
    latencyMs: Math.max(0, Math.round(event.latencyMs)),
  };
  pushBounded(networkRing, entry, NETWORK_RING_SIZE);
  return entry;
}

export function recordAIRequest(input: {
  requestId: string;
  httpRequestId?: string | null;
  route: string;
  model: string;
  stream: boolean;
  accountId: string | null;
  latencyMs: number;
  success: boolean;
  error?: string | null;
  errorReason?: string | null;
  retryCount?: number;
  attemptedAccounts?: number;
}): AIRequestRecord {
  const error = cleanErrorText(input.error ?? null);
  const record: AIRequestRecord = {
    id: nextId++,
    timestamp: Date.now(),
    requestId: input.requestId,
    httpRequestId: input.httpRequestId ?? null,
    route: input.route,
    model: input.model,
    stream: input.stream,
    accountId: input.accountId,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    success: input.success,
    error,
    errorReason: input.errorReason ?? null,
    retryCount: input.retryCount ?? 0,
    attemptedAccounts: input.attemptedAccounts ?? 1,
  };
  pushBounded(aiRing, record, AI_REQUEST_RING_SIZE);
  pushLatencySample(globalLatency, record.latencyMs, LATENCY_SAMPLES_GLOBAL);

  let model = perModel.get(record.model);
  if (!model) {
    model = {
      requests: 0,
      success: 0,
      errors: 0,
      lastActivity: 0,
      latencies: [],
    };
    perModel.set(record.model, model);
  }
  model.requests += 1;
  if (record.success) model.success += 1;
  else model.errors += 1;
  model.lastActivity = record.timestamp;
  model.latencies.push(record.latencyMs);
  if (model.latencies.length > LATENCY_SAMPLES_PER_KEY) {
    model.latencies.splice(0, model.latencies.length - LATENCY_SAMPLES_PER_KEY);
  }
  // Samples back median/p95; the exact sum backs the average.
  (model as unknown as { latencySum: number }).latencySum =
    ((model as unknown as { latencySum: number }).latencySum ?? 0) +
    record.latencyMs;

  if (record.accountId) {
    let account = perAccount.get(record.accountId);
    if (!account) {
      account = {
        requests: 0,
        success: 0,
        errors: 0,
        lastActivity: 0,
        latencies: [],
        recentErrors: [],
      };
      perAccount.set(record.accountId, account);
    }
    account.requests += 1;
    if (record.success) account.success += 1;
    else account.errors += 1;
    account.lastActivity = record.timestamp;
    account.latencies.push(record.latencyMs);
    if (account.latencies.length > LATENCY_SAMPLES_PER_KEY) {
      account.latencies.splice(0, account.latencies.length - LATENCY_SAMPLES_PER_KEY);
    }
    (account as unknown as { latencySum: number }).latencySum =
      ((account as unknown as { latencySum: number }).latencySum ?? 0) +
      record.latencyMs;
    if (error && !account.recentErrors.includes(error)) {
      account.recentErrors.unshift(error);
      if (account.recentErrors.length > RECENT_ERRORS_PER_ACCOUNT) {
        account.recentErrors.length = RECENT_ERRORS_PER_ACCOUNT;
      }
    }
  }

  let route = perRoute.get(record.route);
  if (!route) {
    route = { requests: 0, success: 0, errors: 0 };
    perRoute.set(record.route, route);
  }
  route.requests += 1;
  if (record.success) route.success += 1;
  else route.errors += 1;

  if (error) {
    errorCounts.set(error, (errorCounts.get(error) ?? 0) + 1);
  }
  return record;
}

export interface AccountSummary {
  accountId: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastActivity: number;
  recentErrors: string[];
}

export interface ModelSummary {
  model: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  lastActivity: number;
}

export interface RouteSummary {
  route: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
}

function errorRate(errors: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((errors / total) * 10000) / 100;
}

function getLatencySum(holder: unknown, samples: number[]): number {
  const exact = (holder as { latencySum?: number }).latencySum;
  if (typeof exact === "number") return exact;
  return samples.reduce((a, b) => a + b, 0);
}

export function getMonitorSummary(): {
  totals: {
    totalRequests: number;
    totalSuccess: number;
    totalErrors: number;
    overallErrorRate: number;
    overallAvgLatencyMs: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
  };
  modeComparison: {
    streaming: { totalRequests: number; successCount: number; errorCount: number; avgLatencyMs: number | null } | null;
    nonStreaming: { totalRequests: number; successCount: number; errorCount: number; avgLatencyMs: number | null } | null;
  };
  accounts: Array<
    AccountSummary & {
      byMode: {
        streaming: { totalRequests: number } | null;
        nonStreaming: { totalRequests: number } | null;
      };
    }
  >;
  topErrors: Array<{ message: string; count: number }>;
  timeRange: { from: number; to: number } | null;
  totalEntries: number;
} {
  let success = 0;
  let errors = 0;
  let streamCount = 0;
  let streamSuccess = 0;
  let streamSum = 0;
  let nonStreamCount = 0;
  let nonStreamSuccess = 0;
  let nonStreamSum = 0;
  const byAccountMode = new Map<
    string,
    { stream: number; nonStream: number }
  >();
  for (const r of aiRing) {
    if (r.success) success += 1;
    else errors += 1;
    if (r.stream) {
      streamCount += 1;
      if (r.success) streamSuccess += 1;
      streamSum += r.latencyMs;
    } else {
      nonStreamCount += 1;
      if (r.success) nonStreamSuccess += 1;
      nonStreamSum += r.latencyMs;
    }
    if (r.accountId) {
      let m = byAccountMode.get(r.accountId);
      if (!m) {
        m = { stream: 0, nonStream: 0 };
        byAccountMode.set(r.accountId, m);
      }
      if (r.stream) m.stream += 1;
      else m.nonStream += 1;
    }
  }
  const total = aiRing.length;

  const accounts = [...perAccount.entries()].map(([accountId, a]) => {
    const sum = getLatencySum(a, a.latencies);
    const modes = byAccountMode.get(accountId);
    return {
      accountId,
      totalRequests: a.requests,
      successCount: a.success,
      errorCount: a.errors,
      errorRate: errorRate(a.errors, a.requests),
      avgLatencyMs: avgOf(a.requests, sum),
      medianLatencyMs: medianOf(a.latencies),
      p95LatencyMs: p95Of(a.latencies),
      lastActivity: a.lastActivity,
      recentErrors: [...a.recentErrors],
      byMode: {
        streaming: modes && modes.stream > 0 ? { totalRequests: modes.stream } : null,
        nonStreaming:
          modes && modes.nonStream > 0 ? { totalRequests: modes.nonStream } : null,
      },
    };
  });
  accounts.sort((x, y) => y.lastActivity - x.lastActivity);

  const topErrors = [...errorCounts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ERRORS_LIMIT);

  return {
    totals: {
      totalRequests: total,
      totalSuccess: success,
      totalErrors: errors,
      overallErrorRate: errorRate(errors, total),
      overallAvgLatencyMs: avgOf(globalLatency.count, globalLatency.sum),
      medianLatencyMs: medianOf(globalLatency.samples),
      p95LatencyMs: p95Of(globalLatency.samples),
    },
    modeComparison: {
      streaming:
        streamCount > 0
          ? {
              totalRequests: streamCount,
              successCount: streamSuccess,
              errorCount: streamCount - streamSuccess,
              avgLatencyMs: avgOf(streamCount, streamSum),
            }
          : null,
      nonStreaming:
        nonStreamCount > 0
          ? {
              totalRequests: nonStreamCount,
              successCount: nonStreamSuccess,
              errorCount: nonStreamCount - nonStreamSuccess,
              avgLatencyMs: avgOf(nonStreamCount, nonStreamSum),
            }
          : null,
    },
    accounts,
    topErrors,
    timeRange: total > 0 ? { from: aiRing[0].timestamp, to: aiRing[aiRing.length - 1].timestamp } : null,
    totalEntries: total,
  };
}

export function getUsageSummary(): {
  window: { since: number; label: string };
  totals: { totalRequests: number; successCount: number; errorCount: number };
  accounts: AccountSummary[];
  models: ModelSummary[];
  routes: RouteSummary[];
} {
  const accounts: AccountSummary[] = [...perAccount.entries()].map(
    ([accountId, a]) => ({
      accountId,
      totalRequests: a.requests,
      successCount: a.success,
      errorCount: a.errors,
      errorRate: errorRate(a.errors, a.requests),
      avgLatencyMs: avgOf(a.requests, getLatencySum(a, a.latencies)),
      medianLatencyMs: medianOf(a.latencies),
      p95LatencyMs: p95Of(a.latencies),
      lastActivity: a.lastActivity,
      recentErrors: [...a.recentErrors],
    }),
  );
  accounts.sort((x, y) => y.totalRequests - x.totalRequests);

  const models: ModelSummary[] = [...perModel.entries()].map(
    ([model, m]) => ({
      model,
      totalRequests: m.requests,
      successCount: m.success,
      errorCount: m.errors,
      avgLatencyMs: avgOf(m.requests, getLatencySum(m, m.latencies)),
      lastActivity: m.lastActivity,
    }),
  );
  models.sort((x, y) => y.totalRequests - x.totalRequests);

  const routes: RouteSummary[] = [...perRoute.entries()].map(
    ([route, r]) => ({
      route,
      totalRequests: r.requests,
      successCount: r.success,
      errorCount: r.errors,
    }),
  );
  routes.sort((x, y) => y.totalRequests - x.totalRequests);

  let success = 0;
  let errors = 0;
  for (const r of aiRing) {
    if (r.success) success += 1;
    else errors += 1;
  }

  return {
    window: { since: bootTime, label: "since process start (in-memory)" },
    totals: {
      totalRequests: aiRing.length,
      successCount: success,
      errorCount: errors,
    },
    accounts,
    models,
    routes,
  };
}

export function getRecentNetworkEvents(limit = 50): NetworkEvent[] {
  const n = Math.max(1, Math.min(limit, NETWORK_RING_SIZE));
  return networkRing.slice(-n).reverse();
}

export function getRecentAIRequests(limit = 50): AIRequestRecord[] {
  const n = Math.max(1, Math.min(limit, AI_REQUEST_RING_SIZE));
  return aiRing.slice(-n).reverse();
}

/** QwenGate-shaped model health, now backed by real per-model counters. */
export function getModelHealth(): Record<
  string,
  { successCount: number; errorCount: number; lastActivity: number }
> {
  const out: Record<
    string,
    { successCount: number; errorCount: number; lastActivity: number }
  > = {};
  for (const [model, m] of perModel) {
    out[model] = {
      successCount: m.success,
      errorCount: m.errors,
      lastActivity: m.lastActivity,
    };
  }
  return out;
}

export function getStatsSnapshot(): {
  bootTime: number;
  networkEvents: number;
  aiRequests: number;
  models: number;
  accounts: number;
} {
  return {
    bootTime,
    networkEvents: networkRing.length,
    aiRequests: aiRing.length,
    models: perModel.size,
    accounts: perAccount.size,
  };
}

/** Test-only reset (unit tests run in-process against the shared ring). */
export function resetDashboardStatsForTesting(): void {
  networkRing.length = 0;
  aiRing.length = 0;
  globalLatency.count = 0;
  globalLatency.sum = 0;
  globalLatency.samples.length = 0;
  perModel.clear();
  perAccount.clear();
  perRoute.clear();
  errorCounts.clear();
}
