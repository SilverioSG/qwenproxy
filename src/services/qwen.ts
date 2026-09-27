import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  getQwenHeaders,
  getBasicHeaders,
  isAuthMockEnabled,
  isTokenExpiringSoon,
} from "./auth-playwright.ts";
import { v4 as uuidv4 } from "uuid";
import {
  UpstreamRateLimit,
  ClientAbortedError,
} from "../core/errors.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { qwenOrigin, qwenUrl } from "./qwen-url.ts";
import { config, type ChatMode, isLocalChatMode } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type {
  PersonalizationEstimationInfo,
  TokenEstimationContext,
} from "./token-estimation-metrics.ts";
import { getDatabase } from "../core/database.ts";
import { mapClientModelToQwen } from "../core/model-alias.ts";
import {
  MAX_PAYLOAD_SIZE,
  replaceModelMetadata,
  syncModelMetadata,
} from "../core/model-registry.ts";
import { type Page, type BrowserContext } from "patchright";
import { withAccountPage, assertAntiBotHeaders, onBrowserContextCreated, onPlaywrightAccountDeath, closePlaywrightForAccount, getPlaywrightAccountPresence, isPlaywrightInitializing } from "./playwright.ts";
import { recoverBaxiaCaptcha } from "./captcha-coordinator.ts";
import { markLatency, noteLatency } from "../core/latency-trace.ts";
import { startBaxiaCaptchaWatcher } from "./captcha-solver.ts";
import {
  beginCaptureTrace,
  capturePoint,
  captureStageEnter,
  captureStageError,
  captureStageExit,
  endCaptureTrace,
} from "./capture-probe.ts";
import { isAccountBusy } from "../core/account-concurrency.ts";

// Re-exported from extracted modules for backward compatibility
export {
  isRetryableFetchErrorMessage,
  RetryableQwenStreamError,
  PersonalizationSyncError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  QwenUpstreamUnavailableError,
  QwenNetworkError,
  getQwenErrorCode,
} from "./qwen-errors.ts";
export {
  setToolCapNotice,
  consumeToolCapNotice,
  flushLogicalThreadState,
  getLogicalThreadState,
  updateLogicalThreadState,
  updateLogicalThreadParent,
  updateSessionParent,
  invalidateLogicalThreadParent,
  clearAllSessionsForAccount,
  removeSessionByChatId,
  isChatSessionActive,
  getSessionParent,
} from "./qwen-thread-state.ts";
export type { LogicalThreadEntry } from "./qwen-thread-state.ts";
export {
  buildChatNewBody,
  isReusableUnusedChatTitle,
  releaseWarmChat,
  acquireNewQwenChatSession,
  warmQwenChatPool,
} from "./qwen-chat-pool.ts";

import {
  isRetryableFetchErrorMessage,
  RetryableQwenStreamError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  QwenUpstreamUnavailableError,
  QwenNetworkError,
} from "./qwen-errors.ts";
import {
  clearAllSessionsForAccount,
  removeSessionByChatId,
  isChatSessionActive,
  getSessionParent,
  updateSessionParent,
} from "./qwen-thread-state.ts";
import {
  acquireNewQwenChatSession,
  releaseWarmChat,
} from "./qwen-chat-pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSER_STREAM_BINDING = "__qwenProxyStreamEvent";
const BROWSER_ABORTERS_KEY = "__qwenProxyAborters";
// Steady-state bridge batching. The first chunk always flushes immediately
// (see the !firstChunkSent bypass in the in-page reader), so these only govern
// mid-stream latency: 4KB/25ms held tokens behind a buffer the client writer
// (8KB/3ms) would have flushed anyway. 512B/8ms matches ~2-3 SSE events per CDP
// hop — invisible to the WAF (bytes-per-hop is not a signal) and strictly
// faster for the client.
const BROWSER_STREAM_FLUSH_BYTES = 512;
const BROWSER_STREAM_FLUSH_MS = 8;
const METADATA_TIMEOUT_PER_PAYLOAD_MB_MS = 10_000;
const POST_CAPTCHA_METADATA_GRACE_MS = 20_000;

type BrowserStreamEvent = {
  type: "headers" | "chunk" | "done" | "error";
  status?: number;
  contentType?: string;
  data?: string;
  message?: string;
  errorName?: string;
};

interface BrowserStreamMetadata {
  status: number;
  contentType: string;
}

interface BrowserStreamState {
  chunks: Uint8Array[];
  done: boolean;
  error: Error | null;
  metadata: BrowserStreamMetadata | null;
  waiters: Set<() => void>;
  /** Owning account: lets a renderer/context death fail only its own streams. */
  accountId?: string;
}

const browserStreamStates = new Map<string, BrowserStreamState>();
const browserStreamBindingPages = new WeakSet<object>();
const browserStreamBindingContexts = new WeakSet<object>();

export async function registerBrowserContextStreamBinding(
  context: BrowserContext,
): Promise<void> {
  if (browserStreamBindingContexts.has(context)) return;
  browserStreamBindingContexts.add(context);
  try {
    await context.exposeFunction(
      BROWSER_STREAM_BINDING,
      (requestId: string, event: BrowserStreamEvent) => {
        handleBrowserStreamEvent(requestId, event);
      },
    );
  } catch (error) {
    logger.warn("[Qwen] Failed to register stream binding on context", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

onBrowserContextCreated((context) => {
  void registerBrowserContextStreamBinding(context);
});

/**
 * Diagnostic request id for the completion currently being created on this
 * async turn. Set only by acquireUpstreamStream; read by captcha/header marks.
 * AsyncLocalStorage keeps concurrent requests apart. Never read by routing.
 */
const latencyRequestStore = new AsyncLocalStorage<string>();
function latencyRequestId(): string | undefined {
  return latencyRequestStore.getStore();
}
export function runWithLatencyRequest<T>(requestId: string | undefined, fn: () => T): T {
  if (!requestId) return fn();
  return latencyRequestStore.run(requestId, fn);
}

/**
 * Fail every parked browser stream owned by a dead account (renderer crash,
 * context close, shared-browser disconnect). Marks error+done and wakes
 * waiters so waitForBrowserStreamMetadata / ReadableStream pull reject
 * promptly; pull/cancel cleanup then releases the stream slot, lease and
 * registry entry. Scoped by accountId: other accounts' streams are untouched.
 * Exported for tests.
 */
export function failBrowserStreamsForAccount(
  accountId: string,
  message = "Browser context closed during stream",
): void {
  for (const state of browserStreamStates.values()) {
    if (state.accountId !== accountId || state.done) continue;
    state.error =
      state.error ?? new QwenNetworkError(`${message} (account=${accountId})`);
    state.done = true;
    wakeBrowserStreamState(state);
  }
}

onPlaywrightAccountDeath((accountId) => {
  failBrowserStreamsForAccount(accountId);
});

/**
 * Test-only: register a parked browser stream state without a live browser,
 * so the renderer-crash wake path can be exercised deterministically.
 * Returns a promise that resolves when the state is woken (same mechanism
 * ReadableStream pull / waitForBrowserStreamMetadata park on).
 */
export function __registerBrowserStreamStateForTests(
  requestId: string,
  accountId: string,
): { waitForWake: Promise<void> } {
  const state: BrowserStreamState = {
    chunks: [],
    done: false,
    error: null,
    metadata: null,
    waiters: new Set(),
    accountId,
  };
  browserStreamStates.set(requestId, state);
  const waitForWake = new Promise<void>((resolve) => {
    state.waiters.add(resolve);
  });
  return { waitForWake };
}

/** Test-only: inspect a registered browser stream state. */
export function __getBrowserStreamStateForTests(
  requestId: string,
): BrowserStreamState | undefined {
  return browserStreamStates.get(requestId);
}

/** Test-only: drop all registered browser stream states. */
export function __resetBrowserStreamStatesForTests(): void {
  browserStreamStates.clear();
}

function wakeBrowserStreamState(state: BrowserStreamState): void {
  const waiters = Array.from(state.waiters);
  state.waiters.clear();
  for (const wake of waiters) wake();
}

function handleBrowserStreamEvent(
  requestId: string,
  event: BrowserStreamEvent,
): void {
  const state = browserStreamStates.get(requestId);
  if (!state) return;

  if (event.type === "headers") {
    state.metadata = {
      status: event.status ?? 0,
      contentType: event.contentType ?? "",
    };
  } else if (event.type === "chunk" && typeof event.data === "string") {
    if (event.data.length > 0) {
      state.chunks.push(Buffer.from(event.data, "utf8"));
    }
  } else if (event.type === "done") {
    state.done = true;
  } else if (event.type === "error") {
    state.error = browserStreamError(
      event.message || "Browser Qwen stream failed",
      event.errorName,
    );
    state.done = true;
  }

  wakeBrowserStreamState(state);
}

async function ensureBrowserStreamBinding(page: Page): Promise<void> {
  const context = page.context();
  if (!browserStreamBindingContexts.has(context)) {
    await registerBrowserContextStreamBinding(context);
  }
  if (browserStreamBindingPages.has(page)) return;
  try {
    await page.exposeFunction(
      BROWSER_STREAM_BINDING,
      (requestId: string, event: BrowserStreamEvent) => {
        handleBrowserStreamEvent(requestId, event);
      },
    );
  } catch {
    // If context-level binding is already present, page-level expose may throw or no-op.
  }
  browserStreamBindingPages.add(page);
}

function browserStreamError(message: string, errorName?: string): Error {
  const normalizedMessage = message || "Browser Qwen stream failed";
  if (errorName === "AbortError") {
    const abortError = new DOMException(normalizedMessage, "AbortError");
    return abortError;
  }
  return new QwenNetworkError(normalizedMessage);
}

async function waitForBrowserStreamMetadata(
  requestId: string,
  timeoutMs: number,
): Promise<BrowserStreamMetadata> {
  const state = browserStreamStates.get(requestId);
  if (!state) {
    throw new Error("Browser Qwen stream state was lost before response headers");
  }

  const waitForStateChange = new Promise<void>((resolve) => {
    state.waiters.add(resolve);
    if (state.metadata || state.error || state.done) {
      state.waiters.delete(resolve);
      resolve();
    }
  });

  while (!state.metadata && !state.error && !state.done) {
    await waitForStateChange;
    if (!state.metadata && !state.error && !state.done) {
      return waitForBrowserStreamMetadata(requestId, timeoutMs);
    }
  }

  if (state.metadata) return state.metadata;
  throw state.error ?? new Error(
    `Browser Qwen stream ended before response headers after ${timeoutMs}ms`,
  );
}

/**
 * Idle timeout for an upstream stream, derived from model type, payload size
 * and whether the stream is an auxiliary parallel-escape request.
 *
 * Base: REASONING_MODEL_TIMEOUT when thinking, IDLE_STREAM_TIMEOUT otherwise;
 * +30s per MB of payload.
 *
 * Auxiliary (parallel-escape) streams serve a small request (e.g. a chat
 * title) that generates in seconds; a SHORT cap frees the account slot fast
 * when the upstream never sends the SSE terminal. The tight cap must ONLY
 * apply to NON-thinking models: thinking streams legitimately pause >15s
 * between reasoning chunks, and a 15s cap killed a 564KB full-replay in
 * production (log 2026-08-21, etimedout idle after 15000ms on qwen3.8-max).
 */
export function computeDynamicIdleTimeout(opts: {
  enableThinking: boolean;
  parallelEscape?: boolean;
  baseTimeoutMs: number;
  payloadSize: number;
}): number {
  const payloadMB = opts.payloadSize / (1024 * 1024);
  const dynamic = opts.baseTimeoutMs + Math.ceil(payloadMB * 30_000);
  // The tight 15s cap is ONLY for small auxiliary requests (e.g. title generation).
  // Larger parallel requests (such as Zed/OMP context compaction with big history)
  // need the full dynamic timeout so they do not time out at 15s.
  if (opts.parallelEscape && !opts.enableThinking && opts.payloadSize < 16_384) {
    return Math.min(15_000, dynamic);
  }
  return dynamic;
}

function addIdleTimeoutToStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  onTimeout?: () => void,
  onDone?: () => void,
  /**
   * Stricter deadline for the FIRST chunk only (thinking models idle at
   * REASONING_MODEL_TIMEOUT = 600s by default; a stream that produced NOTHING
   * in that window is almost certainly dead, and holding the account slot for
   * 10 minutes stalls the whole session). After the first chunk the normal
   * idleTimeoutMs governs gaps. Aborts here are retryable (etimedout marker).
   */
  firstChunkDeadlineMs?: number,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let wrapperController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let firstChunkSeen = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const currentIdleMs = () =>
    firstChunkSeen || firstChunkDeadlineMs === undefined
      ? idleTimeoutMs
      : firstChunkDeadlineMs;

  const resetIdleTimer = () => {
    clearIdleTimer();
    const timeoutMs = currentIdleMs();
    idleTimer = setTimeout(() => {
      // The `etimedout` marker lets retry-policy (isNetworkLikeError) treat a
      // stalled upstream as a retryable network failure instead of a terminal
      // 500, so the bridge auto-rotates to another account mid-stream.
      const message = `${label} etimedout (${firstChunkSeen ? "idle" : "first-chunk"} timeout after ${timeoutMs}ms without upstream data)`;
      clearIdleTimer();
      controller.abort();
      onTimeout?.();
      // Best-effort cleanup of the upstream source.
      try {
        void stream.cancel(message).catch(() => {});
      } catch {}
      // Error the WRAPPED stream so the bridge's pending read() rejects
      // immediately. Without this, a page/fetch that ignores abort keeps the
      // read pending forever: the stream slot stays held, later requests queue
      // with timeout=unbounded, and no further timeout can ever fire (the
      // timer is one-shot per pull).
      try {
        wrapperController?.error(new Error(message));
      } catch {}
      // Belt-and-braces: settle a pending read on the wrapper's own reader.
      try {
        void reader?.cancel(message).catch(() => {});
      } catch {}
    }, timeoutMs);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
      resetIdleTimer();
    },
    async pull(streamController) {
      wrapperController = streamController;
      try {
        if (!reader) throw new Error("Stream reader was not initialized");
        const { done, value } = await reader.read();
        if (done) {
          clearIdleTimer();
          onDone?.();
          streamController.close();
          return;
        }
        firstChunkSeen = true;
        resetIdleTimer();
        streamController.enqueue(value);
      } catch (error) {
        clearIdleTimer();
        onDone?.();
        streamController.error(error);
      }
    },
    cancel(reason) {
      clearIdleTimer();
      onDone?.();
      return reader ? reader.cancel(reason) : stream.cancel(reason);
    },
  });
}

export interface QwenMessage {
  id: string | null;
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: string;
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  model: string;
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format?: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  stream_options?: { include_usage: boolean };
  chatId?: string | null;
  chat_id: string | null;
  parentId?: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface PublicQwenModel {
  id: string;
  name: string;
  object: "model";
  owned_by: string;
  created: number;
  context_window?: number;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  info?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  modality?: string[];
  chat_type?: string[];
  think_skip?: Record<string, unknown>;
  is_active?: boolean;
  [key: string]: unknown;
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const modelsCache = new Map<
  string,
  { models: PublicQwenModel[]; fetchedAt: number }
>();

export function getAnyCachedQwenModels(): PublicQwenModel[] | undefined {
  for (const entry of modelsCache.values()) {
    if (entry.models && entry.models.length > 0) {
      return entry.models;
    }
  }
  return undefined;
}
const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();
const lastSyncedPersonalizationHashes = new Map<string, string>();

// Direct-fetch circuit breaker for the personalization settings API. A raw
// Node fetch to chat.qwen.ai can be WAF-blocked (baxia/captcha challenge) in
// some environments; after N consecutive block-like responses we open the
// breaker for that account and route personalization through the browser (the
// guaranteed WAF-safe transport) until the app restarts. This keeps the fast
// direct path primary while never letting a WAF block cost a round-trip on
// every sync.
const directSettingsFetchConsecutiveFailures = new Map<string, number>();
const DIRECT_SETTINGS_FETCH_BLOCK_THRESHOLD = 2;
const directSettingsFetchBlocked = new Set<string>();
const DIRECT_SETTINGS_FETCH_TIMEOUT_MS = 10_000;

const activePersonalizationByAccount = new Map<
  string,
  PersonalizationEstimationInfo
>();

function getPersonalizationHashFromDb(accountId: string): string | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT instruction_hash FROM personalization_cache WHERE account_id = ?",
      )
      .get(accountId) as { instruction_hash: string } | undefined;
    return row?.instruction_hash ?? null;
  } catch {
    return null;
  }
}

function setPersonalizationHashInDb(accountId: string, hash: string): void {
  try {
    const db = getDatabase();
    db.prepare(
      `
      INSERT INTO personalization_cache (account_id, instruction_hash, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET instruction_hash = excluded.instruction_hash, updated_at = excluded.updated_at
    `,
    ).run(accountId, hash);
  } catch (err) {
    console.error(
      `[Qwen] Failed to persist personalization hash for ${accountId}:`,
      (err as Error).message,
    );
  }
}
export function clearPersonalizationDbCache(accountId?: string): number {
  try {
    const db = getDatabase();
    if (accountId) {
      const info = db
        .prepare("DELETE FROM personalization_cache WHERE account_id = ?")
        .run(accountId);
      lastSyncedPersonalizationHashes.delete(accountId);
      activePersonalizationByAccount.delete(accountId);
      return info.changes;
    }
    const info = db.prepare("DELETE FROM personalization_cache").run();
    lastSyncedPersonalizationHashes.clear();
    activePersonalizationByAccount.clear();
    return info.changes;
  } catch {
    return 0;
  }
}

function shortContentHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function shortAccountId(accountId: string): string {
  const normalized = accountId.trim();
  return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
}

