/**
 * DIRECT WEB TRANSPORT for chat.qwen.ai.
 *
 * Derived from three independent, currently-working implementations audited at
 * their real code (not their READMEs):
 *
 *  - smanx/qwen2api @ 54f7993 (core.js, scripts/baxia-token.js)
 *      * headless Chrome runs the REAL Baxia SDK and reads
 *        window.__baxia__.getFYModule() -> getUidToken()/getFYToken()/fyObj.ver
 *      * those become bx-umidtoken / bx-ua / bx-v, cached 25 min
 *      * chat transport is then PURE HTTP: no UI, no composer, no clicking
 *      * POST {base}/api/v2/chats/new              {chat_mode:'guest',...}
 *      * POST {base}/api/v2/chat/completions?chat_id=<id>
 *      * NO Authorization header; auth is the `token` cookie
 *      * headers: bx-ua, bx-umidtoken, bx-v, Cookie, Origin, Referer,
 *        source:web, version, User-Agent, Accept-Language, x-request-id
 *      * WAF: body containing aliyun_waf => IP blocked; rgv587 => risk control
 *        (retry with fresh anti-bot material)
 *
 *  - izaart95-jpg/Qwen-Free-Api @ 0423802 (main.js)
 *      * auth is the `token` COOKIE, NOT a Bearer header — verified there that
 *        "Authorization: Bearer alone -> WAF CAPTCHA punish page (HTTP 200
 *        text/html)" and "Cookie: token=<jwt> -> passes WAF"
 *      * `Version` is REQUIRED by /api/v2/chat/completions; without it the
 *        endpoint answers HTTP 200 JSON {"code":"Bad_Request"}
 *      * X-Request-Id + source required by /api/v2/chats/new
 *      * frontend version scraped from the homepage bundle path
 *        /qwenweb/qwen-chat-fe/<VERSION>/js/main.js, cached 30 min, with one
 *        self-heal retry when Qwen bumps it
 *      * WAF markers: text/html response, or RGV587|FAIL_SYS_USER_VALIDATE|
 *        punish|x5sec inside a JSON body
 *
 *  - encryptarun/qwen-api @ 9fcac52 — third confirmation that the Qwen web
 *    credential is localStorage "token" from chat.qwen.ai (their own Bearer is
 *    only their hosted-API gate).
 *
 * Architectural consequence: the browser is required ONLY to produce the real
 * Baxia anti-bot material. The chat transport itself is ordinary HTTP. That is
 * why captureQwenHeaders (UI typing / send button / request interception) is
 * NOT architecturally necessary for chat.
 */

import { config } from "../core/config.ts";
import {
  getDefaultQwenUserAgent,
  getQwenWebVersion,
  updateQwenWebVersion,
} from "./qwen-headers.ts";
import { qwenUrl, qwenOrigin } from "./qwen-url.ts";
import {
  getLastBaxiaMintDiagnostics,
  mintQwenBaxiaMaterial,
} from "./qwen-baxia-minter.ts";

/**
 * Feature flag. DEFAULT IS FALSE: the legacy browser transport stays the
 * production path until the direct account transport is explicitly enabled.
 *
 * Read from `config` (not `process.env` directly) so the value resolves through
 * the same validated env schema as every other setting.
 */
export const QWEN_DIRECT_WEB_TRANSPORT_ENABLED =
  config.qwen.directWebTransport;

/** Anti-bot material TTL. qwen2api caches the SDK result for 25 minutes. */
export const BAXIA_CACHE_TTL_MS = 20 * 60 * 1000;
/** Frontend version TTL. Qwen-Free-Api caches the scrape for 30 minutes. */
export const VERSION_CACHE_TTL_MS = 30 * 60 * 1000;
/** qwen2api's hardcoded fallback when the SDK/browser is unavailable. */
export const BAXIA_VERSION_FALLBACK = "2.5.37";

/** Shape returned by the in-page Baxia probe. */
export interface BaxiaProbe {
  ready: boolean;
  uid?: string;
  fy?: string;
  ver?: string;
  /** Sanitized reason the probe is not ready yet. Never contains values. */
  diag?: {
    hasBaxia: boolean;
    baxiaKeys: string;
    hasGetFYModule: boolean;
    hasFyObj: boolean;
    getFYModuleErr: string;
    uidLen: number;
    uidPrefix: string;
    fyLen: number;
    verValue: string;
    href: string;
    scriptHosts: string;
  };
  err?: string;
}

