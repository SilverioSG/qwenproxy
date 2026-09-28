/**
 * Dedicated Baxia anti-bot minter for chat.qwen.ai.
 *
 * Contract ported from sfiorini/pi-stef @f0adb33 (`packages/qwen-proxy`,
 * v0.6.5) — `src/upstream/baxia-token.ts` + `src/upstream/guest-client.ts` —
 * and corroborated by smanx/qwen2api @54f7993 (`scripts/baxia-token.js`).
 * That recipe was verified working in this exact environment: a FRESH,
 * EMPTY-PROFILE, non-stealth headless Chromium mints the material, and the
 * resulting guest cookie creates a real chat with plain HTTP.
 *
 * Why this is a separate component:
 *   The account page (stealth-patched, persistent profile) never exposes
 *   `window.__baxia__`, so the SDK cannot be harvested there. The reference
 *   sidesteps this by owning a throwaway browser. We do the same, and keep the
 *   account session/auth state completely separate.
 *
 * CRITICAL SDK DETAIL (both references call this out in comments):
 *   `window.__baxia__.getFYModule` is a FUNCTION-OBJECT. The SDK attaches
 *   `fyObj`, `getUidToken()` and `getFYToken()` to it once ready. Calling
 *   `getFYModule()` returns something else, `fyObj` stays undefined, and the
 *   SDK looks permanently uninitialised. It is READ as a property, never
 *   called. `readFyModuleAsFunctionObject()` exists so a regression is a
 *   failing assertion rather than a silent "SDK not ready".
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Only the fields the transport needs. Values are never logged. */
export interface QwenBaxiaMaterial {
  bxUa: string;
  bxUmidtoken: string;
  bxV: string;
  /** document.cookie from the minting browser. Guest flow: no token= needed. */
  cookie: string;
  userAgent: string;
  mintedAt: number;
  expiresAt: number;
}

export interface QwenBaxiaMintDiagnostics {
  ok: boolean;
  reason: string;
  uidLen: number;
  fyLen: number;
  bxV: string;
  cookieLen: number;
  hasTokenCookie: boolean;
  cookieHash: string;
  mintMs: number;
  chromePath: string;
  port: number;
  lastPageState: string;
  polls: number;
}

export const BAXIA_MINT_TTL_MS = 20 * 60 * 1000;
export const BAXIA_MINT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
export const BAXIA_CHAT_URL = "https://chat.qwen.ai";
/** Reference default; overridden by the SDK's own fyObj.ver when present. */
export const BAXIA_VERSION_DEFAULT = "2.5.37";
const POLL_MAX = 60;
const POLL_INTERVAL_MS = 500;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/home/silver/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function findChromeBinary(): string {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("Chrome not found for Baxia minting (set CHROME_PATH)");
}

/** Deterministic 5-digit seed, exactly like the reference (crc32 of host). */
export function stableFingerprintSeed(host: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < host.length; i++) {
    crc ^= host.charCodeAt(i);
    for (let k = 0; k < 8; k++) {
      crc = (Math.imul(crc >>> 1, 1) ^ (crc & 1 ? 0xedb88320 : 0)) >>> 0;
    }
  }
  return ((crc ^ 0xffffffff) >>> 0) % 90000 + 10000;
}

export function buildChromeArgs(port: number, userDataDir: string, seed: number): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    "--no-pings",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,MediaRouter",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--fingerprint=${seed}`,
    "--window-size=1280,800",
    `--user-agent=${BAXIA_MINT_UA}`,
    "about:blank",
  ];
}

/**
 * The exact in-page expression used by both references. Kept in one exported
 * constant so the read-vs-call contract is testable.
 */
export const BAXIA_READ_EXPRESSION =
  `(function(){
  var fm = (window.__baxia__||{}).getFYModule;
  if (!fm) return { ready: false, why: 'no-baxia', hasBaxia: !!window.__baxia__, href: location.href };
  if (typeof fm === 'function') return { ready: false, why: 'getFYModule-is-function-called', hasBaxia: true, href: location.href };
  if (!fm.fyObj) return { ready: false, why: 'no-fyObj', hasBaxia: true, href: location.href };
  var uid='', fy='', ver='';
  try { uid = String(fm.getUidToken()); } catch(e) {}
  try { fy = String(fm.getFYToken()); } catch(e) {}
  try { ver = (fm.fyObj && fm.fyObj.ver) ? String(fm.fyObj.ver) : ''; } catch(e) {}
  return { ready: true, uid: uid, fy: fy, ver: ver, cookie: document.cookie || '', href: location.href };
})()`;

/** Page-state probe, logged every ~5s to expose CAPTCHA/error pages instantly. */
export const BAXIA_STATE_EXPRESSION =
  `JSON.stringify({href: location.href, title: document.title, hasBaxia: !!(window.__baxia__ && window.__baxia__.getFYModule), hasFyObj: !!(window.__baxia__ && window.__baxia__.getFYModule && window.__baxia__.getFYModule.fyObj)})`;

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

