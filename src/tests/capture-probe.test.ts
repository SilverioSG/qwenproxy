import test from "node:test";
import assert from "node:assert/strict";

process.env.CAPTURE_PROBE = "1";
process.env.CAPTURE_PROBE_HEARTBEAT_MS = "100";
process.env.CAPTURE_PROBE_STALL_MS = "400";

const {
  captureQwenHeaders,
  refreshHeaders,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
  withAccountPage,
} = await import("../services/playwright.ts");
const captureProbe = await import("../services/capture-probe.ts");

const COMPLETE_HEADERS = {
  cookie: "token=x",
  "user-agent": "ua",
  "bx-v": "2.5.37",
  "bx-ua": "present",
  "bx-umidtoken": "present",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCapturedLogs(
  fn: () => Promise<unknown>,
): Promise<{ lines: string[]; error?: unknown }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
    return { lines };
  } catch (error) {
    return { lines, error };
  } finally {
    console.log = original;
  }
}

function probeLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("[CAPTURE-PROBE]"));
}

function stageEvents(lines: string[], stage: string): string[] {
  return probeLines(lines).filter((line) => line.includes(`stage=${stage} `));
}

function countEvent(lines: string[], stage: string, event: string): number {
  return stageEvents(lines, stage).filter((line) =>
    line.includes(`event=${event}`),
  ).length;
}

function makeInvisibleLocator() {
  const invisible = {
    first: () => invisible,
    isVisible: async () => false,
    waitFor: async () => undefined,
    boundingBox: async () => null,
  };
  return invisible;
}

interface RouteArgs {
  route: { abort: (reason?: string) => Promise<void>; continue: () => Promise<void> };
  request: { headers: () => Record<string, string>; postData?: () => string | null };
}