/**
 * Compile an in-page source into a real function so Playwright serializes and
 * CALLS it. Passing the raw string makes Playwright evaluate it as an
 * expression (a function literal that is never invoked).
 */
function compileInPage<T>(source: string): (arg?: unknown) => T {
  try {
    return new Function(`return (${source});`)() as (arg?: unknown) => T;
  } catch {
    return () => null as unknown as T;
  }
}

export interface BaxiaMaterial {
  /** getFYToken() — sent as bx-ua. */
  bxUa: string;
  /** getUidToken() — T2gA... — sent as bx-umidtoken. */
  bxUmidToken: string;
  /** fyObj.ver when the SDK reports it, else the 2.5.37 constant. */
  bxV: string;
  /** document.cookie from the minting browser (guest flow: no token=). */
  cookie?: string;
  /** Whether the values came from the real SDK (vs a degraded fallback). */
  fromSdk: boolean;
  fetchedAt: number;
}

/**
 * Anti-bot material now comes exclusively from the DEDICATED minter
 * (src/services/qwen-baxia-minter.ts): a fresh, empty-profile, non-stealth
 * headless Chromium. The account page is never used — it does not expose
 * window.__baxia__ (verified), so the SDK cannot be harvested there.
 */
let lastBaxiaProbe: { reason: string } | null = null;

function toBaxiaMaterial(m: {
  bxUa: string;
  bxUmidtoken: string;
  bxV: string;
}): { bxUa: string; bxUmidToken: string; bxV: string; fromSdk: boolean; fetchedAt: number } {
  return {
    bxUa: m.bxUa,
    bxUmidToken: m.bxUmidtoken,
    bxV: m.bxV,
    fromSdk: true,
    fetchedAt: Date.now(),
  };
}

/** Sanitized readiness info for the last mint attempt. */
export function getLastBaxiaProbe(): { reason: string } | null {
  return lastBaxiaProbe;
}

export function _resetDirectTransportCachesForTests(): void {
  versionCache = null;
  versionFetchedAt = 0;
  versionInflight = null;
  lastBaxiaProbe = null;
}

/**
 * Anti-bot material for the direct transport: the guest cookie and the
 * bx-* triple minted together by the dedicated browser. Cached by the minter.
 */
export async function getBaxiaMaterial(
  _accountId?: string,
  opts: { force?: boolean } = {},
): Promise<BaxiaMaterial | null> {
  const m = await mintQwenBaxiaMaterial({ force: opts.force === true });
  if (!m) {
    const d = getLastBaxiaMintDiagnostics();
    lastBaxiaProbe = { reason: d?.reason || "unknown" };
    return null;
  }
  lastBaxiaProbe = { reason: "ok" };
  return {
    ...toBaxiaMaterial(m),
    cookie: m.cookie,
  };
}

let versionCache: string | null = null;
let versionFetchedAt = 0;
let versionInflight: Promise<string | null> | null = null;

/**
 * Frontend `version` header value.
 *
 * Qwen-Free-Api scrapes the homepage bundle path
 * `/qwenweb/qwen-chat-fe/<VERSION>/js/main.js`; qwen2api pins `0.2.83`. We do
 * the same scrape and fall back to the configured value, and we keep the
 * dynamic value in the shared store so every other call site benefits.
 */
export async function getFrontendVersion(
  opts: { force?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  if (!opts.force && versionCache && now - versionFetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache;
  }
  if (!versionInflight) {
    versionInflight = (async (): Promise<string | null> => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(qwenUrl("/"), {
            headers: {
              "User-Agent": getDirectUserAgent(),
              Accept: "text/html,application/xhtml+xml",
            },
            signal: controller.signal,
          });
          const html = await res.text();
          const m =
            html.match(/qwenweb\/qwen-chat-fe\/(\d+\.\d+\.\d+)/) ??
            html.match(/qwen-chat-fe\/(\d+\.\d+\.\d+)/);
          if (m && m[1]) {
            versionCache = m[1];
            versionFetchedAt = Date.now();
            updateQwenWebVersion(m[1]);
            return m[1];
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Keep whatever we have.
      }
      return null;
    })().finally(() => {
      versionInflight = null;
    });
  }
  const scraped = await versionInflight;
  return scraped || getQwenWebVersion();
}

function getDirectUserAgent(): string {
  return getDefaultQwenUserAgent();
}