function textSize(value: unknown): {
  chars: number | null;
  bytes: number | null;
  hash: string | null;
} {
  if (typeof value !== "string") {
    return { chars: null, bytes: null, hash: null };
  }
  return {
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8"),
    hash: shortContentHash(value),
  };
}

function rememberActivePersonalization(
  accountId: string,
  instruction: string,
  metadata: {
    model?: string;
    toolsCount?: number;
  },
  source: PersonalizationEstimationInfo["source"],
): void {
  const size = textSize(instruction);
  if (size.chars === null || size.bytes === null || !size.hash) return;

  activePersonalizationByAccount.set(accountId, {
    accountId,
    model: metadata.model ?? null,
    toolCount: metadata.toolsCount ?? 0,
    chars: size.chars,
    bytes: size.bytes,
    hash: size.hash,
    estimatedTokens: estimateTokenCount(instruction),
    source,
    updatedAt: Date.now(),
  });
}

function getActivePersonalizationInfo(
  accountId: string,
): PersonalizationEstimationInfo | null {
  return activePersonalizationByAccount.get(accountId) ?? null;
}

export function buildCapturedQwenHeaders(
  headers: Record<string, string>,
  options: {
    chatSessionId?: string | null;
    referer?: string;
    extra?: Record<string, string>;
  } = {},
): Record<string, string> {
  assertAntiBotHeaders(headers, "Qwen request");
  return buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    secChUa: headers["sec-ch-ua"] || undefined,
    secChUaMobile: headers["sec-ch-ua-mobile"] || undefined,
    secChUaPlatform: headers["sec-ch-ua-platform"] || undefined,
    version: headers["version"] || undefined,
    chatSessionId: options.chatSessionId,
    extra: {
      ...(options.referer ? { Referer: options.referer } : {}),
      ...(options.extra || {}),
    },
  });
}


// Per-account stream slots: a counting semaphore capped by
// config.concurrency.maxStreamsPerAccount (NOT a capacity-1 mutex). The browser
// relay multiplexes concurrent streams on one page via reqId (browserStreamStates),
// so serializing to 1 here silently overrode the lease cap and made
// ACCOUNT_MAX_CONCURRENT_STREAMS>1 unreachable (the second stream queued behind
// the first's whole generation). FIFO handoff on release keeps the old
// leak-recovery semantics (release is idempotent; a dropped stream still blocks
// its slot until cancel/idle-timeout frees it — same as before).
interface AccountStreamSlots {
  active: number;
  queue: Array<() => void>;
}
const accountStreamMutexes = new Map<string, AccountStreamSlots>();

function getAccountStreamMutex(
  accountId: string,
): AccountStreamSlots {
  let slots = accountStreamMutexes.get(accountId);
  if (!slots) {
    slots = { active: 0, queue: [] };
    accountStreamMutexes.set(accountId, slots);
  }
  return slots;
}

function streamSlotCapacity(): number {
  return Math.max(1, config.concurrency.maxStreamsPerAccount);
}

function createStreamSlotRelease(slots: AccountStreamSlots): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.active -= 1;
    const next = slots.queue.shift();
    if (next) {
      // Hand the slot directly to the waiter (FIFO), same as the old mutex.
      slots.active += 1;
      next();
    }
  };
}

async function acquireAccountStreamLock(accountId: string): Promise<() => void> {
  const slots = getAccountStreamMutex(accountId);
  if (slots.active < streamSlotCapacity()) {
    slots.active += 1;
    return Promise.resolve(createStreamSlotRelease(slots));
  }
  return new Promise<() => void>((resolve) => {
    slots.queue.push(() => resolve(createStreamSlotRelease(slots)));
  });
}

const QWEN_SAFE_SETTINGS_PATCH = {
  ui: {
    autoTags: false,
    largeTextAsFile: false,
    splitLargeChunks: false,
    title: {
      auto: false,
    },
    notificationEnabled: false,
  },
  mcp_remind: false,
  mcp: {
    "code-interpreter": false,
    "fire-crawl": false,
    amap: false,
    "image-generation": false,
  },
  memory: {
    enable_memory: false,
    enable_history_memory: false,
    memory_version_reminder: false,
  },
  tools_enabled: {
    web_extractor: false,
    web_search_image: false,
    web_search: false,
    image_gen_tool: false,
    code_interpreter: false,
    history_retriever: false,
    image_edit_tool: false,
    bio: false,
    image_zoom_in_tool: false,
    image_search: false,
  },
  extension: {
    show_guide: false,
  },
} as const;

const QWEN_SAFE_SETTINGS_HASH = crypto
  .createHash("sha256")
  .update(JSON.stringify(QWEN_SAFE_SETTINGS_PATCH))
  .digest("hex")
  .slice(0, 12);

export function buildQwenSettingsUpdatePayload(
  currentSettings: any,
  instruction: string,
): Record<string, unknown> {
  const currentPersonalization =
    currentSettings?.personalization &&
    typeof currentSettings.personalization === "object"
      ? currentSettings.personalization
      : {};

  const hasInstruction = instruction.trim().length > 0;

  return {
    personalization: {
      ...currentPersonalization,
      name: "",
      description:
        currentPersonalization.description === undefined
          ? null
          : currentPersonalization.description,
      style: null,
      instruction,
      enable_for_new_chat: hasInstruction,
    },
  };
}

export async function readJsonTextResponse(
  response: Response,
  options: { strict?: boolean } = {},
): Promise<{ raw: string; json: any }> {
  const raw = await response.text();
  if (!raw) {
    return { raw, json: null };
  }

  // Pre-check HTTP status: upstream gateways (like Alibaba GA) returning 502/503/504
  // with an HTML body (e.g. <html><head><title>502 Bad Gateway</title>...) will fail JSON.parse.
  // In strict mode on a non-ok response with non-JSON/HTML, throw an upfront descriptive upstream error
  // rather than a cryptic SyntaxError ("Unexpected token '<'").
  if (!response.ok && (raw.trimStart().startsWith("<") || response.status >= 500)) {
    if (options.strict) {
      const { QwenUpstreamError } = await import("./qwen-errors.ts");
      throw new QwenUpstreamError(
        `Upstream gateway error ${response.status} ${response.statusText}: ${raw.substring(0, 200)}`,
        "UpstreamGatewayError",
        response.status >= 500 ? 502 : response.status,
      );
    }
    return { raw, json: null };
  }

  try {
    return { raw, json: JSON.parse(raw) };
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return { raw, json: null };
  }
}

async function withQwenBrowserPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  targetPath?: string,
  operationTimeoutMs = config.timeouts.page,
  recoverOnTimeout = true,
): Promise<T> {
  // When targetPath is omitted, any page under the Qwen origin can run the
  // in-page evaluate/fetch without an expensive, stream-breaking page.goto.
  // Only navigate when targetPath is explicitly provided or when the page is not
  // on the Qwen origin yet (e.g. about:blank).
  const targetUrl = qwenUrl(targetPath || "/");
  const targetOrigin = new URL(targetUrl).origin;
  const normalizedTargetPath = targetPath
    ? new URL(targetUrl).pathname.replace(/\/+$/, "") || "/"
    : null;

  return withAccountPage(
    accountId,
    async (page) => {
      let currentOrigin = "";
      let currentPath = "";
      try {
        const currentUrl = new URL(page.url());
        currentOrigin = currentUrl.origin;
        currentPath = currentUrl.pathname.replace(/\/+$/, "") || "/";
      } catch {
        // Navigate below when the current page has no usable URL.
      }

      const needsNavigation =
        currentOrigin !== targetOrigin ||
        (normalizedTargetPath !== null && currentPath !== normalizedTargetPath);

      if (needsNavigation) {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(config.timeouts.navigation, operationTimeoutMs),
        });
      }

      return fn(page);
    },
    operationTimeoutMs,
    Math.min(config.timeouts.page, 30_000),
    recoverOnTimeout,
  );
}



/**
 * Build minimal headers for browser-side fetch. The browser automatically
 * adds Cookie, User-Agent, Origin, Referer, and sec-* headers, so we only
 * pass the anti-bot tokens and metadata that the browser cannot infer.
 */
function getBrowserFetchHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const browserAllowedHeaders = new Set([
    "accept",
    "content-type",
    "authorization",
    "bx-ua",
    "bx-umidtoken",
    "bx-v",
    "source",
    "version",
    "timezone",
    "x-request-id",
    "x-accel-buffering",
  ]);

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      browserAllowedHeaders.has(name.toLowerCase()),
    ),
  );
}

interface BrowserTextResponse {
  status: number;
  contentType: string;
  raw: string;
}

/** Sanitized result of the settings A/B auth experiment. No secrets. */
export interface SettingsAuthABResult {
  bearerStatus: number;
  bearerAppAuthFailure: boolean;
  cookieStatus: number;
  cookieAppAuthFailure: boolean;
  liveTokenPresent: boolean;
  cookieCount: number;
  cookieNameHash: string;
  liveTokenStable: boolean | null;
}

/**
 * EXPERIMENTAL DIAGNOSTIC (read-only): compare settings auth with live
 * bearer (A) vs cookie-only (B) on the SAME live page/context, back to
 * back. No heal, no refresh, no login, no DB writes, no cooldown changes.
 * Single attempt each. Inline statements only (__name constraints).
 */
export async function probeSettingsAuthAB(
  accountId: string,
): Promise<SettingsAuthABResult> {
  const { withAccountPage } = await import("./playwright.ts");
  return withAccountPage(
    accountId,
    async (page: Page): Promise<SettingsAuthABResult> => {
      return page.evaluate(async (): Promise<SettingsAuthABResult> => {
        try {
          let liveToken: string | null = null;
          try {
            const t = localStorage.getItem("token");
            liveToken = typeof t === "string" && t.length > 0 ? t : null;
          } catch {
            liveToken = null;
          }
          const base: Record<string, string> = {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            "x-request-id":
              Math.random().toString(36).slice(2) +
              Math.random().toString(36).slice(2),
            source: "web",
          };
          // A: live bearer.
          const headersA: Record<string, string> = { ...base };
          if (liveToken) {
            headersA["authorization"] = "Bearer " + liveToken;
            headersA["Authorization"] = "Bearer " + liveToken;
          }
          const resA = await fetch(
            "https://chat.qwen.ai/api/v2/users/user/settings",
            {
              method: "GET",
              credentials: "include",
              headers: headersA,
              signal: AbortSignal.timeout(20000),
            },
          );
          const textA = await resA.text().catch(() => "");
          let appFailA = false;
          try {
            const p: any = JSON.parse(textA);
            appFailA =
              p &&
              p.success === false &&
              (p.data?.code === "Unauthorized" || p.code === "Unauthorized");
          } catch {
            appFailA = false;
          }
          // B: cookie-only (no Authorization at all).
          const headersB: Record<string, string> = { ...base };
          const resB = await fetch(
            "https://chat.qwen.ai/api/v2/users/user/settings",
            {
              method: "GET",
              credentials: "include",
              headers: headersB,
              signal: AbortSignal.timeout(20000),
            },
          );
          const textB = await resB.text().catch(() => "");
          let appFailB = false;
          try {
            const p2: any = JSON.parse(textB);
            appFailB =
              p2 &&
              p2.success === false &&
              (p2.data?.code === "Unauthorized" || p2.code === "Unauthorized");
          } catch {
            appFailB = false;
          }
          let liveStable: boolean | null = null;
          try {
            const t2 = localStorage.getItem("token");
            const now2 = typeof t2 === "string" && t2.length > 0 ? t2 : null;
            liveStable =
              liveToken !== null && now2 !== null
                ? liveToken === now2
                : null;
          } catch {
            liveStable = null;
          }
          let cookieCount = 0;
          let cookieNameHash = "";
          try {
            const rawParts = document.cookie.split(";");
            const names: string[] = [];
            for (let i = 0; i < rawParts.length; i++) {
              const trimmed = rawParts[i].trim();
              if (!trimmed) continue;
              cookieCount += 1;
              const eq = trimmed.indexOf("=");
              names.push(eq >= 0 ? trimmed.slice(0, eq) : trimmed);
            }
            names.sort();
            let joined = "";
            for (let i = 0; i < names.length; i++) {
              joined += (i > 0 ? ";" : "") + names[i];
            }
            let h1 = 0x811c9dc5;
            for (let i = 0; i < joined.length; i++) {
              h1 ^= joined.charCodeAt(i);
              h1 = Math.imul(h1, 0x01000193);
            }
            cookieNameHash = (h1 >>> 0).toString(16);
          } catch {
            cookieCount = 0;
            cookieNameHash = "";
          }
          return {
            bearerStatus: resA.status,
            bearerAppAuthFailure: appFailA,
            cookieStatus: resB.status,
            cookieAppAuthFailure: appFailB,
            liveTokenPresent: liveToken !== null,
            cookieCount,
            cookieNameHash,
            liveTokenStable: liveStable,
          };
        } catch {
          return {
            bearerStatus: 0,
            bearerAppAuthFailure: false,
            cookieStatus: 0,
            cookieAppAuthFailure: false,
            liveTokenPresent: false,
            cookieCount: 0,
            cookieNameHash: "",
            liveTokenStable: null,
          };
        }
      });
    },
    60_000,
    30_000,
    false,
  );
}

/** Sanitized refresh-endpoint structure. Names/lengths/booleans only. */
export interface RefreshStructureResult {
  httpStatus: number;
  contentType: string;
  topKeys: string[];
  dataKeys: string[];
  nestedKeys: string[];
  appSuccess: boolean;
  appAuthFailure: boolean;
  tokenCandidates: Array<{
    path: string;
    present: boolean;
    valueType: string;
    valueLength: number;
  }>;
  cookiesChanged: boolean;
  cookieCountBefore: number;
  cookieCountAfter: number;
  liveTokenPresentBefore: boolean;
  liveTokenPresentAfter: boolean;
  liveTokenChanged: boolean;
}

/**
 * EXPERIMENTAL DIAGNOSTIC, single controlled refresh execution. Calls the
 * auth refresh endpoint ONCE in-page and reports response STRUCTURE only
 * (key names, value types/lengths, presence booleans). NEVER logs values,
 * tokens, cookies, or bodies. Performs NO writes (no setItem, no cookies,
 * no retry, no login, no DB, no cooldown).
 * Inline statements only (__name constraints).
 */
export async function probeRefreshStructure(
  accountId: string,
): Promise<RefreshStructureResult> {
  const { withAccountPage } = await import("./playwright.ts");
  return withAccountPage(
    accountId,
    async (page: Page): Promise<RefreshStructureResult> => {
      return page.evaluate(async (): Promise<RefreshStructureResult> => {
        const empty: RefreshStructureResult = {
          httpStatus: 0,
          contentType: "",
          topKeys: [],
          dataKeys: [],
          nestedKeys: [],
          appSuccess: false,
          appAuthFailure: false,
          tokenCandidates: [],
          cookiesChanged: false,
          cookieCountBefore: 0,
          cookieCountAfter: 0,
          liveTokenPresentBefore: false,
          liveTokenPresentAfter: false,
          liveTokenChanged: false,
        };
        try {
          let preCookies = "";
          try {
            preCookies = document.cookie || "";
          } catch {
            preCookies = "";
          }
          let preCount = 0;
          try {
            const parts = preCookies.split(";");
            for (let i = 0; i < parts.length; i++) {
              if (parts[i].trim()) preCount += 1;
            }
          } catch {
            preCount = 0;
          }
          empty.cookieCountBefore = preCount;
          let preToken: string | null = null;
          try {
            const t = localStorage.getItem("token");
            preToken = typeof t === "string" && t.length > 0 ? t : null;
          } catch {
            preToken = null;
          }
          empty.liveTokenPresentBefore = preToken !== null;
          let resStatus = 0;
          let resContentType = "";
          let rawText = "";
          try {
            const refreshRes = await fetch(
              "https://auth.qwen.ai/api/v2/auths/refresh",
              {
                method: "GET",
                credentials: "include",
                signal: AbortSignal.timeout(10000),
              },
            );
            resStatus = refreshRes.status;
            try {
              resContentType = refreshRes.headers.get("content-type") || "";
            } catch {
              resContentType = "";
            }
            try {
              rawText = await refreshRes.text();
            } catch {
              rawText = "";
            }
          } catch {
            empty.httpStatus = 0;
            return empty;
          }
          empty.httpStatus = resStatus;
          empty.contentType = resContentType.slice(0, 80);
          let parsed: any = null;
          try {
            parsed = JSON.parse(rawText);
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed === "object") {
            for (const k in parsed) {
              if (Object.prototype.hasOwnProperty.call(parsed, k)) {
                empty.topKeys.push(k);
              }
            }
            if (parsed.success === true) empty.appSuccess = true;
            const code = String(parsed.data?.code || parsed.code || "");
            const details = String(
              parsed.data?.details || parsed.details || parsed.message || "",
            );
            if (
              parsed.success === false &&
              (code === "Unauthorized" ||
                code.toLowerCase().indexOf("unauthorized") >= 0 ||
                details.toLowerCase().indexOf("unauthorized") >= 0 ||
                details.indexOf("401") >= 0)
            ) {
              empty.appAuthFailure = true;
            }
            const data = parsed.data;
            if (data && typeof data === "object") {
              for (const k in data) {
                if (Object.prototype.hasOwnProperty.call(data, k)) {
                  empty.dataKeys.push(k);
                }
              }
              for (const k in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                const v = (data as Record<string, unknown>)[k];
                const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
                let extra = "";
                if (typeof v === "string") extra = " len=" + v.length;
                else if (Array.isArray(v)) extra = " len=" + v.length;
                else if (v && typeof v === "object") {
                  let nk = 0;
                  for (const kk in v as Record<string, unknown>) {
                    if (Object.prototype.hasOwnProperty.call(v, kk)) nk += 1;
                  }
                  extra = " keys=" + nk;
                }
                empty.nestedKeys.push("data." + k + ":" + t + extra);
              }
            }
            const paths = [
              "data.token",
              "data.access_token",
              "data.accessToken",
              "data.id_token",
              "data.idToken",
              "token",
              "access_token",
              "accessToken",
              "data.session",
              "data.ticket",
              "data.refresh_token",
            ];
            for (let i = 0; i < paths.length; i++) {
              const segs = paths[i].split(".");
              let cur: unknown = parsed;
              let ok = true;
              for (let s = 0; s < segs.length; s++) {
                if (cur && typeof cur === "object" && segs[s] in (cur as Record<string, unknown>)) {
                  cur = (cur as Record<string, unknown>)[segs[s]];
                } else {
                  ok = false;
                  break;
                }
              }
              empty.tokenCandidates.push({
                path: paths[i],
                present: ok,
                valueType: ok ? (cur === null ? "null" : Array.isArray(cur) ? "array" : typeof cur) : "absent",
                valueLength:
                  ok && typeof cur === "string"
                    ? cur.length
                    : ok && Array.isArray(cur)
                      ? cur.length
                      : 0,
              });
            }
          }
          try {
            const postCookies = document.cookie || "";
            let postCount = 0;
            try {
              const parts = postCookies.split(";");
              for (let i = 0; i < parts.length; i++) {
                if (parts[i].trim()) postCount += 1;
              }
            } catch {
              postCount = 0;
            }
            empty.cookieCountAfter = postCount;
            empty.cookiesChanged = postCount !== preCount;
          } catch {
            empty.cookieCountAfter = preCount;
            empty.cookiesChanged = false;
          }
          try {
            const t2 = localStorage.getItem("token");
            const now2 = typeof t2 === "string" && t2.length > 0 ? t2 : null;
            empty.liveTokenPresentAfter = now2 !== null;
            empty.liveTokenChanged =
              (preToken === null) !== (now2 === null) ||
              (preToken !== null && now2 !== null && preToken !== now2);
          } catch {
            empty.liveTokenPresentAfter = empty.liveTokenPresentBefore;
            empty.liveTokenChanged = false;
          }
          return empty;
        } catch {
          return empty;
        }
      });
    },
    60_000,
    30_000,
    false,
  );
}
/** Sanitized shape of a chats/new response. Structure only, never values. */
export interface ChatResponseShape {
  topKeys: string[];
  dataType: string;
  dataKeys: string[];
  nestedKeys: string[];
  arrayLengths: string[];
  successPresent: boolean;
  successValue: boolean | null;
  codePresent: boolean;
  codeLen: number;
  chatIdCandidates: string[];
}
export interface ShapingHeaderResult {
  name: string;
  status: number;
  appAuthFailure: boolean;
}