function makeSuccessPage(
  headerSets: Record<string, string>[],
  onIntercept?: (call: number) => void,
) {
  const invisible = makeInvisibleLocator();
  const state = { sends: 0, unroutes: 0, aborts: 0, continues: 0 };
  let handler: ((route: RouteArgs["route"], request: RouteArgs["request"]) => Promise<void>) | null =
    null;

  const page = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async (
      _pattern: string,
      routeHandler: (route: RouteArgs["route"], request: RouteArgs["request"]) => Promise<void>,
    ) => {
      handler = routeHandler;
    },
    unroute: async () => {
      state.unroutes++;
    },
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {
      const headers = headerSets[Math.min(state.sends, headerSets.length - 1)];
      state.sends++;
      onIntercept?.(state.sends);
      await handler!(
        {
          abort: async () => {
            state.aborts++;
          },
          continue: async () => {
            state.continues++;
          },
        },
        { headers: () => headers },
      );
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  return { page, state };
}

test("capture probe: normal capture emits balanced ENTER/EXIT stages", async () => {
  const { page } = makeSuccessPage([COMPLETE_HEADERS]);

  const { lines, error } = await withCapturedLogs(async () => {
    await captureQwenHeaders("test-capture-normal", page as any, 30_000, 50);
    await sleep(50);
  });
  assert.equal(error, undefined);

  const probe = probeLines(lines);
  assert.ok(probe.length > 0, "probe enabled must emit CAPTURE-PROBE lines");

  for (const stage of [
    "capture",
    "route_register",
    "capture_goto",
    "trigger_send",
    "route_handler",
  ]) {
    assert.equal(
      countEvent(lines, stage, "ENTER"),
      countEvent(lines, stage, "EXIT"),
      `stage ${stage} ENTER/EXIT must balance`,
    );
    assert.ok(countEvent(lines, stage, "ENTER") >= 1, `stage ${stage} missing`);
  }

  const captureEnter = probe[0];
  assert.ok(captureEnter.includes("stage=capture event=ENTER"));
  assert.ok(captureEnter.includes("account=testcapt"));
  assert.ok(!captureEnter.includes("test-capture-normal"));

  const registerExit = probe.findIndex((line) =>
    line.includes("stage=route_register event=EXIT"),
  );
  const captureExit = probe.findIndex((line) =>
    line.includes("stage=capture event=EXIT"),
  );
  const settleIndex = probe.findIndex((line) =>
    line.includes("stage=capture_settle"),
  );
  assert.ok(registerExit > 0);
  assert.ok(captureExit > 0, "capture EXIT must be emitted");
  assert.ok(settleIndex > 0 && settleIndex < captureExit);

  const handlerExit = stageEvents(lines, "route_handler").find((line) =>
    line.includes("event=EXIT"),
  );
  assert.ok(handlerExit?.includes("result=abort"));
  assert.ok(handlerExit?.includes("intercept_count=1"));

  const settle = stageEvents(lines, "capture_settle");
  assert.equal(settle.length, 1);
  assert.ok(settle[0].includes("outcome=ok"));

  const heartbeat = probe.filter((line) => line.includes("event=HEARTBEAT") || line.includes("event=STALL"));
  assert.ok(heartbeat.length >= 1, "heartbeat must run while capture is active");
  for (const line of heartbeat) {
    assert.ok(line.includes("stage="));
    assert.ok(line.includes("stage_age_ms="));
    assert.ok(line.includes("intercept_count="));
    assert.ok(line.includes("attempt="));
  }
});

test("capture probe: route handler enter/exit stay balanced across retriggers", async () => {
  const { page, state } = makeSuccessPage([
    { "bx-ua": "present" },
    COMPLETE_HEADERS,
  ]);

  const { lines, error } = await withCapturedLogs(async () => {
    await captureQwenHeaders("test-capture-retrigger", page as any, 30_000, 50);
    await sleep(50);
  });
  assert.equal(error, undefined);
  assert.equal(state.sends, 2);

  assert.equal(countEvent(lines, "route_handler", "ENTER"), 2);
  assert.equal(countEvent(lines, "route_handler", "EXIT"), 2);
  assert.equal(countEvent(lines, "trigger_send", "ENTER"), 2);
  assert.equal(countEvent(lines, "trigger_send", "EXIT"), 2);

  const handlerExits = stageEvents(lines, "route_handler").filter((line) =>
    line.includes("event=EXIT"),
  );
  assert.ok(handlerExits[0].includes("intercept_count=1"));
  assert.ok(handlerExits[0].includes("result=abort"));
  assert.ok(handlerExits[1].includes("intercept_count=2"));

  const secondTrigger = stageEvents(lines, "trigger_send").filter((line) =>
    line.includes("event=ENTER"),
  )[1];
  assert.ok(secondTrigger.includes("attempt=2"));
});

test("capture probe: goto error emits ERROR and still closes the capture", async () => {
  const base = makeSuccessPage([COMPLETE_HEADERS]);
  const page = { ...base.page, goto: async () => { throw new Error("nav boom"); } };

  const { lines, error } = await withCapturedLogs(() =>
    captureQwenHeaders("test-capture-goto-error", page as any, 30_000, 50),
  );
  assert.ok(error instanceof Error);

  const gotoError = stageEvents(lines, "capture_goto").find((line) =>
    line.includes("event=ERROR"),
  );
  assert.ok(gotoError, "capture_goto ERROR must be emitted");
  assert.ok(gotoError!.includes("error=Error"));

  const settle = stageEvents(lines, "capture_settle");
  assert.equal(settle.length, 1);
  assert.ok(settle[0].includes("outcome=error"));

  assert.equal(countEvent(lines, "capture", "EXIT"), 1);
  const probe = probeLines(lines);
  assert.ok(probe[probe.length - 1].includes("stage=capture event=EXIT"));
});

test("capture probe: triggerSend error emits ERROR and still closes the capture", async () => {
  const invisible = makeInvisibleLocator();
  const page = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {},
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: {
      press: async () => {
        throw new Error("send boom");
      },
    },
  };

  const { lines, error } = await withCapturedLogs(() =>
    captureQwenHeaders("test-capture-send-error", page as any, 30_000, 50),
  );
  assert.ok(error instanceof Error);

  const sendError = stageEvents(lines, "trigger_send").find((line) =>
    line.includes("event=ERROR"),
  );
  assert.ok(sendError, "trigger_send ERROR must be emitted");
  assert.ok(sendError!.includes("error=Error"));

  assert.equal(countEvent(lines, "capture", "EXIT"), 1);
});