export interface DirectHeaderInput {
  cookie: string;
  userAgent?: string;
  bxUa?: string | null;
  bxUmidToken?: string | null;
  bxV?: string | null;
  version?: string | null;
  chatSessionId?: string | null;
  referer?: string;
  acceptLanguage?: string;
  /** Guest flow: /c/guest referer and the reference's accept-language. */
  chatModeGuest?: boolean;
  /**
   * Account flow: the account's current JWT as `Authorization: Bearer <jwt>`.
   *
   * Verified live against the current upstream: account-mode /chats/new and
   * /chat/completions answer HTTP 200 {"success":false,"code":"Unauthorized"}
   * when this is absent, even with a complete, freshly-cleared cookie jar. The
   * cookie alone is the *guest* credential. Guest requests must NOT send it.
   */
  bearerToken?: string | null;
  /**
   * Omit the `version` header entirely.
   *
   * Only for POST /api/v2/chats/new. The frontend version scraped from the
   * homepage is NOT always accepted by that endpoint: with a stale value such
   * as 0.3.12 it answers HTTP 200 {"code":"unauthorized","details":"401
   * Unauthorized"} for an otherwise valid account session — same bearer, same
   * cookie jar, same User-Agent. With 0.2.91, 0.2.83, or with the header
   * omitted, the same request returns success:true. So the header is dropped
   * for chat creation rather than pinned to a value that can rot the same way.
   *
   * /api/v2/chat/completions still REQUIRES `version` and keeps sending it.
   */
  omitVersion?: boolean;
  extra?: Record<string, string>;
}

export function buildDirectQwenHeaders(input: DirectHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language":
      input.acceptLanguage ||
      (input.chatModeGuest ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9"),
    "Content-Type": "application/json",
    // Guest auth is the token cookie. Account auth additionally carries the
    // Bearer JWT (see DirectHeaderInput.bearerToken).
    Cookie: input.cookie,
    Origin: qwenOrigin(),
    Referer:
      input.referer ||
      (input.chatSessionId
        ? input.chatModeGuest
          ? qwenUrl("/c/guest")
          : qwenUrl(`/c/${encodeURIComponent(input.chatSessionId)}`)
        : input.chatModeGuest
          ? qwenUrl("/c/guest")
          : qwenUrl("/")),
    "User-Agent": input.userAgent || getDirectUserAgent(),
    "X-Request-Id": crypto.randomUUID(),
    "bx-v": input.bxV || BAXIA_VERSION_FALLBACK,
    source: "web",
    // REQUIRED by /api/v2/chat/completions; rejected by /chats/new when stale.
    ...(input.omitVersion ? {} : { version: input.version || getQwenWebVersion() }),
    timezone: new Date().toString().split(" (")[0],
    "sec-ch-ua": '"Chromium";v="151", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...(input.extra ?? {}),
  };
  if (input.bearerToken) headers["Authorization"] = `Bearer ${input.bearerToken}`;
  // qwen2api sends bx-ua/bx-umidtoken as headers on both chats/new and
  // completions, sourced from the real SDK. The proven account flow does not
  // require them, so they are only attached when the caller supplies material.
  if (input.bxUa) headers["bx-ua"] = input.bxUa;
  if (input.bxUmidToken) headers["bx-umidtoken"] = input.bxUmidToken;
  return headers;
}

export function looksLikeWafChallenge(body: string, contentType = ""): boolean {
  if (/text\/html/i.test(contentType)) {
    if (/aliyun_waf|Access[_ ]?Verification|captcha|_____tmd_____|x5secdata|x5referer|punish/i.test(body)) {
      return true;
    }
    return false;
  }
  return /RGV587|FAIL_SYS_USER_VALIDATE|aliyun_waf|punish_|x5sec/i.test(body);
}

/**
 * Pull the WAF punish/challenge URL out of a response body. The body arrives
 * JSON-wrapped today (`{"ret":[...],"data":{"url":"https://…/_____tmd_____/punish?x5sec…"}}`)
 * but the upstream has also shipped HTML/attribute forms, so all three are
 * normalized before matching. Sanitized: only the URL is returned.
 */
