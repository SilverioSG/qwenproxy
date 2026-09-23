import test from "node:test";
import assert from "node:assert";
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";

test("streaming error handler emits visible content delta and terminal error", async () => {
  const app = new Hono();
  app.get("/stream-err", (c) => {
    return honoStream(
      c,
      async () => {
        throw new Error("Qwen content moderation: data_inspection_failed");
      },
      async (err: Error, errorStream: any) => {
        const userFriendlyNotice = `\n\n⚠️ **[Qwen Security / Erro]** ${err.message}\n\n`;
        const errorDelta = {
          choices: [{ delta: { content: userFriendlyNotice } }],
        };
        await errorStream.write(`data: ${JSON.stringify(errorDelta)}\n\n`);
        await errorStream.write(
          `data: ${JSON.stringify({
            error: { message: err.message, type: "upstream_error", code: "data_inspection_failed" },
          })}\n\ndata: [DONE]\n\n`,
        );
      },
    );
  });

  const res = await app.request("http://localhost/stream-err");
  assert.equal(res.status, 200);
  const text = await res.text();

  assert.ok(text.includes("⚠️ **[Qwen Security / Erro]**"));
  assert.ok(text.includes("data_inspection_failed"));
  assert.ok(text.includes("data: [DONE]"));
});
