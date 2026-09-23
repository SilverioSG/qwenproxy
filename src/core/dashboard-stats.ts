/**
 * Dashboard statistics ring (V2).
 *
 * Passive, bounded, in-memory only. No persistence, no business-logic
 * changes: producers call `recordNetworkEvent` / `recordAIRequest` with
 * already-known values; every aggregate below is derived on read.
 *
 * Two windows, never mixed:
 * - Monitor (`getMonitorSummary`) reads only `aiRing` (last
 *   AI_REQUEST_RING_SIZE logical AI requests). Avg, median and p95 share
 *   that same population. Restart clears it.
 * - Usage (`getUsageSummary`) reads only process-lifetime Maps incremented
 *   once per logical AI request. Restart clears them. No disk restore.
 *
 * `getModelHealth` stays on the lifetime `perModel` map (not the ring).
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

/** Dimension bucket for null/empty account, model or route. Not a real id. */
export const UNKNOWN_DIMENSION = "unknown";

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

interface LifetimeBucket {
  requests: number;
  success: number;
  errors: number;
  lastActivity: number;
  latencySum: number;
  latencyCount: number;
  /** Usage percentiles only. Capped at LATENCY_SAMPLES_PER_KEY. */
  latencies: number[];
  recentErrors?: string[];
}

interface RouteAccumulator {
  requests: number;
  success: number;
  errors: number;
}

let nextId = 1;
const networkRing: NetworkEvent[] = [];
const aiRing: AIRequestRecord[] = [];
const perModel = new Map<string, LifetimeBucket>();
const perAccount = new Map<string, LifetimeBucket>();
const perRoute = new Map<string, RouteAccumulator>();
/** Lifetime account × model. Both keys pass through normalizeDimension. */
const perAccountModel = new Map<string, Map<string, LifetimeBucket>>();
const errorCounts = new Map<string, number>();

export function normalizeDimension(value: string | null | undefined): string {
  if (typeof value !== "string") return UNKNOWN_DIMENSION;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : UNKNOWN_DIMENSION;
}

