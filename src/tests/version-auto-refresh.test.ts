/**
 * Frontend `version` AUTO discovery + single stale-version self-heal.
 *
 * Mirrors the proven Qwen-Free-Api flow (scrape the public bundle path, cache
 * 30 min, single in-flight probe, last-known-good on failure, retry once only
 * when the value actually changed) adapted to QwenProxy's shared module state.
 *
 * All tests are deterministic: the network is stubbed and the cache/TTL is
 * driven through the same test seams the production code exposes.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { config, isAutoWebVersion } from "../core/config.ts";
import {
  extractFrontendVersion,
  getDirectBundleVersion,
  getFrontendVersion,
  _resetVersionCacheForTests,
  _setVersionCacheAgeForTests,
} from "../services/qwen-direct-transport.ts";
import {
  attemptWithVersionHeal,
  isStaleVersionBadRequest,
} from "../services/qwen-direct-stream.ts";
import { clientHintsFromUserAgent } from "../services/qwen-direct-transport.ts";
import { _resetQwenWebVersionForTests } from "../services/qwen-headers.ts";

const BAD_REQUEST_BODY =
  '{"success":false,"data":{"code":"Bad_Request","details":"Internal error..."}}';

type HompageStub = { restore: () => void; calls: () => number };

function stubHomepage(version: string | null, opts: { fail?: boolean } = {}): HompageStub {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (opts.fail) throw new Error("network down");
    const html = version
      ? `<script src="/qwenweb/qwen-chat-fe/${version}/js/main.js"></script>`
      : "<html><body>no bundle</body></html>";
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = real;
    },
    calls: () => calls,
  };
}

beforeEach(() => {
  _resetVersionCacheForTests();
  _resetQwenWebVersionForTests();
});

// ── 1. Discovery: accepted format ────────────────────────────────────────────

test("discovery: extracts the bundle version from the homepage", () => {
  assert.equal(
    extractFrontendVersion('<script src="/qwenweb/qwen-chat-fe/0.3.26/js/main.js">'),
    "0.3.26",
  );
  assert.equal(
    extractFrontendVersion("https://chat.qwen.ai/qwen-chat-fe/1.2.3/js/main.js"),
    "1.2.3",
  );
});

// ── 2. Discovery: invalid payload is rejected ────────────────────────────────

test("discovery: invalid payload yields null and never becomes a version", () => {
  assert.equal(extractFrontendVersion(""), null);
  assert.equal(extractFrontendVersion("<html>maintenance</html>"), null);
  assert.equal(extractFrontendVersion("/qwen-chat-fe/not-a-version/js/main.js"), null);
});

// ── 3. Cache + TTL ──────────────────────────────────────────────────────────

test("cache: repeated calls reuse one probe inside the TTL; force re-probes", async () => {
  const stub = stubHomepage("0.3.26");
  try {
    assert.equal(await getFrontendVersion(), "0.3.26");
    assert.equal(await getFrontendVersion(), "0.3.26");
    assert.equal(stub.calls(), 1, "second call must hit the cache");
    assert.equal(await getFrontendVersion({ force: true }), "0.3.26");
    assert.equal(stub.calls(), 2, "force must probe again");
  } finally {
    stub.restore();
  }
});

test("cache: expires after the 30 minute TTL", async () => {
  const stub = stubHomepage("0.3.26");
  try {
    assert.equal(await getFrontendVersion(), "0.3.26");
    _setVersionCacheAgeForTests(30 * 60 * 1000 + 1);
    assert.equal(await getFrontendVersion(), "0.3.26");
    assert.equal(stub.calls(), 2, "expired cache must probe again");
  } finally {
    stub.restore();
  }
});

// ── 4. Discovery failure keeps the last known good value ────────────────────

test("failure: scrape error preserves the previous version and does not loop", async () => {
  const good = stubHomepage("0.3.26");
  assert.equal(await getFrontendVersion(), "0.3.26");
  good.restore();

  const broken = stubHomepage(null, { fail: true });
  try {
    assert.equal(await getFrontendVersion({ force: true }), "0.3.26", "last good kept");
    assert.equal(await getFrontendVersion(), "0.3.26", "cached value still served");
    assert.equal(broken.calls(), 1, "a failed probe must stamp the TTL, not retry per call");
  } finally {
    broken.restore();
  }
});

// ── 5. Bad_Request signature ────────────────────────────────────────────────

test("signature: only Bad_Request + internal error counts as stale version", () => {
  assert.equal(isStaleVersionBadRequest(BAD_REQUEST_BODY), true);
  assert.equal(isStaleVersionBadRequest('{"code":"Bad_Request"}'), false);
  assert.equal(isStaleVersionBadRequest('{"code":"Unauthorized"}'), false);
  assert.equal(isStaleVersionBadRequest(""), false);
  assert.equal(isStaleVersionBadRequest(null), false);
});

// ── 6. Refresh on Bad_Request: exactly one retry when version changed ───────

test("refresh: changed version triggers exactly one retry on the same attempt", async () => {
  let version = "0.2.91";
  let attempts = 0;
  const results = [
    { ok: false, waf: false, challengeBody: BAD_REQUEST_BODY },
    { ok: true, waf: false, challengeBody: "" },
  ];
  const result = await attemptWithVersionHeal(
    async () => {
      const r = results[attempts] ?? results[results.length - 1];
      attempts += 1;
      return r;
    },
    {
      getVersion: async () => version,
      refreshVersion: async () => {
        version = "0.3.26";
        return version;
      },
    },
  );
  assert.equal(attempts, 2, "one original + one retry");
  assert.equal(result.ok, true);
});

test("refresh: unchanged version never retries and never refreshes twice", async () => {
  let refreshes = 0;
  let attempts = 0;
  const result = await attemptWithVersionHeal(
    async () => {
      attempts += 1;
      return { ok: false, waf: false, challengeBody: BAD_REQUEST_BODY };
    },
    {
      getVersion: async () => "0.2.91",
      refreshVersion: async () => {
        refreshes += 1;
        return "0.2.91";
      },
    },
  );
  assert.equal(attempts, 1, "no retry when the version did not change");
  assert.equal(refreshes, 1, "exactly one forced probe");
  assert.equal(result.ok, false, "original failure is preserved");
});

// ── 7. No retry for WAF or unrelated errors (no rotation / full-replay) ────

test("refresh: WAF challenges and unrelated errors bypass the version path", async () => {
  for (const first of [
    { ok: false, waf: true, challengeBody: BAD_REQUEST_BODY },
    { ok: false, waf: false, challengeBody: '{"code":"Unauthorized"}' },
    { ok: true, waf: false, challengeBody: "" },
  ]) {
    let attempts = 0;
    let refreshes = 0;
    const result = await attemptWithVersionHeal(
      async () => {
        attempts += 1;
        return first;
      },
      {
        getVersion: async () => "0.2.91",
        refreshVersion: async () => {
          refreshes += 1;
          return "0.3.26";
        },
      },
    );
    assert.equal(attempts, 1);
    assert.equal(refreshes, 0);
    assert.equal(result, first);
  }
});

// ── 8. Client Hints coherence with the captured UA ─────────────────────────

test("hints: derived from the session UA, never hardcoded Chrome/Windows", () => {
  const linux = clientHintsFromUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  );
  assert.match(linux.chUa, /v="153"/);
  assert.equal(linux.platform, '"Linux"');
  assert.equal(linux.mobile, "?0");

  const win = clientHintsFromUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  );
  assert.match(win.chUa, /v="149"/);
  assert.equal(win.platform, '"Windows"');

  const android = clientHintsFromUserAgent(
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
  );
  assert.equal(android.mobile, "?1");
  assert.equal(android.platform, '"Android"');
});

// ── 9. Manual override ──────────────────────────────────────────────────────

test("override: a literal QWEN_WEB_VERSION pins, auto/empty discovers", () => {
  assert.equal(isAutoWebVersion("auto"), true);
  assert.equal(isAutoWebVersion("AUTO"), true);
  assert.equal(isAutoWebVersion(""), true);
  assert.equal(isAutoWebVersion(undefined), true);
  assert.equal(isAutoWebVersion("0.3.26"), false);
  // The configured fallback must always be a literal version, never "auto".
  assert.match(config.qwen.webVersion, /^\d+\.\d+\.\d+/);
});

test("override: AUTO mode resolves through discovery, not the pinned constant", async () => {
  if (!config.qwen.webVersionAuto) {
    // The test environment pinned QWEN_WEB_VERSION: the override path is the
    // one under test here.
    assert.equal(await getDirectBundleVersion(), config.qwen.webVersion);
    return;
  }
  const stub = stubHomepage("0.3.27");
  try {
    assert.equal(await getDirectBundleVersion(), "0.3.27");
  } finally {
    stub.restore();
  }
});
