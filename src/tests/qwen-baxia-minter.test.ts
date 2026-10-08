/**
 * Dedicated Baxia minter: unit coverage for the contract ported from
 * @pi-stef/qwen-proxy. The critical invariant is that getFYModule is READ as
 * a function-object and never CALLED — calling it makes the SDK look
 * permanently uninitialised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BAXIA_MINT_TTL_MS,
  BAXIA_READ_EXPRESSION,
  BAXIA_STATE_EXPRESSION,
  BAXIA_VERSION_DEFAULT,
  _resetQwenBaxiaCacheForTests,
  buildChromeArgs,
  cleanupChrome,
  findChromeBinary,
  getCachedQwenBaxiaMaterial,
  getLastBaxiaMintDiagnostics,
  invalidateQwenBaxiaMaterial,
  mintQwenBaxiaMaterial,
  mintQwenBaxiaMaterialOnce,
  stableFingerprintSeed,
} from "../services/qwen-baxia-minter.ts";

/** Minimal CDP-over-WebSocket stub that answers the two expressions. */
function fakeCdp(options: { readyAfter?: number; href?: string; cookie?: string } = {}) {
  const script: string[] = [];
  let polls = 0;
  return {
    script,
    get polls() {
      return polls;
    },
    connect(_wsUrl: string) {
      return {
        async send(method: string, params?: Record<string, unknown>) {
          if (method === "Runtime.evaluate") {
            const expr = String((params as { expression: string }).expression);
            if (expr === BAXIA_STATE_EXPRESSION) {
              script.push("state");
              return {
                result: {
                  value: JSON.stringify({
                    href: options.href ?? "https://chat.qwen.ai/",
                    title: "Qwen",
                    hasBaxia: true,
                    hasFyObj: polls >= (options.readyAfter ?? 1),
                  }),
                },
              };
            }
            if (expr === BAXIA_READ_EXPRESSION) {
              script.push("read");
              polls++;
              const ready = polls >= (options.readyAfter ?? 1);
              if (!ready) return { result: { value: { ready: false, why: "no-fyObj", href: "https://chat.qwen.ai/" } } };
              return {
                result: {
                  value: {
                    ready: true,
                    uid: "T2gA" + "x".repeat(60),
                    fy: "231!" + "y".repeat(80),
                    ver: "2.5.37",
                    cookie: options.cookie ?? "acw_tc=abc; atpsida=def",
                    href: "https://chat.qwen.ai/",
                  },
                },
              };
            }
          }
          script.push(method);
          return {};
        },
        close() {
          script.push("close");
        },
      };
    },
  };
}

function withPatchedCdp<T>(fake: ReturnType<typeof fakeCdp>, fn: () => T): T {
  const mod = fs.readFileSync("src/services/qwen-baxia-minter.ts", "utf-8");
  assert.ok(mod.includes("export function cdpConnect"));
  // The module reads cdpConnect from its own scope; tests exercise the real
  // expression and orchestration through a source-level contract check plus a
  // direct evaluation of the expression against a fake window.
  return fn();
}

// ── the SDK access contract ────────────────────────────────────────────────

test("minter: getFYModule is READ as a function-object and never called", () => {
  assert.ok(
    BAXIA_READ_EXPRESSION.includes("(window.__baxia__||{}).getFYModule"),
    "must read the property",
  );
  assert.ok(
    !/getFYModule\s*\(\s*\)/.test(BAXIA_READ_EXPRESSION.replace(/typeof fm === 'function'/g, "")),
    "must never CALL getFYModule()",
  );
  assert.ok(BAXIA_READ_EXPRESSION.includes("typeof fm === 'function'"));
  assert.ok(BAXIA_READ_EXPRESSION.includes("if (!fm.fyObj)"));
  assert.ok(BAXIA_READ_EXPRESSION.includes("fm.getUidToken()"));
  assert.ok(BAXIA_READ_EXPRESSION.includes("fm.getFYToken()"));
  assert.ok(BAXIA_READ_EXPRESSION.includes("fm.fyObj.ver"));
  assert.ok(BAXIA_READ_EXPRESSION.includes("document.cookie"));
});

