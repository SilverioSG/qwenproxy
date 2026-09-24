/**
 * latencyMs ownership.
 *
 * Streaming records once, from the SSE lifecycle, at the [DONE] write.
 * The Response is returned before the stream finishes. Non-stream still
 * records from the handler when the JSON body is complete.
 *
 * QWEN_LATENCY_TRACE stays off: the metric must not depend on the diagnostic
 * flag. No second reader, no tee.
 */
import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.QWEN_LATENCY_TRACE;

const { app } = await import("../api/server.js");
const stats = await import("../core/dashboard-stats.ts");
const { clearAllAccountCooldowns } = await import("../core/account-manager.ts");

function resetObservability(): void {
  stats.resetDashboardStatsForTesting();
  clearAllAccountCooldowns();
}

function sseUpstream(chunks: string[], opts?: { close?: boolean; hang?: boolean }) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (opts?.hang) return;
      if (opts?.close !== false) controller.close();
    },
  });
}

function answer(text: string): string {
  return `data: {"choices":[{"delta":{"phase":"answer","content":${JSON.stringify(text)}}}]}\n\n`;
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    return handler(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function readBody(res: Response): Promise<{ text: string; chunks: number }> {
  const reader = res.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = "";
  let chunks = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, chunks };
}

function aiRecords() {
  return stats.getRecentAIRequests(20);
}

test("stream success: Response returns before [DONE], one record at stream end", async () => {
  resetObservability();
  let releaseUpstream: (() => void) | null = null;
  const upstreamReady = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const restore = installFetch(async (url) => {
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(answer("hola")));
          await upstreamReady;
          controller.enqueue(encoder.encode(answer(" mundo")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200 },
    );
  });

  const started = Date.now();
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        messages: [{ role: "user", content: "latency semantics" }],
      }),
    });
    const openedAt = Date.now();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    // The handler returned the Response while the upstream is still paused,
    // so the AI ring must still be empty.
    assert.equal(aiRecords().length, 0, "must not record when the Response opens");

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(aiRecords().length, 0, "must stay unrecorded while the stream is open");

    releaseUpstream!();
    const body = await readBody(res);
    const finishedAt = Date.now();

    assert.equal((body.text.match(/data: \[DONE\]/g) || []).length, 1);
    assert.ok(body.text.includes("hola"));
    assert.ok(body.text.includes(" mundo"));
    assert.ok(body.chunks >= 1);

    // The SSE callback records after its writes settle.
    await new Promise((r) => setTimeout(r, 30));
    const records = aiRecords();
    assert.equal(records.length, 1, "RECORD_COUNT=1");
    const row = records[0];
    assert.equal(row.success, true);
    assert.equal(row.stream, true);
    assert.equal(row.retryCount, 0);
    const responseOpenMs = openedAt - started;
    assert.ok(row.latencyMs > responseOpenMs, "latencyMs must include generation past Response open");
    assert.ok(row.latencyMs <= finishedAt - started + 50);
    assert.ok(row.latencyMs >= 30, "paused upstream must be inside latencyMs");

    const summary = stats.getMonitorSummary();
    assert.equal(summary.totals.totalRequests, 1);
    const account = summary.accounts.find((a) => a.accountId === row.accountId);
    assert.ok(account);
    assert.equal(account.totalRequests, 1);
  } finally {
    restore();
    resetObservability();
  }
});

test("stream error before Response: handler records once, success=false", async () => {
  resetObservability();
  const restore = installFetch(async (url) => {
    if (url.includes("/api/v2/chat/completions")) {
      return new Response(
        JSON.stringify({
          success: false,
          data: { code: "RateLimited", details: "limit", num: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  const started = Date.now();
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        messages: [{ role: "user", content: "fail before stream" }],
      }),
    });
    assert.ok(res.status >= 400);
    await res.text();
    const records = aiRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].success, false);
    assert.ok(records[0].latencyMs >= 0);
    assert.ok(records[0].latencyMs <= Date.now() - started + 50);
    assert.equal(stats.getMonitorSummary().totals.totalRequests, 1);
    assert.equal(stats.getMonitorSummary().totals.totalErrors, 1);
  } finally {
    restore();
    resetObservability();
  }
});

