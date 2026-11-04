/**
 * AUTH CONTRACT REGRESSION — isolated worktree only.
 *
 * Runs against the baseline worktree with QWEN_DATA_DIR pointed at a temp
 * directory; it never touches the real DB, profiles, logs, accounts or service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDataDir } from "../core/paths.ts";
import { probePageLoggedIn } from "../services/playwright.ts";
import {
  classifyPostLoginValidation,
  shouldUnmarkReadyAfterRecovery,
  type AuthValidationState,
} from "../services/auth-contract.ts";
import {
  saveAuthSession,
  saveValidatedAuthSession,
  getValidAuthSession,
  deleteAuthSession,
  getDatabase,
} from "../core/database.ts";
import { ensureAccountFresh } from "../services/qwen-token-refresh.ts";

function fakeProbePage(
  reason: string,
  opts: { closed?: boolean; url?: string } = {},
) {
  return {
    isClosed: () => opts.closed === true,
    url: () => opts.url ?? "https://chat.qwen.ai/",
    context: () => ({ cookies: async () => [] }),
    evaluate: async () => ({ reason, obs: [], res: [] }),
  };
}

function futureSeconds(offset = 3600): number {
  return Math.floor(Date.now() / 1000) + offset;
}

function readAuthRow(accountId: string): { user_agent?: string | null } | undefined {
  return getDatabase()
    .prepare("SELECT user_agent FROM qwen_auth_sessions WHERE account_id = ?")
    .get(accountId) as { user_agent?: string | null } | undefined;
}

test("isolation: QWEN_DATA_DIR must be an isolated test directory", () => {
  const dir = path.resolve(getDataDir());
  const repoTest = dir === path.resolve("data-test");
  const explicitTemp =
    !!process.env.QWEN_DATA_DIR &&
    dir.startsWith(path.resolve(os.tmpdir()) + path.sep);
  assert.ok(
    repoTest || explicitTemp,
    `refusing to run outside an isolated test dir: ${dir}`,
  );
  assert.ok(!dir.includes("/.local/share/"), `refusing production db: ${dir}`);
  if (process.env.QWEN_DATA_DIR) {
    assert.equal(dir, path.resolve(process.env.QWEN_DATA_DIR));
  }
});

test("classifier: reasons -> valid/rejected/inconclusive", () => {
  const cases: Array<[string, AuthValidationState, number, boolean]> = [
    ["ok", "valid", 200, false],
    ["settings-401", "rejected", 401, true],
    ["settings-403", "rejected", 403, true],
    ["settings-revoked", "rejected", 200, true],
    ["auths-status", "rejected", 0, true],
    ["auths-schema", "rejected", 0, true],
    ["refresh-401", "rejected", 0, true],
    ["refresh-revoked", "rejected", 0, true],
    ["timeout", "inconclusive", 0, true],
    ["evaluate-error", "inconclusive", 0, true],
    ["page-closed", "inconclusive", 0, true],
    ["no-page", "inconclusive", 0, true],
    ["auth-url", "inconclusive", 0, true],
    ["logged-out-marker", "inconclusive", 0, true],
    ["some-new-ambiguous-reason", "inconclusive", 0, false],
  ];
  for (const [reason, expected, settingsStatus, settingsAppFail] of cases) {
    assert.equal(
      classifyPostLoginValidation({ reason, settingsStatus, settingsAppFail }),
      expected,
      reason,
    );
  }
});

test("production probe emits the reason contract we classify", async () => {
  const cases: Array<[string, AuthValidationState, Parameters<typeof fakeProbePage>[1]]> = [
    ["ok", "valid", {}],
    ["settings-401", "rejected", {}],
    ["settings-403", "rejected", {}],
    ["settings-revoked", "rejected", {}],
    ["timeout", "inconclusive", {}],
    ["evaluate-error", "inconclusive", {}],
    ["page-closed", "inconclusive", { closed: true }],
    ["auth-url", "inconclusive", { url: "https://chat.qwen.ai/auth" }],
  ];
  for (const [reason, expected, opts] of cases) {
    const out = await probePageLoggedIn(
      fakeProbePage(reason, opts) as never,
      1_000,
      { nonMutating: true },
    );
    assert.equal(out.reason, reason, reason);
    assert.equal(
      classifyPostLoginValidation({
        reason: out.reason,
        settingsStatus: reason === "settings-401" ? 401 : reason === "settings-403" ? 403 : reason === "ok" ? 200 : 0,
        settingsAppFail: reason !== "ok",
      }),
      expected,
      reason,
    );
  }
  const noPage = await probePageLoggedIn(null as never, 1_000, {
    nonMutating: true,
  });
  assert.equal(noPage.reason, "no-page");
  assert.equal(classifyPostLoginValidation({ reason: noPage.reason }), "inconclusive");
});

test("DESIRED: initial empty UA must not persist a confirmed session", () => {
  const id = `test-auth-contract-empty-ua-${Date.now()}`;
  deleteAuthSession(id);
  try {
    const result = saveValidatedAuthSession(
      id,
      {
        cookie: "token=test-token; refresh_token=test-refresh",
        userAgent: "",
        bxV: "2.5.37",
        tokenExpiresAt: futureSeconds(),
        refreshToken: "test-refresh",
        capturedAt: Date.now(),
      },
      "valid",
    );
    assert.equal(result.saved, false);
    assert.equal(result.reason, "missing-user-agent");
    assert.equal(readAuthRow(id), undefined);
  } finally {
    deleteAuthSession(id);
  }
});

test("rejected/inconclusive never persist a confirmed session", () => {
  for (const validation of ["rejected", "inconclusive"] as const) {
    const id = `test-auth-contract-${validation}-${Date.now()}`;
    deleteAuthSession(id);
    try {
      const result = saveValidatedAuthSession(
        id,
        {
          cookie: "token=test-token; refresh_token=test-refresh",
          userAgent: "Mozilla/5.0 ContractTest",
          bxV: "2.5.37",
          tokenExpiresAt: futureSeconds(),
          refreshToken: "test-refresh",
          capturedAt: Date.now(),
        },
        validation,
      );
      assert.equal(result.saved, false, validation);
      assert.equal(readAuthRow(id), undefined, validation);
    } finally {
      deleteAuthSession(id);
    }
  }
});

test("valid + UA persists a confirmed session", () => {
  const id = `test-auth-contract-valid-${Date.now()}`;
  deleteAuthSession(id);
  try {
    const result = saveValidatedAuthSession(
      id,
      {
        cookie: "token=test-token; refresh_token=test-refresh",
        userAgent: "Mozilla/5.0 ContractTest",
        bxV: "2.5.37",
        tokenExpiresAt: futureSeconds(),
        refreshToken: "test-refresh",
        capturedAt: Date.now(),
      },
      "valid",
    );
    assert.equal(result.saved, true);
    assert.equal(readAuthRow(id)?.user_agent, "Mozilla/5.0 ContractTest");
    assert.ok(getValidAuthSession(id));
  } finally {
    deleteAuthSession(id);
  }
});

test("update with empty UA preserves the previous UA", () => {
  const id = `test-auth-contract-ua-update-${Date.now()}`;
  deleteAuthSession(id);
  try {
    saveAuthSession(id, {
      cookie: "token=test-token; refresh_token=test-refresh",
      userAgent: "Mozilla/5.0 ContractTest",
      bxV: "2.5.37",
      tokenExpiresAt: futureSeconds(),
      refreshToken: "test-refresh",
      capturedAt: Date.now(),
    });
    const result = saveValidatedAuthSession(
      id,
      {
        cookie: "token=test-token; refresh_token=test-refresh",
        userAgent: "",
        bxV: "2.5.37",
        capturedAt: Date.now(),
      },
      "valid",
    );
    assert.equal(result.saved, true);
    assert.equal(readAuthRow(id)?.user_agent, "Mozilla/5.0 ContractTest");
  } finally {
    deleteAuthSession(id);
  }
});

test("BASELINE: ensureAccountFresh stays boolean and does not block hot path", async () => {
  const id = `test-auth-contract-fresh-${Date.now()}`;
  deleteAuthSession(id);
  try {
    saveAuthSession(id, {
      cookie: "token=test-token; refresh_token=test-refresh",
      userAgent: "Mozilla/5.0 ContractTest",
      bxV: "2.5.37",
      tokenExpiresAt: futureSeconds(3600),
      refreshToken: "test-refresh",
      capturedAt: Date.now(),
    });
    assert.equal(await ensureAccountFresh(id), true);
    assert.ok(getValidAuthSession(id));
  } finally {
    deleteAuthSession(id);
  }
});

test("loginViaApi classifies before returning success", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginViaApi");
  assert.ok(start >= 0, "loginViaApi not found");
  const end = src.indexOf("export interface AutofillResult", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  assert.ok(block.includes("classifyPostLoginValidation"));
  assert.ok(block.includes('validation === "rejected"'));
  assert.ok(block.includes('validation === "inconclusive"'));
  assert.ok(
    !/if\s*\(\s*!?\s*trace\.validated\s*\)/.test(block),
    "the raw validated boolean must not be the gate",
  );
});

test("HTTP 200 without token is classified as rejected", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginViaApi");
  const end = src.indexOf("export interface AutofillResult", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  const noToken = block.indexOf('"API signin não confirmou sessão autenticada"');
  assert.ok(noToken >= 0);
  const before = block.slice(Math.max(0, noToken - 250), noToken);
  assert.ok(before.includes('validation: "rejected"'));
});

test("loginToQwenInner stops non-valid API results before UI fallback", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginToQwenInner");
  const end = src.indexOf("async function loginViaApi", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  const guard = block.indexOf('apiResult.validation !== "valid"');
  const ui = block.indexOf("loginViaUi(page, email, password)");
  assert.ok(guard >= 0 && ui > guard, "guard must precede UI fallback");
});

test("markAccountHeadersReady is gated by a saved valid session", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginToQwenInner");
  assert.ok(start >= 0, "loginToQwenInner not found");
  const end = src.indexOf("async function loginViaApi", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  assert.ok(block.includes("saveValidatedAuthSession"));
  const saveIdx = block.indexOf("saveValidatedAuthSession");
  const readyIdx = block.indexOf("markAccountHeadersReady", saveIdx);
  assert.ok(saveIdx >= 0 && readyIdx > saveIdx, "READY must follow persistence");
  assert.ok(block.includes("if (saved.saved)"));
});

test("loginToQwenInner does not return success when persistence fails", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginToQwenInner");
  const end = src.indexOf("async function loginViaApi", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  assert.ok(block.includes("persisted = saved.saved"));
  assert.ok((block.match(/return persisted/g) ?? []).length >= 2);
  assert.ok(block.includes("if (!persisted) unmarkAccountHeadersReady"));
  assert.ok(block.includes("Session not persisted for"));
});

test("loginViaApi catch reuses the non-mutating probe and classifier", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("async function loginViaApi");
  const end = src.indexOf("export interface AutofillResult", start);
  const block = src.slice(start, end > 0 ? end : start + 60_000);
  const catchIdx = block.indexOf("} catch (err: any)");
  assert.ok(catchIdx >= 0);
  const catchBlock = block.slice(catchIdx);
  assert.ok(catchBlock.includes("probePageLoggedIn(page, 3000, {"));
  assert.ok(catchBlock.includes("nonMutating: true"));
  assert.ok(catchBlock.includes("classifyPostLoginValidation"));
  assert.ok(!catchBlock.includes("isPageLoggedIn(page, 3000)"));
});

test("capture and reauth writers persist before READY", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const captureIdx = src.indexOf("if (persistSession) {");
  assert.ok(captureIdx >= 0);
  const captureBlock = src.slice(captureIdx, captureIdx + 4_000);
  const captureSave = captureBlock.indexOf("saveValidatedAuthSession");
  const captureReady = captureBlock.indexOf("markAccountHeadersReady", captureSave);
  assert.ok(captureSave >= 0 && captureReady > captureSave);

  const reauthIdx = src.indexOf("Fast re-auth completion");
  assert.ok(reauthIdx >= 0);
  const reauthBlock = src.slice(reauthIdx, reauthIdx + 4_000);
  const reauthSave = reauthBlock.indexOf("saveValidatedAuthSession");
  const reauthReady = reauthBlock.indexOf("markAccountHeadersReady", reauthSave);
  assert.ok(reauthSave >= 0 && reauthReady > reauthSave);
});

test("loginToQwen modern requires verified session, not mere freshness", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/services/playwright.ts"),
    "utf8",
  );
  const start = src.indexOf("export async function loginToQwen");
  const end = src.indexOf("async function loginToQwenInner", start);
  const block = src.slice(start, end > 0 ? end : start + 8_000);
  assert.ok(block.includes("recoverAccountSession"));
  assert.ok(block.includes('recovery?.outcome === "verified"'));
  assert.ok(
    !/ensureAccountFresh\(accountId\)/.test(block),
    "modern login must not treat freshness as authentication",
  );
});

test("READY: only rejected is unmarked; inconclusive preserves READY", () => {
  assert.equal(shouldUnmarkReadyAfterRecovery("rejected"), true);
  for (const outcome of [
    "verified",
    "inconclusive",
    "deferred",
    "page-required",
  ] as const) {
    assert.equal(
      shouldUnmarkReadyAfterRecovery(outcome),
      false,
      outcome,
    );
  }
});