test("capture probe: heartbeat runs while active and stops after end", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const traceId = captureProbe.beginCaptureTrace("test-heartbeat-account");
    assert.ok(traceId.length > 0);
    captureProbe.captureStageEnter("capture");
    captureProbe.captureSetActive(true);
    await sleep(650);
    captureProbe.captureSetActive(false);
    const linesAtStop = probeLines(lines).length;
    await sleep(300);
    assert.equal(
      probeLines(lines).length,
      linesAtStop,
      "no heartbeat may fire after captureSetActive(false)",
    );

    const heartbeats = probeLines(lines).filter(
      (line) => line.includes("event=HEARTBEAT") || line.includes("event=STALL"),
    );
    assert.ok(heartbeats.length >= 1, "heartbeat must fire while active");
    assert.ok(
      heartbeats.some((line) => line.includes("event=STALL")),
      "a stage older than the stall threshold must flip to STALL",
    );

    captureProbe.captureStageExit("capture");
    captureProbe.endCaptureTrace(traceId, "done");
    const linesAfterEnd = probeLines(lines).length;
    await sleep(250);
    assert.equal(probeLines(lines).length, linesAfterEnd);
  } finally {
    console.log = original;
  }
});

test("capture probe: recovery_returned point event contract", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const traceId = captureProbe.beginCaptureTrace("5c9c6c18-503b-4fa2");
    captureProbe.capturePoint("recovery_returned", { solved: 1 });
    captureProbe.captureStageEnter("headers_refresh");
    captureProbe.captureStageExit("headers_refresh", { duration_ms: 12 });
    captureProbe.captureStageEnter("retry_fetch");
    captureProbe.endCaptureTrace(traceId, "retry_fetch_started");
  } finally {
    console.log = original;
  }

  const probe = probeLines(lines);
  assert.ok(probe[0].includes("stage=recovery_returned"));
  assert.ok(probe[0].includes("solved=1"));
  assert.ok(probe[0].includes("account=5c9c6c18"));
  assert.ok(!probe[0].includes("503b-4fa2"));
  assert.ok(probe.some((line) => line.includes("stage=headers_refresh event=ENTER")));
  assert.ok(
    probe.some((line) =>
      line.includes("stage=headers_refresh event=EXIT") &&
      line.includes("duration_ms=12"),
    ),
  );
  assert.ok(probe.some((line) => line.includes("stage=retry_fetch event=ENTER")));
});

