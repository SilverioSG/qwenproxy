/**
 * Normal-request modern-auth integration (FASE 7):
 *
 * A. normal request + cold modern persisted account -> direct path, no browser
 * B. modern persisted account passes the runtime eligibility gate without
 *    legacy headersReady
 * C. modern persisted account never enters password reauth for lack of browser
 * D. refresh PASS + cold session feeds the direct decision
 * E. revoked/expired modern auth classifies without password retries
 * F. legacy-only account keeps the legacy behavior
 * G. qwen3.8-max-fast -> upstream qwen3.8-max
 * H. WAF still classifies as WAF, never AuthFailed
 * I. no usable modern material -> prior fallback preserved
 *
 * No network, no browser, no production data (isolated data-test/ DB).
 * Secrets never printed or asserted by value (lengths/booleans only).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  deleteAuthSession,
  hasUsableModernPersistedAuth,
  saveAuthSession,
} from "../core/database.ts";
import {
  _passesHeadersReadyGateForTests,
  getNextAvailableAccount,
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  directTransportScopeReason,
  shouldUseDirectTransport,
} from "../services/qwen-transport-dispatch.ts";
import {
  captureAccountSession,
  revalidateModernAccountSession,
  _resetAccountSessionsForTests,
} from "../services/qwen-account-session.ts";
import { getAccountPageSnapshotHandles } from "../services/playwright.ts";
import { resolveUpstreamModel } from "../services/qwen-direct-stream.ts";
import {
  looksLikeWafChallenge,
} from "../services/qwen-direct-transport.ts";
import { _attemptReloginForTests } from "../routes/chat/account.ts";
import {
  _resetRefreshSingleFlightForTests,
  _setRefreshFetchForTests,
  ensureAccountFresh,
} from "../services/qwen-token-refresh.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(expSec: number): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "u-test", exp: expSec })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const createdIds: string[] = [];
let idSeq = 0;

function seedModern(opts: { expSec?: number; withJar?: boolean } = {}): string {
  const id = `normal-modern-${Date.now()}-${idSeq++}`;
  createdIds.push(id);
  const exp = opts.expSec ?? Math.floor(Date.now() / 1000) + 3600;
  const access = makeJwt(exp);
  saveAuthSession(id, {
    cookie:
      opts.withJar === false
        ? ""
        : `token=${access}; refresh_token=R-NORMAL-1; cna=x`,
    userAgent: "Mozilla/5.0 Chrome/153.0.0.0",
    bxV: "2.5.37",
    bxUa: "",
    bxUmidtoken: "",
    tokenExpiresAt: exp,
    capturedAt: Date.now(),
    refreshToken: "R-NORMAL-1",
  });
  return id;
}

beforeEach(() => {
  _resetAccountSessionsForTests();
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    try {
      deleteAuthSession(id);
    } catch {}
    try {
      unmarkAccountHeadersReady(id);
    } catch {}
    try {
      const { getDatabase } = await import("../core/database.ts");
      getDatabase().prepare("DELETE FROM accounts WHERE id = ?").run(id);
    } catch {}
  }
  try {
    const { invalidateAccountsCache } = await import("../core/accounts.ts");
    invalidateAccountsCache();
  } catch {}
  _resetAccountSessionsForTests();
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

const inScope = (accountId: string) => ({
  accountId,
  fileCount: 0,
  threadParentId: null,
  parallelEscape: false,
  existingChatSessionId: null,
});

// ── A. dispatch: cold modern account -> direct without the flag ─────────────

test("A: in-scope request on a cold modern account uses the direct path", async () => {
  const id = seedModern({});
  assert.equal(hasUsableModernPersistedAuth(id), true);
  assert.deepEqual(shouldUseDirectTransport(inScope(id)), {
    use: true,
    reason: "modern-persisted",
  });
  // The cold bridge serves it with no live page.
  assert.equal(getAccountPageSnapshotHandles(id), null);
  const state = await captureAccountSession(id);
  assert.ok(state);
  assert.equal(state!.bearerSource, "db");
  assert.equal(getAccountPageSnapshotHandles(id), null);
});

// ── B. runtime eligibility without legacy headersReady ──────────────────────

test("B: modern cold account passes the ready gate; legacy-only does not", () => {
  const modern = seedModern({});
  const legacy = `normal-legacy-${Date.now()}`;
  createdIds.push(legacy);
  assert.equal(_passesHeadersReadyGateForTests(modern, true), true);
  assert.equal(_passesHeadersReadyGateForTests(legacy, true), false);
  assert.equal(_passesHeadersReadyGateForTests(legacy, false), true);
  assert.equal(isAccountHeadersReady(modern), false);
  markAccountHeadersReady("other-ready-acct");
  try {
    assert.equal(_passesHeadersReadyGateForTests("other-ready-acct", true), true);
  } finally {
    unmarkAccountHeadersReady("other-ready-acct");
  }
});

// ── C. no password reauth for modern accounts ───────────────────────────────

test("C: modern session revalidation succeeds without legacy login", async () => {
  const id = seedModern({});
  const ok = await _attemptReloginForTests(id, "modern@example.com");
  assert.equal(ok, true);
  // No browser context was created to achieve this.
  assert.equal(getAccountPageSnapshotHandles(id), null);
});

// ── D. refresh PASS feeds the direct decision ───────────────────────────────

test("D: rotated fresh token keeps the direct path", async () => {
  const fresh = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const id = seedModern({ expSec: Math.floor(Date.now() / 1000) - 3600 });
  let calls = 0;
  _setRefreshFetchForTests(async () => {
    calls++;
    return jsonResponse({ success: true, data: { access_token: fresh } });
  });
  assert.equal(await ensureAccountFresh(id), true);
  assert.equal(calls, 1);
  const state = await captureAccountSession(id);
  assert.ok(state);
  assert.equal(state!.bearerToken, fresh);
  assert.deepEqual(shouldUseDirectTransport(inScope(id)), {
    use: true,
    reason: "modern-persisted",
  });
});

// ── E. revoked/expired modern auth classifies without password ──────────────
test("E: dead refresh material fails fresh without browser or password", async () => {
  const id = seedModern({ expSec: Math.floor(Date.now() / 1000) - 3600 });
  _setRefreshFetchForTests(async () => {
    throw new Error("socket hangup");
  });
  assert.equal(await ensureAccountFresh(id), false);
  assert.equal(hasUsableModernPersistedAuth(id), false);
  assert.equal(getAccountPageSnapshotHandles(id), null);
});

// ── F. legacy-only preserved ────────────────────────────────────────────────

test("F: legacy-only account keeps flag-disabled + gate behavior", () => {
  const legacy = `normal-legacy-only-${Date.now()}`;
  createdIds.push(legacy);
  assert.equal(hasUsableModernPersistedAuth(legacy), false);
  assert.deepEqual(shouldUseDirectTransport(inScope(legacy)), {
    use: false,
    reason: "flag-disabled",
  });
  assert.equal(_passesHeadersReadyGateForTests(legacy, true), false);
});

// ── G. -fast alias normalized to the upstream id ────────────────────────────

test("G: qwen3.8-max-fast resolves to qwen3.8-max upstream; others intact", () => {
  assert.equal(resolveUpstreamModel("qwen3.8-max-fast"), "qwen3.8-max");
  assert.equal(resolveUpstreamModel("qwen3.8-max"), "qwen3.8-max");
  assert.equal(resolveUpstreamModel("qwen-max"), "qwen-max");
  assert.equal(
    directTransportScopeReason({
      accountId: "a1",
      fileCount: 1,
      threadParentId: null,
      parallelEscape: false,
      existingChatSessionId: null,
    }),
    "files-unsupported",
  );
});

// ── H. WAF stays WAF ────────────────────────────────────────────────────────

test("H: punish challenge still classifies as WAF", () => {
  assert.equal(
    looksLikeWafChallenge(
      '<html><body><a href="https://qwen.ai/_____tmd_____/punish?x5secdata=abc">verify</a></body></html>',
      "text/html",
    ),
    true,
  );
  assert.equal(
    looksLikeWafChallenge('{"success":true,"data":{"id":"chat-1"}}', "application/json"),
    false,
  );
});

// ── I. empty jar -> no modern auth, prior fallback intact ───────────────────

test("J: revalidation returns null/fresh/stale without legacy login", async () => {
  const legacy = `normal-reval-legacy-${Date.now()}`;
  createdIds.push(legacy);
  assert.equal(await revalidateModernAccountSession(legacy), null);

  const freshId = seedModern({});
  assert.equal(await revalidateModernAccountSession(freshId), true);
  assert.equal(getAccountPageSnapshotHandles(freshId), null);

  const deadId = seedModern({ expSec: Math.floor(Date.now() / 1000) - 3600 });
  _setRefreshFetchForTests(async () => {
    throw new Error("socket hangup");
  });
  assert.equal(await revalidateModernAccountSession(deadId), false);
  assert.equal(getAccountPageSnapshotHandles(deadId), null);
});

test("I: empty persisted jar is not usable modern auth", () => {
  const id = seedModern({ withJar: false });
  assert.equal(hasUsableModernPersistedAuth(id), false);
  assert.deepEqual(shouldUseDirectTransport(inScope(id)), {
    use: false,
    reason: "flag-disabled",
  });
});

// ── L. persisted rows never set the global bundle version ───────────────────

test("L: DB restore never feeds persisted version into the global", async () => {
  // A row outlives frontend releases; sending its stale bundle version on
  // completions answers 401 Unauthorized while chats/new (which omits the
  // version) still returns 200. Proven live: 0.3.11 vs 0.2.91.
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  assert.ok(!src.includes("updateQwenWebVersion(persisted"));
});
