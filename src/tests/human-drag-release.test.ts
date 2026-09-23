import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const { humanDrag, CaptchaCdpTimeoutError } = await import(
  "../services/human-behavior.ts"
);

interface MockMouse {
  moves: number;
  downs: number;
  ups: number;
  onMove?: (n: number) => Promise<void> | void;
  onDown?: () => Promise<void> | void;
  onUp?: () => Promise<void> | void;
}

function makePage(mock: MockMouse): any {
  return {
    mouse: {
      move: async (..._args: unknown[]) => {
        mock.moves += 1;
        await mock.onMove?.(mock.moves);
      },
      down: async (..._args: unknown[]) => {
        mock.downs += 1;
        await mock.onDown?.();
      },
      up: async (..._args: unknown[]) => {
        mock.ups += 1;
        await mock.onUp?.();
      },
    },
  };
}

function withTestCap<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`TEST CAP EXCEEDED: ${label} hung >${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, cap]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test("TC1 normal: down OK, trajectory sana, up exactamente 1 vez, sin error", async () => {
  const mock: MockMouse = { moves: 0, downs: 0, ups: 0 };
  await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, 8000),
    15000,
    "TC1",
  );
  assert.equal(mock.downs, 1);
  assert.equal(mock.ups, 1);
  assert.ok(mock.moves > 1);
});

test("TC2 trajectory CaptchaCdpTimeoutError: up 0 veces, error original preservado", async () => {
  const original = new CaptchaCdpTimeoutError("drag_move", 8000);
  const mock: MockMouse = {
    moves: 0,
    downs: 0,
    ups: 0,
    onMove: (n) => {
      // move #1 = approach; trajectory moves empiezan en #2
      if (n >= 4) throw original;
    },
  };
  const err = await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, 8000).then(
      () => null,
      (e: unknown) => e,
    ),
    15000,
    "TC2",
  );
  assert.equal(mock.downs, 1);
  assert.equal(mock.ups, 0);
  assert.equal(err, original);
  assert.ok(err instanceof CaptchaCdpTimeoutError);
});

test("TC3 elapsed > timeout: up 0 veces, CaptchaCdpTimeoutError(drag_trajectory)", async () => {
  const mock: MockMouse = { moves: 0, downs: 0, ups: 0 };
  const realNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  mock.onMove = () => {
    now += 1000;
  };
  try {
    const err = await withTestCap(
      humanDrag(makePage(mock), 0, 0, 100, 0, 8000).then(
        () => null,
        (e: unknown) => e,
      ),
      15000,
      "TC3",
    );
    assert.equal(mock.downs, 1);
    assert.equal(mock.ups, 0);
    assert.ok(err instanceof CaptchaCdpTimeoutError);
    assert.equal((err as { stage?: unknown }).stage, "drag_trajectory");
  } finally {
    (Date as any).now = realNow;
  }
});

test("TC4 generic error con renderer sano: up se ejecuta, error original preservado", async () => {
  const original = new Error("boom-logic");
  const mock: MockMouse = {
    moves: 0,
    downs: 0,
    ups: 0,
    onMove: (n) => {
      if (n >= 4) throw original;
    },
  };
  const err = await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, 8000).then(
      () => null,
      (e: unknown) => e,
    ),
    15000,
    "TC4",
  );
  assert.equal(mock.downs, 1);
  assert.equal(mock.ups, 1);
  assert.equal(err, original);
  assert.ok(!(err instanceof CaptchaCdpTimeoutError));
});

test("TC5 error antes de down: up 0 veces, error original preservado", async () => {
  const original = new Error("down-failed");
  const mock: MockMouse = {
    moves: 0,
    downs: 0,
    ups: 0,
    onDown: () => {
      throw original;
    },
  };
  const err = await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, 8000).then(
      () => null,
      (e: unknown) => e,
    ),
    15000,
    "TC5",
  );
  assert.equal(mock.downs, 1);
  assert.equal(mock.ups, 0);
  assert.equal(err, original);
});

test("TC6 timeoutMs undefined: comportamiento actual preservado", async () => {
  const mock: MockMouse = { moves: 0, downs: 0, ups: 0 };
  await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, undefined),
    15000,
    "TC6-ok",
  );
  assert.equal(mock.downs, 1);
  assert.equal(mock.ups, 1);

  const original = new Error("boom-undefined");
  const mock2: MockMouse = {
    moves: 0,
    downs: 0,
    ups: 0,
    onMove: (n) => {
      if (n >= 4) throw original;
    },
  };
  const err = await withTestCap(
    humanDrag(makePage(mock2), 0, 0, 100, 0, undefined).then(
      () => null,
      (e: unknown) => e,
    ),
    15000,
    "TC6-err",
  );
  assert.equal(mock2.downs, 1);
  assert.equal(mock2.ups, 1);
  assert.equal(err, original);
});

test("TC7 throw en release no sobrescribe error previo de trajectory", async () => {
  const original = new Error("trajectory-boom");
  const releaseErr = new Error("release-boom");
  const mock: MockMouse = {
    moves: 0,
    downs: 0,
    ups: 0,
    onMove: (n) => {
      if (n >= 4) throw original;
    },
    onUp: () => {
      throw releaseErr;
    },
  };
  const err = await withTestCap(
    humanDrag(makePage(mock), 0, 0, 100, 0, 8000).then(
      () => null,
      (e: unknown) => e,
    ),
    15000,
    "TC7",
  );
  assert.equal(mock.ups, 1);
  assert.equal(err, original);
  assert.notEqual(err, releaseErr);
});