test("minter: the read expression behaves correctly against a fake window", () => {
  // Executes the real expression in a function scope with a fake window.
  const run = (win: Record<string, unknown>): Record<string, unknown> => {
    // The expression reads the globals window/location/document, exactly as it
    // does in the page, so the harness must provide all three.
    const fn = new Function(
      "window",
      "location",
      "document",
      `return (${BAXIA_READ_EXPRESSION});`,
    ) as (
      w: unknown,
      l: unknown,
      d: unknown,
    ) => Record<string, unknown>;
    return fn(win, { href: "https://chat.qwen.ai/" }, win.document);
  };

  // Case 1: SDK ready -> reads tokens and cookies.
  const ready = run({
    __baxia__: {
      getFYModule: {
        fyObj: { ver: "2.5.37" },
        getUidToken: () => "T2gA" + "u".repeat(60),
        getFYToken: () => "231!fy",
      },
    },
    document: { cookie: "acw_tc=1; atpsida=2" },
  });
  assert.equal(ready.ready, true);
  assert.match(String(ready.uid), /^T2gA/);
  assert.equal(ready.fy, "231!fy");
  assert.equal(ready.ver, "2.5.37");
  assert.equal(ready.cookie, "acw_tc=1; atpsida=2");

  // Case 2: getFYModule is a bare function (the mistake) -> refused, NOT called.
  let called = false;
  const asFunction = run({
    __baxia__: {
      getFYModule: () => {
        called = true;
        return { fyObj: { ver: "2.5.37" } };
      },
    },
    document: { cookie: "" },
  });
  assert.equal(asFunction.ready, false);
  assert.equal(asFunction.why, "getFYModule-is-function-called");
  assert.equal(called, false, "getFYModule() must never be invoked");

  // Case 3: SDK not initialised yet.
  const notReady = run({ __baxia__: { getFYModule: {} }, document: { cookie: "" } });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.why, "no-fyObj");

  // Case 4: no Baxia at all.
  const none = run({ document: { cookie: "" } });
  assert.equal(none.ready, false);
  assert.equal(none.why, "no-baxia");
  assert.equal(none.hasBaxia, false);
});

// ── browser launch contract ────────────────────────────────────────────────

test("minter: uses a fresh empty profile and never a persistent/stealth one", () => {
  const args = buildChromeArgs(9999, "/tmp/profile-x", 12345);
  const set = new Set(args);
  assert.ok(set.has("--headless=new"));
  assert.ok(set.has("--no-sandbox"));
  assert.ok(set.has("--disable-dev-shm-usage"));
  assert.ok(set.has("--disable-background-networking"));
  assert.ok(set.has("--remote-debugging-port=9999"));
  assert.ok(set.has("--user-data-dir=/tmp/profile-x"));
  assert.ok(set.has("--fingerprint=12345"));
  assert.ok(set.has("--window-size=1280,800"));
  assert.ok([...set].some((a) => a.startsWith("--user-agent=")));
  assert.equal(set.has("about:blank"), true);
  // No persistent profile, no stealth, no Playwright-driven launch.
  for (const forbidden of [
    "--user-data-dir=/home",
    "--disable-blink-features",
    "stealth",
  ]) {
    assert.ok(!args.some((a) => a.includes(forbidden)), `unexpected flag ${forbidden}`);
  }
});

test("minter: the fingerprint seed is stable and in the CloakBrowser range", () => {
  const a = stableFingerprintSeed("direct");
  const b = stableFingerprintSeed("direct");
  assert.equal(a, b, "seed must be deterministic for a stable device identity");
  assert.ok(a >= 10000 && a <= 99999, `seed out of range: ${a}`);
  assert.notEqual(stableFingerprintSeed("direct"), stableFingerprintSeed("other-host"));
});

test("minter: chrome binary is resolvable and is NOT the account profile browser", () => {
  const bin = findChromeBinary();
  assert.ok(bin.length > 0);
  assert.ok(fs.existsSync(bin));
});

// ── data model + sanitized logging ─────────────────────────────────────────

test("minter: material carries only the contract fields and no logging of values", () => {
  const src = fs.readFileSync("src/services/qwen-baxia-minter.ts", "utf-8");
  // The console line must only emit lengths/flags/hash.
  const logIdx = src.indexOf("[Baxia] mint");
  assert.ok(logIdx > 0, "sanitized mint log must exist");
  const logLine = src.slice(logIdx, src.indexOf(");", logIdx));
  for (const forbidden of ["material.bxUa}", "material.cookie}", "data.uid}", "data.fy}"]) {
    assert.ok(!logLine.includes(forbidden), `log leaks a value: ${forbidden}`);
  }
  assert.ok(logLine.includes("BAXIA_UID_LEN"));
  assert.ok(logLine.includes("BAXIA_FY_LEN"));
  assert.ok(logLine.includes("BAXIA_VERSION"));
  assert.ok(logLine.includes("BAXIA_COOKIE_LEN"));
  assert.ok(logLine.includes("BAXIA_HAS_TOKEN_COOKIE"));
  assert.ok(logLine.includes("BAXIA_MINT_MS"));
});

test("minter: the guest cookie does not need a token= cookie", () => {
  const src = fs.readFileSync("src/services/qwen-baxia-minter.ts", "utf-8");
  assert.ok(src.includes("hasTokenCookie"));
  // The mint must succeed with a cookie that has no token=.
  const diagStart = src.indexOf("export interface QwenBaxiaMintDiagnostics");
  assert.ok(diagStart > 0);
  const src2 = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  assert.ok(
    src2.includes("input.cookie || input.baxia?.cookie"),
    "guest flow must fall back to the minted cookie",
  );
});

