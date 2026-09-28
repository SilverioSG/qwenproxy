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

export const QWEN_DIRECT_WEB_TRANSPORT_ENABLED =
  process.env.QWEN_DIRECT_WEB_TRANSPORT !== "false";

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
}

export interface BaxiaMaterial {
  /** getFYToken() — sent as bx-ua. */
  bxUa: string;
  /** getUidToken() — T2gA... — sent as bx-umidtoken. */
  bxUmidToken: string;
  /** fyObj.ver when the SDK reports it, else the 2.5.37 constant. */
  bxV: string;
  /** Whether the values came from the real SDK (vs a degraded fallback). */
  fromSdk: boolean;
  fetchedAt: number;
}

const baxiaCache = new Map<string, BaxiaMaterial>();
let baxiaInflight = new Map<string, Promise<BaxiaMaterial | null>>();

export function _resetDirectTransportCachesForTests(): void {
  baxiaCache.clear();
  baxiaInflight = new Map();
  versionCache = null;
  versionFetchedAt = 0;
  versionInflight = null;
}

/**
 * Read the real Baxia anti-bot material from the account's live page.
 *
 * The page is already on chat.qwen.ai for the account, which means the Baxia
 * SDK (`window.__baxia__`) is already loaded — the same object qwen2api
 * reaches for via CDP. No typing, no clicking, no request interception.
 */