test("stream error after Response: SSE lifecycle records once, success=false", async () => {
  resetObservability();
  // Valid SSE first, so the Response is already open. The error frame is the
  // shape the stream loop treats as a terminal upstream error (content + [DONE]),
  // not a retryable SSE `error` object — a retry would be a second attempt of
  // the same logical request and must not be what this test measures.
  const restore = installFetch(async (url) => {
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      sseUpstream([
        answer("parcial"),
        'data: {"error":{"code":"InternalError","message":"boom mid stream","details":"boom mid stream"}}\n\n',
      ]),
      { status: 200 },
    );
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        messages: [{ role: "user", content: "fail during stream" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(aiRecords().length, 0, "Response open must not record");
    const body = await readBody(res);
    assert.ok(body.text.includes("parcial"));
    assert.equal((body.text.match(/data: \[DONE\]/g) || []).length, 1);
    await new Promise((r) => setTimeout(r, 40));
    const records = aiRecords();
    assert.equal(records.length, 1, "error after Response records exactly once");
    assert.equal(records[0].success, false);
    assert.equal(records[0].stream, true);
    assert.equal(stats.getMonitorSummary().totals.totalRequests, 1);
    assert.equal(stats.getMonitorSummary().totals.totalErrors, 1);
  } finally {
    restore();
    resetObservability();
  }
});

test("client abort during stream: one record, success=false", async () => {
  resetObservability();
  const restore = installFetch(async (url) => {
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(sseUpstream([answer("hola")], { hang: true }), { status: 200 });
  });
  const controller = new AbortController();
  try {
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          stream: true,
          messages: [{ role: "user", content: "abort me" }],
        }),
        signal: controller.signal,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(aiRecords().length, 0);
    controller.abort();
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 80));
    const records = aiRecords();
    assert.equal(records.length, 1, "abort must record exactly once");
    assert.equal(records[0].success, false);
    assert.equal(records[0].errorReason, "client_abort");
    assert.equal(stats.getMonitorSummary().totals.totalRequests, 1);
  } finally {
    restore();
    resetObservability();
  }
});

test("non-stream: handler still records once when the JSON body is complete", async () => {
  resetObservability();
  const restore = installFetch(async (url) => {
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(sseUpstream([answer("listo"), "data: [DONE]\n\n"]), { status: 200 });
  });
  const started = Date.now();
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        messages: [{ role: "user", content: "non stream" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "listo");
    const records = aiRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].success, true);
    assert.equal(records[0].stream, false);
    assert.ok(records[0].latencyMs <= Date.now() - started + 50);
    assert.equal(stats.getMonitorSummary().totals.totalRequests, 1);
    assert.equal(stats.getMonitorSummary().modeComparison.nonStreaming?.totalRequests, 1);
  } finally {
    restore();
    resetObservability();
  }
});

test("output parity: flag off, one [DONE], content order unchanged", async () => {
  resetObservability();
  assert.equal(process.env.QWEN_LATENCY_TRACE, undefined);
  const restore = installFetch(async (url) => {
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      sseUpstream([answer("uno"), answer(" dos"), "data: [DONE]\n\n"]),
      { status: 200 },
    );
  });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        messages: [{ role: "user", content: "parity" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await readBody(res);
    const dataLines = body.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data: "));
    const contents = dataLines
      .filter((line) => line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((event) => event.choices?.[0]?.delta?.content)
      .filter((content) => typeof content === "string" && content.length > 0);
    assert.deepEqual(contents, ["uno", " dos"]);
    assert.equal(dataLines.filter((line) => line === "data: [DONE]").length, 1);
    assert.equal((body.text.match(/data: \[DONE\]/g) || []).length, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aiRecords().length, 1);
    assert.equal(aiRecords()[0].success, true);
  } finally {
    restore();
    resetObservability();
  }
});
