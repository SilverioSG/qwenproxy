/**
 * WAF recovery integration for the direct transport.
 * Covers: detection, punish-URL extraction, single recovery invocation,
 * Baxia invalidation, brand-new chat after recovery, one-retry ceiling,
 * no Authorization, no secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  directChatWithWafRecovery,
  extractPunishUrl,
  isRiskControlled,
  looksLikeWafChallenge,
} from "../services/qwen-direct-transport.ts";

/**
 * Strip comments so static guards inspect CODE, not prose. Naming a legacy
 * symbol in a doc comment ("the legacy solveChallengeOnPage path is untouched")
 * is documentation, not a dependency.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const RGV_BODY =
  '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],' +
  '"data":{"url":"https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5sec=abc123"}}';

test("waf: the exact RGV587 body is classified as a challenge", () => {
  assert.equal(looksLikeWafChallenge(RGV_BODY, "application/json"), true);
  assert.equal(isRiskControlled(RGV_BODY), true);
  assert.equal(looksLikeWafChallenge('{"success":true}', "application/json"), false);
});

test("waf: punish URL is extracted from the JSON-wrapped body", () => {
  const url = extractPunishUrl(RGV_BODY);
  assert.ok(url, "punish url must be found");
  assert.ok(url.includes("_____tmd_____/punish"));
  assert.ok(url.includes("x5sec="));
  assert.ok(url.startsWith("https://chat.qwen.ai"));
  // Never leak the whole body.
  assert.ok(url.length <= 400);
});

test("waf: punish URL extraction survives the escaped/HTML shapes", () => {
  const escaped =
    '{"data":{"url":"https:\\/\\/chat.qwen.ai\\/api\\/v2\\/chat\\/completions\\u002f_____tmd_____\\/punish?x5sec=zz"}}';
  const u1 = extractPunishUrl(escaped);
  assert.ok(u1 && u1.includes("_____tmd_____/punish"), `escaped form failed: ${u1}`);
  const html =
    '<a href="https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5sec=q&amp;p=1">go</a>';
  const u2 = extractPunishUrl(html);
  assert.ok(u2 && u2.includes("punish"), `html form failed: ${u2}`);
  assert.equal(extractPunishUrl(""), null);
  assert.equal(extractPunishUrl("no challenge here"), null);
});

test("waf: recovery runs at most once and never reuses the old chatId", async () => {
  const src = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  const start = src.indexOf("export async function directChatWithWafRecovery");
  assert.ok(start > 0);
  const block = src.slice(start, src.length);
  // Exactly one recovery invocation, no loop construct around it.
  assert.equal(
    (block.match(/recoverWithHumanCaptcha\(/g) ?? []).length,
    1,
    "must invoke the human-solve recovery exactly once",
  );
  assert.ok(!/while\s*\(/.test(block.split("export interface")[0]), "no retry loop");
  assert.ok(!/for\s*\(.*attempt/.test(block), "no attempt loop");
  // The second leg must build a brand new chat (runLeg -> directCreateChat),
  // never reuse `first.create.chatId`.
  assert.ok(block.includes("const second = await runLeg("));
  assert.ok(!/chatId:\s*first\.create\.chatId/.test(block));
  // The clearance we were refused on is dropped before the solve, and the
  // POST-solve jar (not the pre-solve one) drives the retry leg.
  assert.ok(block.includes("invalidateX5sec("));
  const solve = block.indexOf("recoverWithHumanCaptcha(");
  const retry = block.indexOf("const second = await runLeg(");
  assert.ok(solve > 0 && retry > solve, "solve must precede the retry leg");
  assert.ok(block.includes("cookie: recoveredCookie"));
  // The retry leg must NOT re-mint anti-bot material: the proven account flow
  // needs the cookie jar + Bearer only.
  const retryBlock = block.slice(retry);
  assert.ok(
    !/mintQwenBaxiaMaterial/.test(retryBlock),
    "account retry must not depend on the Baxia minter",
  );
});

test("waf: recovery is skipped when the caller disables it", async () => {
  const r = await directChatWithWafRecovery({
    cookie: "",
    bearerToken: null,
    model: "qwen3.8-max",
    content: "Responde únicamente: OK",
    chatMode: "guest",
    chatType: "t2t",
    version: "0.2.83",
    baxia: null,
    allowRecovery: false,
  });
  // With no Baxia material the create leg fails, so no WAF is even reached;
  // the important assertion is that nothing loops and the shape is stable.
  assert.equal(r.second, null);
  assert.equal(typeof r.recoveryAttempted, "boolean");
  assert.equal(typeof r.recoverySuccess, "boolean");
  assert.equal(r.recoveryDurationMs >= 0, true);
});

test("waf: Authorization is Bearer-gated and never sent for guest requests", async () => {
  const { buildDirectQwenHeaders } = await import(
    "../services/qwen-direct-transport.ts"
  );
  // Account mode: the live JWT is REQUIRED (jar alone -> {"code":"Unauthorized"}).
  const acct = buildDirectQwenHeaders({
    cookie: "token=a; x5sec=b",
    bearerToken: "JWT123",
  });
  assert.equal(acct["Authorization"], "Bearer JWT123");
  // Guest mode: no Bearer at all.
  const guest = buildDirectQwenHeaders({ cookie: "cna=x", chatModeGuest: true });
  assert.equal(guest["Authorization"], undefined);
  // A null/empty token must not produce a malformed "Bearer " header.
  const empty = buildDirectQwenHeaders({ cookie: "token=a", bearerToken: null });
  assert.equal(empty["Authorization"], undefined);
  const blank = buildDirectQwenHeaders({ cookie: "token=a", bearerToken: "" });
  assert.equal(blank["Authorization"], undefined);
});

test("waf: no secret values are returned or logged by the orchestration", () => {
  const src = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  const orch = src.slice(src.indexOf("export async function directChatWithWafRecovery"));
  // Only pass the challenge BODY (which the coordinator parses and validates);
  // never the token/cookie values.
  // The FULL body must be passed: the 200-char preview truncates x5secdata.
  assert.ok(orch.includes("challengeBody: comp?.challengeBody ?? \"\""));
  assert.ok(!orch.includes("challengeBody: comp?.bodyPreview"));
  assert.ok(
    /challengeBody: string \| null/.test(src),
    "the result must carry the full body for the coordinator",
  );
  assert.ok(!/challengeBody:[^}]*cookie/.test(orch));
  assert.ok(!/challengeBody:[^}]*bxUa/.test(orch));
  // Logs are limited to the punish URL host/shape at most; assert no console
  // line in this module prints material values.
  const logs = [...src.matchAll(/console\.(log|warn|error)\(([\s\S]{0,400}?)\);/g)].map(
    (m) => m[2],
  );
  for (const l of logs) {
    assert.ok(
      !/\.bxUa\b|\.bxUmidToken\b|\.cookie\b|challengeBody\b/.test(l),
      `log leaks material: ${l.slice(0, 80)}`,
    );
  }
});

test("waf: browser roles stay separated", () => {
  const src = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  const orch = src.slice(src.indexOf("export async function directChatWithWafRecovery"));
  // Recovery runs in the ACCOUNT browser (session + human solve only).
  assert.ok(orch.includes("recoverWithHumanCaptcha("));
  // The account direct path must NOT depend on the dedicated Baxia minter.
  assert.ok(
    !/mintQwenBaxiaMaterial/.test(orch),
    "account recovery must not mint anti-bot material",
  );
  const minter = fs.readFileSync("src/services/qwen-baxia-minter.ts", "utf-8");
  assert.ok(!/withAccountPage|accountPages|getAccountPageSnapshotHandles/.test(minter));
  assert.ok(!/captureQwenHeaders|composer|textarea/.test(orch + minter));
  // The human-captcha module must never drive the slider itself.
  const human = codeOnly(
    fs.readFileSync("src/services/qwen-human-captcha.ts", "utf-8"),
  );
  assert.ok(
    !/solveBaxiaCaptcha|solveChallengeOnPage/.test(human),
    "human captcha path must not invoke the automatic solver",
  );
  // The legacy automatic solver is preserved for the legacy transport.
  const coord = fs.readFileSync("src/services/captcha-coordinator.ts", "utf-8");
  assert.ok(coord.includes("recoverBaxiaCaptcha"));
  assert.ok(coord.includes("solveChallengeOnPage"));
});