export async function getBaxiaMaterial(
  accountId: string,
  opts: { force?: boolean; baxiaWaitMs?: number } = {},
): Promise<BaxiaMaterial | null> {
  const cached = baxiaCache.get(accountId);
  const now = Date.now();
  if (!opts.force && cached && now - cached.fetchedAt < BAXIA_CACHE_TTL_MS) {
    return cached;
  }
  const inflight = baxiaInflight.get(accountId);
  if (inflight && !opts.force) return inflight;

  const task = (async (): Promise<BaxiaMaterial | null> => {
    try {
      const playwright = await import("./playwright.ts");
      let handles = playwright.getAccountPageSnapshotHandles(accountId);
      if (!handles) {
        // The account page is created lazily. The browser is needed ONLY to
        // host the real Baxia SDK (qwen2api reaches the very same
        // window.__baxia__ object, just through its own CDP connection).
        try {
          const { loadAccounts } = await import("../core/accounts.ts");
          const acct = loadAccounts().find((a) => a.id === accountId);
          if (acct) {
            await playwright.initPlaywrightForAccount(acct, undefined, undefined, {
              // No UI capture: the transport no longer needs it.
              skipHeaderCapture: true,
            });
          }
        } catch {
          // Fall through: a missing page means no anti-bot material.
        }
        handles = playwright.getAccountPageSnapshotHandles(accountId);
      }
      if (!handles) return null;
      // The SDK lives on the chat document; make sure we are on it.
      try {
        const pg = handles.page as { url?: () => string; goto?: unknown };
        const current = typeof pg.url === "function" ? pg.url() : "";
        if (!current.includes("chat.qwen.ai")) {
          await (
            pg as unknown as {
              goto: (u: string, o: unknown) => Promise<unknown>;
            }
          ).goto(qwenUrl("/"), { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
      } catch {
        // Navigation problems are handled by the evaluate below returning
        // not-ready.
      }
      const page = handles.page as {
        evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
      };
      // The SDK needs time: qwen2api polls up to 60 x 500ms waiting for
      // getFYModule().fyObj and a T2gA uid token. Same wait, same shape.
      let raw: BaxiaProbe | null = null;
      const deadline = Date.now() + (opts.baxiaWaitMs ?? 25_000);
      while (Date.now() < deadline) {
        const attempt = (await page
          .evaluate(BAXIA_EXTRACT_FN as unknown as () => unknown)
          .catch(() => null)) as BaxiaProbe | null;
        if (attempt && attempt.ready) {
          const uidNow = typeof attempt.uid === "string" ? attempt.uid : "";
          if (/^T2gA/i.test(uidNow) && uidNow.length > 20) {
            raw = attempt;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!raw || !raw.ready) return null;
      const uid = typeof raw.uid === "string" ? raw.uid : "";
      if (!/^T2gA/i.test(uid) || uid.length <= 20) return null;
      const fy = typeof raw.fy === "string" && raw.fy.length > 0 ? raw.fy : `231!${uid}`;
      const ver =
        typeof raw.ver === "string" && /^\d+\.\d+\.\d+/.test(raw.ver)
          ? raw.ver
          : BAXIA_VERSION_FALLBACK;
      const material: BaxiaMaterial = {
        bxUa: fy,
        bxUmidToken: uid,
        bxV: ver,
        fromSdk: true,
        fetchedAt: Date.now(),
      };
      baxiaCache.set(accountId, material);
      return material;
    } catch {
      return null;
    } finally {
      baxiaInflight.delete(accountId);
    }
  })();
  baxiaInflight.set(accountId, task);
  return task;
}

/**
 * In-page Baxia extraction. Array-literal helpers only: esbuild with keepNames
 * rewrites named function expressions to __name(f, "f"), and __name does not
 * exist in the page (regression d3c7140).
 */
export const BAXIA_EXTRACT_FN = `
() => {
  try {
    const b = window.__baxia__;
    const fm = b && b.getFYModule ? b.getFYModule() : null;
    if (!fm || !fm.fyObj) return { ready: false };
    let uid = "";
    let fy = "";
    try { uid = String(fm.getUidToken()); } catch (e) {}
    try { fy = String(fm.getFYToken()); } catch (e) {}
    return {
      ready: true,
      uid: uid,
      fy: fy,
      ver: (fm.fyObj && fm.fyObj.ver) ? String(fm.fyObj.ver) : "",
    };
  } catch (e) {
    return { ready: false };
  }
}
`;

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
  extra?: Record<string, string>;
}

export function buildDirectQwenHeaders(input: DirectHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": input.acceptLanguage || "en-US,en;q=0.9",
    "Content-Type": "application/json",
    // Auth is the token COOKIE. A Bearer header is what triggers the Aliyun WAF
    // punish page (verified in Qwen-Free-Api), so it is never added here.
    Cookie: input.cookie,
    Origin: qwenOrigin(),
    Referer:
      input.referer ||
      (input.chatSessionId
        ? qwenUrl(`/c/${encodeURIComponent(input.chatSessionId)}`)
        : qwenUrl("/")),
    "User-Agent": input.userAgent || getDirectUserAgent(),
    "X-Request-Id": crypto.randomUUID(),
    "bx-v": input.bxV || BAXIA_VERSION_FALLBACK,
    source: "web",
    // REQUIRED by /api/v2/chat/completions (Qwen-Free-Api).
    version: input.version || getQwenWebVersion(),
    timezone: new Date().toString().split(" (")[0],
    "sec-ch-ua": '"Chromium";v="151", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...(input.extra ?? {}),
  };
  // qwen2api sends bx-ua/bx-umidtoken as headers on both chats/new and
  // completions, sourced from the real SDK.
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
  timeoutMs?: number;
}): Promise<DirectCreateChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, input.timeoutMs ?? 25_000),
  );
  try {
    const res = await fetch(qwenUrl("/api/v2/chats/new"), {
      method: "POST",
      headers: buildDirectQwenHeaders({
        cookie: input.cookie,
        userAgent: input.userAgent,
        bxUa: input.baxia?.bxUa,
        bxUmidToken: input.baxia?.bxUmidToken,
        bxV: input.baxia?.bxV,
        version: input.version,
        referer: qwenUrl("/"),
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
          cookie: input.cookie,
          userAgent: input.userAgent,
          bxUa: input.baxia?.bxUa,
          bxUmidToken: input.baxia?.bxUmidToken,
          bxV: input.baxia?.bxV,
          version: input.version,
          chatSessionId: input.chatId,
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
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = frame
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
        if (obj.type === "text" || obj.type === "thinking") {
          if (obj.data && typeof obj.data === "string") {
            // accumulate below
          }
        }
        const phase = obj.phase ?? obj.data?.phase ?? null;
        if (phase === "answer" || phase === "final_answer") sseStarted = true;
        if (phase === "done" || obj.type === "done") {
          sseDone = true;
          break;
        }
        idx = buffer.indexOf("\n\n");
      }
      if (sseDone) break;
    }
    const text = extractAnswerFromSse(raw);
    return {
      ok: sseStarted && text.length > 0,
      httpStatus: res.status,
      contentType,
      waf: false,
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
 * Minimal answer extraction from Qwen's SSE. Mirrors the shapes both working
 * references rely on: a `data:` JSON frame per delta, and an explicit
 * phase=done terminator.
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
    if (!obj || typeof obj !== "object") continue;
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const c of choices) {
      const delta = c?.delta?.content ?? c?.message?.content ?? null;
      if (typeof delta === "string" && delta.length > 0) out += delta;
    }
    const detail = obj.data?.choices;
    if (Array.isArray(detail)) {
      for (const c of detail) {
        const delta = c?.delta?.content ?? c?.message?.content ?? null;
        if (typeof delta === "string" && delta.length > 0) out += delta;
      }
    }
    const content = obj.data?.content;
    if (typeof content === "string" && content.length > 0) out += content;
  }
  return out;
}