function pushBounded<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) {
    ring.splice(0, ring.length - cap);
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

function emptyLifetime(): LifetimeBucket {
  return {
    requests: 0,
    success: 0,
    errors: 0,
    lastActivity: 0,
    latencySum: 0,
    latencyCount: 0,
    latencies: [],
  };
}

function touchLifetime(
  bucket: LifetimeBucket,
  success: boolean,
  latencyMs: number,
  timestamp: number,
): void {
  bucket.requests += 1;
  if (success) bucket.success += 1;
  else bucket.errors += 1;
  bucket.lastActivity = timestamp;
  if (Number.isFinite(latencyMs)) {
    bucket.latencySum += latencyMs;
    bucket.latencyCount += 1;
    bucket.latencies.push(latencyMs);
    if (bucket.latencies.length > LATENCY_SAMPLES_PER_KEY) {
      bucket.latencies.splice(0, bucket.latencies.length - LATENCY_SAMPLES_PER_KEY);
    }
  }
}

function getOrCreateLifetime(map: Map<string, LifetimeBucket>, key: string): LifetimeBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyLifetime();
    map.set(key, bucket);
  }
  return bucket;
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

  const accountKey = normalizeDimension(record.accountId);
  const modelKey = normalizeDimension(record.model);
  const routeKey = normalizeDimension(record.route);

  const model = getOrCreateLifetime(perModel, modelKey);
  touchLifetime(model, record.success, record.latencyMs, record.timestamp);

  const account = getOrCreateLifetime(perAccount, accountKey);
  if (!account.recentErrors) account.recentErrors = [];
  touchLifetime(account, record.success, record.latencyMs, record.timestamp);
  if (error && !account.recentErrors.includes(error)) {
    account.recentErrors.unshift(error);
    if (account.recentErrors.length > RECENT_ERRORS_PER_ACCOUNT) {
      account.recentErrors.length = RECENT_ERRORS_PER_ACCOUNT;
    }
  }

  let modelsForAccount = perAccountModel.get(accountKey);
  if (!modelsForAccount) {
    modelsForAccount = new Map();
    perAccountModel.set(accountKey, modelsForAccount);
  }
  const accountModel = getOrCreateLifetime(modelsForAccount, modelKey);
  touchLifetime(accountModel, record.success, record.latencyMs, record.timestamp);

  let route = perRoute.get(routeKey);
  if (!route) {
    route = { requests: 0, success: 0, errors: 0 };
    perRoute.set(routeKey, route);
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

interface RingAccountBucket {
  requests: number;
  success: number;
  errors: number;
  stream: number;
  nonStream: number;
  latencySum: number;
  latencyCount: number;
  latencies: number[];
  recentErrors: string[];
  lastActivity: number;
}

function emptyRingAccount(): RingAccountBucket {
  return {
    requests: 0,
    success: 0,
    errors: 0,
    stream: 0,
    nonStream: 0,
    latencySum: 0,
    latencyCount: 0,
    latencies: [],
    recentErrors: [],
    lastActivity: 0,
  };
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
        streaming: { totalRequests: number };
        nonStreaming: { totalRequests: number };
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
  let streamLatencyCount = 0;
  let nonStreamCount = 0;
  let nonStreamSuccess = 0;
  let nonStreamSum = 0;
  let nonStreamLatencyCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const ringLatencies: number[] = [];
  const ringErrors = new Map<string, number>();
  const ringAccounts = new Map<string, RingAccountBucket>();
  for (const r of aiRing) {
    if (r.success) success += 1;
    else errors += 1;
    const hasLatency = Number.isFinite(r.latencyMs);
    if (hasLatency) {
      latencySum += r.latencyMs;
      latencyCount += 1;
      ringLatencies.push(r.latencyMs);
    }
    if (r.stream) {
      streamCount += 1;
      if (r.success) streamSuccess += 1;
      if (hasLatency) {
        streamSum += r.latencyMs;
        streamLatencyCount += 1;
      }
    } else {
      nonStreamCount += 1;
      if (r.success) nonStreamSuccess += 1;
      if (hasLatency) {
        nonStreamSum += r.latencyMs;
        nonStreamLatencyCount += 1;
      }
    }
    const accountKey = normalizeDimension(r.accountId);
    let bucket = ringAccounts.get(accountKey);
    if (!bucket) {
      bucket = emptyRingAccount();
      ringAccounts.set(accountKey, bucket);
    }
    bucket.requests += 1;
    if (r.success) bucket.success += 1;
    else bucket.errors += 1;
    if (r.stream) bucket.stream += 1;
    else bucket.nonStream += 1;
    if (hasLatency) {
      bucket.latencySum += r.latencyMs;
      bucket.latencyCount += 1;
      bucket.latencies.push(r.latencyMs);
    }
    bucket.lastActivity = r.timestamp;
    if (r.error && !bucket.recentErrors.includes(r.error)) {
      bucket.recentErrors.unshift(r.error);
      if (bucket.recentErrors.length > RECENT_ERRORS_PER_ACCOUNT) {
        bucket.recentErrors.length = RECENT_ERRORS_PER_ACCOUNT;
      }
    }
    if (r.error) {
      ringErrors.set(r.error, (ringErrors.get(r.error) ?? 0) + 1);
    }
  }
  const total = aiRing.length;

  const accounts = [...ringAccounts.entries()].map(([accountId, a]) => ({
    accountId,
    totalRequests: a.requests,
    successCount: a.success,
    errorCount: a.errors,
    errorRate: errorRate(a.errors, a.requests),
    avgLatencyMs: avgOf(a.latencyCount, a.latencySum),
    medianLatencyMs: medianOf(a.latencies),
    p95LatencyMs: p95Of(a.latencies),
    lastActivity: a.lastActivity,
    recentErrors: [...a.recentErrors],
    byMode: {
      streaming: { totalRequests: a.stream },
      nonStreaming: { totalRequests: a.nonStream },
    },
  }));
  accounts.sort((x, y) => y.lastActivity - x.lastActivity);

  const topErrors = [...ringErrors.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ERRORS_LIMIT);

  return {
    totals: {
      totalRequests: total,
      totalSuccess: success,
      totalErrors: errors,
      overallErrorRate: errorRate(errors, total),
      overallAvgLatencyMs: avgOf(latencyCount, latencySum),
      medianLatencyMs: medianOf(ringLatencies),
      p95LatencyMs: p95Of(ringLatencies),
    },
    modeComparison: {
      streaming:
        total > 0
          ? {
              totalRequests: streamCount,
              successCount: streamSuccess,
              errorCount: streamCount - streamSuccess,
              avgLatencyMs: avgOf(streamLatencyCount, streamSum),
            }
          : null,
      nonStreaming:
        total > 0
          ? {
              totalRequests: nonStreamCount,
              successCount: nonStreamSuccess,
              errorCount: nonStreamCount - nonStreamSuccess,
              avgLatencyMs: avgOf(nonStreamLatencyCount, nonStreamSum),
            }
          : null,
    },
    accounts,
    topErrors,
    timeRange: total > 0 ? { from: aiRing[0].timestamp, to: aiRing[aiRing.length - 1].timestamp } : null,
    totalEntries: total,
  };
}

export interface AccountModelCount {
  model: string;
  requests: number;
  successCount: number;
  errorCount: number;
}

export function getUsageSummary(): {
  window: { since: number; label: string; kind: "process-lifetime" };
  totals: { totalRequests: number; successCount: number; errorCount: number };
  accounts: Array<AccountSummary & { perModel: AccountModelCount[] }>;
  models: ModelSummary[];
  routes: RouteSummary[];
} {
  const accounts = [...perAccount.entries()].map(([accountId, a]) => {
    const perModelRows: AccountModelCount[] = [
      ...(perAccountModel.get(accountId)?.entries() ?? []),
    ].map(([model, m]) => ({
      model,
      requests: m.requests,
      successCount: m.success,
      errorCount: m.errors,
    }));
    perModelRows.sort((x, y) => y.requests - x.requests);
    return {
      accountId,
      totalRequests: a.requests,
      successCount: a.success,
      errorCount: a.errors,
      errorRate: errorRate(a.errors, a.requests),
      avgLatencyMs: avgOf(a.latencyCount, a.latencySum),
      medianLatencyMs: medianOf(a.latencies),
      p95LatencyMs: p95Of(a.latencies),
      lastActivity: a.lastActivity,
      recentErrors: [...(a.recentErrors ?? [])],
      perModel: perModelRows,
    };
  });
  accounts.sort((x, y) => y.totalRequests - x.totalRequests);

  const models: ModelSummary[] = [...perModel.entries()].map(
    ([model, m]) => ({
      model,
      totalRequests: m.requests,
      successCount: m.success,
      errorCount: m.errors,
      avgLatencyMs: avgOf(m.latencyCount, m.latencySum),
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

  let totalRequests = 0;
  let success = 0;
  let errors = 0;
  for (const a of perAccount.values()) {
    totalRequests += a.requests;
    success += a.success;
    errors += a.errors;
  }

  return {
    window: {
      since: bootTime,
      label: "since process start (in-memory)",
      kind: "process-lifetime",
    },
    totals: {
      totalRequests,
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

/**
 * Lifetime per-model counters since process start (not the Monitor ring).
 * Empty until the first logical AI request of this process.
 */
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
  perModel.clear();
  perAccount.clear();
  perAccountModel.clear();
  perRoute.clear();
  errorCounts.clear();
}