export function extractPunishUrl(body: string): string | null {
  if (!body) return null;
  const normalized = body
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const m = normalized.match(
    /https?:\/\/[^\s"'`\\<>()]*(?:_____tmd_____|x5secdata=|\/punish)[^\s"'`\\<>()]*/i,
  );
  if (m && m[0]) {
    try {
      return new URL(m[0]).toString().slice(0, 400);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Risk-control code qwen2api retries on with fresh anti-bot material. */
export function isRiskControlled(body: string, code?: string | null): boolean {
  if (code && /rgv.?587/i.test(code)) return true;
  return /rgv.?587/i.test(body);
}

export interface DirectCreateChatResult {
  ok: boolean;
  httpStatus: number;
  appSuccess: boolean;
  chatId: string | null;
  waf: boolean;
  riskControlled: boolean;
  contentType: string;
  errorCode: string | null;
  bodyPreview: string;
}

export async function directCreateChat(input: {
  cookie: string;
  model: string;
  chatMode?: string;
  chatType?: string;
  userAgent?: string;
  baxia?: BaxiaMaterial | null;
  version?: string | null;
  /** Account flow: current account JWT. Required for account mode. */
  bearerToken?: string | null;
  timeoutMs?: number;
}): Promise<DirectCreateChatResult> {
  // The guest cookie is minted together with the anti-bot material; when the
  // caller supplies one, use it instead of the account cookie.
  const effectiveCookie = input.cookie || input.baxia?.cookie || "";
  const accountMode = Boolean(input.bearerToken);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, input.timeoutMs ?? 25_000),
  );
  try {
    const res = await fetch(qwenUrl("/api/v2/chats/new"), {
      method: "POST",
      headers: buildDirectQwenHeaders({
        cookie: effectiveCookie,
        userAgent: input.userAgent,
        bxUa: input.baxia?.bxUa,
        bxUmidToken: input.baxia?.bxUmidToken,
        bxV: input.baxia?.bxV,
        version: input.version,
        // See DirectHeaderInput.omitVersion: a stale scraped version makes
        // /chats/new answer 401 for a perfectly valid session.
        omitVersion: true,
        bearerToken: input.bearerToken,
        // Account chats are referenced by their own session; the guest
        // referer would be wrong for them.
        referer: accountMode ? qwenUrl("/") : qwenUrl("/c/guest"),
        chatModeGuest: !accountMode,
      }),
      body: JSON.stringify({
        title: "",
        models: [input.model],
        chat_mode: input.chatMode || "normal",
        chat_type: input.chatType || "t2p",
        timestamp: Date.now(),
        project_id: "",
      }),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();
    const waf = looksLikeWafChallenge(raw, contentType);
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const appSuccess = json?.success === true;
    const chatId =
      json?.data?.id ?? json?.data?.chat_id ?? json?.chat_id ?? json?.id ?? null;
    return {
      ok: appSuccess && typeof chatId === "string" && chatId.length > 0,
      httpStatus: res.status,
      appSuccess,
      chatId: typeof chatId === "string" ? chatId : null,
      waf,
      riskControlled: isRiskControlled(raw, json?.data?.code ?? json?.code ?? null),
      contentType,
      errorCode: json?.data?.code ?? json?.code ?? null,
      bodyPreview: raw.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      appSuccess: false,
      chatId: null,
      waf: false,
      riskControlled: false,
      contentType: "",
      errorCode: null,
      bodyPreview: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DirectCompletionResult {
  ok: boolean;
  httpStatus: number;
  contentType: string;
  waf: boolean;
  /** The WAF punish/challenge URL to hand to the recovery coordinator. */
  punishUrl: string | null;
  /**
   * Full upstream body. The coordinator extracts the challenge URL from it, and
   * the 200-char `bodyPreview` TRUNCATES the x5secdata parameter, so the
   * orchestrator must pass this instead. Never logged.
   */
  challengeBody: string | null;
  sseStarted: boolean;
  sseDone: boolean;
  outputLength: number;
  bodyPreview: string;
  text: string;
}

/**
 * POST /api/v2/chat/completions?chat_id=<id> and consume the SSE stream.
 * Body shape follows qwen2api (the reference that actually works against the
 * current upstream) rather than any historical QwenProxy shape.
 */
export async function directCompletion(input: {
  cookie: string;
  chatId: string;
  model: string;
  content: string;
  chatMode?: string;
  chatType?: string;
  enableSearch?: boolean;
  thinkingEnabled?: boolean;
  userAgent?: string;
  baxia?: BaxiaMaterial | null;
  version?: string | null;
  /** Account flow: current account JWT. Required for account mode. */
  bearerToken?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<DirectCompletionResult> {
  const chatType = input.chatType || "t2p";
  const model = input.model;
  const fid = crypto.randomUUID();
  const body = JSON.stringify({
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: input.chatId,
    chatId: input.chatId,
    chat_mode: input.chatMode || "normal",
    model,
    parent_id: null,
    parentId: "",
    messages: [
      {
        id: null,
        fid,
        parentId: null,
        childrenIds: [crypto.randomUUID()],
        role: "user",
        content: input.content,
        user_action: "chat",
        files: [],
        timestamp: Date.now(),
        models: [model],
        model: "",
        chat_type: chatType,
        feature_config: {
          thinking_enabled: input.thinkingEnabled !== false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: true,
          thinking_mode: "Auto",
          thinking_format: "summary",
          auto_search: input.enableSearch === true,
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      },
    ],
    timestamp: Date.now(),
  });

  const effectiveCookie = input.cookie || input.baxia?.cookie || "";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, input.timeoutMs ?? 120_000),
  );
  try {
    const res = await fetch(
      qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(input.chatId)}`),
      {
        method: "POST",
        headers: buildDirectQwenHeaders({
          cookie: effectiveCookie,
          userAgent: input.userAgent,
          bxUa: input.baxia?.bxUa,
          bxUmidToken: input.baxia?.bxUmidToken,
          bxV: input.baxia?.bxV,
          version: input.version,
          bearerToken: input.bearerToken,
          chatSessionId: input.chatId,
          chatModeGuest: !input.bearerToken,
          extra: { "x-accel-buffering": "no" },
        }),
        body,
        signal: controller.signal,
      },
    );
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      return {
        ok: false,
        httpStatus: res.status,
        contentType,
        waf: looksLikeWafChallenge(raw, contentType),
        punishUrl: extractPunishUrl(raw),
        challengeBody: raw,
        sseStarted: false,
        sseDone: false,
        outputLength: 0,
        bodyPreview: raw.slice(0, 200),
        text: "",
      };
    }
    if (!/text\/event-stream/i.test(contentType)) {
      // JSON answer: either an app-level error or a non-streaming payload.
      const raw = await res.text().catch(() => "");
      const waf = looksLikeWafChallenge(raw, contentType);
      const punishUrl = extractPunishUrl(raw);
      const challengeBody = raw;
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      if (json && json.success === false) {
        return {
          ok: false,
          httpStatus: res.status,
          contentType,
          waf,
          punishUrl,
          challengeBody,
          sseStarted: false,
          sseDone: false,
          outputLength: 0,
          bodyPreview: raw.slice(0, 200),
          text: "",
        };
      }
      const text =
        json?.data?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.message?.content ??
        "";
      return {
        ok: Boolean(text),
        httpStatus: res.status,
        contentType,
        waf,
        punishUrl,
        challengeBody,
        sseStarted: false,
        sseDone: Boolean(text),
        outputLength: typeof text === "string" ? text.length : 0,
        bodyPreview: raw.slice(0, 200),
        text: typeof text === "string" ? text : "",
      };
    }

    // SSE: consume until DONE.
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        ok: false,
        httpStatus: res.status,
        contentType,
        waf: false,
        punishUrl: null,
        challengeBody: null,
        sseStarted: false,
        sseDone: false,
        outputLength: 0,
        bodyPreview: "no-body-reader",
        text: "",
      };
    }
    const decoder = new TextDecoder();
    const maxBytes = input.maxBytes ?? 512 * 1024;
    let buffer = "";
    let raw = "";
    let sseStarted = false;
    let sseDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      if (raw.length > maxBytes) break;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const rawFrame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = rawFrame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!payload) {
          idx = buffer.indexOf("\n\n");
          continue;
        }
        sseStarted = true;
        let obj: any = null;
        try {
          obj = JSON.parse(payload);
        } catch {
          obj = null;
        }
        if (!obj) continue;
        const info = classifySseFrame(obj);
        if (info.known) sseStarted = true;
        if (info.done) {
          sseDone = true;
          break;
        }
        idx = buffer.indexOf("\n\n");
      }
      if (sseDone) break;
    }
    // A stream that produced events and then closed at the socket IS complete:
    // the current upstream does not always send an explicit terminator, and
    // requiring one made a fully answered request report sseDone=false.
    if (!sseDone && sseStarted) {
      sseDone = raw.trim().length > 0;
    }
    const text = extractAnswerFromSse(raw);
    return {
      ok: sseStarted && text.length > 0,
      httpStatus: res.status,
      contentType,
      waf: false,
      punishUrl: null,
      challengeBody: null,
      sseStarted,
      sseDone,
      outputLength: text.length,
      bodyPreview: raw.slice(0, 200),
      text,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      contentType: "",
      waf: false,
      punishUrl: null,
      challengeBody: null,
      sseStarted: false,
      sseDone: false,
      outputLength: 0,
      bodyPreview: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      text: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify one decoded SSE frame.
 *
 * The current upstream emits OpenAI-Responses-style envelopes, where the event
 * NAME is the single top-level key:
 *
 *   data: {"response.created":        {...}}
 *   data: {"response.output_text.delta":{"delta":"OK", ...}}
 *   data: {"response.completed":      {...}}
 *
 * while older/other shapes carry `choices[].delta.content` or a `phase` field.
 * Both are accepted; the terminator list deliberately does NOT include `[DONE]`
 * alone, because the proven account stream never sends it and relying on it made
 * a working completion look truncated.
 */
export interface SseFrameInfo {
  /** Any assistant text carried by this frame. */
  delta: string;
  /** The stream terminator was observed. */
  done: boolean;
  /** The frame was a well-formed Qwen event. */
  known: boolean;
}

const DONE_EVENT_NAMES = new Set([
  "response.completed",
  "response.done",
  "response.completion",
  "response.finished",
]);

export function classifySseFrame(obj: any): SseFrameInfo {
  const info: SseFrameInfo = { delta: "", done: false, known: false };
  if (!obj || typeof obj !== "object") return info;

  // ── OpenAI-Responses envelope: the event name is the top-level key ──
  for (const key of Object.keys(obj)) {
    if (!key.startsWith("response.")) continue;
    info.known = true;
    if (DONE_EVENT_NAMES.has(key)) {
      info.done = true;
      return info;
    }
    if (key === "response.output_text.delta" || key === "response.text.delta") {
      const d = obj[key]?.delta ?? obj[key]?.text ?? obj[key]?.content;
      if (typeof d === "string") info.delta += d;
    }
    if (key === "response.output_text.done" || key === "response.text.done") {
      const d = obj[key]?.text ?? obj[key]?.content;
      if (typeof d === "string" && d.length > 0 && info.delta.length === 0) {
        info.delta += d;
      }
    }
  }

  // ── Legacy choice-delta shape ──
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const c of choices) {
    const d = c?.delta?.content ?? c?.message?.content ?? null;
    if (typeof d === "string" && d.length > 0) info.delta += d;
  }
  const nested = obj.data?.choices;
  if (Array.isArray(nested)) {
    for (const c of nested) {
      const d = c?.delta?.content ?? c?.message?.content ?? null;
      if (typeof d === "string" && d.length > 0) info.delta += d;
    }
  }
  const content = obj.data?.content;
  if (typeof content === "string" && content.length > 0) info.delta += content;

  // ── phase / type terminators ──
  const phase = obj.phase ?? obj.data?.phase ?? null;
  if (phase === "done" || obj.type === "done") info.done = true;
  if (obj.type === "text" || obj.type === "thinking" || phase) info.known = true;

  return info;
}

/**
 * Minimal answer extraction from Qwen's SSE, tolerant of both the
 * `response.*` envelope and the legacy choice-delta shape.
 */
export function extractAnswerFromSse(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj: any = null;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    out += classifySseFrame(obj).delta;
  }
  return out;
}

/**
 * Streaming variant of `directCompletion`.
 *
 * The difference that matters: nothing is emitted to the caller until the
 * response is confirmed to be a real `text/event-stream`. A WAF/risk-control
 * answer arrives as `application/json`, so the challenge is detected and can be
 * handled BEFORE any byte reaches the client — a buffered implementation would
 * already have committed to a failed response.
 *
 * Once confirmed, the body reader is pumped straight through, so the client
 * sees genuine incremental output.
 */
export interface DirectCompletionStreamResult {
  ok: boolean;
  httpStatus: number;
  contentType: string;
  waf: boolean;
  punishUrl: string | null;
  challengeBody: string | null;
  /** Non-null only when `ok` is true. */
  stream: ReadableStream<Uint8Array> | null;
}

export async function directCompletionStream(input: {
  cookie: string;
  bearerToken: string | null;
  chatId: string;
  model: string;
  content: string;
  chatMode?: string;
  chatType?: string;
  enableSearch?: boolean;
  thinkingEnabled?: boolean;
  userAgent?: string;
  baxia?: BaxiaMaterial | null;
  version?: string | null;
  signal?: AbortSignal;
  maxBytes?: number;
}): Promise<DirectCompletionStreamResult> {
  const chatType = input.chatType || "t2p";
  const model = input.model;
  const body = JSON.stringify({
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: input.chatId,
    chat_mode: input.chatMode || "normal",
    model,
    parent_id: null,
    messages: [
      {
        id: null,
        fid: crypto.randomUUID(),
        parentId: null,
        childrenIds: [crypto.randomUUID()],
        role: "user",
        content: input.content,
        user_action: "chat",
        files: [],
        timestamp: Date.now(),
        models: [model],
        model: "",
        chat_type: chatType,
        feature_config: {
          thinking_enabled: input.thinkingEnabled !== false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: true,
          thinking_mode: "Auto",
          thinking_format: "summary",
          auto_search: input.enableSearch === true,
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      },
    ],
    timestamp: Date.now(),
  });

  const effectiveCookie = input.cookie || input.baxia?.cookie || "";
  let res: Response;
  try {
    res = await fetch(
      qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(input.chatId)}`),
      {
        method: "POST",
        headers: buildDirectQwenHeaders({
          cookie: effectiveCookie,
          userAgent: input.userAgent,
          bxUa: input.baxia?.bxUa,
          bxUmidToken: input.baxia?.bxUmidToken,
          bxV: input.baxia?.bxV,
          version: input.version,
          bearerToken: input.bearerToken,
          chatSessionId: input.chatId,
          chatModeGuest: !input.bearerToken,
          extra: { "x-accel-buffering": "no" },
        }),
        body,
        signal: input.signal,
      },
    );
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      contentType: "",
      waf: false,
      punishUrl: null,
      challengeBody: null,
      stream: null,
    };
  }

  const contentType = res.headers.get("content-type") || "";
  if (!/text\/event-stream/i.test(contentType)) {
    // Not a stream: a WAF challenge, an app error, or a buffered answer. Read
    // it fully so the caller can classify, and emit NOTHING downstream.
    const raw = await res.text().catch(() => "");
    return {
      ok: false,
      httpStatus: res.status,
      contentType,
      waf: looksLikeWafChallenge(raw, contentType),
      punishUrl: extractPunishUrl(raw),
      challengeBody: raw,
      stream: null,
    };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    return {
      ok: false,
      httpStatus: res.status,
      contentType,
      waf: false,
      punishUrl: null,
      challengeBody: null,
      stream: null,
    };
  }

  const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value && value.length) {
        emitted += value.length;
        if (emitted > maxBytes) {
          await reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });

  return {
    ok: true,
    httpStatus: res.status,
    contentType,
    waf: false,
    punishUrl: null,
    challengeBody: null,
    stream,
  };
}

// ── WAF recovery orchestration ─────────────────────────────────────────────

export interface DirectRunLeg {
  create: {
    http: number;
    appSuccess: boolean;
    ok: boolean;
    chatId: string | null;
    waf: boolean;
    riskControlled: boolean;
    errorCode: string | null;
  };
  completion: DirectCompletionResult | null;
}

export interface DirectWafRunResult {
  first: DirectRunLeg;
  recoveryAttempted: boolean;
  recoverySuccess: boolean;
  recoveryDurationMs: number;
  recoverySkipReason: string | null;
  postBaxiaReady: boolean;
  second: DirectRunLeg | null;
}

async function runLeg(args: {
  baxia: BaxiaMaterial | null;
  cookie: string;
  bearerToken: string | null;
  model: string;
  content: string;
  chatMode: string;
  chatType: string;
  version: string | null;
  timeoutMs: number;
}): Promise<DirectRunLeg> {
  const created = await directCreateChat({
    cookie: args.cookie,
    model: args.model,
    chatMode: args.chatMode,
    chatType: args.chatType,
    baxia: args.baxia,
    version: args.version,
    bearerToken: args.bearerToken,
  });
  let completion: DirectCompletionResult | null = null;
  if (created.ok && created.chatId) {
    completion = await directCompletion({
      cookie: args.cookie,
      chatId: created.chatId,
      model: args.model,
      content: args.content,
      chatMode: args.chatMode,
      chatType: args.chatType,
      baxia: args.baxia,
      version: args.version,
      timeoutMs: args.timeoutMs,
    });
  }
  return {
    create: {
      http: created.httpStatus,
      appSuccess: created.appSuccess,
      ok: created.ok,
      chatId: created.chatId,
      waf: created.waf,
      riskControlled: created.riskControlled,
      errorCode: created.errorCode,
    },
    completion,
  };
}

/**
 * create-chat -> completion, with AT MOST ONE WAF recovery.
 *
 * On FAIL_SYS_USER_VALIDATE / RGV587 / _____tmd_____/punish / x5sec the
 * clearance is gone. Recovery is HUMAN: the official challenge is opened in the
 * ACCOUNT browser and a person solves it. No automated slider, no third-party
 * service. After a successful solve the cookie jar is re-read and a BRAND NEW
 * chat is issued — the pre-recovery chatId is never reused — and the completion
 * is retried exactly ONCE. A second challenge fails cleanly; there are no loops.
 *
 * Browser roles stay separated: ACCOUNT browser = session + human solve;
 * HTTP client = chats/new + completions. The dedicated Baxia minter is NOT on
 * this path (the proven account flow does not need bx-* material).
 */
export async function directChatWithWafRecovery(args: {
  accountId?: string;
  cookie: string;
  bearerToken: string | null;
  model: string;
  content: string;
  chatMode: string;
  chatType: string;
  version: string | null;
  baxia: BaxiaMaterial | null;
  timeoutMs?: number;
  allowRecovery?: boolean;
  /** Budget handed to the human solve. */
  humanSolveTimeoutMs?: number;
}): Promise<DirectWafRunResult> {
  const timeoutMs = args.timeoutMs ?? 90_000;
  const first = await runLeg({
    baxia: args.baxia,
    cookie: args.cookie,
    bearerToken: args.bearerToken,
    model: args.model,
    content: args.content,
    chatMode: args.chatMode,
    chatType: args.chatType,
    version: args.version,
    timeoutMs,
  });
  const comp = first.completion;
  const wafHit = Boolean(
    comp &&
      (comp.waf === true ||
        /RGV587|FAIL_SYS_USER_VALIDATE/i.test(comp.bodyPreview)),
  );
  if (!wafHit) {
    return {
      first,
      recoveryAttempted: false,
      recoverySuccess: false,
      recoveryDurationMs: 0,
      recoverySkipReason: null,
      postBaxiaReady: false,
      second: null,
    };
  }
  if (args.allowRecovery === false) {
    return {
      first,
      recoveryAttempted: false,
      recoverySuccess: false,
      recoveryDurationMs: 0,
      recoverySkipReason: "recovery-disabled-by-caller",
      postBaxiaReady: false,
      second: null,
    };
  }
  if (!args.accountId) {
    return {
      first,
      recoveryAttempted: false,
      recoverySuccess: false,
      recoveryDurationMs: 0,
      recoverySkipReason: "no-account-id-for-human-solve",
      postBaxiaReady: false,
      second: null,
    };
  }

  const startedAt = Date.now();
  let recoverySuccess = false;
  let recoverySkipReason: string | null = null;
  let recoveredCookie = args.cookie;
  try {
    // The clearance we were refused on is now known to be useless.
    const { invalidateX5sec } = await import("./qwen-account-session.ts");
    invalidateX5sec(args.accountId);
    const { recoverWithHumanCaptcha } = await import(
      "./qwen-human-captcha.ts"
    );
    const outcome = await recoverWithHumanCaptcha(args.accountId, {
      // FULL body: the punish URL's x5secdata is truncated in any preview.
      challengeBody: comp?.challengeBody ?? "",
      timeoutMs: args.humanSolveTimeoutMs,
    });
    recoverySuccess = outcome.solved;
    if (outcome.solved && outcome.cookieHeader) {
      recoveredCookie = outcome.cookieHeader;
    } else {
      recoverySkipReason = outcome.solved
        ? "solve-without-cookie-jar"
        : "human-solve-failed";
    }
  } catch (e) {
    recoverySkipReason =
      e instanceof Error ? e.message.slice(0, 120) : "recovery-threw";
  }
  const recoveryDurationMs = Date.now() - startedAt;
  if (!recoverySuccess) {
    return {
      first,
      recoveryAttempted: true,
      recoverySuccess: false,
      recoveryDurationMs,
      recoverySkipReason: recoverySkipReason ?? "human-solve-failed",
      postBaxiaReady: false,
      second: null,
    };
  }
  // Clearance refreshed: NEW chat with the post-solve jar. The old chatId
  // belongs to the pre-solve session and is deliberately discarded.
  const second = await runLeg({
    baxia: null,
    cookie: recoveredCookie,
    bearerToken: args.bearerToken,
    model: args.model,
    content: args.content,
    chatMode: args.chatMode,
    chatType: args.chatType,
    version: args.version,
    timeoutMs,
  });
  return {
    first,
    recoveryAttempted: true,
    recoverySuccess: true,
    recoveryDurationMs,
    recoverySkipReason: null,
    postBaxiaReady: true,
    second,
  };
}
