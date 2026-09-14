import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "patchright";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const { CaptchaCdpTimeoutError } = await import(
  "../services/captcha-solver.ts"
);
const { solveBaxiaCaptcha } = await import("../services/captcha-solver.ts");
const {
  isPlaywrightInitialized,
  onPlaywrightAccountDeath,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
  withAccountPage,
} = await import("../services/playwright.ts");
const {
  __registerBrowserStreamStateForTests,
  __getBrowserStreamStateForTests,
  __resetBrowserStreamStatesForTests,
} = await import("../services/qwen.ts");
const { getHeadersReadyAccountIds } = await import(
  "../core/account-manager.ts"
);
const { getActivePlaywrightAccountIds } = await import(
  "../services/playwright.ts"
);

/**
 * Regresión RCA v2: un renderer Chromium muerto deja promesas CDP pendientes
 * para siempre (ni resuelven ni rechazan). Sin deadline explícito, el solve
 * retenía captchaMouseLock (global), el mutex de cuenta y los browser streams
 * estacionados, sin que el fix previo de account-death llegara a ejecutarse.
 *
 * Cada test usa un cap: en base (sin fix) el solve se cuelga y el cap falla
 * el test en lugar de colgar la suite.
 */

const FAST_BUDGETS = {
  waitForMs: 50,
  maxAttempts: 1,
  retryDelayMs: 10,
  settleMs: 10,
  sliderTimeoutMs: 500,
};