/** Sanitized shaping-probe outcome. No secrets, no bodies. */
export interface ChatShapingResult {
  baseline: { status: number; appAuthFailure: boolean; created: boolean };
  baselineShape: ChatResponseShape | null;
  stoppedEarly: boolean;
  headerTests: ShapingHeaderResult[];
  causalHeader: string | null;
  groupTests: Array<{ group: string; status: number; appAuthFailure: boolean }>;
  causalGroup: string | null;
  preCreate: { status: number; appAuthFailure: boolean };
  settingsUpdate: { status: number; appAuthFailure: boolean };
  postCreate: { status: number; appAuthFailure: boolean };
  loginOk: boolean;
}

/**
 * EXPERIMENTAL DIAGNOSTIC: isolate which pipeline request shaping turns a
 * valid session into appUnauthorized/401. Same live page/context throughout:
 * fresh loginViaApi first, then baseline minimal create-chat, then single
 * headers added one by one (stop at first failure), then group tests, then
 * settings/update pre/post create-chat comparison. No re-auth, no refresh,
 * no cooldown/DB changes, no rotation, no context recreation.
 * In-page code uses inline statements only (__name constraints).
 */
export async function probeChatShaping(
  accountId: string,
): Promise<ChatShapingResult> {
  const { withAccountPage, getCachedQwenHeaders } = await import("./playwright.ts");
  const { probeLoginOnce } = await import("./playwright.ts");
  const login = await probeLoginOnce(accountId);
  const failResult: ChatShapingResult = {
    baseline: { status: 0, appAuthFailure: false, created: false },
    baselineShape: null,
    stoppedEarly: true,
    headerTests: [],
    causalHeader: null,
    groupTests: [],
    causalGroup: null,
    preCreate: { status: 0, appAuthFailure: false },
    settingsUpdate: { status: 0, appAuthFailure: false },
    postCreate: { status: 0, appAuthFailure: false },
    loginOk: login.loginOk,
  };
  if (!login.loginOk) return failResult;
  const cached = getCachedQwenHeaders(accountId) || {};
  const { qwenUrl } = await import("./qwen-url.ts");
  const referer = qwenUrl("/");
  const baseEntries: Array<{ name: string; value: string }> = [
    { name: "accept", value: "application/json, text/plain, */*" },
    { name: "content-type", value: "application/json" },
    { name: "source", value: "web" },
  ];
  const baseNames = new Set(baseEntries.map((e) => e.name));
  const singleNames = [
    "Version",
    "Timezone",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "bx-v",
    "bx-ua",
    "bx-umidtoken",
  ];
  const tests: Array<{
    name: string;
    headers: Array<{ name: string; value: string }>;
  }> = [{ name: "baseline-minimal", headers: baseEntries.map((e) => ({ ...e })) }];
  const pickCached = (name: string): string | null => {
    for (const k of Object.keys(cached)) {
      if (k.toLowerCase() === name.toLowerCase()) {
        const v = cached[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
    }
    return null;
  };
  for (const hname of singleNames) {
    if (hname === "Referer") continue;
    const v = pickCached(hname);
    if (v === null) continue;
    tests.push({
      name: `+${hname}`,
      headers: [...baseEntries.map((e) => ({ ...e })), { name: hname, value: v }],
    });
  }
  // Referer variant goes through the fetch referrer option, not a header.
  tests.push({ name: "+Referer", headers: baseEntries.map((e) => ({ ...e })), referer: true } as unknown as {
    name: string;
    headers: Array<{ name: string; value: string }>;
  });
  const groupOf = (names: string[]): Array<{ name: string; value: string }> | null => {
    const out: Array<{ name: string; value: string }> = baseEntries.map((e) => ({ ...e }));
    for (const hname of names) {
      const v = pickCached(hname);
      if (v === null) return null;
      out.push({ name: hname, value: v });
    }
    return out;
  };
  const groups: Array<{ group: string; headers: Array<{ name: string; value: string }> }> = [];
  const gh = groupOf(["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
  if (gh) groups.push({ group: "client-hints", headers: gh });
  const ab: Array<{ name: string; value: string }> = baseEntries.map((e) => ({ ...e }));
  let abAny = false;
  for (const hname of ["bx-v", "bx-ua", "bx-umidtoken"]) {
    const v = pickCached(hname);
    if (v !== null) {
      ab.push({ name: hname, value: v });
      abAny = true;
    }
  }
  if (abAny) groups.push({ group: "antibot", headers: ab });
  const spa = groupOf(["Version", "Timezone"]);
  if (spa) groups.push({ group: "spa-headers", headers: spa });
  groups.push({
    group: "full-pipeline",
    headers: [...baseEntries.map((e) => ({ ...e }))].concat(
      Object.keys(cached)
        .filter((k) => {
          const l = k.toLowerCase();
          return (
            !baseNames.has(l) &&
            l !== "cookie" &&
            l !== "authorization" &&
            l !== "user-agent"
          );
        })
        .map((k) => ({ name: k, value: cached[k] })),
    ),
  });
  try {
    console.log(
      `[Shaping] account=${accountId.slice(0, 8)} loginOk=true baseline-next singles=${tests.length - 1} groups=${groups.length}`,
    );
  } catch {
    // Diagnostics must never break the probe.
  }
  const shaping = await withAccountPage(
    accountId,
    async (page: Page): Promise<ChatShapingResult> => {
      return page.evaluate(
        async (args: {
          tests: Array<{
            name: string;
            headers: Array<{ name: string; value: string }>;
            referer?: boolean;
          }>;
          groups: Array<{
            group: string;
            headers: Array<{ name: string; value: string }>;
          }>;
          referer: string;
          createUrl: string;
          settingsUrl: string;
          updateUrl: string;
        }): Promise<ChatShapingResult> => {
          const result: ChatShapingResult = {
            baseline: { status: 0, appAuthFailure: false, created: false },
    baselineShape: null,
            stoppedEarly: true,
            headerTests: [],
            causalHeader: null,
            groupTests: [],
            causalGroup: null,
            preCreate: { status: 0, appAuthFailure: false },
            settingsUpdate: { status: 0, appAuthFailure: false },
            postCreate: { status: 0, appAuthFailure: false },
            loginOk: true,
          };
          const newBody = JSON.stringify({
            chatId: "",
            models: ["qwen3.8-max"],
            project_id: "",
            timestamp: Date.now(),
          });
          for (let ti = 0; ti < args.tests.length; ti++) {
            const t = args.tests[ti];
            const hh: Record<string, string> = {};
            for (let hi = 0; hi < t.headers.length; hi++) {
              hh[t.headers[hi].name] = t.headers[hi].value;
            }
            let status = 0;
            let appFail = false;
            let created = false;
            let shape: ChatResponseShape | null = null;
            try {
              const fetchInit: RequestInit = {
                method: "POST",
                credentials: "include",
                headers: hh,
                body: newBody,
                signal: AbortSignal.timeout(25000),
              };
              if (t.referer) {
                (fetchInit as Record<string, unknown>)["referrer"] = args.referer;
              }
              const resp = await fetch(args.createUrl, fetchInit);
              status = resp.status;
              const text = await resp.text().catch(() => "");
              try {
                const j: any = JSON.parse(text);
                if (j && typeof j === "object") {
                  created = Boolean(
                    j.chat_id || j.id || j.data?.chat_id || j.data?.id || j.data?.chat?.id,
                  );
                  appFail =
                    j.success === false &&
                    (j.data?.code === "Unauthorized" ||
                      j.code === "Unauthorized");
                  if (ti === 0) {
                    // Sanitized shape recording, inline (no helpers: __name).
                    const topKeys: string[] = [];
                    for (const k in j) {
                      if (Object.prototype.hasOwnProperty.call(j, k)) {
                        topKeys.push(k);
                      }
                    }
                    const dv = j.data;
                    const dataType =
                      dv === null ? "null" : Array.isArray(dv) ? "array" : typeof dv;
                    const dataKeys: string[] = [];
                    const nestedKeys: string[] = [];
                    const arrayLengths: string[] = [];
                    if (dv && typeof dv === "object" && !Array.isArray(dv)) {
                      for (const k in dv) {
                        if (!Object.prototype.hasOwnProperty.call(dv, k)) continue;
                        dataKeys.push(k);
                        const vv = (dv as Record<string, unknown>)[k];
                        const vt =
                          vv === null ? "null" : Array.isArray(vv) ? "array" : typeof vv;
                        if (Array.isArray(vv)) {
                          arrayLengths.push(k + "=" + vv.length);
                        } else if (vv && typeof vv === "object") {
                          let nk = 0;
                          for (const kk in vv as Record<string, unknown>) {
                            if (Object.prototype.hasOwnProperty.call(vv, kk)) nk += 1;
                          }
                          nestedKeys.push(k + "{keys=" + nk + "}");
                        } else {
                          nestedKeys.push(k + ":" + vt);
                        }
                      }
                    } else if (Array.isArray(dv)) {
                      arrayLengths.push("data=" + dv.length);
                    }
                    const found: string[] = [];
                    const cands = [
                      "chat_id",
                      "id",
                      "data.chat_id",
                      "data.id",
                      "data.chat.id",
                    ];
                    for (let ci = 0; ci < cands.length; ci++) {
                      const segs = cands[ci].split(".");
                      let cur: unknown = j;
                      let okk = true;
                      for (let s = 0; s < segs.length; s++) {
                        if (
                          cur &&
                          typeof cur === "object" &&
                          segs[s] in (cur as Record<string, unknown>)
                        ) {
                          cur = (cur as Record<string, unknown>)[segs[s]];
                        } else {
                          okk = false;
                          break;
                        }
                      }
                      if (okk && typeof cur === "string" && cur.length > 0) {
                        found.push(cands[ci]);
                      }
                    }
                    let codePresent = false;
                    let codeLen = 0;
                    try {
                      const codeV = j.data?.code ?? j.code;
                      if (typeof codeV === "string") {
                        codePresent = true;
                        codeLen = codeV.length;
                      }
                    } catch {
                      codePresent = false;
                    }
                    shape = {
                      topKeys,
                      dataType,
                      dataKeys,
                      nestedKeys,
                      arrayLengths,
                      successPresent: "success" in j,
                      successValue: j.success === true ? true : j.success === false ? false : null,
                      codePresent,
                      codeLen,
                      chatIdCandidates: found,
                    };
                  }
                }
              } catch {
                appFail = false;
              }
            } catch {
              status = 0;
              appFail = false;
            }
            if (ti === 0) {
              result.baseline = { status, appAuthFailure: appFail, created };
              result.baselineShape = shape;
              result.preCreate = { status, appAuthFailure: appFail };
              // created/chat_id is INFORMATIONAL ONLY: HTTP 2xx without app
              // failure continues the matrix regardless of response shape.
              if (status !== 200 || appFail) {
                result.stoppedEarly = true;
                return result;
              }
              result.stoppedEarly = false;
            } else {
              result.headerTests.push({ name: t.name, status, appAuthFailure: appFail });
              if (status === 401 || appFail) {
                result.causalHeader = t.name;
                result.stoppedEarly = true;
                return result;
              }
            }
          }
          for (let gi = 0; gi < args.groups.length; gi++) {
            const g = args.groups[gi];
            const ghh: Record<string, string> = {};
            for (let hi = 0; hi < g.headers.length; hi++) {
              ghh[g.headers[hi].name] = g.headers[hi].value;
            }
            let status = 0;
            let appFail = false;
            try {
              const resp = await fetch(args.createUrl, {
                method: "POST",
                credentials: "include",
                headers: ghh,
                body: newBody,
                signal: AbortSignal.timeout(25000),
              });
              status = resp.status;
              const text = await resp.text().catch(() => "");
              try {
                const j: any = JSON.parse(text);
                appFail =
                  !!j &&
                  j.success === false &&
                  (j.data?.code === "Unauthorized" || j.code === "Unauthorized");
              } catch {
                appFail = false;
              }
            } catch {
              status = 0;
              appFail = false;
            }
            result.groupTests.push({ group: g.group, status, appAuthFailure: appFail });
            if (status === 401 || appFail) {
              result.causalGroup = g.group;
              result.stoppedEarly = true;
              return result;
            }
          }
          // settings/update phase with real echoed instruction shape.
          let current: any = null;
          try {
            const getRes = await fetch(args.settingsUrl, {
              method: "GET",
              credentials: "include",
              headers: {
                accept: "application/json, text/plain, */*",
                source: "web",
              },
              signal: AbortSignal.timeout(20000),
            });
            if (getRes.status === 200) {
              try {
                current = await getRes.json().catch(() => null);
              } catch {
                current = null;
              }
            }
          } catch {
            current = null;
          }
          const curP =
            current && current.data && typeof current.data.personalization === "object"
              ? current.data.personalization
              : {};
          let updStatus = 0;
          let updFail = false;
          try {
            const updBody = JSON.stringify({
              personalization: {
                name: "",
                description: curP.description === undefined ? null : curP.description,
                style: null,
                instruction: "",
                enable_for_new_chat: false,
              },
            });
            const updRes = await fetch(args.updateUrl, {
              method: "POST",
              credentials: "include",
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                source: "web",
              },
              body: updBody,
              signal: AbortSignal.timeout(25000),
            });
            updStatus = updRes.status;
            const updText = await updRes.text().catch(() => "");
            try {
              const uj: any = JSON.parse(updText);
              updFail =
                !!uj &&
                uj.success === false &&
                (uj.data?.code === "Unauthorized" || uj.code === "Unauthorized");
            } catch {
              updFail = false;
            }
          } catch {
            updStatus = 0;
            updFail = false;
          }
          result.settingsUpdate = { status: updStatus, appAuthFailure: updFail };
          let postStatus = 0;
          let postFail = false;
          let postCreated = false;
          try {
            const postRes = await fetch(args.createUrl, {
              method: "POST",
              credentials: "include",
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                source: "web",
              },
              body: newBody,
              signal: AbortSignal.timeout(25000),
            });
            postStatus = postRes.status;
            const postText = await postRes.text().catch(() => "");
            try {
              const pj: any = JSON.parse(postText);
              if (pj && typeof pj === "object") {
                postCreated = Boolean(
                  pj.chat_id || pj.id || pj.data?.chat_id || pj.data?.id || pj.data?.chat?.id,
                );
                postFail =
                  pj.success === false &&
                  (pj.data?.code === "Unauthorized" || pj.code === "Unauthorized");
              }
            } catch {
              postFail = false;
            }
          } catch {
            postStatus = 0;
            postFail = false;
          }
          result.postCreate = { status: postStatus, appAuthFailure: postFail };
          void postCreated;
          return result;
        },
        {
          tests,
          groups,
          referer,
          createUrl: qwenUrl("/api/v2/chats/new"),
          settingsUrl: qwenUrl("/api/v2/users/user/settings"),
          updateUrl: qwenUrl("/api/v2/users/user/settings/update"),
        },
      );
    },
    600_000,
    60_000,
    false,
  );
  const id8 = accountId.slice(0, 8);
  try {
    const b = shaping.baseline;
    console.log(
      `[Shaping] account=${id8} baseline status=${b.status} appFail=${b.appAuthFailure} created=${b.created} stoppedEarly=${shaping.stoppedEarly}`,
    );
    try {
      const sh = shaping.baselineShape;
      if (sh) {
        console.log(
          `[Shaping] account=${id8} shape top=[${sh.topKeys.join(",")}] dataType=${sh.dataType} ` +
            `dataKeys=[${sh.dataKeys.join(",")}] nested=[${sh.nestedKeys.join(",")}] ` +
            `arrays=[${sh.arrayLengths.join(",")}] success=${sh.successPresent}/${sh.successValue} ` +
            `code=${sh.codePresent}/${sh.codeLen} chatIdPaths=[${sh.chatIdCandidates.join(",")}]`,
        );
      }
    } catch {
      // Diagnostics must never break the probe.
    }
    for (const h of shaping.headerTests) {
      console.log(
        `[Shaping] account=${id8} header name=${h.name} status=${h.status} appFail=${h.appAuthFailure}`,
      );
    }
    if (shaping.causalHeader) {
      console.log(`[Shaping] account=${id8} causalHeader=${shaping.causalHeader}`);
    }
    for (const g of shaping.groupTests) {
      console.log(
        `[Shaping] account=${id8} group=${g.group} status=${g.status} appFail=${g.appAuthFailure}`,
      );
    }
    if (shaping.causalGroup) {
      console.log(`[Shaping] account=${id8} causalGroup=${shaping.causalGroup}`);
    }
    console.log(
      `[Shaping] account=${id8} settingsUpdate status=${shaping.settingsUpdate.status} appFail=${shaping.settingsUpdate.appAuthFailure} ` +
        `postCreate status=${shaping.postCreate.status} appFail=${shaping.postCreate.appAuthFailure}`,
    );
  } catch {
    // Diagnostics must never break the probe.
  }
  return shaping;
}
export interface BrowserAuthDiag {
  /** Live localStorage token readable in-page. */
  liveTokenPresent: boolean;
  /** Outgoing bearer vs live token: true/false, or null when incomparable. */
  authMatchesLive: boolean | null;
  /** Which credential won: live token, cookies only, post-heal, or none. */
  authSource: "live" | "cookie-only" | "healed" | "none";
  /** True when this request matched a cookie-only chat route. */
  cookieOnlyRoute: boolean;
  /** Explicit Authorization actually sent on the effective request. */
  explicitAuthPresent: boolean;
  /** First response carried application-level Unauthorized (HTTP 200 body). */
  firstAppAuthFailure: boolean;
  refreshAttempted: boolean;
  refreshStatus: number;
  refreshUsable: boolean;
  refreshUpdatedLs: boolean;
  refreshUpdatedCookie: boolean;
  refreshUpdatedAuth: boolean;
  refreshErrorClass: string | null;
  retried: boolean;
  retryStatus: number;
}

/** Bearer token carried by request headers, if any. Value stays in memory. */
export function extractBearerToken(
  headers: Record<string, string>,
): string | null {
  const raw =
    headers["authorization"] || headers["Authorization"] || "";
  const m = raw.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

/** Compare outgoing bearer with the live in-page token (equality only). */
export function bearerMatchesLiveToken(
  headerBearer: string | null,
  liveToken: string | null,
): boolean | null {
  if (!headerBearer || !liveToken) return null;
  if (headerBearer.length !== liveToken.length) return false;
  let diff = 0;
  for (let i = 0; i < headerBearer.length; i++) {
    diff |= headerBearer.charCodeAt(i) ^ liveToken.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Chat routes that must use cookie/session-centric browser auth: NO explicit
 * Authorization header (mirrors the reference client). Pure and unit-tested;
 * the in-page transport mirrors this predicate inline (bundler __name
 * constraints forbid importing it there) with a consistency test below.
 */
export function isCookieOnlyRoute(url: string): boolean {
  return (
    url.includes("/api/v2/chats/new") ||
    url.includes("/api/v2/users/user/settings")
  );
}

/** Return headers without any Authorization variant (new object). */
export function stripExplicitAuth(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  delete out["authorization"];
  delete out["Authorization"];
  return out;
}

/** Structural usability of an auth-refresh payload (no values inspected). */
export function isUsableRefreshPayload(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const j = json as { success?: unknown; data?: unknown };
  if (j.success !== true) return false;
  const d = j.data as
    | { token?: unknown; access_token?: unknown }
    | null
    | undefined;
  if (!d) return false;
  return (
    (typeof d.access_token === "string" && d.access_token.length > 0) ||
    (typeof d.token === "string" && d.token.length > 0)
  );
}

/**
 * Application-level Unauthorized classification for a completed response.
 * Mirrors the inline in-page predicate in requestQwenTextInBrowser (which
 * cannot import helpers — bundler __name constraints). Pure and unit-tested;
 * a source-consistency test pins the two copies together.
 */
export function isAppUnauthorized(status: number, bodyText: string): boolean {
  if (status === 401) return true;
  if (typeof bodyText !== "string" || bodyText.length === 0) return false;
  try {
    const parsed: {
      success?: unknown;
      code?: unknown;
      message?: unknown;
      data?: { code?: unknown; details?: unknown } | null;
      details?: unknown;
    } = JSON.parse(bodyText);
    if (!parsed || parsed.success !== false) return false;
    const code = String(parsed.data?.code ?? parsed.code ?? "");
    const details = String(
      parsed.data?.details ?? parsed.details ?? parsed.message ?? "",
    );
    return (
      code === "Unauthorized" ||
      /unauthorized/i.test(code) ||
      /unauthorized/i.test(details) ||
      /\b401\b/.test(details)
    );
  } catch {
    return false;
  }
}

/** Sanitized exception class for refresh failures (no messages/values). */
export function sanitizeRefreshErrorClass(err: unknown): string {
  if (err instanceof TypeError) return "TypeError";
  if (err instanceof DOMException) {
    return `DOMException:${err.name || "unknown"}`;
  }
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

export async function requestQwenTextInBrowser(
  accountId: string | undefined,
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: string,
  options: {
    settingsPage?: boolean;
    referrer?: string;
    timeoutMs?: number;
    /**
     * Best-effort operations (e.g. the post-disconnect stop) must not trigger
     * the aggressive stuck-mutex recovery: the mutex is legitimately held by the
     * NEW request that superseded this one, and closing the context / resetting
     * the profile would kill the account for a healthy in-flight generation.
     */
    noMutexRecovery?: boolean;
  } = {},
): Promise<Response> {
  const url = qwenUrl(path);

  // Mock tests intentionally use Node fetch and do not initialize a browser.
  if (isAuthMockEnabled()) {
    return fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  if (!accountId) {
    throw new Error("A Qwen account is required for browser request");
  }

  const browserHeaders = getBrowserFetchHeaders(headers);
  if (
    body !== undefined &&
    !Object.keys(browserHeaders).some(
      (name) => name.toLowerCase() === "content-type",
    )
  ) {
    browserHeaders["Content-Type"] = "application/json";
  }

  const evaluateRequest = (page: Page) =>
    page.evaluate(
      async ({ url, method, headers, body, referrer, timeoutMs }: {
        url: string;
        method: "GET" | "POST" | "DELETE";
        headers: Record<string, string>;
        body?: string;
        referrer?: string;
        timeoutMs: number;
      }): Promise<BrowserTextResponse & { diag: BrowserAuthDiag }> => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        // Read-only observation of the live in-page token (never modifies
        // the request, never leaves the page; only booleans are reported).
        // NOTE: no helper consts/arrow functions in here — the bundler wraps
        // those with __name(), which does not exist in the page context.
        const diag: BrowserAuthDiag = {
          liveTokenPresent: false,
          authMatchesLive: null,
          authSource: "none",
          firstAppAuthFailure: false,
          refreshAttempted: false,
          refreshStatus: 0,
          refreshUsable: false,
          refreshUpdatedLs: false,
          refreshUpdatedCookie: false,
          refreshUpdatedAuth: false,
          refreshErrorClass: null,
          retried: false,
          retryStatus: 0,
          cookieOnlyRoute: false,
          explicitAuthPresent: false,
        };
        try {
          let liveToken: string | null = null;
          try {
            const t = localStorage.getItem("token");
            liveToken = typeof t === "string" && t.length > 0 ? t : null;
          } catch {
            liveToken = null;
          }
          diag.liveTokenPresent = liveToken !== null;
          // Cookie-only routes (chat + chat personalization): reproduce the
          // cookie/session-centric behavior of the reference client — NO
          // explicit Authorization; credentials:include + live browser
          // cookies govern. All other routes keep current behavior.
          const cookieOnlyRoute =
            url.includes("/api/v2/chats/new") ||
            url.includes("/api/v2/users/user/settings");
          diag.cookieOnlyRoute = cookieOnlyRoute;
          const effHeaders: Record<string, string> = { ...headers };
          const hadCachedAuth = Boolean(
            effHeaders["authorization"] || effHeaders["Authorization"],
          );
          if (cookieOnlyRoute) {
            delete effHeaders["authorization"];
            delete effHeaders["Authorization"];
            diag.authSource = hadCachedAuth ? "cookie-only" : "none";
          } else if (liveToken) {
            effHeaders["authorization"] = `Bearer ${liveToken}`;
            effHeaders["Authorization"] = `Bearer ${liveToken}`;
            diag.authSource = "live";
          } else {
            delete effHeaders["authorization"];
            delete effHeaders["Authorization"];
            diag.authSource = hadCachedAuth ? "cookie-only" : "none";
          }
          diag.explicitAuthPresent =
            Boolean(effHeaders["authorization"]) ||
            Boolean(effHeaders["Authorization"]);
          const sentRaw =
            effHeaders["authorization"] || effHeaders["Authorization"] || "";
          const sentMatch = sentRaw.match(/^\s*Bearer\s+(\S+)\s*$/i);
          const sentEff = sentMatch ? sentMatch[1] : null;
          diag.authMatchesLive =
            sentEff && liveToken ? sentEff === liveToken : null;
          let response = await fetch(url, {
            method,
            credentials: "include",
            headers: effHeaders,
            body,
            signal: controller.signal,
            ...(referrer ? { referrer } : {}),
          });
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            bodyText = "";
          }

          // Auth failure = HTTP 401 OR application-level Unauthorized
          // (Qwen answers HTTP 200 + {success:false} on create-chat).
          let appUnauthorized = false;
          try {
            const parsed: any = JSON.parse(bodyText);
            if (parsed && parsed.success === false) {
              const code = String(parsed.data?.code || parsed.code || "");
              const details = String(
                parsed.data?.details || parsed.details || parsed.message || "",
              );
              appUnauthorized =
                code === "Unauthorized" ||
                /unauthorized/i.test(code) ||
                /unauthorized/i.test(details) ||
                /\b401\b/.test(details);
            }
          } catch {
            appUnauthorized = false;
          }
          diag.firstAppAuthFailure = appUnauthorized;

          // Silent in-page token refresh + single retry on auth failure.
          // Mirrors the official SPA: same endpoint/method/credentials PLUS
          // the interceptor headers the web client always sends (Version,
          // source, X-Request-Id, Timezone), and the SPA response contract
          // (success + data.access_token, with data.expires_at).
          if (response.status === 401 || appUnauthorized) {
            diag.refreshAttempted = true;
            try {
              const refreshVersion =
                headers["version"] && headers["version"].length > 0
                  ? headers["version"]
                  : "0.3.11";
              let rid = "";
              try {
                rid =
                  Math.random().toString(36).slice(2) +
                  Math.random().toString(36).slice(2);
              } catch {
                rid = "manual-refresh";
              }
              const refreshRes = await fetch("https://auth.qwen.ai/api/v2/auths/refresh", {
                method: "GET",
                credentials: "include",
                headers: {
                  accept: "application/json, text/plain, */*",
                  Version: refreshVersion,
                  source: "web",
                  "X-Request-Id": rid,
                  Timezone: new Date().toString().split(" (")[0],
                },
                signal: AbortSignal.timeout(10000),
              });
              diag.refreshStatus = refreshRes.status;
              if (refreshRes.status === 200) {
                const refreshJson: any = await refreshRes.json().catch(() => null);
                let freshTok: string | null = null;
                try {
                  const d = refreshJson && refreshJson.data;
                  const cand =
                    d && typeof d.access_token === "string" && d.access_token.length > 0
                      ? d.access_token
                      : d && typeof d.token === "string" && d.token.length > 0
                        ? d.token
                        : null;
                  if (refreshJson && refreshJson.success === true && cand) {
                    freshTok = cand;
                  }
                } catch {
                  freshTok = null;
                }
                const usable = freshTok !== null;
                diag.refreshUsable = usable;
                if (usable) {
                  const tok: string = freshTok as string;
                  localStorage.setItem("token", tok);
                  diag.refreshUpdatedLs = true;
                  document.cookie = `token=${encodeURIComponent(tok)}; path=/; domain=.qwen.ai; max-age=31536000`;
                  diag.refreshUpdatedCookie = true;
                  if (!cookieOnlyRoute) {
                    effHeaders["authorization"] = `Bearer ${freshTok}`;
                    effHeaders["Authorization"] = `Bearer ${freshTok}`;
                    diag.refreshUpdatedAuth = true;
                    diag.authSource = "healed";
                  }
                  response = await fetch(url, {
                    method,
                    credentials: "include",
                    headers: effHeaders,
                    body,
                    signal: controller.signal,
                    ...(referrer ? { referrer } : {}),
                  });
                  diag.retried = true;
                  diag.retryStatus = response.status;
                  try {
                    bodyText = await response.text();
                  } catch {
                    // Keep first body on retry read failure.
                  }
                  try {
                    const t3 = localStorage.getItem("token");
                    const live3 =
                      typeof t3 === "string" && t3.length > 0 ? t3 : null;
                    const sRaw3 =
                      effHeaders["authorization"] ||
                      effHeaders["Authorization"] ||
                      "";
                    const sMatch3 = sRaw3.match(/^\s*Bearer\s+(\S+)\s*$/i);
                    const sent3 = sMatch3 ? sMatch3[1] : null;
                    diag.authMatchesLive =
                      sent3 && live3 ? sent3 === live3 : null;
                  } catch {
                    diag.authMatchesLive = null;
                  }
                }
              }
            } catch (err) {
              diag.refreshErrorClass =
                err instanceof TypeError
                  ? "TypeError"
                  : err instanceof Error
                    ? err.name || "Error"
                    : typeof err;
            }
          }

          return {
            status: response.status,
            contentType: response.headers.get("content-type") || "",
            raw: bodyText,
            diag,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        url,
        method,
        headers: browserHeaders,
        body,
        referrer: options.referrer,
        timeoutMs: options.timeoutMs ?? Math.min(config.timeouts.page, 20_000),
      },
    );
  const recoverOnTimeout = !options.noMutexRecovery;
  // Settings and personalization requests run as same-origin in-browser fetch
  // with appropriate Referer, keeping the page on the stable chat UI without
  // expensive page.goto navigations that can time out under load.
  const response = await withQwenBrowserPage<
    BrowserTextResponse & { diag?: BrowserAuthDiag }
  >(
    accountId,
    evaluateRequest,
    undefined,
    options.timeoutMs,
    recoverOnTimeout,
  );

  // Sanitized per-attempt auth diagnostics (booleans/codes only).
  try {
    const id8 = (accountId || "global").slice(0, 8);
    const hasAuth =
      Boolean(browserHeaders["authorization"]) ||
      Boolean(browserHeaders["Authorization"]);
    const d = response.diag;
    console.log(
      `[QwenAuth] account=${id8} path=${path} attempt=1 ` +
        `authSource=${d ? d.authSource : "unknown"} hasAuth=${hasAuth} ` +
        `explicitAuth=${d ? String(d.explicitAuthPresent) : "unknown"} ` +
        `cookieOnly=${d ? String(d.cookieOnlyRoute) : "unknown"} ` +
        `matchesLive=${d ? String(d.authMatchesLive) : "unknown"} ` +
        `liveToken=${d ? String(d.liveTokenPresent) : "unknown"} ` +
        `status=${response.status}` +
        (d?.firstAppAuthFailure ? " appUnauthorized=true" : ""),
    );
    if (d?.refreshAttempted) {
      console.log(
        `[QwenAuth] account=${id8} path=${path} refresh attempted ` +
          `status=${d.refreshStatus} usable=${d.refreshUsable} ` +
          `updatedLs=${d.refreshUpdatedLs} updatedCookie=${d.refreshUpdatedCookie} ` +
          `updatedAuth=${d.refreshUpdatedAuth} ` +
          `retryStatus=${d.retried ? d.retryStatus : "none"}` +
          (d.refreshErrorClass ? ` errClass=${d.refreshErrorClass}` : ""),
      );
      try {
        const { traceSessionEvent } = await import("./session-tracer.ts");
        traceSessionEvent(accountId, "REFRESH_START", `path=${path}`);
        traceSessionEvent(
          accountId,
          "REFRESH_END",
          `status=${d.refreshStatus} usable=${d.refreshUsable} retry=${d.retried ? d.retryStatus : "none"}`,
        );
      } catch {
        // Tracing must never break requests.
      }
    }
  } catch {
    // Diagnostics must never break requests.
  }

  return new Response(response.raw, {
    status: response.status,
    headers: response.contentType
      ? { "content-type": response.contentType }
      : undefined,
  });
}

/**
 * Direct Node fetch of Qwen settings/user APIs using the captured (now
 * anti-hardcoded) headers. This is exactly what the real web client does — a
 * plain fetch against `/api/v2/users/user/settings` on the same origin — and
 * it avoids the flaky `page.evaluate` + settings-page navigation that hung
 * the personalization sync (the 30s sync timeout / "stuck page operation").
 *
 * Returns null (instead of throwing) when the direct path should not be used:
 * the account's circuit breaker is open, a WAF block is detected, or the
 * request errors — in all cases the caller falls back to the browser path.
 */
export async function requestQwenSettingsDirectFetch(
  accountId: string | undefined,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
): Promise<{ status: number; raw: string; json: any } | null> {
  const cacheKey = accountId || "global";
  if (directSettingsFetchBlocked.has(cacheKey)) {
    return null;
  }

  const url = qwenUrl(path);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    DIRECT_SETTINGS_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const contentType =
      response.headers.get("content-type") || "application/json";

    // A WAF/baxia challenge (or proxy error page) is HTML, not the JSON the
    // settings API always returns. If we see one, treat it as a block and let
    // the browser path take over — the browser has the real fingerprint that
    // passes the WAF.
    let json: any = null;
    let okShape = false;
    if (contentType.includes("html") || !response.ok) {
      okShape = false;
    } else {
      try {
        json = JSON.parse(raw);
        okShape = json && typeof json === "object" && json.success === true;
      } catch {
        okShape = false;
      }
    }

    if (!okShape) {
      const failures = (directSettingsFetchConsecutiveFailures.get(cacheKey) ??
        0) + 1;
      if (failures >= DIRECT_SETTINGS_FETCH_BLOCK_THRESHOLD) {
        directSettingsFetchBlocked.add(cacheKey);
        logger.debug(
          "[Qwen] Direct settings fetch WAF-blocked; routing personalization through the browser",
          {
            accountId: cacheKey,
            path,
            consecutiveFailures: failures,
            contentType,
            status: response.status,
          },
        );
      } else {
        directSettingsFetchConsecutiveFailures.set(cacheKey, failures);
      }
      return null;
    }

    directSettingsFetchConsecutiveFailures.delete(cacheKey);
    logger.debug("[Qwen] Direct settings fetch succeeded", {
      accountId: cacheKey,
      path,
      status: response.status,
    });
    return { status: response.status, raw, json };
  } catch (err) {
    // Network error or the bounded timeout — fall back to the browser path.
    logger.debug("[Qwen] Direct settings fetch failed; using browser path", {
      accountId: cacheKey,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestQwenPersonalizationInBrowser(
  accountId: string | undefined,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
): Promise<{ status: number; raw: string; json: any }> {
  // Always route personalization through stealth browser page (user constraint: tudo via browser stealth)
  const response = await requestQwenTextInBrowser(
    accountId,
    method,
    path,
    headers,
    payload === undefined ? undefined : JSON.stringify(payload),
    {
      settingsPage: true,
      referrer: qwenUrl("/settings/personalization"),
    },
  );
  const { raw, json } = await readJsonTextResponse(response);
  return { status: response.status, raw, json };
}

async function cancelQwenBrowserStream(
  accountId: string,
  requestId: string,
): Promise<void> {
  const state = browserStreamStates.get(requestId);
  if (state) {
    state.done = true;
    wakeBrowserStreamState(state);
  }

  try {
    await withQwenBrowserPage(accountId, async (page) => {
      await page.evaluate(
        ({ abortersKey, requestId }: {
          abortersKey: string;
          requestId: string;
        }) => {
          const aborters = (globalThis as unknown as Record<string, unknown>)[
            abortersKey
          ] as Map<string, AbortController> | undefined;
          aborters?.get(requestId)?.abort();
        },
        { abortersKey: BROWSER_ABORTERS_KEY, requestId },
      );
    });
  } catch {
    // The page may already be closing after an abort or timeout.
  } finally {
    browserStreamStates.delete(requestId);
  }
}

async function createQwenBrowserResponse(
  accountId: string | undefined,
  url: string,
  method: "POST",
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  referrer?: string,
  pageOperationTimeoutMs = config.timeouts.page,
): Promise<Response> {
  if (isAuthMockEnabled()) {
    return fetch(url, {
      method,
      headers,
      body,
      signal,
    });
  }

  if (!accountId) {
    throw new Error("A Qwen account is required for browser streaming");
  }
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  const requestId = uuidv4();
  const state: BrowserStreamState = {
    chunks: [],
    done: false,
    error: null,
    metadata: null,
    waiters: new Set(),
    accountId,
  };
  browserStreamStates.set(requestId, state);

  const browserHeaders = getBrowserFetchHeaders(headers);
  if (
    !Object.keys(browserHeaders).some(
      (name) => name.toLowerCase() === "content-type",
    )
  ) {
    browserHeaders["Content-Type"] = "application/json";
  }

  let settled = false;
  let abortListener: (() => void) | undefined;
  let cancelPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (abortListener) signal.removeEventListener("abort", abortListener);
    browserStreamStates.delete(requestId);
  };
  const cancel = () => {
    if (!cancelPromise) {
      cancelPromise = cancelQwenBrowserStream(accountId, requestId);
    }
    cleanup();
    return cancelPromise;
  };

  abortListener = () => {
    void cancel();
  };
  signal.addEventListener("abort", abortListener, { once: true });

  const payloadMbForMetadata = Math.ceil(
    Buffer.byteLength(body, "utf8") / (1024 * 1024),
  );
  // First-byte deadline for the completion fetch: honor TIME_TO_FIRST_BYTE
  // (default 60s) with a 15s floor. A stall past this window is a dead
  // connection / WAF swallow — classified retryable by the caller.
  const metadataTimeoutMs = Math.max(
    5_000,
    Math.min(
      pageOperationTimeoutMs,
      Math.max(15_000, config.timeouts.timeToFirstByte) +
        payloadMbForMetadata * METADATA_TIMEOUT_PER_PAYLOAD_MB_MS,
    ),
  );
  let captchaWatcher: ReturnType<typeof startBaxiaCaptchaWatcher> | undefined;

  try {
    const startOperationTimeoutMs = Math.max(
      5_000,
      Math.min(config.timeouts.navigation, pageOperationTimeoutMs),
    );
    const started = await withQwenBrowserPage(
      accountId,
      async (page) => {
        await ensureBrowserStreamBinding(page);
        if (config.captcha.enabled) {
          captchaWatcher = startBaxiaCaptchaWatcher(
            page,
            metadataTimeoutMs,
            {
              maxAttempts: config.captcha.maxAttempts,
              retryDelayMs: config.captcha.retryDelayMs,
              settleMs: config.captcha.settleMs,
            },
          );
        }
        return page.evaluate(
          ({
            url,
            method,
            headers,
            body,
            referrer,
            requestId,
            bindingName,
            abortersKey,
            flushBytes,
            flushMs,
            timeoutMs,
          }: {
            url: string;
            method: "POST";
            headers: Record<string, string>;
            body: string;
            referrer?: string;
            requestId: string;
            bindingName: string;
            abortersKey: string;
            flushBytes: number;
            flushMs: number;
            timeoutMs: number;
          }) => {
            const globalObject = globalThis as unknown as Record<string, unknown>;
            const notify = globalObject[bindingName] as (
              (id: string, event: BrowserStreamEvent) => Promise<void>
            );
            if (typeof notify !== "function") {
              throw new Error("Qwen browser stream binding is unavailable");
            }

            let aborters = globalObject[abortersKey] as
              | Map<string, AbortController>
              | undefined;
            if (!aborters) {
              aborters = new Map<string, AbortController>();
              globalObject[abortersKey] = aborters;
            }
            const abortController = new AbortController();
            aborters.set(requestId, abortController);
            const timeoutId = setTimeout(
              () => abortController.abort(),
              timeoutMs,
            );

            void (async () => {
              try {
                const response = await fetch(url, {
                  method,
                  credentials: "include",
                  headers,
                  body,
                  signal: abortController.signal,
                  ...(referrer ? { referrer } : {}),
                });
                clearTimeout(timeoutId);

                await notify(requestId, {
                  type: "headers",
                  status: response.status,
                  contentType: response.headers.get("content-type") || "",
                });

                if (!response.body) {
                  await notify(requestId, { type: "done" });
                  return;
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffered = "";
                let lastFlushAt = Date.now();
                let firstChunkSent = false;

                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (!value) continue;

                  buffered += decoder.decode(value, { stream: true });
                  if (
                    !firstChunkSent ||
                    buffered.length >= flushBytes ||
                    Date.now() - lastFlushAt >= flushMs
                  ) {
                    const data = buffered;
                    buffered = "";
                    firstChunkSent = true;
                    lastFlushAt = Date.now();
                    await notify(requestId, { type: "chunk", data });
                  }
                }

                buffered += decoder.decode();
                if (buffered) {
                  const data = buffered;
                  buffered = "";
                  await notify(requestId, { type: "chunk", data });
                }
                await notify(requestId, { type: "done" });
              } catch (error) {
                clearTimeout(timeoutId);
                try {
                  await notify(requestId, {
                    type: "error",
                    message:
                      error instanceof Error ? error.message : String(error),
                    errorName: error instanceof Error ? error.name : undefined,
                  });
                } catch {
                  // Node may have cancelled the stream already.
                }
              } finally {
                aborters?.delete(requestId);
              }
            })();

            // Do not await the upstream fetch here. Returning immediately
            // releases the per-account Playwright mutex while metadata/chunks
            // continue through the exposed binding.
            return true;
          },
          {
            url,
            method,
            headers: browserHeaders,
            body,
            referrer,
            requestId,
            bindingName: BROWSER_STREAM_BINDING,
            abortersKey: BROWSER_ABORTERS_KEY,
            flushBytes: BROWSER_STREAM_FLUSH_BYTES,
            flushMs: BROWSER_STREAM_FLUSH_MS,
            timeoutMs: metadataTimeoutMs,
          },
        );
      },
      undefined,
      startOperationTimeoutMs,
    );

    if (!started) {
      throw new Error("Qwen browser stream failed to start");
    }

    let captchaSolvedDuringMetadata = false;
    let metadataTimer: ReturnType<typeof setTimeout> | undefined;
    const metadataTimeoutPromise = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(
          new Error(
            `Qwen browser stream timed out waiting for response headers after ${metadataTimeoutMs}ms${
              captchaSolvedDuringMetadata
                ? " (captcha solved; original request did not resume)"
                : ""
            }`,
          ),
        );
      metadataTimer = setTimeout(fail, metadataTimeoutMs);
      metadataTimer.unref?.();

      // When the watcher solves a challenge while headers have not arrived, the
      // original background fetch often remains stalled. Give it a short grace
      // window; if nothing arrives, the caller retries with fresh headers.
      if (captchaWatcher) {
        void captchaWatcher.promise
          .then((solved) => {
            if (!solved) return;
            captchaSolvedDuringMetadata = true;
            if (metadataTimer) {
              clearTimeout(metadataTimer);
              metadataTimer = setTimeout(fail, POST_CAPTCHA_METADATA_GRACE_MS);
              metadataTimer.unref?.();
            }
          })
          .catch(() => undefined);
      }
    });

    let metadata: BrowserStreamMetadata;
    try {
      metadata = await Promise.race([
        waitForBrowserStreamMetadata(
          requestId,
          metadataTimeoutMs + POST_CAPTCHA_METADATA_GRACE_MS,
        ),
        metadataTimeoutPromise,
      ]);
      markLatency(latencyRequestId(), "T3_COMPLETION_HEADERS");
    } catch (error) {
      if (
        captchaSolvedDuringMetadata &&
        error instanceof Error &&
        error.message.includes("timed out waiting for response headers")
      ) {
        const retryableError = new Error(error.message);
        (retryableError as any).captchaSolvedDuringMetadata = true;
        throw retryableError;
      }
      throw error;
    } finally {
      if (metadataTimer) clearTimeout(metadataTimer);
    }

    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const current = browserStreamStates.get(requestId);
        if (!current) {
          controller.close();
          return;
        }

        while (current.chunks.length === 0 && !current.done) {
          await new Promise<void>((resolve) => {
            current.waiters.add(resolve);
            if (current.chunks.length > 0 || current.done) {
              current.waiters.delete(resolve);
              resolve();
            }
          });
        }

        if (current.chunks.length > 0) {
          controller.enqueue(current.chunks.shift()!);
          return;
        }

        cleanup();
        if (current.error) {
          controller.error(current.error);
        } else {
          controller.close();
        }
      },
      cancel() {
        return cancel();
      },
    });

    return new Response(stream, {
      status: metadata.status,
      headers: metadata.contentType
        ? { "content-type": metadata.contentType }
        : undefined,
    });
  } catch (error) {
    captchaWatcher?.stop();
    await cancel().catch(() => {});
    throw error;
  } finally {
    captchaWatcher?.stop();
  }
}

export async function syncQwenRequestPersonalization(
  instruction: string,
  accountId?: string,
  metadata: {
    model?: string;
    toolsCount?: number;
    sessionId?: string | null;
    promptChars?: number;
    /** Bypass memory/DB/GET caches and always POST. Used on new chat creation. */
    forceSync?: boolean;
  } = {},
): Promise<boolean> {
  if (isAuthMockEnabled()) {
    // Test hook: force the sync to report "not applied" so the fail-fast
    // contract (personalization-required suite) is exercisable in mock mode.
    if (process.env.TEST_PERSONALIZATION_SYNC_FAIL === "true") return false;
    return true;
  }
  // instruction pode ser vazia para limpar personalization

  const cacheKey = accountId || "global";

  // Proactive token renewal: refresh BEFORE attempting personalization
  // to avoid 401 errors that waste time on retry
  let forceRefresh = false;
  try {
    const basic = await getBasicHeaders(accountId);
    if (isTokenExpiringSoon(basic.cookie, 5)) {
      logger.debug("[Qwen] Token expiring soon, refreshing proactively", {
        accountId: cacheKey,
      });
      forceRefresh = true;
    }
  } catch {
    // If we can't check, let the normal flow handle it
  }

  const { headers } = await getQwenHeaders(forceRefresh, accountId);
  let requestHeaders = buildCapturedQwenHeaders(headers, {
    referer: qwenUrl("/settings/personalization"),
  });
  let currentSettings: any = null;
  let payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);

  const sent = textSize(instruction);
  const syncHash = sent.hash ? `${sent.hash}:${QWEN_SAFE_SETTINGS_HASH}` : null;
  const bypassCache = metadata.forceSync === true;

  // 1. Check memory cache (skipped on forceSync)
  const cachedHash = lastSyncedPersonalizationHashes.get(cacheKey);
  if (!bypassCache && syncHash && cachedHash === syncHash) {
    rememberActivePersonalization(cacheKey, instruction, metadata, "memory");
    // Personalization unchanged - no log needed
    return true;
  }

  // Diagnostic: log when the in-memory hash exists but differs, so we can
  // trace what is destabilising the personalization hash between requests.
  if (!bypassCache && syncHash && cachedHash && cachedHash !== syncHash) {
    logger.debug("[Qwen] personalization cache miss (hash changed)", {
      accountId: cacheKey,
      cachedHash,
      newHash: syncHash,
      model: metadata.model || null,
      tools: metadata.toolsCount ?? 0,
    });
  }

  // 2. Check DB cache (survives restarts) (skipped on forceSync)
  const isEmptyInstruction = instruction.trim().length === 0;

  // 2. Check DB cache (survives restarts) (skipped on forceSync)
  // For empty instructions, do not blindly trust DB cache without verifying
  // because external agents or web sessions might have altered personalization.
  if (!bypassCache && syncHash && !cachedHash && !isEmptyInstruction) {
    const dbHash = getPersonalizationHashFromDb(cacheKey);
    if (dbHash === syncHash) {
      lastSyncedPersonalizationHashes.set(cacheKey, syncHash);
      rememberActivePersonalization(cacheKey, instruction, metadata, "db");
      // Personalization unchanged (DB) - no log needed
      return true;
    }
  }
  let existing = { chars: null, bytes: null, hash: null } as ReturnType<
    typeof textSize
  >;
  // Verifica GET apenas se temos um hash válido (skipped on forceSync)
  if (!bypassCache && syncHash && !cachedHash && config.qwen.personalizationVerifyGet) {
    try {
      const { json: existingJson } =
        await requestQwenPersonalizationInBrowser(
          accountId,
          "GET",
          "/api/v2/users/user/settings",
          requestHeaders,
        );
      currentSettings = existingJson?.data ?? null;
      payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);
      const existingInstruction = existingJson?.data?.personalization?.instruction;
      const existingEnabled = existingJson?.data?.personalization?.enable_for_new_chat === true;
      existing = textSize(existingInstruction);
      const existingSafeSettingsApplied =
        existingJson?.data?.ui?.largeTextAsFile === false &&
        existingJson?.data?.ui?.splitLargeChunks === false &&
        existingJson?.data?.ui?.autoTags === false &&
        existingJson?.data?.ui?.title?.auto === false &&
        existingJson?.data?.mcp_remind === false &&
        existingJson?.data?.memory?.enable_memory === false &&
        existingJson?.data?.memory?.enable_history_memory === false &&
        existingJson?.data?.tools_enabled?.web_search === false &&
        existingJson?.data?.tools_enabled?.code_interpreter === false;
      const isEmptyAndCleared =
        isEmptyInstruction &&
        (!existingInstruction || existingInstruction.trim().length === 0) &&
        !existingEnabled;
      const isContentMatched = existing.hash !== null && existing.hash === sent.hash;
      if ((isContentMatched || isEmptyAndCleared) && existingSafeSettingsApplied) {
        setPersonalizationHashInDb(cacheKey, syncHash);
        rememberActivePersonalization(
          cacheKey,
          instruction,
          metadata,
          "verified",
        );
        // Personalization unchanged (verified) - no log needed
        logger.debug("[Qwen] personalization sync skipped after GET", {
          accountId: cacheKey,
          model: metadata.model || null,
          tools: metadata.toolsCount ?? 0,
          promptChars: metadata.promptChars ?? null,
          sessionId: metadata.sessionId ?? null,
          sent,
          existing,
        });
        return true;
      }
    } catch (err) {
      logger.debug("[Qwen] personalization pre-check failed; updating anyway", {
        accountId: cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Helper: attempt the POST, returns { raw, json } or throws on non-retriable errors
  async function attemptPost(
    headers: Record<string, string>,
  ): Promise<{ raw: string; json: any }> {
    if (!currentSettings) {
      try {
        const { json: settingsJson } =
          await requestQwenPersonalizationInBrowser(
            accountId,
            "GET",
            "/api/v2/users/user/settings",
            headers,
          );
        currentSettings = settingsJson?.data ?? null;
        payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);
      } catch (err) {
        logger.debug(
          "[Qwen] settings GET before update failed; using safe partial payload",
          {
            accountId: cacheKey,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    return requestQwenPersonalizationInBrowser(
      accountId,
      "POST",
      "/api/v2/users/user/settings/update",
      headers,
      payload,
    );
  }

  let raw: string;
  let json: any;

  // Layer 1: First attempt. attemptPost MUST receive the fully-built request
  // headers (Content-Type: application/json, Origin, Referer, source, ...) —
  // the raw getQwenHeaders map lacks Content-Type, and the Qwen API rejects a
  // body POSTed without it with RequestValidationError ("Field '': Input
  // should be a valid dictionary..." — the body is not parsed as a JSON object).
  ({ raw, json } = await attemptPost(requestHeaders));

  // Layer 2: On 401/Unauthorized → refresh session and retry once
  const isUnauthorized =
    json?.success === false &&
    (json?.data?.code === "Unauthorized" ||
      json?.data?.code === "unauthorized" ||
      (typeof json?.data?.details === "string" &&
        json.data.details.includes("401")));

  if (isUnauthorized) {
    console.warn(
      `[Qwen] Personalization 401 — refreshing session with re-auth and retrying | account=${cacheKey}`,
    );
    // First-failure capture BEFORE any recovery: snapshot the live state so
    // the transition (valid -> Unauthorized) is classifiable afterwards.
    try {
      const {
        snapshotForAccount,
        markFirstFailure,
        traceSessionEvent,
      } = await import("./session-tracer.ts");
      const snap = await snapshotForAccount(accountId || "").catch(() => null);
      traceSessionEvent(accountId, "SETTINGS_UPDATE_STATUS", "http=401-or-appFail", snap);
      markFirstFailure(accountId, "SETTINGS_UPDATE_STATUS", snap);
    } catch {
      // Tracing must never break flows.
    }
    try {
      currentSettings = null;
      const { headers: freshHeaders } = await getQwenHeaders(true, accountId, true);
      requestHeaders = buildCapturedQwenHeaders(freshHeaders, {
        referer: qwenUrl("/settings/personalization"),
      });
      ({ raw, json } = await attemptPost(requestHeaders));
    } catch (retryErr) {
      // Layer 3: Retry failed → non-fatal, continue without personalization
      console.warn(
        `[Qwen] Personalization retry failed, continuing without it | account=${cacheKey} | error=${(retryErr as Error).message?.substring(0, 150)}`,
      );
      return false;
    }
  }

  // Layer 3: Check final result — non-fatal on failure
  if (json?.success === false) {
    console.warn(
      `[Qwen] Personalization sync failed (non-fatal) | account=${cacheKey} | response=${raw.slice(0, 200)}`,
    );
    try {
      const { noteUpstreamAuthResult } = await import("./session-tracer.ts");
      noteUpstreamAuthResult(accountId, "settings-update", 200, true);
    } catch {
      // Tracing must never break flows.
    }
    return false;
  }

  const returnedInstruction = json?.data?.personalization?.instruction;
  const returned = textSize(returnedInstruction);
  let stored = { chars: null, bytes: null, hash: null } as ReturnType<
    typeof textSize
  >;

  let verifyData: any = null;
  if (config.qwen.personalizationVerifyGet) {
    const { json: verifyJson } =
      await requestQwenPersonalizationInBrowser(
        accountId,
        "GET",
        "/api/v2/users/user/settings",
        requestHeaders,
      );
    verifyData = verifyJson?.data?.personalization;
    stored = textSize(verifyData?.instruction);
  }

  const matchReturned =
    (isEmptyInstruction && (!returnedInstruction || returned.chars === 0)) ||
    (returned.hash !== null && returned.hash === sent.hash);
  const matchStored =
    stored.hash === null
      ? null
      : (isEmptyInstruction && (!verifyData?.instruction || stored.chars === 0)) ||
        stored.hash === sent.hash;
  const applied = matchReturned || matchStored === true;
  if (syncHash && applied) {
    lastSyncedPersonalizationHashes.set(cacheKey, syncHash);
    setPersonalizationHashInDb(cacheKey, syncHash);
    rememberActivePersonalization(cacheKey, instruction, metadata, "synced");
  }

  if (!applied) {
    logger.warn("[Qwen] personalization response did not confirm the requested instructions", {
      accountId: cacheKey,
      model: metadata.model || null,
      tools: metadata.toolsCount ?? 0,
      sent,
      returned,
      stored,
    });
    return false;
  }

  console.log(
    `✅ [Qwen] Personalization synced | account=${shortAccountId(cacheKey)} | model=${metadata.model || "?"} | tools=${metadata.toolsCount ?? 0} | prompt_chars=${sent.chars ?? 0}${metadata.sessionId ? ` | chat=${metadata.sessionId.substring(0, 12)}` : ""}${matchStored === null ? "" : ` | verified=${matchStored}`}`,
  );
  logger.debug("[Qwen] personalization sync details", {
    accountId: cacheKey,
    model: metadata.model || null,
    tools: metadata.toolsCount ?? 0,
    promptChars: metadata.promptChars ?? null,
    sessionId: metadata.sessionId ?? null,
    sent,
    returned,
    existing,
    stored,
    matchReturned,
    matchStored,
  });
  try {
    const { noteUpstreamAuthResult, snapshotForAccount } = await import("./session-tracer.ts");
    const snap = await snapshotForAccount(accountId || "").catch(() => null);
    noteUpstreamAuthResult(accountId, "settings-update", 200, false, snap);
  } catch {
    // Tracing must never break flows.
  }
  return true;
}

const DISABLE_TOOLS_MAX_RETRIES = 3;
const DISABLE_TOOLS_BACKOFF_MS = 2000;

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || "global";
  if (
    nativeToolsDisabled.has(cacheKey) ||
    disablingNativeToolsInProgress.has(cacheKey)
  ) {
    return;
  }
  // Defer if the account's Playwright browser is still initializing: the
  // settings POST requires the page mutex, and init legitimately holds it for
  // 20-30s (navigation + bx SDK + header capture). Attempting to acquire the
  // mutex now would time out (5s default in withQwenBrowserPage) and log a
  // spurious WARN. The startup flow calls us again after init finishes.
  if (accountId && isPlaywrightInitializing(accountId)) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    // Apply the FULL safe-settings patch (tools_enabled + ui + memory +
    // mcp_remind), not just tools_enabled: since the personalization POST
    // became personalization-only, nothing else applies ui/memory/mcp_remind,
    // and the sync's verified-cache check (existingSafeSettingsApplied)
    // requires ALL of them false. A live probe confirmed the combined
    // no-personalization payload is accepted by settings/update.
    const payload = QWEN_SAFE_SETTINGS_PATCH;

    // Use an isolated page only when the main page is actively serving a stream.
    // Startup/idle operations should not open a visible extra tab.
    if (accountId && !isAuthMockEnabled() && isAccountBusy(accountId)) {
      try {
        const result = await withAccountPage(
          accountId,
          async (page) => {
            const requestId = crypto.randomUUID();
            const response = await page.evaluate(
              async ({ payload, timeoutMs, requestId }: { payload: any; timeoutMs: number; requestId: string }) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                  const resp = await fetch(
                    "https://chat.qwen.ai/api/v2/users/user/settings/update",
                    {
                      method: "POST",
                      headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        "x-request-id": requestId,
                        timezone: new Date().toString().split(" (")[0],
                        source: "web",
                      },
                      body: JSON.stringify(payload),
                      signal: controller.signal,
                    },
                  );
                  return { status: resp.status, body: await resp.text() };
                } finally {
                  clearTimeout(timeoutId);
                }
              },
              { payload, timeoutMs: config.timeouts.http, requestId },
            );
            return response;
          },
        );
        if (result.status < 400) {
          nativeToolsDisabled.add(cacheKey);
          return;
        }
        console.warn(
          `⚠️  [Qwen] Isolated disableNativeTools returned ${result.status} for ${cacheKey}`,
        );
      } catch (error) {
        // Fall through to standard request path
        logger.debug("[Qwen] Isolated disableNativeTools failed, using standard path", {
          accountId: cacheKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: standard request path
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildCapturedQwenHeaders(headers, {
      referer: qwenUrl("/settings/personalization"),
    });

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= DISABLE_TOOLS_MAX_RETRIES; attempt++) {
      try {
        const response = await requestQwenTextInBrowser(
          accountId,
          "POST",
          "/api/v2/users/user/settings/update",
          requestHeaders,
          JSON.stringify(payload),
          {
            settingsPage: true,
            referrer: qwenUrl("/settings/personalization"),
          },
        );

        if (!response.ok) {
          const text = await response.text();
          lastError = `${response.status} - ${text}`;
          console.warn(
            `⚠️  [Qwen] Failed to disable native tools for ${cacheKey} (attempt ${attempt}/${DISABLE_TOOLS_MAX_RETRIES}): ${lastError}`,
          );
        } else {
          nativeToolsDisabled.add(cacheKey);
          return;
        }
      } catch (err: any) {
        lastError = err.message;
        console.warn(
          `[Qwen] Error disabling native tools for ${cacheKey} (attempt ${attempt}/${DISABLE_TOOLS_MAX_RETRIES}): ${lastError}`,
        );
      }

      if (attempt < DISABLE_TOOLS_MAX_RETRIES) {
        const backoff = DISABLE_TOOLS_BACKOFF_MS * attempt;
        console.log(
          `🔄 [Qwen] Retrying disable native tools in ${backoff}ms...`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    console.error(
      `[Qwen] Failed to disable native tools for ${cacheKey} after ${DISABLE_TOOLS_MAX_RETRIES} attempts. Last error: ${lastError}`,
    );
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

function asModelRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Keep the upstream model object intact while adding stable normalized aliases.
 * The registry consumes `info.meta`, and adapters can still inspect fields Qwen
 * adds in the future without another parser change.
 */
function formatPublicQwenModel(model: Record<string, unknown>): PublicQwenModel {
  const info = asModelRecord(model.info);
  const metadata = {
    ...asModelRecord(model.metadata),
    ...asModelRecord(model.meta),
    ...asModelRecord(info.meta),
  };
  const capabilities = {
    ...asModelRecord(metadata.capabilities),
    ...asModelRecord(info.capabilities),
    ...asModelRecord(model.capabilities),
  };
  const id = typeof model.id === "string" ? model.id : "";
  const name =
    (typeof model.name === "string" && model.name) ||
    (typeof info.name === "string" && info.name) ||
    id;
  const createdValue = info.created_at ?? model.created;
  const created =
    typeof createdValue === "number" && Number.isFinite(createdValue)
      ? createdValue
      : Date.now();
  const contextWindow =
    typeof metadata.max_context_length === "number"
      ? metadata.max_context_length
      : undefined;
  const modality = Array.isArray(metadata.modality)
    ? metadata.modality.filter((value): value is string => typeof value === "string")
    : undefined;
  const chatType = Array.isArray(metadata.chat_type)
    ? metadata.chat_type.filter((value): value is string => typeof value === "string")
    : undefined;
  const isActive =
    typeof info.is_active === "boolean"
      ? info.is_active
      : typeof model.is_active === "boolean"
        ? model.is_active
        : undefined;

  return {
    ...model,
    id,
    name,
    object: "model",
    owned_by:
      (typeof model.owned_by === "string" && model.owned_by) || "qwen",
    created,
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    capabilities,
    metadata,
    info,
    meta: metadata,
    ...(modality ? { modality } : {}),
    ...(chatType ? { chat_type: chatType } : {}),
    ...(metadata.think_skip && typeof metadata.think_skip === "object"
      ? { think_skip: metadata.think_skip as Record<string, unknown> }
      : {}),
    ...(isActive !== undefined ? { is_active: isActive } : {}),
    ...(metadata.max_summary_generation_length !== undefined
      ? { max_summary_generation_length: metadata.max_summary_generation_length }
      : {}),
    ...(metadata.max_thinking_generation_length !== undefined
      ? {
          max_thinking_generation_length:
            metadata.max_thinking_generation_length,
        }
      : {}),
  };
}

export async function deleteAllQwenChats(accountId?: string): Promise<boolean> {
  if (isAuthMockEnabled()) {
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildCapturedQwenHeaders(headers, {
      referer: qwenUrl("/settings/chats"),
    });

    const response = await requestQwenTextInBrowser(
      accountId,
      "DELETE",
      "/api/v2/chats/",
      requestHeaders,
      undefined,
      { referrer: qwenUrl("/settings/chats") },
    );

    const { raw, json: parsed } = await readJsonTextResponse(response, {
      strict: true,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to delete chats from Qwen: ${response.status} ${raw.substring(0, 200)}`,
      );
    }

    const success = parsed?.success === true && parsed?.data?.status === true;
    if (!success) {
      throw new Error(
        `Qwen delete chats returned unexpected payload: ${raw.substring(0, 200)}`,
      );
    }

    clearAllSessionsForAccount(accountId || "global");
    return true;
  }

  // Live mode: fetch remote chats and delete them by ID in parallel batches
  // (Alibaba WAF rejects bare DELETE /api/v2/chats/ with 401; deleting by ID succeeds 100%).
  try {
    const { withAccountPage } = await import("./playwright.ts");
    const result = await withAccountPage(
      accountId || "global",
      async (page) => {
        return page.evaluate(async () => {
          let totalDeleted = 0;
          let pageNum = 1;
          while (true) {
            const listRes = await fetch(`/api/v2/chats/?page=${pageNum}&exclude_project=true`, {
              credentials: "include",
              headers: { accept: "application/json, text/plain, */*" },
            });
            const listJson = await listRes.json().catch(() => null);
            const items = listJson?.data || [];
            if (!Array.isArray(items) || items.length === 0) break;

            for (let i = 0; i < items.length; i += 5) {
              const batch = items.slice(i, i + 5);
              await Promise.all(
                batch.map(async (chat: any) => {
                  try {
                    await fetch(`/api/v2/chats/${chat.id}`, {
                      method: "DELETE",
                      credentials: "include",
                      headers: { accept: "application/json, text/plain, */*" },
                    });
                    totalDeleted++;
                  } catch {}
                }),
              );
            }

            if (items.length < 20) break;
          }
          return { success: true, count: totalDeleted };
        });
      },
      60_000,
      30_000,
      true,
    );

    clearAllSessionsForAccount(accountId || "global");
    return result?.success === true;
  } catch (err: any) {
    try {
      const chats = await fetchRemoteQwenChats(accountId);
      if (chats.length === 0) {
        clearAllSessionsForAccount(accountId || "global");
        return true;
      }
      for (const chat of chats) {
        await deleteSingleQwenChat(accountId, chat.id).catch(() => false);
      }
      clearAllSessionsForAccount(accountId || "global");
      return true;
    } catch {
      return false;
    }
  }
}

export interface RemoteQwenChat {
  id: string;
  title: string;
  updated_at: number | string;
  created_at: number | string;
}

/**
 * Deletes a single chat session by ID on Qwen Web.
 */
export async function deleteSingleQwenChat(
  accountId: string | undefined,
  chatId: string,
): Promise<boolean> {
  if (!chatId) return false;

  if (isAuthMockEnabled()) {
    const url = qwenUrl(`/api/v2/chats/${encodeURIComponent(chatId)}`);
    const response = await fetch(url, {
      method: "DELETE",
    });
    removeSessionByChatId(chatId);
    return response.ok;
  }

  const requestHeaders: Record<string, string> = {
    source: "web",
    version: "0.2.89",
    timezone: new Date().toString().split(" (")[0],
    "x-request-id": crypto.randomUUID(),
    Referer: qwenUrl(`/c/${encodeURIComponent(chatId)}`),
  };

  try {
    const response = await requestQwenTextInBrowser(
      accountId,
      "DELETE",
      `/api/v2/chats/${encodeURIComponent(chatId)}`,
      requestHeaders,
      undefined,
      { referrer: qwenUrl(`/c/${encodeURIComponent(chatId)}`), noMutexRecovery: true },
    );

    const { json: parsed } = await readJsonTextResponse(response, {
      strict: false,
    });

    const success = response.ok && parsed?.success === true && parsed?.data?.status === true;
    if (success) {
      removeSessionByChatId(chatId);
    }
    return success;
  } catch (error) {
    logger.debug("[Qwen] deleteSingleQwenChat failed", {
      accountId,
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Fetch remote chat list from Qwen Web.
 */
export async function fetchRemoteQwenChats(
  accountId?: string,
): Promise<RemoteQwenChat[]> {
  if (isAuthMockEnabled()) {
    try {
      const response = await fetch(qwenUrl("/api/v2/chats/?page=1&exclude_project=true"));
      const json: any = await response.json().catch(() => null);
      if (json?.success && Array.isArray(json.data)) {
        return json.data;
      }
    } catch {}
    return [];
  }

  const requestHeaders: Record<string, string> = {
    version: "0.2.89",
    timezone: new Date().toString().split(" (")[0],
    "x-request-id": crypto.randomUUID(),
    Referer: qwenUrl("/settings/chats"),
  };

  try {
    const response = await requestQwenTextInBrowser(
      accountId,
      "GET",
      "/api/v2/chats/?page=1&exclude_project=true",
      requestHeaders,
      undefined,
      { referrer: qwenUrl("/settings/chats"), noMutexRecovery: true },
    );
    if (!response.ok) return [];
    const json: any = await response.json().catch(() => null);
    if (json?.success && Array.isArray(json.data)) {
      return json.data;
    }
    return [];
  } catch {
    return [];
  }
}

export async function fetchQwenModels(
  accountId?: string,
): Promise<PublicQwenModel[]> {
  const cacheKey = accountId || "global";
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    syncModelMetadata(
      cached.models as unknown as Array<Record<string, unknown> & { id: string }>,
      accountId,
    );
    return cached.models;
  }

  // Use an isolated page only when the main page is actively serving a stream.
  // Startup/idle operations should not open a visible extra tab.
  if (accountId && !isAuthMockEnabled() && isAccountBusy(accountId)) {
    try {
      const result = await withAccountPage(
        accountId,
        async (page) => {
          const requestId = crypto.randomUUID();
          const response = await page.evaluate(
            async ({ timeoutMs, requestId }: { timeoutMs: number; requestId: string }) => {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const resp = await fetch("https://chat.qwen.ai/api/models", {
                  method: "GET",
                  headers: {
                    accept: "application/json, text/plain, */*",
                    "x-request-id": requestId,
                    timezone: new Date().toString().split(" (")[0],
                    source: "web",
                  },
                  signal: controller.signal,
                });
                return { status: resp.status, body: await resp.text() };
              } finally {
                clearTimeout(timeoutId);
              }
            },
            { timeoutMs: config.timeouts.http, requestId },
          );
          return response;
        },
      );
      if (result.status < 400) {
        const json = JSON.parse(result.body);
        if (json.data && Array.isArray(json.data)) {
          const models = json.data
            .filter((model: unknown) => {
              const record = asModelRecord(model);
              return typeof record.id === "string" && record.id.trim().length > 0;
            })
            .map((model: unknown) => formatPublicQwenModel(asModelRecord(model)));

          replaceModelMetadata(
            models as unknown as Array<Record<string, unknown> & { id: string }>,
            accountId,
          );
          modelsCache.set(cacheKey, { models, fetchedAt: now });
          return models;
        }
      }
    } catch (error) {
      // Fall through to standard request path
      logger.debug("[Qwen] Isolated model fetch failed, using standard path", {
        accountId: cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
    await getBasicHeaders(accountId);

  const response = await requestQwenTextInBrowser(
    accountId,
    "GET",
    "/api/models",
    buildQwenRequestHeaders({
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
      extra: {
        timezone: new Date().toString(),
      },
    }),
    undefined,
    { referrer: qwenUrl("/") },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from Qwen: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    // Keep only upstream/base entries here. The public `-fast` variant is
    // generated exactly once by the public models endpoint after metadata has
    // been synchronized.
    const models = json.data
      .filter((model: unknown) => {
        const record = asModelRecord(model);
        return typeof record.id === "string" && record.id.trim().length > 0;
      })
      .map((model: unknown) => formatPublicQwenModel(asModelRecord(model)));

    replaceModelMetadata(
      models as unknown as Array<Record<string, unknown> & { id: string }>,
      accountId,
    );
    modelsCache.set(cacheKey, { models, fetchedAt: now });
    return models;
  }

  return [];
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}


function isQwenChatNotExistMessage(details: string): boolean {
  return (
    details.includes("is not exist") ||
    details.includes("not exist") ||
    details.includes("does not exist")
  );
}

function isQwenQuotaLimitMessage(details: string): boolean {
  const normalized = details.toLowerCase();
  return (
    normalized.includes("allocated quota exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("increase your quota") ||
    normalized.includes("token-limit") ||
    normalized.includes("insufficient quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("ratelimited")
  );
}

function parseQwenJsonError(
  raw: string,
  status: number,
  accountId?: string,
): Error | null {
  let errorJson: any;
  try {
    errorJson = JSON.parse(raw);
  } catch {
    return null;
  }



  const retryDelay = (attempt: number) => {
    const base = config.retry.baseDelayMs;
    const max = config.retry.maxDelayMs;
    const exp = Math.min(base * Math.pow(2, attempt - 1), max);
    const jitter = exp * 0.3 * Math.random();
    return Math.floor(exp + jitter);
  };

  // Anti-bot detection: {ret: ["FAIL_SYS_USER_VALIDATE", ...]} format
  const retArray: string[] | undefined = errorJson?.ret;
  if (Array.isArray(retArray)) {
    const retStr = retArray.join(",");
    if (
      retStr.includes("FAIL_SYS_USER_VALIDATE") ||
      retStr.includes("RGV587_ERROR")
    ) {
      const error = new RetryableQwenStreamError(
        `Qwen anti-bot: ${retStr.substring(0, 200)}`,
        0,
      );
      error.upstreamCode = "waf_challenge";
      return error;
    }
  }

  const details =
    errorJson?.data?.details ||
    errorJson?.message ||
    errorJson?.error?.message ||
    "Qwen returned an error";

  if (typeof details === "string" && isQwenChatNotExistMessage(details)) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const error = new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
    error.upstreamCode = "chat_not_exist";
    return error;
  }

  // Anti-bot detection: FAIL_SYS_USER_VALIDATE / RGV587_ERROR
  if (
    typeof details === "string" &&
    (details.includes("FAIL_SYS_USER_VALIDATE") ||
      details.includes("RGV587_ERROR") ||
      details.includes("user validate"))
  ) {
    const error = new RetryableQwenStreamError(
      `Qwen anti-bot: ${details}`,
      0,
    );
    error.upstreamCode = "waf_challenge";
    return error;
  }

  if (
    typeof details === "string" &&
    (details.toLowerCase().includes("chat is in progress") ||
      details.toLowerCase().includes("the chat is in progress"))
  ) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const error = new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
    error.upstreamCode = "chat_in_progress";
    return error;
  }

  if (errorJson?.success === false) {
    const code = errorJson.data?.code || errorJson.code || "UpstreamError";

    if (
      status === 401 ||
      code === "Unauthorized" ||
      (typeof details === "string" &&
        (details.includes("login") || details.includes("session")))
    ) {
      return new QwenSessionExpiredError(
        `Session expired: ${details}`,
        accountId || "global",
      );
    }

    const wait =
      errorJson.data?.num !== undefined
        ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
        : "";
    const message = `Qwen upstream error: ${code}: ${details}.${wait}`;

    if (
      code === "RateLimited" ||
      status === 429 ||
      (typeof details === "string" && isQwenQuotaLimitMessage(details))
    ) {
      return new UpstreamRateLimit(message);
    }

    const upstreamStatus = code === "Not_Found" ? 404 : 502;
    return new QwenUpstreamError(message, code, upstreamStatus);
  }

  if (errorJson?.error) {
    const message =
      typeof errorJson.error === "string"
        ? errorJson.error
        : errorJson.error.message || JSON.stringify(errorJson.error);
    if (isQwenQuotaLimitMessage(message)) {
      return new UpstreamRateLimit(`Qwen upstream error: ${message}`);
    }

    return new QwenUpstreamError(
      `Qwen upstream error: ${message}`,
      "UpstreamError",
      502,
    );
  }

  return null;
}

const UPSTREAM_RESPONSE_PREVIEW_BYTES = 8 * 1024;

function isHtmlResponseContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/html") ||
    normalized.includes("application/xhtml+xml")
  );
}

function isHtmlResponseBody(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(value);
}

function isWafChallengeResponse(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("aliyun_waf") ||
    normalized.includes("_____tmd_____") ||
    normalized.includes("fail_sys_user_validate") ||
    normalized.includes("rgv587_error") ||
    normalized.includes("denyfromx5") ||
    normalized.includes("captcha") ||
    normalized.includes("security verification")
  );
}

async function readResponsePreview(
  response: Response,
  maxBytes = UPSTREAM_RESPONSE_PREVIEW_BYTES,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - bytesRead;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytesRead += remaining;
        break;
      }
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Headers for the completions POST (browser relay). Reuses
 * buildCapturedQwenHeaders (cookie, origin, referer with the chat id,
 * sec-ch-ua, version, bx-v, source) and additionally injects
 * bx-ua/bx-umidtoken when captured — the real client POSTs completions WITH
 * them (0.2.86 HAR, network/), so the relay matches the browser client.
 *
 * NOTE: a direct Node-side fetch was tried and removed — the Qwen WAF
 * fingerprints the HTTP stack beyond headers and JA3 (live probes: blocked
 * with no headers at all AND with a chrome_136 TLS profile), so completions
 * must go through the browser. The settings endpoints have no such WAF and
 * use direct Node fetch (requestQwenSettingsDirectFetch).
 */
export function buildCompletionHeaders(
  headers: Record<string, string>,
  chatSessionId: string | null | undefined,
): Record<string, string> {
  const base = buildCapturedQwenHeaders(headers, {
    chatSessionId: chatSessionId || null,
    extra: {
      "x-accel-buffering": "no",
    },
  });
  if (headers["bx-ua"]) base["bx-ua"] = headers["bx-ua"];
  if (headers["bx-umidtoken"]) base["bx-umidtoken"] = headers["bx-umidtoken"];
  return base;
}

export interface PostCaptchaResetDeps {
  closeAccount?: (accountId: string) => Promise<void>;
  presence?: (accountId: string) => { context: boolean; page: boolean };
}

/**
 * FIX V1 (fase 2.17B): reset the account's BrowserContext after a solved
 * CAPTCHA, before the headers refresh runs.
 *
 * Root cause: the Page/renderer used during CAPTCHA recovery can be left in
 * an unstable/zombie state (renderer SIGTRAP observed ~4s before a fatal
 * `refresh_goto` hang with neither EXIT nor ERROR, followed by event-loop
 * stall and Node OOM). The old Page must not be reused for the refresh that
 * immediately follows recovery.
 *
 * Reuses `closePlaywrightForAccount`: strictly per-account (mutex-guarded
 * `close:` key, maps cleaned, profile/credentials/cooldowns untouched, the
 * shared browser untouched). The next `getQwenHeaders(true, accountId)`
 * lazily re-initializes a fresh context + page.
 *
 * Failure is controlled, never silent: if the old context cannot be closed
 * or cannot be proven invalidated, a retryable `QwenNetworkError` is thrown
 * (account rotation kicks in) instead of running `refresh_goto` on the
 * suspect renderer. Returns true when a reset was performed, false when the
 * challenge was not solved (no reset, no probes).
 */
export async function maybeResetContextAfterCaptchaRecovery(
  accountId: string,
  solved: boolean,
  options: PostCaptchaResetDeps & { traceId?: string } = {},
): Promise<boolean> {
  if (!solved) return false;
  const closeAccount = options.closeAccount ?? closePlaywrightForAccount;
  const presence = options.presence ?? getPlaywrightAccountPresence;
  const before = presence(accountId);
  const startedAt = Date.now();
  captureStageEnter("post_captcha_context_reset", {
    old_context_present: before.context ? 1 : 0,
    old_page_present: before.page ? 1 : 0,
  });
  const failControlled = (reason: string, errorKind: string): never => {
    captureStageError("post_captcha_context_reset", errorKind);
    if (options.traceId) endCaptureTrace(options.traceId, reason);
    throw new QwenNetworkError(
      `Post-CAPTCHA browser context reset ${reason} (account=${accountId}); refusing to refresh headers on the suspect renderer.`,
    );
  };
  try {
    await closeAccount(accountId);
  } catch (error) {
    failControlled(
      "post_captcha_context_reset_error",
      error instanceof Error ? error.name : "Error",
    );
  }
  const after = presence(accountId);
  if (after.context || after.page) {
    failControlled(
      "post_captcha_context_reset_incomplete",
      "ResetIncomplete",
    );
  }
  captureStageExit("post_captcha_context_reset", {
    duration_ms: Date.now() - startedAt,
    result: "reset",
  });
  return true;
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  options?: {
    chatSessionId?: string | null;
    forceNewChat?: boolean;
    reasoningMode?: "auto" | "thinking" | "fast";
    /** Auxiliary stream (title on its own chat): short idle cap. */
    parallelEscape?: boolean;
    /** "thread" (chat_mode:"normal") or "temp" (chat_mode:"local"). */
    chatMode?: ChatMode;
  },
  signal?: AbortSignal,
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
  createdNewChat: boolean;
  tokenEstimationContext: TokenEstimationContext;
}> {
  if (signal?.aborted) {
    throw new Error("client aborted before stream creation");
  }
  // Take a stream slot for the account (up to maxStreamsPerAccount concurrent;
  // the relay multiplexes them on the page via reqId).
  const streamLockKey = accountId || "global";
  const startedAt = Date.now();
  const releaseStreamLock = await acquireAccountStreamLock(streamLockKey);
  if (logger.isLevelEnabled("info")) {
    console.log(
      `⏱️ [Qwen] Create: stream-lock | account=${accountId ?? "global"} | +${Date.now() - startedAt}ms`,
    );
  }
  let streamLockReleased = false;
  const releaseStreamLockOnce = () => {
    if (streamLockReleased) return;
    streamLockReleased = true;
    releaseStreamLock();
  };

  // A signal can fire while this attempt waited in the stream-lock queue
  // (client disconnect, same-session supersede, or the acquire deadline
  // aborting the race loser). Re-check AFTER the lock: a race-lost orphan must
  // not proceed to make a full upstream request while unobserved (it would hold
  // the lock for minutes and burn a Qwen request).
  if (signal?.aborted) {
    releaseStreamLockOnce();
    throw new Error("client aborted before stream creation");
  }

  try {
    return await createQwenStreamInternal(
      prompt,
      enableThinking,
      modelId,
      forcedParentId,
      accountId,
      files,
      options,
      signal,
      releaseStreamLockOnce,
      startedAt,
    );
  } catch (error) {
    releaseStreamLockOnce();
    throw error;
  }
}

async function createQwenStreamInternal(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId: string | null | undefined,
  accountId: string | undefined,
  files: QwenFileEntry[] | undefined,
  options: {
    chatSessionId?: string | null;
    forceNewChat?: boolean;
    reasoningMode?: "auto" | "thinking" | "fast";
    /** Auxiliary stream (title on its own chat): short idle cap. */
    parallelEscape?: boolean;
    /** "thread" (chat_mode:"normal") or "temp" (chat_mode:"local"). */
    chatMode?: ChatMode;
  } | undefined,
  signal: AbortSignal | undefined,
  releaseStreamLock: () => void,
  /** Wall-clock start of the acquire (used for per-phase +Xms telemetry). */
  startedAt: number,
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
  createdNewChat: boolean;
  tokenEstimationContext: TokenEstimationContext;
}> {
  const ensureNotAborted = () => {
    if (signal?.aborted) {
      // Aborted by the client OR by a same-session supersede (latest-wins).
      // Typed as ClientAbortedError so the retry policy treats it as a silent
      // client abort instead of a retryable stream_aborted — a superseded
      // request must not resend full context on another account.
      throw new ClientAbortedError("client aborted before completion request");
    }
  };

  const phase = (name: string) => {
    if (logger.isLevelEnabled("info")) {
      console.log(
        `⏱️ [Qwen] Create: ${name} | account=${accountId ?? "global"} | +${Date.now() - startedAt}ms`,
      );
    }
  };

  // A new logical chat session should reuse the warmed header cache when available.
  // Header recapture is much more expensive and should be reserved for real refresh/login cases,
  // not for ordinary first prompts that simply need parent_id reset.
  const captured = await getQwenHeaders(
    options?.forceNewChat === true,
    accountId,
  );
  ensureNotAborted();
  phase("headers");
  const { headers, parentMessageId } = captured;
  let activeHeaders = headers;
  // The upstream always receives the real base model ID. Reasoning mode is
  // selected exclusively by feature_config, not by a synthetic model suffix.
  const model = mapClientModelToQwen(modelId);
  let createdNewChat = false;
  let chatSessionId: string | null | undefined;
  let leasedWarmChat = false;
  markLatency(latencyRequestId(), "CHAT_PREP_START");
  if (options && "chatSessionId" in options) {
    if (options.chatSessionId === null || options.chatSessionId === "") {
      const acquired = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
        options?.chatMode ?? "thread",
      );
      chatSessionId = acquired.chatId;
      leasedWarmChat = acquired.leasedFromPool;
      createdNewChat = true;
    } else {
      chatSessionId = options.chatSessionId;
    }
  } else {
    chatSessionId = captured.chatSessionId;
    if (!chatSessionId) {
      const acquired = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
        options?.chatMode ?? "thread",
      );
      chatSessionId = acquired.chatId;
      leasedWarmChat = acquired.leasedFromPool;
      createdNewChat = true;
    }
  }

  markLatency(latencyRequestId(), "CHAT_PREP_END");
  ensureNotAborted();
  phase("chat");

  let warmChatReleased = false;
  const releaseLeasedWarmChat = () => {
    if (!leasedWarmChat || warmChatReleased || !chatSessionId) return;
    warmChatReleased = true;
    releaseWarmChat(accountId, model, chatSessionId);
  };

  // Combined cleanup: release warm chat AND stream lock
  const releaseStreamResources = () => {
    releaseLeasedWarmChat();
    releaseStreamLock();
  };

  const wrapUpstreamStream = (
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
  ): ReadableStream<Uint8Array> => {
    if (config.timeouts.idleStreamTimeout <= 0) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>({
        start() {
          reader = stream.getReader();
        },
        async pull(streamController) {
          try {
            if (!reader) throw new Error("Stream reader was not initialized");
            const { done, value } = await reader.read();
            if (done) {
              releaseStreamResources();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (error) {
            releaseStreamResources();
            streamController.error(error);
          }
        },
        cancel(reason) {
          releaseStreamResources();
          return stream.cancel(reason);
        },
      });
    }

    // Dynamic idle timeout based on model type and payload size
    // Reasoning models (thinking enabled): use REASONING_MODEL_TIMEOUT as base
    // Non-reasoning models: use IDLE_STREAM_TIMEOUT as base
    // Both add 30s per MB of payload. Parallel-escape streams get a tight cap
    // ONLY when non-thinking (see computeDynamicIdleTimeout).
    const baseTimeoutMs = enableThinking
      ? config.timeouts.reasoningModelTimeout
      : config.timeouts.idleStreamTimeout;
    const dynamicIdleTimeoutMs = computeDynamicIdleTimeout({
      enableThinking,
      parallelEscape: options?.parallelEscape,
      baseTimeoutMs,
      payloadSize,
    });

    logger.debug("[Qwen] dynamic idle timeout", {
      chatId: chatSessionId || "new",
      model: modelId,
      enableThinking,
      payloadMB: payloadMB.toFixed(2),
      baseTimeout: baseTimeoutMs,
      dynamicTimeout: dynamicIdleTimeoutMs,
    });

    // Thinking models idle at 600s — fine for gaps AFTER data flows, but a
    // stream that produced NOTHING in the first-chunk window is dead. Fail
    // fast (retryable) so the account slot is not held for 10 minutes.
    const firstChunkDeadlineMs = enableThinking
      ? Math.max(
          config.timeouts.firstChunkTimeout,
          config.timeouts.timeToFirstByte,
        )
      : undefined;

    return addIdleTimeoutToStream(
      stream,
      controller,
      dynamicIdleTimeoutMs,
      `Qwen stream ${chatSessionId || "unknown"}`,
      releaseStreamResources,
      releaseStreamResources,
      firstChunkDeadlineMs,
    );
  };

  const withCreatedChatMetadata = <T extends Error>(error: T): T => {
    if (createdNewChat && chatSessionId) {
      (error as any).createdNewChat = true;
      (error as any).chatSessionId = chatSessionId;
      (error as any).accountId = accountId ?? "global";
    }
    return error;
  };

  let actualParentId: string | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
    if (chatSessionId && forcedParentId === null) {
      updateSessionParent(chatSessionId, null, accountId ?? "global");
    }
  } else if (chatSessionId) {
    const storedParent = getSessionParent(chatSessionId, accountId ?? "global");
    if (storedParent !== undefined) {
      actualParentId = storedParent;
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const childId = uuidv4();

  const payload: QwenPayload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId: chatSessionId || null,
    parentId: actualParentId ?? "",
    chat_id: chatSessionId || null,
    chat_mode: isLocalChatMode(options?.chatMode) ? "local" : "normal",
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        id: null,
        fid: fid,
        parentId: actualParentId,
        childrenIds: [childId],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: files || [],
        timestamp: timestamp,
        models: [model],
        model: "",
        chat_type: "t2t",
        feature_config: (() => {
          // Determine reasoning mode: explicit option takes precedence, otherwise derive from enableThinking
          // - reasoningMode="auto": Qwen decides (auto_thinking=true, thinking_mode="Auto")
          // - reasoningMode="thinking": force thinking ON (thinking_mode="Thinking")
          // - reasoningMode="fast": force thinking OFF (thinking_mode="Fast")
          // - No reasoningMode + enableThinking=false: legacy "fast" mode
          // - No reasoningMode + enableThinking=true: legacy "thinking" mode
          const mode = options?.reasoningMode ?? (enableThinking ? "thinking" : "fast");
          const thinkingMode = mode === "thinking" ? "Thinking" : mode === "fast" ? "Fast" : "Auto";
          const thinkingEnabled = mode !== "fast";
          return {
            thinking_enabled: thinkingEnabled,
            output_schema: "phase",
            research_mode: "normal",
            auto_thinking: mode === "auto",
            thinking_mode: thinkingMode,
            ...(thinkingEnabled ? { thinking_format: "summary" } : {}),
            auto_search: false,
          };
        })(),
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: actualParentId,
      },
    ],
    timestamp: timestamp + 1,
  };

  // Debug-only: textSize hashes/scans the whole prompt and the preview runs a
  // full-string regex, so build the payload only when it will actually log.
  if (logger.isLevelEnabled("debug")) {
    logger.debug("[Qwen] chat payload", {
      accountId: accountId ?? "global",
      model,
      chatId: chatSessionId || "new",
      parentId: actualParentId || null,
      content: textSize(prompt),
      preview: prompt.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

  // Dynamic timeout based on payload size
  const BASE_TIMEOUT_MS = 120000;
  const TIMEOUT_PER_MB = 30000;

  const payloadJson = JSON.stringify(payload);
  const payloadSize = Buffer.byteLength(payloadJson);
  const tokenEstimationContext: TokenEstimationContext = {
    activePersonalization: getActivePersonalizationInfo(accountId ?? "global"),
    qwenPayloadBytes: payloadSize,
    qwenPayloadPromptChars: prompt.length,
    qwenPayloadMessageCount: payload.messages.length,
  };

  if (payloadSize > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload too large: ${payloadSize} bytes exceeds limit of ${MAX_PAYLOAD_SIZE} bytes`,
    );
  }

  const payloadMB = payloadSize / (1024 * 1024);
  const dynamicTimeoutMs = enableThinking
    ? Math.max(
        config.timeouts.reasoningModelTimeout,
        BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB),
      )
    : BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB);
  // Keep the total generation budget separate from the browser bridge startup
  // and first-response-header deadlines. The bridge releases the account page
  // mutex immediately; this budget only bounds the request lifecycle.
  const browserStreamBudgetMs = Math.max(
    config.timeouts.page,
    Math.min(
      dynamicTimeoutMs,
      config.timeouts.totalRequestTimeout > 0
        ? config.timeouts.totalRequestTimeout
        : dynamicTimeoutMs,
    ),
  );

  const url = chatSessionId
    ? qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatSessionId)}`)
    : qwenUrl("/api/v2/chat/completions");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), dynamicTimeoutMs);
  // Propagate client/supersede aborts to the upstream fetch IMMEDIATELY: the
  // internal controller is otherwise only aborted by the dynamic timeout, so a
  // superseded generation would keep running — and keep holding the chat lock
  // — until the idle timeout (180s+) instead of dying instantly.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const fetchCompletion = async (requestHeaders: Record<string, string>): Promise<Response> => {
      return createQwenBrowserResponse(
        accountId,
        url,
        "POST",
        // The 0.2.86 HAR shows the real client POSTs completions with
        // bx-ua/bx-umidtoken + x-accel-buffering, so the relay matches it
        // instead of relying on sendBxUa.
        buildCompletionHeaders(requestHeaders, chatSessionId),
        payloadJson,
        controller.signal,
        qwenUrl(
          chatSessionId
            ? `/c/${encodeURIComponent(chatSessionId)}`
            : "/",
        ),
        browserStreamBudgetMs,
      );
    };

    let response!: Response;
    let captchaRecoveryAttempted = false;
    const retryAfterCaptchaRecovery = async (
      label: string,
      challengeBody: string,
    ): Promise<boolean> => {
      if (captchaRecoveryAttempted || !accountId) return false;
      captchaRecoveryAttempted = true;

      markLatency(latencyRequestId(), "CAPTCHA_START");
      const solved = await recoverBaxiaCaptcha(accountId, label, {
        challengeBody,
      });
      markLatency(latencyRequestId(), "CAPTCHA_END");
      noteLatency(latencyRequestId(), { captcha: true });
      const captureTraceId = beginCaptureTrace(accountId);
      capturePoint("recovery_returned", { solved: solved ? 1 : 0 });
      if (!solved) {
        endCaptureTrace(captureTraceId, "unsolved");
        return false;
      }

      // FIX V1 (fase 2.17B): break the continuity between the Page/renderer
      // used during CAPTCHA recovery and the refresh_goto below. Resets only
      // this account's BrowserContext; throws (retryable) in a controlled
      // way when the old context cannot be invalidated.
      await maybeResetContextAfterCaptchaRecovery(accountId, solved, {
        traceId: captureTraceId,
      });

      // The challenge may have rotated bx-* values or session cookies. Refresh
      // them only after the visible challenge was solved, then replay the same
      // payload on the same account.
      const headersRefreshStartedAt = Date.now();
      captureStageEnter("headers_refresh");
      let refreshed: Awaited<ReturnType<typeof getQwenHeaders>>;
      try {
        refreshed = await getQwenHeaders(true, accountId);
      } catch (error) {
        captureStageError(
          "headers_refresh",
          error instanceof Error ? error.name : "Error",
        );
        endCaptureTrace(captureTraceId, "headers_refresh_error");
        throw error;
      }
      captureStageExit("headers_refresh", {
        duration_ms: Date.now() - headersRefreshStartedAt,
      });
      activeHeaders = refreshed.headers;
      if (config.captcha.retryDelayMs > 0) {
        await sleep(config.captcha.retryDelayMs);
      }
      ensureNotAborted();
      captureStageEnter("retry_fetch");
      try {
        response = await fetchCompletion(activeHeaders);
      } finally {
        endCaptureTrace(captureTraceId, "retry_fetch_started");
      }
      return true;
    };

    let captchaMetadataRetryAttempted = false;
    const throwFetchCompletionError = (error: unknown): never => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Treat network errors (fetch failed, timeout, DNS, first-byte stall,
      // etc.) as retryable so account rotation kicks in instead of a terminal
      // 500 that forces the client to retry in a loop ("request hangs").
      if (isRetryableFetchErrorMessage(errorMsg) || error instanceof TypeError) {
        throw withCreatedChatMetadata(new QwenNetworkError(errorMsg));
      }
      throw withCreatedChatMetadata(
        error instanceof Error ? error : new Error(errorMsg),
      );
    };

    try {
      ensureNotAborted();
      phase("fetch");
      markLatency(latencyRequestId(), "T2_COMPLETION_START");
      response = await fetchCompletion(activeHeaders);
    } catch (error) {
      // The challenge was solved while waiting for headers, but the original
      // background fetch did not resume. Replay the same payload on the same
      // account with fresh headers instead of failing as an unknown error.
      if (
        (error as any)?.captchaSolvedDuringMetadata &&
        accountId &&
        !captchaMetadataRetryAttempted
      ) {
        captchaMetadataRetryAttempted = true;
        logger.warn(
          "[Qwen] Completion headers timed out after captcha recovery; retrying with fresh headers",
          {
            accountId,
            chatId: chatSessionId ?? "new",
          },
        );
        const refreshed = await getQwenHeaders(true, accountId);
        activeHeaders = refreshed.headers;
        if (config.captcha.retryDelayMs > 0) {
          await sleep(config.captcha.retryDelayMs);
        }
        try {
          ensureNotAborted();
          response = await fetchCompletion(activeHeaders);
        } catch (retryError) {
          throwFetchCompletionError(retryError);
        }
      } else {
        throwFetchCompletionError(error);
      }
    }

    let responseContentType = response.headers.get("content-type") || "";
    let retriedNonSseResponse = false;

    while (true) {
      responseContentType = response.headers.get("content-type") || "";

      const isNonSseSuccessResponse =
        response.ok &&
        responseContentType.trim().length > 0 &&
        !responseContentType.includes("text/event-stream") &&
        !responseContentType.includes("application/json") &&
        Boolean(response.body);

      if (
        isHtmlResponseContentType(responseContentType) ||
        isNonSseSuccessResponse
      ) {
        const preview = await readResponsePreview(response);
        const htmlBody = isHtmlResponseBody(preview);
        const antiBotChallenge = isWafChallengeResponse(preview);

        if (
          antiBotChallenge &&
          (await retryAfterCaptchaRecovery(
            `chat ${chatSessionId ?? "new"}`,
            preview,
          ))
        ) {
          retriedNonSseResponse = true;
          continue;
        }

        if (!antiBotChallenge && !retriedNonSseResponse) {
          retriedNonSseResponse = true;
          const refreshed = await getQwenHeaders(true, accountId);
          activeHeaders = refreshed.headers;
          response = await fetchCompletion(activeHeaders);
          continue;
        }

        logger.warn(
          htmlBody || isHtmlResponseContentType(responseContentType)
            ? "[Qwen] Completion returned HTML instead of SSE"
            : "[Qwen] Completion returned a non-SSE body",
          {
            accountId: accountId ?? "global",
            chatId: chatSessionId ?? "new",
            status: response.status,
            contentType: responseContentType,
            antiBotChallenge,
            previewBytes: Buffer.byteLength(preview, "utf8"),
          },
        );
        throw withCreatedChatMetadata(
          new QwenUpstreamError(
            antiBotChallenge
              ? "Qwen returned an anti-bot challenge instead of an SSE response."
              : "Qwen returned an HTML response instead of an SSE response.",
            antiBotChallenge
              ? "waf_challenge"
              : htmlBody || isHtmlResponseContentType(responseContentType)
                ? "non_sse_html_response"
                : "non_sse_response",
            502,
          ),
        );
      }

      if (
        response.status === 200 &&
        !responseContentType.includes("text/event-stream") &&
        (!response.body || response.headers.get("content-length") === "0")
      ) {
        if (!retriedNonSseResponse) {
          logger.warn(
            "[Qwen] Completion returned an empty non-stream 200 response; retrying with fresh headers.",
            {
              accountId: accountId ?? "global",
              chatId: chatSessionId ?? "new",
              contentType: responseContentType || null,
            },
          );
          retriedNonSseResponse = true;
          const refreshed = await getQwenHeaders(true, accountId);
          activeHeaders = refreshed.headers;
          response = await fetchCompletion(activeHeaders);
          continue;
        }
        break;
      }

      if (response.ok && responseContentType.includes("application/json")) {
        const errText = await response.text().catch(() => "");

        const htmlResponse = isHtmlResponseBody(errText);
        const antiBotChallenge = isWafChallengeResponse(errText);
        if (antiBotChallenge || htmlResponse) {
          if (
            antiBotChallenge &&
            (await retryAfterCaptchaRecovery(
              `chat ${chatSessionId ?? "new"}`,
              errText,
            ))
          ) {
            retriedNonSseResponse = true;
            continue;
          }

          if (!antiBotChallenge && !retriedNonSseResponse) {
            retriedNonSseResponse = true;
            const refreshed = await getQwenHeaders(true, accountId);
            activeHeaders = refreshed.headers;
            response = await fetchCompletion(activeHeaders);
            continue;
          }

          logger.warn(
            "[Qwen] Completion returned an HTML or anti-bot challenge body instead of SSE.",
            {
              accountId: accountId ?? "global",
              chatId: chatSessionId ?? "new",
              antiBotChallenge,
              previewBytes: Buffer.byteLength(errText, "utf8"),
            },
          );
          throw withCreatedChatMetadata(
            new QwenUpstreamError(
              antiBotChallenge
                ? "Qwen returned an anti-bot challenge instead of an SSE response."
                : "Qwen returned an HTML response instead of an SSE response.",
              antiBotChallenge ? "waf_challenge" : "non_sse_html_response",
              502,
            ),
          );
        }

        throw withCreatedChatMetadata(
          parseQwenJsonError(errText, response.status, accountId) ??
            new QwenUpstreamError(
              `Qwen returned non-stream JSON response: ${errText.substring(0, 300)}`,
              "NonStreamJsonResponse",
              502,
            ),
        );
      }

      break;
    }

    phase("metadata");

    if (logger.isLevelEnabled("info")) {
      // What the upstream actually received: new vs reused chat, warm-pool
      // lease, payload weight, parent chain. The 📤 line shows the client view;
      // this is the upstream-facing counterpart.
      console.log(
        `⏱️ [Qwen] Create: ready | account=${accountId ?? "global"} | chat=${(chatSessionId ?? "new").substring(0, 12)} | ${createdNewChat ? "new-chat" : "reuse"}${leasedWarmChat ? " | warm-pool" : ""} | payload=${payloadSize}B | parent=${actualParentId ? actualParentId.substring(0, 8) : "none"} | +${Date.now() - startedAt}ms`,
      );
    }

    if (!response.ok || !response.body) {
      const contentType = response.headers.get("content-type") || "";
      const errText = contentType.includes("application/json")
        ? await response.text().catch(() => "")
        : await readResponsePreview(response);
      const antiBotChallenge = isWafChallengeResponse(errText);

      if (
        antiBotChallenge &&
        (await retryAfterCaptchaRecovery(
          `chat ${chatSessionId ?? "new"}`,
          errText,
        ))
      ) {
        const recoveredContentType = response.headers.get("content-type") || "";
        if (
          response.ok &&
          response.body &&
          recoveredContentType.includes("text/event-stream")
        ) {
          return {
            stream: wrapUpstreamStream(response.body, controller),
            headers: activeHeaders,
            uiSessionId: chatSessionId || "",
            controller,
            accountId: accountId ?? "global",
            createdNewChat,
            tokenEstimationContext,
          };
        }
      }

      // Handle 502/503/504 as retryable upstream unavailability
      if (
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        throw withCreatedChatMetadata(
          new QwenUpstreamUnavailableError(
            `Qwen upstream unavailable: ${response.status} ${response.statusText}`,
            response.status,
          ),
        );
      }

      if (contentType.includes("application/json")) {
        try {
          const parsedError = parseQwenJsonError(
            errText,
            response.status,
            accountId,
          );
          if (parsedError) {
            throw withCreatedChatMetadata(parsedError);
          }
        } catch (parseOrRetryError) {
          if (
            parseOrRetryError instanceof RetryableQwenStreamError ||
            parseOrRetryError instanceof QwenUpstreamError ||
            parseOrRetryError instanceof QwenSessionExpiredError
          ) {
            throw withCreatedChatMetadata(parseOrRetryError);
          }
          logger.warn("Unexpected error during stream error parsing", {
            error: parseOrRetryError,
          });
        }
      }
      throw withCreatedChatMetadata(
        new QwenUpstreamError(
          `Qwen completion request failed: ${response.status} ${response.statusText}`,
          isWafChallengeResponse(errText)
            ? "waf_challenge"
            : "completion_http_error",
          502,
        ),
      );
    }

    return {
      stream: wrapUpstreamStream(response.body, controller),
      headers: activeHeaders,
      uiSessionId: chatSessionId || "",
      controller,
      accountId: accountId ?? "global",
      createdNewChat,
      tokenEstimationContext,
    };
  } catch (error) {
    releaseStreamResources();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    clearTimeout(timeoutId);
  }
}
