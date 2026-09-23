import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import {
  looksLikeAntiBotChallengeText,
  shortMediaId,
  mediaLog,
  isSupportedMediaSize,
  supportsPromptMediaGeneration,
  resolveMediaModel,
  classifyMediaModel,
  getMediaModelModes,
  listMediaGenerationModels,
  MEDIA_SIZE_OPTIONS,
} from "../services/media-generation.ts";

test("Media Generation Utils: looksLikeAntiBotChallengeText detects challenge markers", () => {
  assert.equal(looksLikeAntiBotChallengeText(""), false);
  assert.equal(looksLikeAntiBotChallengeText("Here is your cyberpunk image result"), false);
  assert.equal(looksLikeAntiBotChallengeText("Error: FAIL_SYS_USER_VALIDATE"), true);
  assert.equal(looksLikeAntiBotChallengeText("rgv587_error detected in response"), true);
  assert.equal(looksLikeAntiBotChallengeText("Please complete the baxia puzzle"), true);
  assert.equal(looksLikeAntiBotChallengeText("_____tmd_____ token challenge"), true);
  assert.equal(looksLikeAntiBotChallengeText("security verification required"), true);
  assert.equal(looksLikeAntiBotChallengeText("human verification failed"), true);
  assert.equal(looksLikeAntiBotChallengeText("denyfromx5 rule triggered"), true);
  assert.equal(looksLikeAntiBotChallengeText('<meta name="aliyun_waf_aa" content="xyz">'), true);
  assert.equal(looksLikeAntiBotChallengeText('appkey: "CF_APP_WAF"'), true);
  assert.equal(looksLikeAntiBotChallengeText('<!doctype html><html><body>challenge</body></html>'), true);
});

test("Media Generation Utils: shortMediaId and mediaLog helper formatting", () => {
  assert.equal(shortMediaId("123456789012345", 8), "12345678");
  assert.equal(shortMediaId("short", 10), "short");

  const imageLog = mediaLog("image", "generate", {
    model: "qwen-image-3.0-pro",
    url: "https://secret.oss.aliyuncs.com/file.png?token=123",
  });
  assert.ok(imageLog.includes("🎨"));
  assert.ok(imageLog.includes("generate"));
  assert.ok(imageLog.includes("[redacted-url]"), "URLs must be redacted from media log output");

  const videoLog = mediaLog("video", "poll", { taskId: "task_123" });
  assert.ok(videoLog.includes("🎬"));
  assert.ok(videoLog.includes("taskId=task_123"));
});

test("Media Generation Capabilities: media size validation and model classification", () => {
  for (const size of MEDIA_SIZE_OPTIONS) {
    assert.equal(isSupportedMediaSize(size), true);
  }
  assert.equal(isSupportedMediaSize("invalid_size"), false);
  assert.equal(isSupportedMediaSize(null), false);
  assert.equal(isSupportedMediaSize(123), false);

  // Model classification
  assert.equal(classifyMediaModel("qwen-image-3.0-pro"), "image");
  assert.equal(classifyMediaModel("wan2.7-image-pro"), "image");
  assert.equal(classifyMediaModel("wan3.0-video"), "video");
  assert.equal(classifyMediaModel("wan2.7-t2v"), "video");
  assert.equal(classifyMediaModel("qwen3.7-plus"), null);
  assert.equal(classifyMediaModel(null), null);

  // Prompt media generation support
  assert.equal(supportsPromptMediaGeneration("qwen-image-3.0-pro", "image"), true);
  assert.equal(supportsPromptMediaGeneration("wan3.0-video", "video"), true);
  assert.equal(supportsPromptMediaGeneration("wan2.7-i2v", "video"), false);
  assert.equal(supportsPromptMediaGeneration("wan3.0-video", "image"), false);

  // Resolution and catalog modes
  const resolved = resolveMediaModel("qwen-image-3.0-pro");
  assert.ok(resolved.chatModel);
  assert.equal(resolved.generationModel, "qwen-image-3.0-pro");

  const modes = getMediaModelModes("qwen-image-3.0-pro");
  assert.ok(Array.isArray(modes));
  assert.ok(modes.length > 0);

  const allModels = listMediaGenerationModels();
  assert.ok(Array.isArray(allModels));
  assert.ok(allModels.some((m) => m.kind === "image"));
  assert.ok(allModels.some((m) => m.kind === "video"));
});

test("Images Generations Route: validates input parameters according to OpenAI spec", async () => {
  // 1. Invalid JSON body
  let res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 2. Missing prompt
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen-image-3.0-pro" }),
    }),
  );
  assert.equal(res.status, 400);
  let json = (await res.json()) as any;
  assert.ok(json.error.message.includes("prompt"));

  // 3. Invalid n
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-3.0-pro",
        prompt: "cyberpunk cat",
        n: 0,
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("n"));

  // 4. Invalid size
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-3.0-pro",
        prompt: "cyberpunk cat",
        size: "999x999",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("size"));

  // 5. Invalid response_format
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-3.0-pro",
        prompt: "cyberpunk cat",
        response_format: "raw_buffer",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("response_format"));

  // 6. Missing model
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "cyberpunk cat",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("model"));

  // 7. Model not supporting prompt-only image generation
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan2.7-i2v",
        prompt: "cyberpunk cat",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("requires a reference image"));
});

test("Videos Generations Route: validates video generation and task status requests", async () => {
  // 1. Invalid JSON body
  let res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 2. Missing prompt
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "wan3.0-video" }),
    }),
  );
  assert.equal(res.status, 400);
  let json = (await res.json()) as any;
  assert.ok(json.error.message.includes("prompt"));

  // 3. Invalid size
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan3.0-video",
        prompt: "cyberpunk drone flight",
        size: "invalid",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("size"));

  // 4. Missing model
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "cyberpunk drone flight",
      }),
    }),
  );
  assert.equal(res.status, 400);

  // 5. Model not supporting video generation
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan2.7-i2v",
        prompt: "cyberpunk drone flight",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("requires a reference image"));

  // 6. Video task status: non-existent task ID returns 404
  res = await app.fetch(new Request("http://localhost/v1/tasks/status/task_non_existent_123"));
  assert.equal(res.status, 404);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("not found"));
});