function withTestCap<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`TEST CAP EXCEEDED: ${label} hung >${ms}ms (base stalls)`),
        ),
      ms,
    );
  });
  return Promise.race([promise, cap]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const never: () => Promise<never> = () => new Promise(() => {});

type Box = { x: number; y: number; width: number; height: number };

function fakeLocator(
  opts: {
    visible?: boolean | (() => boolean);
    waitFor?: () => Promise<void>;
    bbox?: () => Promise<Box | null>;
    click?: () => Promise<void>;
  } = {},
): Locator {
  const visible =
    typeof opts.visible === "function" ? opts.visible : () => !!opts.visible;
  const value = {
    first: () => value,
    isVisible: async () => visible(),
    waitFor: opts.waitFor ?? (async () => undefined),
    boundingBox: opts.bbox ?? (async () => null),
    click: opts.click ?? (async () => undefined),
  };
  return value as unknown as Locator;
}

function fakeMouse(
  opts: {
    move?: () => Promise<void>;
    down?: () => Promise<void>;
    up?: () => Promise<void>;
  } = {},
): Page["mouse"] {
  return {
    move: opts.move ?? (async () => undefined),
    down: opts.down ?? (async () => undefined),
    up: opts.up ?? (async () => undefined),
  } as unknown as Page["mouse"];
}

/** Página con challenge Baxia visible (iframe) y slider/track configurables. */
function challengePage(opts: {
  mouse?: Page["mouse"];
  sliderBbox?: () => Promise<Box | null>;
  sliderWaitFor?: () => Promise<void>;
  trackBbox?: () => Promise<Box | null>;
  onSolved?: () => void;
}): Page {
  // Como en el browser real: tras soltar el slider Baxia oculta el diálogo
  // (hide(true)) y el solve observa superficies invisibles = éxito.
  let challengeVisible = true;
  const visible = () => challengeVisible;
  const markSolved = () => {
    challengeVisible = false;
    opts.onSolved?.();
  };
  const dialog = fakeLocator({ visible });
  const content = fakeLocator({ visible });
  const iframe = fakeLocator({ visible });
  const slider = fakeLocator({
    waitFor: opts.sliderWaitFor,
    bbox:
      opts.sliderBbox ??
      (async () => ({ x: 10, y: 20, width: 40, height: 40 })),
  });
  const track = fakeLocator({
    bbox:
      opts.trackBbox ?? (async () => ({ x: 10, y: 20, width: 300, height: 40 })),
  });
  const reload = fakeLocator();
  const invisible = fakeLocator();
  const frame = {
    locator: (selector: string) => {
      if (selector.includes("nc_1_n1z") || selector.includes(".btn_slide"))
        return slider;
      if (selector.includes("nc_1_n1t") || selector.includes(".nc_scale"))
        return track;
      if (
        selector.includes("refresh") ||
        selector.includes("errloading") ||
        selector.includes("btn_refresh")
      )
        return reload;
      return invisible;
    },
  };
  const mouse =
    opts.mouse ??
    fakeMouse({
      up: async () => {
        markSolved();
      },
    });
  return {
    isClosed: () => false,
    locator: (selector: string) => {
      if (selector.includes("iframe")) return iframe;
      if (selector.includes("baxia-dialog-content")) return content;
      if (selector.includes("baxia-dialog")) return dialog;
      return invisible;
    },
    frameLocator: () => frame,
    mouse,
  } as unknown as Page;
}

test("mouse.move que nunca resuelve rechaza con timeout tipado", async () => {
  const page = challengePage({ mouse: fakeMouse({ move: never }) });
  const started = Date.now();
  await assert.rejects(
    withTestCap(
      solveBaxiaCaptcha(page, { ...FAST_BUDGETS }),
      10_000,
      "hanging mouse.move",
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof CaptchaCdpTimeoutError,
        `esperado CaptchaCdpTimeoutError, fue ${String(error)}`,
      );
      assert.equal(
        (error as { code: string }).code,
        "CAPTCHA_CDP_TIMEOUT",
      );
      assert.match((error as Error).message, /drag_approach/);
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 10_000,
    "el deadline debe disparar mucho antes del budget externo",
  );
});

test("boundingBox que nunca resuelve rechaza con timeout tipado", async () => {
  const page = challengePage({ sliderBbox: never });
  await assert.rejects(
    withTestCap(
      solveBaxiaCaptcha(page, { ...FAST_BUDGETS }),
      10_000,
      "hanging boundingBox",
    ),
    (error: unknown) => {
      assert.ok(error instanceof CaptchaCdpTimeoutError);
      assert.match((error as Error).message, /slider_bounds/);
      return true;
    },
  );
});

test("captchaMouseLock se libera tras timeout: segundo solve asienta", async () => {
  const stuck = challengePage({ mouse: fakeMouse({ move: never }) });
  await assert.rejects(
    withTestCap(
      solveBaxiaCaptcha(stuck, { ...FAST_BUDGETS }),
      10_000,
      "first stuck solve",
    ),
    /CaptchaCdpTimeoutError/,
  );

  let solved = false;
  const healthy = challengePage({
    onSolved: () => {
      solved = true;
    },
  });
  // En base el gate global quedaba retenido y este solve se colgaba.
  const result = await withTestCap(
    solveBaxiaCaptcha(healthy, { ...FAST_BUDGETS }),
    25_000,
    "second solve behind stuck gate",
  );
  assert.equal(result, true);
  assert.equal(solved, true);
});

test("segunda cuenta no queda bloqueada por el gate global", async () => {
  const hanging = challengePage({ mouse: fakeMouse({ move: never }) });
  let solvedB = false;
  const healthyB = challengePage({
    onSolved: () => {
      solvedB = true;
    },
  });
  const [a, b] = await withTestCap(
    Promise.allSettled([
      solveBaxiaCaptcha(hanging, { ...FAST_BUDGETS }),
      solveBaxiaCaptcha(healthyB, { ...FAST_BUDGETS }),
    ]),
    25_000,
    "concurrent solves on global gate",
  );
  assert.equal(a.status, "rejected");
  assert.ok(
    (a as PromiseRejectedResult).reason instanceof CaptchaCdpTimeoutError,
  );
  assert.equal(b.status, "fulfilled");
  assert.equal((b as PromiseFulfilledResult<boolean>).value, true);
  assert.equal(solvedB, true);
});

test("timeout del solve resetea cuenta, notifica death y despierta streams", async () => {
  const accountId = "cdp-stall-death";
  const requestId = `req-${accountId}`;
  const page = challengePage({ mouse: fakeMouse({ move: never }) });
  const notified: string[] = [];
  onPlaywrightAccountDeath((id) => {
    notified.push(id);
  });
  try {
    registerPlaywrightAccountForTests(accountId, page, Date.now());
    const { waitForWake } = __registerBrowserStreamStateForTests(
      requestId,
      accountId,
    );

    await assert.rejects(
      withTestCap(
        withAccountPage(
          accountId,
          (p) => solveBaxiaCaptcha(p, { ...FAST_BUDGETS }),
          30_000,
          5_000,
        ),
        20_000,
        "withAccountPage over dead renderer",
      ),
      /CaptchaCdpTimeoutError/,
    );

    await withTestCap(waitForWake, 5_000, "parked stream wake");
    const state = __getBrowserStreamStateForTests(requestId);
    assert.ok(state, "el estado sigue registrado para que pull haga cleanup");
    assert.equal(state.done, true);
    assert.ok(state.error instanceof Error, "pull debe rechazar");
    assert.equal(state.waiters.size, 0);
    assert.equal(
      isPlaywrightInitialized(accountId),
      false,
      "cuenta en cuarentena tras timeout tipado",
    );
    assert.ok(
      notified.includes(accountId),
      "el hook de account death debe ejecutarse",
    );

    // El mutex debe estar libre: re-registrar y operar resuelve rápido.
    const fresh = challengePage({});
    registerPlaywrightAccountForTests(accountId, fresh, Date.now());
    const ok = await withTestCap(
      withAccountPage(accountId, async () => "ok"),
      5_000,
      "mutex after typed timeout",
    );
    assert.equal(ok, "ok");
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
    __resetBrowserStreamStatesForTests();
  }
});

test("/health no depende del solve: responde con gate ocupado", async () => {
  const accountId = "cdp-stall-health";
  const page = challengePage({ mouse: fakeMouse({ move: never }) });
  try {
    registerPlaywrightAccountForTests(accountId, page, Date.now());
    // Solve en vuelo (gate global ocupado por una operación colgada).
    const inflight = solveBaxiaCaptcha(page, { ...FAST_BUDGETS });
    try {
      const deps = await withTestCap(
        (async () => ({
          active: getActivePlaywrightAccountIds(),
          ready: getHeadersReadyAccountIds(),
        }))(),
        2_000,
        "health deps while solve in-flight",
      );
      assert.ok(Array.isArray(deps.active));
      assert.ok(Array.isArray(deps.ready));
    } finally {
      // El propio solve en vuelo también debe asentar (no retener nada).
      await assert.rejects(
        withTestCap(inflight, 15_000, "in-flight solve settles"),
        /CaptchaCdpTimeoutError/,
      );
    }
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

test("/v1/models puede continuar con otra cuenta tras la muerte", async () => {
  const deadId = "cdp-stall-models-dead";
  const liveId = "cdp-stall-models-live";
  const deadPage = challengePage({ mouse: fakeMouse({ move: never }) });
  const livePage = challengePage({});
  try {
    registerPlaywrightAccountForTests(deadId, deadPage, Date.now());
    registerPlaywrightAccountForTests(liveId, livePage, Date.now());

    await assert.rejects(
      withTestCap(
        withAccountPage(
          deadId,
          (p) => solveBaxiaCaptcha(p, { ...FAST_BUDGETS }),
          30_000,
          5_000,
        ),
        20_000,
        "dead account solve",
      ),
      /CaptchaCdpTimeoutError/,
    );
    assert.equal(isPlaywrightInitialized(deadId), false);

    // La cuenta viva sigue operable: el catálogo de modelos puede servirse
    // desde ella (getPreferredModelsAccountId prefiere inicializadas).
    assert.equal(isPlaywrightInitialized(liveId), true);
    const ok = await withTestCap(
      withAccountPage(liveId, async () => "models-ok"),
      5_000,
      "live account while other died",
    );
    assert.equal(ok, "models-ok");
  } finally {
    unregisterPlaywrightAccountForTests(deadId);
    unregisterPlaywrightAccountForTests(liveId);
  }
});
