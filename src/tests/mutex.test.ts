import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
// Short hold limit so stale-lock recovery can be tested without long waits.
process.env.MUTEX_MAX_HOLD_MS = "60";

const { Mutex } = await import("../core/mutex.ts");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Mutex: acquire and release", async () => {
  const m = new Mutex("t-basic");
  const release = await m.acquire();
  assert.strictEqual(m.state().locked, true);
  release();
  assert.strictEqual(m.state().locked, false);
});

test("Mutex: second acquire waits until release", async () => {
  const m = new Mutex("t-order");
  const r1 = await m.acquire(1000, "first");

  let acquired = false;
  const p = m.acquire(1000, "second").then((r) => {
    acquired = true;
    return r;
  });

  await tick(10);
  assert.strictEqual(acquired, false);
  r1();

  const r2 = await p;
  assert.strictEqual(acquired, true);
  r2();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: withLock runs the callback and releases", async () => {
  const m = new Mutex("t-withlock");
  const result = await m.withLock(() => 42);
  assert.strictEqual(result, 42);
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: withLock releases even when the callback throws", async () => {
  const m = new Mutex("t-withlock-throw");
  await assert.rejects(() => m.withLock(() => {
    throw new Error("boom");
  }));
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: acquire times out when the lock is held too long", async () => {
  const m = new Mutex("t-timeout");
  const r1 = await m.acquire(1000, "holder");

  await assert.rejects(
    () => m.acquire(30, "waiter"),
    /acquire timeout after 30ms/,
  );

  r1();
});

test("Mutex: stale lock is force-released on the next acquire", async () => {
  const m = new Mutex("t-stale");
  const leaked = await m.acquire(1000, "leaked");
  assert.strictEqual(m.state().locked, true);

  // Wait past MUTEX_MAX_HOLD_MS (60ms in this suite) without releasing.
  await tick(80);

  // A new acquire must detect the stale lock and take it over.
  const fresh = await m.acquire(500, "fresh");
  assert.strictEqual(m.state().locked, true);
  assert.strictEqual(m.state().heldBy, "fresh");

  fresh();
  // Releasing the leaked handle afterwards is a safe no-op.
  leaked();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: state reports holder and queue length", async () => {
  const m = new Mutex("t-state");
  const r1 = await m.acquire(1000, "a");
  const pending = m.acquire(1000, "b").then((r) => r);

  await tick(10);
  const st = m.state();
  assert.strictEqual(st.locked, true);
  assert.strictEqual(st.heldBy, "a");
  assert.strictEqual(st.queueLength, 1);
  assert.ok(st.heldForMs >= 0);

  r1();
  const r2 = await pending;
  r2();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: release is idempotent", async () => {
  const m = new Mutex("t-idempotent");
  const release = await m.acquire();
  release();
  release(); // must not throw or double-release
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: stale owner release cannot release the recovered holder (A/B/C)", async () => {
  const m = new Mutex("t-epoch", 60);
  const releaseA = await m.acquire(1000, "A");

  let bAcquired = false;
  const bPromise = m.acquire(1000, "B").then((r) => {
    bAcquired = true;
    return r;
  });
  await tick(10);
  assert.strictEqual(bAcquired, false, "B must wait behind A");

  // A expires and C recovers the stale lock while B is still queued.
  await tick(70);
  const releaseC = await m.acquire(1000, "C");
  assert.strictEqual(m.state().heldBy, "C");

  // A's obsolete release must NOT release C's lock.
  releaseA();
  assert.strictEqual(m.state().locked, true);
  assert.strictEqual(m.state().heldBy, "C");
  assert.strictEqual(bAcquired, false, "B must not enter while C holds");

  // C releases -> B enters in FIFO order.
  releaseC();
  const releaseB = await bPromise;
  assert.strictEqual(bAcquired, true);
  assert.strictEqual(m.state().heldBy, "B");
  releaseB();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: touch extends hold time and prevents premature stale force-release", async () => {
  const m = new Mutex("t-touch", 60); // 60ms hold limit
  const release = await m.acquire(1000, "active-stream");

  // Wait 40ms, touch, wait 40ms, touch (total 80ms > 60ms limit)
  await tick(40);
  m.touch("active-stream");
  await tick(40);
  m.touch("active-stream");

  // A waiter trying to acquire should still be blocked because active-stream is heartbeating
  let waiterAcquired = false;
  const waiterPromise = m.acquire(200, "waiter").then((r) => {
    waiterAcquired = true;
    return r;
  });

  await tick(20);
  assert.strictEqual(waiterAcquired, false, "waiter must not steal an actively heartbeating lock");

  release();
  const waiterRelease = await waiterPromise;
  assert.strictEqual(waiterAcquired, true);
  waiterRelease();
  assert.strictEqual(m.isIdle(), true);
});
