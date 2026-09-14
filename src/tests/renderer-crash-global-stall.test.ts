import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const {
  installContextDeathHandlers,
  isPlaywrightInitialized,
  onPlaywrightAccountDeath,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
  withAccountPage,
} = await import("../services/playwright.ts");

const {
  failBrowserStreamsForAccount,
  __registerBrowserStreamStateForTests,
  __getBrowserStreamStateForTests,
  __resetBrowserStreamStatesForTests,
} = await import("../services/qwen.ts");

/**
 * Regresión: antiBotChallenge → captcha challenge_opened → crash de renderer
 * Chromium. El request quedaba estacionado para siempre en
 * browserStreamStates.waiters + ReadableStream pull + honoStream SSE (el
 * renderer muerto jamás enviaba headers/chunk/done/error), el slot de stream
 * quedaba activo, y los sockets huérfanos saturaban el listener (:7936 LISTEN
 * con cientos de CLOSE-WAIT, /health y /v1/models con timeout, systemd sin
 * reiniciar porque Node seguía vivo).
 *
 * El fix mínimo: (1) withAccountPage resetea el contexto también ante errores
 * de crash (no solo ante timeout) y (2) la muerte de la cuenta falla
 * explícitamente sus browser streams estacionados (scoped por cuenta).
 */

function makeFakeContextAndPage() {
  const handlers: Record<string, Array<() => void>> = {};
  const register = (key: string, cb: () => void): void => {
    if (!handlers[key]) handlers[key] = [];
    handlers[key].push(cb);
  };
  const context: any = {
    on: (event: string, cb: () => void) => {
      register(`context:${event}`, cb);
    },
    pages: () => [],
    close: async () => {},
  };
  const page: any = {
    on: (event: string, cb: () => void) => {
      register(`page:${event}`, cb);
    },
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    close: async () => {},
  };
  const fire = (key: string): void => {
    for (const cb of handlers[key] || []) cb();
  };
  return { context, page, fire };
}