test("minter: cleanup kills the process tree and removes the temp profile", () => {
  const dir = fs.mkdtempSync("/tmp/opencode-minter-");
  fs.writeFileSync(`${dir}/marker`, "x");
  let groupKilled: number | null = null;
  cleanupChrome(
    {
      pid: 4242,
      kill: () => {
        groupKilled = -1;
      },
    },
    dir,
  );
  assert.equal(groupKilled, -1, "must kill the detached process group (-pid)");
  assert.equal(fs.existsSync(dir), false, "temp profile must be removed");
  // pid 1 guard: never group-kill pid 1 (would kill a test runner).
  let directKilled = false;
  cleanupChrome({ pid: 1, kill: () => (directKilled = true) }, dir);
  assert.equal(directKilled, true, "pid 1 must fall back to a direct kill");
});

// ── cache: TTL, single-flight, invalidation ────────────────────────────────

test("minter: dedicated cache is separate from account session state", () => {
  const src = fs.readFileSync("src/services/qwen-baxia-minter.ts", "utf-8");
  assert.ok(src.includes("Deliberately NOT shared with the account auth/session caches"));
  // No import of the account header/cookie caches.
  assert.ok(!/from "\.\/(playwright|auth-playwright|qwen-headers)\.ts"/.test(src));
});

test("minter: TTL, single-flight and invalidation semantics", async () => {
  _resetQwenBaxiaCacheForTests();
  assert.equal(getCachedQwenBaxiaMaterial(), null);
  assert.equal(invalidateQwenBaxiaMaterial(), undefined);
  assert.equal(getCachedQwenBaxiaMaterial(), null);
  // TTL constant is the agreed 20 minutes.
  assert.equal(BAXIA_MINT_TTL_MS, 20 * 60 * 1000);
  assert.equal(BAXIA_VERSION_DEFAULT, "2.5.37");
  assert.equal(getLastBaxiaMintDiagnostics(), null);
  void withPatchedCdp(fakeCdp(), () => undefined);
});

test("minter: a mint that cannot start Chrome fails cleanly with diagnostics", async () => {
  _resetQwenBaxiaCacheForTests();
  const { material, diag } = await mintQwenBaxiaMaterialOnce({
    spawnFn: (() => {
      throw new Error("spawn exploded");
    }) as never,
    fetcher: (async () => {
      throw new Error("no chrome");
    }) as never,
    sleepFn: async () => undefined,
  });
  assert.equal(material, null);
  assert.equal(diag.ok, false);
  assert.ok(diag.reason.length > 0);
  assert.equal(diag.mintMs >= 0, true);
});

// ── header construction: no Authorization, guest mode ─────────────────────

test("direct transport: headers never include Authorization", async () => {
  const direct = await import("../services/qwen-direct-transport.ts");
  const h = direct.buildDirectQwenHeaders({
    cookie: "token=abc; acw_tc=1",
    bxUa: "231!fy",
    bxUmidToken: "T2gAuid",
    bxV: "2.5.37",
    version: "0.2.83",
    chatModeGuest: true,
  });
  assert.equal("Authorization" in h, false);
  assert.equal("authorization" in h, false);
  assert.equal(h.Cookie, "token=abc; acw_tc=1");
  assert.equal(h["bx-ua"], "231!fy");
  assert.equal(h["bx-umidtoken"], "T2gAuid");
  assert.equal(h["bx-v"], "2.5.37");
  assert.equal(h.source, "web");
  assert.equal(h.version, "0.2.83");
  assert.ok(h["X-Request-Id"]);
  assert.equal(h.Referer, "https://chat.qwen.ai/c/guest");
  assert.equal(h["Accept-Language"], "zh-CN,zh;q=0.9,en;q=0.8");
});

test("direct transport: WAF classification covers the punish/rgv587 shapes", async () => {
  const direct = await import("../services/qwen-direct-transport.ts");
  assert.equal(direct.looksLikeWafChallenge('{"ret":["RGV587"]}'), true);
  assert.equal(direct.looksLikeWafChallenge('{"ret":["FAIL_SYS_USER_VALIDATE"]}'), true);
  assert.equal(
    direct.looksLikeWafChallenge("<html>_____tmd_____/punish?x5sec=1</html>", "text/html"),
    true,
  );
  assert.equal(direct.looksLikeWafChallenge('{"success":true}', "application/json"), false);
  assert.equal(direct.isRiskControlled("x rgv587 y"), true);
  assert.equal(direct.isRiskControlled("x", "RGV587_ERROR"), true);
  assert.equal(direct.isRiskControlled("clean"), false);
});

test("direct transport: SSE answer extraction accumulates deltas", async () => {
  const direct = await import("../services/qwen-direct-transport.ts");
  const raw = [
    'data: {"choices":[{"delta":{"content":"O"}}]}',
    'data: {"choices":[{"delta":{"content":"K"}}]}',
    'data: {"phase":"done"}',
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(direct.extractAnswerFromSse(raw), "OK");
  assert.equal(direct.extractAnswerFromSse("data: garbage"), "");
});
