/**
 * Focal tests for the modern no-browser auth layer (qwen-token-refresh) and
 * its SQLite persistence. Uses the repo's own test isolation (data-test/
 * under node:test) plus an injected fetch — no network, no browser, no
 * production data. Never touches real accounts.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  deleteAuthSession,
  getRefreshMaterial,
  getValidAuthSession,
  saveAuthSession,
} from "../core/database.ts";
import { getDbPath, resolveDataDir } from "../core/paths.ts";
import {
  QWEN_REFRESH_MARGIN_MS,
  QWEN_REFRESH_URL,
  _refreshSingleFlightSizeForTests,
  _resetRefreshSingleFlightForTests,
  _setRefreshFetchForTests,
  ensureAccountFresh,
  getJarPair,
  hasRefreshMaterial,
  mergeSetCookiesIntoJar,
  needsRefresh,
  parseRefreshBody,
  refreshWithJar,
  replaceRefreshInJar,
  setCookiePairInJar,
  tryRefreshToken,
  type RefreshFetch,
} from "../services/qwen-token-refresh.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(expSec: number): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "u-test", exp: expSec })}.sig`;
}

function futureJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) + 3600);
}

function expiredJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) - 3600);
}

function freshAccessJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) + 900);
}

const createdIds: string[] = [];
let idSeq = 0;
function seedSession(overrides: {
  access?: string;
  refresh?: string | null;
  extraCookies?: string;
  tokenExpiresAt?: number | null;
  refreshField?: string | null | "omit";
}): string {
  const id = `refresh-test-${Date.now()}-${idSeq++}`;
  createdIds.push(id);
  const access = overrides.access ?? futureJwt();
  const pairs = [`token=${access}`];
  if (overrides.refresh !== null) {
    pairs.push(`refresh_token=${overrides.refresh ?? "R-OLD-material"}`);
  }
  if (overrides.extraCookies) pairs.push(overrides.extraCookies);
  const exp =
    overrides.tokenExpiresAt !== undefined
      ? overrides.tokenExpiresAt
      : Math.floor(Date.now() / 1000) + 3600;
  const payload: Record<string, unknown> = {
    cookie: pairs.join("; "),
    userAgent: "ua-test",
    bxV: "2.5.37",
    bxUa: "test-bx-ua",
    bxUmidtoken: "test-bx-umidtoken",
    tokenExpiresAt: exp ?? undefined,
    capturedAt: Date.now(),
  };
  if (overrides.refreshField !== "omit") {
    payload.refreshToken = overrides.refreshField ?? "R-OLD-material";
  }
  saveAuthSession(id, payload as never);
  return id;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    try {
      deleteAuthSession(id);
    } catch {}
  }
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

// ─── pure helpers ───────────────────────────────────────────────────────────

test("jar: setCookiePairInJar replaces, appends, and is $-safe", () => {
  assert.equal(setCookiePairInJar("a=1; token=OLD; b=2", "token", "NEW"), "a=1; token=NEW; b=2");
  assert.equal(setCookiePairInJar("", "token", "T"), "token=T");
  assert.equal(setCookiePairInJar("a=1", "token", "T"), "a=1; token=T");
  // `$` sequences in values must not act as replacement patterns.
  assert.equal(setCookiePairInJar("token=OLD", "token", "$&$'"), "token=$&$'");
  assert.equal(replaceRefreshInJar("a=1; refresh_token=OLD", "NEW"), "a=1; refresh_token=NEW");
  assert.equal(replaceRefreshInJar("", "NEW"), "refresh_token=NEW");
  assert.equal(getJarPair("a=1; token=ABC; b=2", "token"), "ABC");
  assert.equal(getJarPair("a=1", "token"), null);
});

test("jar: mergeSetCookiesIntoJar folds rotation, preserves the rest", () => {
  const { jar, names } = mergeSetCookiesIntoJar("a=1; token=OLD; w=9", [
    "token=NEW; Path=/; Domain=.qwen.ai",
    "extra=7; Path=/",
  ]);
  assert.deepEqual(names, ["token", "extra"]);
  assert.ok(jar.includes("token=NEW"));
  assert.ok(jar.includes("a=1"));
  assert.ok(jar.includes("w=9"));
  assert.ok(jar.includes("extra=7"));
});

test("contract: hasRefreshMaterial / needsRefresh margin", () => {
  assert.equal(hasRefreshMaterial("token=A; refresh_token=B"), true);
  assert.equal(hasRefreshMaterial("token=A"), false);
  assert.equal(hasRefreshMaterial(null), false);
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(needsRefresh(nowSec + 3600), false);
  assert.equal(needsRefresh(nowSec + 240), true); // inside 5min margin
  assert.equal(needsRefresh(nowSec + 400), false); // outside 5min margin
  assert.equal(needsRefresh(nowSec - 10), true);
  assert.equal(needsRefresh(null), false); // legacy-tolerant
  assert.equal(needsRefresh(undefined), false);
  assert.equal(QWEN_REFRESH_MARGIN_MS, 5 * 60 * 1000);
});

test("contract: parseRefreshBody accepts both field shapes", () => {
  assert.deepEqual(parseRefreshBody({ data: { access_token: "A", refresh_token: "R" } }), {
    access: "A",
    incomingRefresh: "R",
  });
  assert.deepEqual(parseRefreshBody({ data: { token: "A", refreshToken: "R" } }), {
    access: "A",
    incomingRefresh: "R",
  });
  assert.deepEqual(parseRefreshBody({ data: {} }), { access: null, incomingRefresh: null });
  assert.deepEqual(parseRefreshBody(null), { access: null, incomingRefresh: null });
});

// ─── 1. valid token loads without network ───────────────────────────────────

test("1: valid persisted access token → fresh, no fetch", async () => {
  let calls = 0;
  const fetchFn: RefreshFetch = async () => {
    calls++;
    return jsonResponse({ success: true, data: {} });
  };
  const id = seedSession({});
  const fresh = await ensureAccountFresh(id, { fetchFn });
  assert.equal(fresh, true);
  assert.equal(calls, 0);
  assert.equal(_refreshSingleFlightSizeForTests(), 0);
});

// ─── 2/3/4. expired + material → success, preservation ──────────────────────

test("2/3/4: expired token + material → refresh ok, keeps refresh + jar", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const freshTok = freshAccessJwt();
  const fetchFn: RefreshFetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return jsonResponse({ success: true, data: { access_token: freshTok } });
  };
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-OLD-material",
    extraCookies: "cna=ABC; x5sec=dummy",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
    refreshField: "R-OLD-material",
  });

  const result = await tryRefreshToken(id, { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.rotated, false);

  // Exact validated contract.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, QWEN_REFRESH_URL);
  const headers = new Headers(seen[0].init.headers as HeadersInit);
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.body, undefined);
  assert.equal(headers.get("source"), "web");
  assert.equal(headers.get("x-request-origin"), "https://chat.qwen.ai");
  assert.equal(headers.get("Version"), "0.3.11");
  assert.ok((headers.get("X-Request-Id") ?? "").length >= 8);
  assert.ok((headers.get("Timezone") ?? "").length > 0);
  assert.equal(headers.get("accept"), "application/json, text/plain, */*");
  assert.equal(headers.get("origin"), "https://chat.qwen.ai");
  assert.equal(headers.get("referer"), "https://chat.qwen.ai/");
  assert.ok((headers.get("Cookie") ?? "").includes("refresh_token=R-OLD-material"));
  assert.equal(headers.get("Authorization"), null);

  // Persistence: new access, preserved refresh + jar companions.
  const material = getRefreshMaterial(id);
  assert.ok(material);
  assert.equal(getJarPair(material!.jar, "token"), freshTok);
  assert.equal(getJarPair(material!.jar, "refresh_token"), "R-OLD-material");
  assert.equal(material!.refreshToken, "R-OLD-material");
  assert.ok(material!.jar.includes("cna=ABC"));
  assert.ok(material!.jar.includes("x5sec=dummy"));
  assert.ok(
    Math.abs((material!.tokenExpiresAtSec ?? 0) - (Math.floor(Date.now() / 1000) + 900)) < 30,
  );
});