async function expectWake(
  promise: Promise<void>,
  what: string,
): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what}: waiter colgado (global block)`)),
        2_000,
      ),
    ),
  ]);
}

test("renderer crash durante withAccountPage resetea la cuenta y libera el mutex", async () => {
  const accountId = "stall-with-page-crash";
  const crashMessages = [
    "page.evaluate: Target crashed",
    "Page crashed",
    "Protocol error (Page.navigate): Target crashed",
  ];
  try {
    for (const crash of crashMessages) {
      const { page } = makeFakeContextAndPage();
      registerPlaywrightAccountForTests(accountId, page, Date.now());
      await assert.rejects(
        withAccountPage(accountId, async () => {
          throw new Error(crash);
        }),
        new RegExp(crash.replace(/[()]/g, "\\$&").slice(0, 20)),
      );
      assert.equal(
        isPlaywrightInitialized(accountId),
        false,
        `tras "${crash}" la cuenta debe quedar re-inicializable (cuarentena)`,
      );
      // El mutex debe estar liberado: re-registrar y operar resuelve rápido.
      const { page: fresh } = makeFakeContextAndPage();
      registerPlaywrightAccountForTests(accountId, fresh, Date.now());
      const ok = await Promise.race([
        withAccountPage(accountId, async () => "ok"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("mutex fugado tras crash")), 2_000),
        ),
      ]);
      assert.equal(ok, "ok");
      unregisterPlaywrightAccountForTests(accountId);
    }
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

test("page crash despierta el stream estacionado con error (no CLOSE-WAIT)", async () => {
  const accountId = "stall-parked-stream";
  const requestId = `req-${accountId}`;
  const { context, page, fire } = makeFakeContextAndPage();
  try {
    registerPlaywrightAccountForTests(accountId, page, Date.now());
    installContextDeathHandlers(accountId, context as any, page as any);
    const { waitForWake } = __registerBrowserStreamStateForTests(
      requestId,
      accountId,
    );

    // antiBotChallenge → challenge_opened → el renderer muere en mitad del solve.
    fire("page:crash");
    await expectWake(waitForWake, "page crash");

    const state = __getBrowserStreamStateForTests(requestId);
    assert.ok(state, "el estado debe seguir registrado para que pull haga cleanup");
    assert.equal(state.done, true);
    assert.ok(state.error instanceof Error, "pull debe rechazar (libera slot/mutex/socket)");
    assert.equal(state.waiters.size, 0, "sin waiters colgados = el handler SSE puede retornar");
    assert.equal(isPlaywrightInitialized(accountId), false, "cuenta en cuarentena");
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
    __resetBrowserStreamStatesForTests();
  }
});

test("la muerte de una cuenta aisla: otra cuenta sigue atendiendo", async () => {
  const deadId = "stall-dead-account";
  const liveId = "stall-live-account";
  const deadReq = `req-${deadId}`;
  const liveReq = `req-${liveId}`;
  const dead = makeFakeContextAndPage();
  const live = makeFakeContextAndPage();
  try {
    registerPlaywrightAccountForTests(deadId, dead.page, Date.now());
    registerPlaywrightAccountForTests(liveId, live.page, Date.now());
    installContextDeathHandlers(deadId, dead.context as any, dead.page as any);
    installContextDeathHandlers(liveId, live.context as any, live.page as any);
    const deadParked = __registerBrowserStreamStateForTests(deadReq, deadId);
    const liveParked = __registerBrowserStreamStateForTests(liveReq, liveId);

    dead.fire("page:crash");
    await expectWake(deadParked.waitForWake, "cuenta muerta");

    // La cuenta viva no debe ser tocada: failover posible.
    const liveState = __getBrowserStreamStateForTests(liveReq);
    assert.ok(liveState && !liveState.done && liveState.error === null);
    assert.equal(isPlaywrightInitialized(liveId), true);
    assert.equal(isPlaywrightInitialized(deadId), false);
    // Su waiter sigue estacionado legítimamente (no fue despertado por error).
    assert.equal(liveState.waiters.size, 1);
    void liveParked;
  } finally {
    unregisterPlaywrightAccountForTests(deadId);
    unregisterPlaywrightAccountForTests(liveId);
    __resetBrowserStreamStatesForTests();
  }
});

test("failBrowserStreamsForAccount es scoped y no bloquea globalmente", async () => {
  const deadId = "stall-scope-dead";
  const otherId = "stall-scope-other";
  try {
    const deadParked = __registerBrowserStreamStateForTests("req-scope-dead", deadId);
    const otherParked = __registerBrowserStreamStateForTests("req-scope-other", otherId);

    failBrowserStreamsForAccount(deadId, "Browser context closed during stream");
    await expectWake(deadParked.waitForWake, "fail scoped");

    const deadState = __getBrowserStreamStateForTests("req-scope-dead");
    assert.equal(deadState?.done, true);
    assert.match(deadState?.error?.message ?? "", /account=stall-scope-dead/);
    const otherState = __getBrowserStreamStateForTests("req-scope-other");
    assert.ok(otherState && !otherState.done && otherState.error === null);
    assert.equal(otherState.waiters.size, 1);
    // Llamar dos veces no acumula nada (idempotente, sin CLOSE-WAIT).
    failBrowserStreamsForAccount(deadId);
    assert.equal(deadState?.waiters.size, 0);
    void otherParked;
  } finally {
    __resetBrowserStreamStatesForTests();
  }
});

test("onPlaywrightAccountDeath notifica y el hook de qwen está suscrito", async () => {
  const accountId = "stall-death-hook";
  const notified: string[] = [];
  onPlaywrightAccountDeath((id) => {
    notified.push(id);
  });
  const { context, page, fire } = makeFakeContextAndPage();
  try {
    registerPlaywrightAccountForTests(accountId, page, Date.now());
    installContextDeathHandlers(accountId, context as any, page as any);
    const { waitForWake } = __registerBrowserStreamStateForTests(
      `req-${accountId}`,
      accountId,
    );
    fire("context:close");
    await expectWake(waitForWake, "context close vía suscripción qwen");
    assert.ok(notified.includes(accountId), "cleanup debe notificar a los hooks");
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
    __resetBrowserStreamStatesForTests();
  }
});