test("capture probe: refreshHeaders emits mutex_acquire and refresh_goto reusing the recovery trace", async () => {
  const accountId = "5c9c6c18-503b-4fa2-d4b2";
  const { page } = makeSuccessPage([COMPLETE_HEADERS]);
  registerPlaywrightAccountForTests(accountId, page as any, Date.now());
  try {
    const { lines, error } = await withCapturedLogs(async () => {
      const traceId = captureProbe.beginCaptureTrace(accountId);
      captureProbe.capturePoint("recovery_returned", { solved: 1 });
      await refreshHeaders(accountId, 30_000);
      await sleep(50);
      captureProbe.endCaptureTrace(traceId, "done");
    });
    assert.equal(error, undefined);

    const probe = probeLines(lines);
    assert.ok(probe.length > 0);

    const traceIds = new Set(
      probe.map((line) => line.match(/trace=(\w+)/)?.[1]),
    );
    assert.equal(
      traceIds.size,
      1,
      "the recovery trace id must be reused end to end",
    );

    assert.equal(countEvent(lines, "mutex_acquire", "ENTER"), 1);
    assert.equal(countEvent(lines, "mutex_acquire", "EXIT"), 1);
    assert.equal(countEvent(lines, "mutex_acquire", "ERROR"), 0);
    assert.equal(countEvent(lines, "refresh_goto", "ENTER"), 1);
    assert.equal(countEvent(lines, "refresh_goto", "EXIT"), 1);
    assert.equal(countEvent(lines, "refresh_goto", "ERROR"), 0);

    const indexOf = (needle: string) =>
      probe.findIndex((line) => line.includes(needle));
    const mutexEnter = indexOf("stage=mutex_acquire event=ENTER");
    const mutexExit = indexOf("stage=mutex_acquire event=EXIT");
    const gotoEnter = indexOf("stage=refresh_goto event=ENTER");
    const gotoExit = indexOf("stage=refresh_goto event=EXIT");
    const captureEnter = indexOf("stage=capture event=ENTER");
    assert.ok(mutexEnter >= 0 && mutexExit > mutexEnter);
    assert.ok(gotoEnter > mutexExit && gotoExit > gotoEnter);
    assert.ok(captureEnter > gotoExit, "capture starts after the refresh goto");

    const mutexExitLine = probe[mutexExit];
    assert.ok(mutexExitLine.includes("duration_ms="));
    assert.ok(mutexExitLine.includes("account=5c9c6c18"));
    assert.ok(!probe.some((line) => line.includes("503b-4fa2")));
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

test("capture probe: mutex_acquire emits ERROR when the account mutex is held", async () => {
  const accountId = "mutex-err-account";
  const invisible = makeInvisibleLocator();
  const page = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {},
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };
  registerPlaywrightAccountForTests(accountId, page as any, Date.now());
  try {
    const hold = withAccountPage(
      accountId,
      () => sleep(1_600),
      5_000,
      5_000,
    ).catch(() => undefined);
    await sleep(50);

    const { lines, error } = await withCapturedLogs(async () => {
      const traceId = captureProbe.beginCaptureTrace(accountId);
      captureProbe.capturePoint("recovery_returned", { solved: 1 });
      await refreshHeaders(accountId, 1_000);
      captureProbe.endCaptureTrace(traceId, "done");
    });

    assert.ok(error instanceof Error);
    assert.match((error as Error).message, /acquire timeout/);
    assert.equal(countEvent(lines, "mutex_acquire", "ENTER"), 1);
    assert.equal(countEvent(lines, "mutex_acquire", "ERROR"), 1);
    assert.equal(countEvent(lines, "mutex_acquire", "EXIT"), 0);
    const errorLine = stageEvents(lines, "mutex_acquire").find((line) =>
      line.includes("event=ERROR"),
    );
    assert.ok(errorLine?.includes("error=Error"));
    assert.equal(countEvent(lines, "refresh_goto", "ENTER"), 0);

    await hold;
    await sleep(200);
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

test("capture probe: refresh_goto emits ERROR when the navigation check fails", async () => {
  const accountId = "goto-err-account";
  const { page: basePage } = makeSuccessPage([COMPLETE_HEADERS]);
  const page = {
    ...basePage,
    goto: async () => {
      throw new Error("refresh nav boom");
    },
  };
  registerPlaywrightAccountForTests(accountId, page as any, Date.now());
  try {
    const { lines } = await withCapturedLogs(async () => {
      const traceId = captureProbe.beginCaptureTrace(accountId);
      captureProbe.capturePoint("recovery_returned", { solved: 1 });
      await refreshHeaders(accountId, 30_000).catch((e) => e);
      await sleep(50);
      captureProbe.endCaptureTrace(traceId, "done");
    });

    assert.equal(countEvent(lines, "mutex_acquire", "EXIT"), 1);
    assert.equal(countEvent(lines, "refresh_goto", "ENTER"), 1);
    assert.equal(countEvent(lines, "refresh_goto", "EXIT"), 0);
    const gotoError = stageEvents(lines, "refresh_goto").find((line) =>
      line.includes("event=ERROR"),
    );
    assert.ok(gotoError, "refresh_goto ERROR must be emitted");
    assert.ok(gotoError!.includes("error=Error"));
    assert.ok(gotoError!.includes("duration_ms="));
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

test("capture probe: disabled probe emits zero logs", async () => {
  const previous = process.env.CAPTURE_PROBE;
  process.env.CAPTURE_PROBE = "0";
  try {
    assert.equal(captureProbe.captureProbeEnabled(), false);

    const { page } = makeSuccessPage([COMPLETE_HEADERS]);
    const { lines, error } = await withCapturedLogs(() =>
      captureQwenHeaders("test-capture-off", page as any, 30_000, 50),
    );
    assert.equal(error, undefined);
    assert.equal(probeLines(lines).length, 0, "probe OFF must emit 0 lines");

    const refreshAccountId = "refresh-off-account";
    registerPlaywrightAccountForTests(
      refreshAccountId,
      page as any,
      Date.now(),
    );
    try {
      const refreshResult = await withCapturedLogs(async () => {
        captureProbe.beginCaptureTrace(refreshAccountId);
        await refreshHeaders(refreshAccountId, 30_000);
        await sleep(50);
      });
      assert.equal(refreshResult.error, undefined);
      assert.equal(
        probeLines(refreshResult.lines).length,
        0,
        "probe OFF must emit 0 lines through refreshHeaders",
      );
    } finally {
      unregisterPlaywrightAccountForTests(refreshAccountId);
    }

    const direct: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      direct.push(args.map(String).join(" "));
    };
    try {
      const traceId = captureProbe.beginCaptureTrace("off-account");
      captureProbe.captureStageEnter("capture");
      captureProbe.capturePoint("recovery_returned", { solved: 1 });
      captureProbe.endCaptureTrace(traceId, "done");
    } finally {
      console.log = original;
    }
    assert.equal(probeLines(direct).length, 0);
  } finally {
    process.env.CAPTURE_PROBE = previous;
  }
});