// ─── 5. rotation ────────────────────────────────────────────────────────────

test("5: rotated refresh token replaces jar pair + field", async () => {
  const freshTok = freshAccessJwt();
  const fetchFn: RefreshFetch = async () =>
    jsonResponse({ success: true, data: { access_token: freshTok, refresh_token: "R-NEW-rotated" } });
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-OLD-material",
    extraCookies: "cna=ABC",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
    refreshField: "R-OLD-material",
  });
  const result = await tryRefreshToken(id, { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.rotated, true);
  const material = getRefreshMaterial(id);
  assert.equal(getJarPair(material!.jar, "refresh_token"), "R-NEW-rotated");
  assert.equal(material!.refreshToken, "R-NEW-rotated");
  assert.ok(material!.jar.includes("cna=ABC"));
});

// ─── 6. single-flight ───────────────────────────────────────────────────────

test("6: concurrent ensureAccountFresh shares one refresh", async () => {
  let calls = 0;
  let release!: (v: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchFn: RefreshFetch = async () => {
    calls++;
    return gate;
  };
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-SHARED",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
  });
  const pending = Array.from({ length: 5 }, () => ensureAccountFresh(id, { fetchFn }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(_refreshSingleFlightSizeForTests(), 1);
  release(jsonResponse({ success: true, data: { access_token: freshAccessJwt() } }));
  const results = await Promise.all(pending);
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(calls, 1);
  assert.equal(_refreshSingleFlightSizeForTests(), 0);
});

// ─── 7. no browser on restore/refresh ───────────────────────────────────────

test("7: refresh path never touches the browser", async () => {
  // Static guarantee: the refresh module must not statically import any
  // browser layer, open profiles, or close browsers. The single dynamic
  // import("./playwright.ts") is the best-effort in-memory cache push (no
  // profile open, no navigation) — allowed, everything else is forbidden.
  const src = fs.readFileSync(
    path.resolve("src/services/qwen-token-refresh.ts"),
    "utf-8",
  );
  assert.ok(!/from\s+["']\.\/playwright\.ts["']/.test(src), "no static playwright import");
  assert.ok(!src.includes("patchright"), "must not import patchright");
  assert.ok(!src.includes("launchPersistentContext"), "must not open profiles");
  assert.ok(!src.includes("Browser.close"), "no browser close handling here");
  assert.ok(!src.includes("newPage"), "no page creation here");
  const dynamicUses = (src.match(/import\("\.\/playwright\.ts"\)/g) ?? []).length;
  assert.equal(
    dynamicUses,
    2,
    "only the live-jar observe + cache-push bridges may touch playwright",
  );

  // Behavioral: an expired session renews with zero browser state involved.
  const fetchFn: RefreshFetch = async () =>
    jsonResponse({ success: true, data: { access_token: freshAccessJwt() } });
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-NOBROWSER",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
  });
  const ok = await ensureAccountFresh(id, { fetchFn });
  assert.equal(ok, true);
});

// ─── 8. failures preserve persisted auth ────────────────────────────────────

test("8: failed refresh never destroys persisted material", async () => {
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-KEEP",
    extraCookies: "cna=ABC",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
    refreshField: "R-KEEP",
  });
  const before = getRefreshMaterial(id);

  // Application-level Unauthorized.
  const r1 = await tryRefreshToken(id, {
    fetchFn: async () =>
      jsonResponse({ success: false, data: { code: "Unauthorized", details: "revoked?" } }),
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "Unauthorized");

  // HTTP 401.
  const r2 = await tryRefreshToken(id, {
    fetchFn: async () => new Response("nope", { status: 401 }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "Http_401");

  // Transport failure.
  const r3 = await tryRefreshToken(id, {
    fetchFn: async () => {
      throw new Error("socket hangup");
    },
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "TransportError");

  const after = getRefreshMaterial(id);
  assert.equal(after!.jar, before!.jar);
  assert.equal(after!.refreshToken, before!.refreshToken);
  assert.equal(after!.tokenExpiresAtSec, before!.tokenExpiresAtSec);

  // ensureAccountFresh with dead material + expired token → false, no throw.
  const fresh = await ensureAccountFresh(id, {
    fetchFn: async () => {
      throw new Error("down");
    },
  });
  assert.equal(fresh, false);
  assert.equal(_refreshSingleFlightSizeForTests(), 0);
});

// ─── 9. legacy compatibility ────────────────────────────────────────────────

test("9: legacy account without new fields still loads", async () => {
  // Legacy shape: NULL refresh bookkeeping, jar-only material.
  const id = seedSession({ refreshField: "omit" });
  const session = getValidAuthSession(id);
  assert.ok(session, "legacy row must load");
  assert.equal(session!.refreshToken, null);
  // Jar-derived material still works for refresh detection.
  const material = getRefreshMaterial(id);
  assert.ok(material);
  assert.equal(material!.refreshToken, "R-OLD-material");
  // Valid access token → fresh without network.
  let calls = 0;
  const fresh = await ensureAccountFresh(id, {
    fetchFn: async () => {
      calls++;
      return jsonResponse({});
    },
  });
  assert.equal(fresh, true);
  assert.equal(calls, 0);
});

// ─── 10. isolation ──────────────────────────────────────────────────────────

test("10: tests run against an isolated database, never production", () => {
  // Under node:test the data dir resolves to the throwaway data-test/.
  assert.ok(
    getDbPath().includes("data-test"),
    `expected isolated db, got ${getDbPath()}`,
  );
  // Explicit env override is honored for temp dirs.
  const tmp = fs.mkdtempSync(path.join("/tmp/opencode", "qwenproxy-test-"));
  try {
    assert.ok(resolveDataDir({ envDataDir: tmp }).startsWith(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Production database file is untouched by this suite (mtime guard lives
  // with the operator; here we assert we never resolve to it).
  assert.ok(!getDbPath().includes(".local/share"));
});

// ─── 11. pre-request path ───────────────────────────────────────────────────

test("11: pre-request hook renews an expired session before headers", async () => {
  let calls = 0;
  const fetchFn: RefreshFetch = async () => {
    calls++;
    return jsonResponse({ success: true, data: { access_token: freshAccessJwt() } });
  };
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-PREREQ",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 5,
  });
  // This is exactly what auth-playwright.getBasicHeaders and
  // qwen-account-session.captureAccountSession invoke before building
  // upstream headers.
  const fresh = await ensureAccountFresh(id, { fetchFn });
  assert.equal(fresh, true);
  assert.equal(calls, 1);
  // Second call is a fast-path hit: no second network call.
  const fresh2 = await ensureAccountFresh(id, { fetchFn });
  assert.equal(fresh2, true);
  assert.equal(calls, 1);
});

test("11b: mock-auth suites short-circuit without storage or network", async () => {
  const prev = process.env.TEST_MOCK_QWEN_AUTH;
  process.env.TEST_MOCK_QWEN_AUTH = "true";
  try {
    let calls = 0;
    const fresh = await ensureAccountFresh("mock-account", {
      fetchFn: async () => {
        calls++;
        return jsonResponse({});
      },
    });
    assert.equal(fresh, true);
    assert.equal(calls, 0);
  } finally {
    if (prev === undefined) delete process.env.TEST_MOCK_QWEN_AUTH;
    else process.env.TEST_MOCK_QWEN_AUTH = prev;
  }
});

// ─── 12. routing untouched ──────────────────────────────────────────────────

test("12: request routing files keep no auth duplication", () => {
  // The refresh hook is centralized: only the header/session getters may
  // import the refresh module. Routes must not grow their own hooks.
  const allowed = new Set([
    "src/services/auth-playwright.ts",
    "src/services/qwen-account-session.ts",
    "src/services/playwright.ts",
    "src/services/manual-verification.ts",
    "src/services/qwen-token-refresh.ts",
    // Single sanctioned operational exception: the API-key-guarded
    // POST /diagnostics/refresh endpoint (status fields only, no secrets).
    "src/api/server.ts",
  ]);
  const routeFiles = [
    "src/routes/chat/index.ts",
    "src/routes/chat/account.ts",
    "src/routes/chat/streaming.ts",
    "src/routes/chat/validation.ts",
    "src/routes/chat/stop.ts",
    "src/routes/responses/index.ts",
    "src/routes/anthropic/index.ts",
    "src/routes/upload.ts",
    "src/api/models.ts",
  ];
  for (const file of routeFiles) {
    const src = fs.readFileSync(path.resolve(file), "utf-8");
    assert.ok(
      !src.includes("qwen-token-refresh"),
      `${file} must not import the refresh module directly`,
    );
  }
  for (const file of allowed) {
    assert.ok(fs.existsSync(path.resolve(file)), `${file} exists`);
  }
  // Retry/cooldown/selection modules are untouched by this change.
  for (const file of [
    "src/routes/chat/retry-policy.ts",
    "src/core/account-manager.ts",
    "src/core/account-concurrency.ts",
  ]) {
    const src = fs.readFileSync(path.resolve(file), "utf-8");
    assert.ok(!src.includes("qwen-token-refresh"), `${file} untouched`);
  }
});

// ─── refreshWithJar edge cases ──────────────────────────────────────────────

test("refreshWithJar: rejects without material, bad payloads", async () => {
  const noMat = await refreshWithJar("token=A; cna=1", null, "ua-test", async () =>
    jsonResponse({}),
  );
  assert.equal(noMat.ok, false);

  const rejected = await refreshWithJar("token=A; refresh_token=R", "R", "ua-test", async () =>
    jsonResponse({ success: false, data: { code: "Unauthorized" } }),
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "Unauthorized");

  const noAccess = await refreshWithJar("token=A; refresh_token=R", "R", "ua-test", async () =>
    jsonResponse({ success: true, data: {} }),
  );
  assert.equal(noAccess.ok, false);
  if (!noAccess.ok) assert.equal(noAccess.code, "NoAccessToken");
});

test("refreshWithJar: folds Set-Cookie rotation into the jar", async () => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", "refresh_token=R-ROTATED; Path=/; Domain=.qwen.ai");
  const resp = new Response(
    JSON.stringify({ success: true, data: { access_token: freshAccessJwt() } }),
    { status: 200, headers },
  );
  const out = await refreshWithJar("token=OLD; refresh_token=R-PREV; cna=1", "R-PREV", "ua-test", async () => resp);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.ok(out.jar.includes("refresh_token=R-ROTATED"));
    assert.ok(out.jar.includes("cna=1"));
    assert.ok(!out.jar.includes("token=OLD"), "stale access pair must be rewritten");
    assert.ok(getJarPair(out.jar, "token"), "new access pair present");
  }
});

// ─── waitForRefreshTokenCookie ──────────────────────────────────────────────

test("live: tryRefreshToken prefers the warm live jar over a stale persisted one", async () => {
  const {
    registerPlaywrightAccountForTests,
    unregisterPlaywrightAccountForTests,
    peekLiveCookieJar,
  } = await import("../services/playwright.ts");

  // Persisted row is stale (expired access, old refresh).
  const id = seedSession({
    access: expiredJwt(),
    refresh: "R-DB-STALE",
    tokenExpiresAt: Math.floor(Date.now() / 1000) - 3600,
    refreshField: "R-DB-STALE",
  });

  // Warm live context holds the current jar.
  const liveJar = `token=${futureJwt()}; refresh_token=R-LIVE-CURRENT; cna=1`;
  const fakePage = {
    isClosed: () => false,
    context: () => ({
      cookies: async () => [
        { name: "token", value: futureJwt(), domain: "chat.qwen.ai" },
        { name: "refresh_token", value: "R-LIVE-CURRENT", domain: ".qwen.ai" },
        { name: "cna", value: "1", domain: ".qwen.ai" },
      ],
      addCookies: async () => {},
    }),
    evaluate: async () => "",
  };
  registerPlaywrightAccountForTests(id, fakePage as never, Date.now());
  try {
    const peeked = await peekLiveCookieJar(id);
    assert.ok(peeked && peeked.jar.includes("R-LIVE-CURRENT"));

    let sentCookie = "";
    const fetchFn: RefreshFetch = async (_url, init) => {
      sentCookie = String(new Headers(init?.headers as HeadersInit).get("Cookie") ?? "");
      return jsonResponse({ success: true, data: { access_token: freshAccessJwt() } });
    };
    const result = await tryRefreshToken(id, { fetchFn });
    assert.equal(result.ok, true);
    assert.ok(
      sentCookie.includes("R-LIVE-CURRENT"),
      "live refresh material must win over the stale persisted jar",
    );
    assert.ok(!sentCookie.includes("R-DB-STALE"));

    // Persisted row now carries the renewal.
    const material = getRefreshMaterial(id);
    assert.ok(material && getJarPair(material.jar, "token"));
  } finally {
    unregisterPlaywrightAccountForTests(id);
  }

  // Cold again → falls back to the persisted jar (now renewed above).
  let sentCookie = "";
  const result = await tryRefreshToken(id, {
    fetchFn: async (_url, init) => {
      sentCookie = String(new Headers(init?.headers as HeadersInit).get("Cookie") ?? "");
      return jsonResponse({ success: true, data: { access_token: freshAccessJwt() } });
    },
  });
  assert.equal(result.ok, true);
  assert.ok(sentCookie.length > 0);
  void liveJar;
});

test("login: waitForRefreshTokenCookie resolves on arrival, times out cleanly", async () => {
  const { waitForRefreshTokenCookie } = await import(
    "../services/playwright.ts"
  );
  // Immediate hit.
  assert.equal(
    await waitForRefreshTokenCookie({
      cookies: async () => [{ name: "refresh_token", value: "R" }],
    } as never, 1000),
    true,
  );
  // Late arrival (refresh lands after the access token).
  let polls = 0;
  assert.equal(
    await waitForRefreshTokenCookie(
      {
        cookies: async () => {
          polls++;
          return polls >= 3 ? [{ name: "refresh_token", value: "R" }] : [];
        },
      } as never,
      5000,
      10,
    ),
    true,
  );
  // Absent → false after the deadline, no throw.
  assert.equal(
    await waitForRefreshTokenCookie({ cookies: async () => [] } as never, 60, 10),
    false,
  );
});