/** Minimal raw-WebSocket CDP client (no Playwright), same shape as the reference. */
export function cdpConnect(wsUrl: string): CdpSession {
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const ws = new WebSocket(wsUrl);
  let opened = false;
  let openResolve!: () => void;
  let openReject!: (e: Error) => void;
  const openPromise = new Promise<void>((res, rej) => {
    openResolve = res;
    openReject = rej;
  });
  const rejectAll = (e: Error): void => {
    for (const [, p] of pending) p.reject(e);
    pending.clear();
    if (!opened) openReject(e);
  };
  ws.addEventListener("open", () => {
    opened = true;
    openResolve();
  });
  ws.addEventListener("error", () => rejectAll(new Error("cdp ws error")));
  ws.addEventListener("close", () => rejectAll(new Error("cdp ws closed")));
  ws.addEventListener("message", (ev: any) => {
    try {
      const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      if (data?.id !== undefined && pending.has(data.id)) {
        const p = pending.get(data.id)!;
        if (data.error) p.reject(new Error(String(data.error.message || "cdp error")));
        else p.resolve(data.result);
        pending.delete(data.id);
      }
    } catch {
      /* ignore */
    }
  });
  return {
    async send(method, params) {
      await openPromise;
      return new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function randomPort(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MintOptions {
  /** Overridable for tests. */
  spawnFn?: typeof spawn;
  fetcher?: typeof fetch;
  WebSocketCtor?: typeof WebSocket;
  sleepFn?: (ms: number) => Promise<void>;
  chatUrl?: string;
  userAgent?: string;
  pollMax?: number;
  pollIntervalMs?: number;
}

/** Kill the whole Chromium process tree and drop the temp profile. */
export function cleanupChrome(child: { pid?: number; kill?: (s?: string) => void }, userDataDir: string): void {
  try {
    if (child.pid && child.pid > 1) process.kill(-child.pid, "SIGKILL");
    else child.kill?.("SIGKILL");
  } catch {
    try {
      child.kill?.("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Mint anti-bot material with a dedicated throwaway browser.
 * Never throws for expected conditions: failures come back as diagnostics.
 */
export async function mintQwenBaxiaMaterialOnce(
  opts: MintOptions = {},
): Promise<{ material: QwenBaxiaMaterial | null; diag: QwenBaxiaMintDiagnostics }> {
  const started = Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const sleepFn = opts.sleepFn ?? sleep;
  const chatUrl = opts.chatUrl ?? BAXIA_CHAT_URL;
  const userAgent = opts.userAgent ?? BAXIA_MINT_UA;
  const pollMax = opts.pollMax ?? POLL_MAX;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const diag: QwenBaxiaMintDiagnostics = {
    ok: false,
    reason: "",
    uidLen: 0,
    fyLen: 0,
    bxV: "",
    cookieLen: 0,
    hasTokenCookie: false,
    cookieHash: "",
    mintMs: 0,
    chromePath: "",
    port: 0,
    lastPageState: "",
    polls: 0,
  };

  let chromePath = "";
  try {
    chromePath = findChromeBinary();
  } catch (e) {
    diag.reason = e instanceof Error ? e.message : "chrome-not-found";
    diag.mintMs = Date.now() - started;
    return { material: null, diag };
  }
  diag.chromePath = chromePath;

  const port = randomPort(9400, 9999);
  diag.port = port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-baxia-"));
  const seed = stableFingerprintSeed("direct");
  const args = buildChromeArgs(port, userDataDir, seed);
  const spawnFn = opts.spawnFn ?? spawn;
  let child: { pid?: number; kill?: (s?: string) => void };
  try {
    child = spawnFn(chromePath, args, { stdio: "ignore", detached: true }) as unknown as {
      pid?: number;
      kill?: (s?: string) => void;
    };
  } catch (e) {
    diag.reason = e instanceof Error ? e.message : "spawn-failed";
    diag.mintMs = Date.now() - started;
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* */
    }
    return { material: null, diag };
  }

  const finish = (
    material: QwenBaxiaMaterial | null,
    reason: string,
  ): { material: QwenBaxiaMaterial | null; diag: QwenBaxiaMintDiagnostics } => {
    diag.ok = material !== null;
    diag.reason = reason;
    diag.mintMs = Date.now() - started;
    if (material) {
      diag.uidLen = material.bxUmidtoken.length;
      diag.fyLen = material.bxUa.length;
      diag.bxV = material.bxV;
      diag.cookieLen = material.cookie.length;
      diag.hasTokenCookie = /(?:^|;\s*)token=/.test(material.cookie);
      diag.cookieHash = createHash("sha256")
        .update(material.cookie, "utf8")
        .digest("hex")
        .slice(0, 8);
    }
    // Sanitized log: lengths and a cookie hash only, never values.
    try {
      console.log(
        `[Baxia] mint ok=${diag.ok} reason=${reason} BAXIA_UID_LEN=${diag.uidLen} ` +
          `BAXIA_FY_LEN=${diag.fyLen} BAXIA_VERSION=${diag.bxV || "n/a"} ` +
          `BAXIA_COOKIE_LEN=${diag.cookieLen} BAXIA_HAS_TOKEN_COOKIE=${diag.hasTokenCookie} ` +
          `BAXIA_MINT_MS=${diag.mintMs}`,
      );
    } catch {
      /* logging must never break the mint */
    }
    return { material, diag };
  };

  try {
    let wsUrl: string | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetcher(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) {
          const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
          const page = list.find((e) => e.type === "page");
          if (page?.webSocketDebuggerUrl) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        /* chrome not ready */
      }
      await sleepFn(250);
    }
    if (!wsUrl) return finish(null, "no-page-target");

    const cdp = cdpConnect(wsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.navigate", { url: chatUrl });

      let data: { uid: string; fy: string; ver: string; cookie: string } | null = null;
      for (let i = 0; i < pollMax; i++) {
        diag.polls = i + 1;
        // Sleep BEFORE each check (reference ordering) so the SDK can init.
        await sleepFn(pollIntervalMs);
        if (i % 10 === 0) {
          try {
            const st = await cdp.send("Runtime.evaluate", {
              expression: BAXIA_STATE_EXPRESSION,
              returnByValue: true,
            });
            diag.lastPageState = String(st?.result?.value ?? "").slice(0, 300);
          } catch {
            /* page evaluating mid-navigation */
          }
        }
        try {
          const r = await cdp.send("Runtime.evaluate", {
            expression: BAXIA_READ_EXPRESSION,
            returnByValue: true,
          });
          const v = r?.result?.value as
            | {
                ready: boolean;
                why?: string;
                href?: string;
                uid?: string;
                fy?: string;
                ver?: string;
                cookie?: string;
              }
            | undefined;
          const href = typeof v?.href === "string" ? v.href : "";
          if (href.startsWith("chrome-error://")) {
            return finish(null, "chrome-error-page");
          }
          if (
            v?.ready &&
            typeof v.uid === "string" &&
            /^T2gA/i.test(v.uid) &&
            v.uid.length > 20
          ) {
            data = {
              uid: v.uid,
              fy: v.fy ?? "",
              ver: v.ver ?? "",
              cookie: v.cookie ?? "",
            };
            break;
          }
        } catch {
          /* evaluation failed; retry */
        }
      }
      if (!data) return finish(null, "baxia-not-ready");
      const bxV = /^\d+\.\d+\.\d+/.test(data.ver) ? data.ver : BAXIA_VERSION_DEFAULT;
      const now = Date.now();
      return finish(
        {
          bxUa: data.fy || `231!${data.uid}`,
          bxUmidtoken: data.uid,
          bxV,
          cookie: data.cookie,
          userAgent,
          mintedAt: now,
          expiresAt: now + BAXIA_MINT_TTL_MS,
        },
        "ok",
      );
    } finally {
      cdp.close();
    }
  } catch (e) {
    return finish(null, e instanceof Error ? e.message.slice(0, 120) : "mint-error");
  } finally {
    cleanupChrome(child, userDataDir);
  }
}

// ── Dedicated cache: 20 min TTL, single-flight, explicit invalidation ──────
// Deliberately NOT shared with the account auth/session caches.

let cache: QwenBaxiaMaterial | null = null;
let inflight: Promise<QwenBaxiaMaterial | null> | null = null;
let lastDiag: QwenBaxiaMintDiagnostics | null = null;

export function getCachedQwenBaxiaMaterial(): QwenBaxiaMaterial | null {
  if (!cache) return null;
  if (Date.now() >= cache.expiresAt) return null;
  return cache;
}

export function getLastBaxiaMintDiagnostics(): QwenBaxiaMintDiagnostics | null {
  return lastDiag;
}

/** Drop the cached material (explicit invalidation, e.g. after a WAF hit). */
export function invalidateQwenBaxiaMaterial(): void {
  cache = null;
}

/** Test-only reset of the dedicated cache. */
export function _resetQwenBaxiaCacheForTests(): void {
  cache = null;
  inflight = null;
  lastDiag = null;
}

/**
 * Cached, single-flight entry point. Concurrent callers share one mint.
 */
export async function mintQwenBaxiaMaterial(
  opts: { force?: boolean; mint?: MintOptions } = {},
): Promise<QwenBaxiaMaterial | null> {
  if (!opts.force) {
    const cached = getCachedQwenBaxiaMaterial();
    if (cached) return cached;
  }
  if (inflight && !opts.force) return inflight;
  const task = (async (): Promise<QwenBaxiaMaterial | null> => {
    const { material, diag } = await mintQwenBaxiaMaterialOnce(opts.mint ?? {});
    lastDiag = diag;
    if (material) cache = material;
    return material;
  })().finally(() => {
    inflight = null;
  });
  inflight = task;
  return task;
}
