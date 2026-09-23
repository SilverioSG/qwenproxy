import type { Page } from "patchright";
import { captchaStageEnter, captchaStageExit } from "./captcha-probe.ts";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Typed timeout for a CDP/Playwright interaction that never settles.
 *
 * A dead renderer (Chromium crash) can leave a protocol promise pending
 * forever: it neither resolves nor rejects, so no `catch` and no crash event
 * ever runs. Every potentially-unsettlable CDP await in the captcha path is
 * raced against this deadline so the failure becomes an identifiable error
 * instead of an indefinite hang. Identifiable via `instanceof`, `name` and
 * `code` (callers without the class import can duck-type on `code`).
 */
export class CaptchaCdpTimeoutError extends Error {
  readonly code = "CAPTCHA_CDP_TIMEOUT";
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`Captcha CDP operation timed out: ${stage} after ${timeoutMs}ms`);
    this.name = "CaptchaCdpTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a CDP-backed promise against an explicit deadline.
 *
 * The loser's late settlement is marked handled so a promise that settles
 * after the race does not surface as an unhandled rejection. The timer is
 * intentionally ref'd: the deadline must fire even when nothing else keeps
 * the loop alive in the test harness.
 */
export function withCdpDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      reject(new CaptchaCdpTimeoutError(stage, ms));
    }, ms);
  });
  void promise.then(undefined, () => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function humanDelay(
  minMs: number,
  maxMs: number,
  rng: () => number = Math.random,
): number {
  if (maxMs <= minMs) return minMs;
  const midpoint = (minMs + maxMs) / 2;
  const jitter = (rng() - 0.5) * (maxMs - minMs);
  return Math.round(Math.max(minMs, Math.min(maxMs, midpoint + jitter)));
}

/**
 * Box-Muller gaussian sample (mean 0, sigma 1). Uniform jitter is itself a bot
 * signature: real pointer noise clusters around zero, so the Baxia slider
 * scorer treats a flat distribution as synthetic.
 */
export function gaussianNoise(rng: () => number = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal delay: most steps are quick, a few are long — the heavy tail real
 * hands produce. Linear/uniform sleeps read as a metronome to the scorer.
 */
export function logNormalDelay(
  medianMs: number,
  sigma: number,
  rng: () => number = Math.random,
): number {
  return Math.max(1, Math.round(medianMs * Math.exp(sigma * gaussianNoise(rng))));
}

/** One pointer sample of a slider drag. */
export interface DragSample {
  x: number;
  y: number;
  /** Delay to wait BEFORE emitting this sample. */
  delayMs: number;
}

/**
 * Pure trajectory generator for a human slider drag.
 *
 * Baxia scores the *shape* of the drag, not just its endpoints, so the path
 * must reproduce the three things a real hand does that a linear ramp does not:
 * an acceleration ramp, an overshoot past the target followed by a correction
 * phase, and dwell pauses mid-path.
 */
export function buildDragTrajectory(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  rng: () => number = Math.random,
): DragSample[] {
  const distance = Math.hypot(endX - startX, endY - startY);
  const steps = Math.max(30, Math.min(50, Math.round(distance / 6)));
  const samples: DragSample[] = [];

  // Overshoot target: real hands decelerate late and pass the mark, then
  // correct. ~12% of the remaining distance, clamped so it stays on-page.
  const overshootX = endX + Math.max(4, distance * 0.12);
  const correctionSteps = Math.max(4, Math.round(steps * 0.2));

  for (let step = 1; step <= steps; step++) {
    const progress = step / steps;
    // Cubic ease-in-out with an acceleration ramp: slow start, fast middle.
    const eased =
      progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const ramp = 0.7 + Math.min(0.6, progress * 1.3);

    const targetX = startX + (overshootX - startX) * eased;
    const jitterY = gaussianNoise(rng) * 1.2;

    // Micro-pauses: humans hesitate at roughly a third and two thirds of a
    // deliberate drag.
    const nearPause =
      Math.abs(progress - 0.3) < 1 / steps || Math.abs(progress - 0.65) < 1 / steps;
    const delayMs = nearPause
      ? logNormalDelay(90, 0.5, rng)
      : logNormalDelay(14 / ramp, 0.45, rng);

    samples.push({
      x: targetX,
      y: startY + (endY - startY) * eased + jitterY,
      delayMs,
    });
  }

  // Correction phase: ease the pointer back from the overshoot onto the target.
  for (let step = 1; step <= correctionSteps; step++) {
    const progress = step / correctionSteps;
    const eased = 1 - Math.pow(1 - progress, 2);
    samples.push({
      x: overshootX + (endX - overshootX) * eased,
      y: endY + gaussianNoise(rng) * 0.8,
      delayMs: logNormalDelay(22, 0.4, rng),
    });
  }

  // Land exactly on the target so the slider registers the release in-range.
  samples.push({ x: endX, y: endY, delayMs: logNormalDelay(18, 0.3, rng) });
  return samples;
}

export async function humanDrag(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  /**
   * Per mouse-operation deadline. Playwright mouse calls are raw CDP
   * (Input.dispatchMouseEvent) with no timeout option: after a renderer
   * crash the promise can stay pending forever and wedge the global captcha
   * lock. The sleeps between samples are local timers and stay outside the
   * deadline; only the protocol round-trips are raced.
   */
  timeoutMs?: number,
): Promise<void> {
  const mouse = (operation: Promise<void>, stage: string): Promise<void> =>
    timeoutMs === undefined
      ? operation
      : withCdpDeadline(operation, timeoutMs, stage);
  // Approach with its own path, then dwell before pressing: a pointer that
  // teleports onto the handle and clicks instantly is the classic automation
  // signature.
  captchaStageEnter("drag_approach");
  await mouse(page.mouse.move(startX, startY, { steps: 8 }), "drag_approach");
  captchaStageExit("drag_approach");
  await sleep(logNormalDelay(160, 0.5));
  captchaStageEnter("drag_press");
  await mouse(page.mouse.down(), "drag_press");
  captchaStageExit("drag_press");
  const mouseDownSucceeded = true;
  await sleep(logNormalDelay(120, 0.5));

  // A stalled renderer answers every CDP round-trip slower and slower until
  // a mouse operation never settles. Issuing one more CDP call (mouse.up)
  // against that session wedges the whole process: the pending promise
  // retains the CDP chain and the event loop can no longer drain it (OOM).
  // Track trajectory health explicitly and skip the release call when the
  // renderer already proved degraded. The error always propagates; no throw
  // here may override a previous one.
  //
  // Health is measured as accumulated CDP round-trip time, not wall time:
  // the sleeps between samples are local timers and say nothing about the
  // renderer. When the session is healthy each round-trip settles in
  // milliseconds; when the accumulated CDP time of one drag exceeds the
  // per-operation deadline, the session is degraded.
  let hasTrajectoryError = false;
  let trajectoryError: unknown;
  let rendererDegraded = false;
  let trajectoryCdpMs = 0;
  try {
    captchaStageEnter("drag_trajectory");
    for (const sample of buildDragTrajectory(startX, startY, endX, endY)) {
      await sleep(sample.delayMs);
      const opStart = Date.now();
      try {
        await mouse(
          page.mouse.move(sample.x, sample.y, { steps: 1 }),
          "drag_move",
        );
      } finally {
        trajectoryCdpMs += Date.now() - opStart;
      }
    }
    // Dwell before release — humans verify the handle is in place.
    await sleep(logNormalDelay(220, 0.5));
    captchaStageExit("drag_trajectory");
  } catch (err) {
    hasTrajectoryError = true;
    trajectoryError = err;
    if (err instanceof CaptchaCdpTimeoutError) rendererDegraded = true;
  }

  if (
    !hasTrajectoryError &&
    mouseDownSucceeded &&
    timeoutMs !== undefined &&
    trajectoryCdpMs > timeoutMs
  ) {
    rendererDegraded = true;
  }

  if (rendererDegraded) {
    if (hasTrajectoryError) throw trajectoryError;
    throw new CaptchaCdpTimeoutError("drag_trajectory", trajectoryCdpMs);
  }

  if (hasTrajectoryError) {
    try {
      captchaStageEnter("drag_release");
      await mouse(page.mouse.up(), "drag_release");
      captchaStageExit("drag_release");
    } catch {
      // The release is best-effort here: the original trajectory error
      // must propagate unchanged.
    }
    throw trajectoryError;
  }

  captchaStageEnter("drag_release");
  await mouse(page.mouse.up(), "drag_release");
  captchaStageExit("drag_release");
}

export async function subtlePageActivity(page: Page): Promise<void> {
  if (page.isClosed()) return;

  const viewport = page.viewportSize();
  if (!viewport) return;

  try {
    const x = Math.floor(viewport.width * (0.25 + Math.random() * 0.5));
    const y = Math.floor(viewport.height * (0.25 + Math.random() * 0.5));
    await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 8) });

    if (Math.random() < 0.35) {
      await page.mouse.wheel(0, Math.random() < 0.5 ? 60 : -60).catch(() => {});
    }

    await page
      .evaluate(() => {
        try {
          const target = document.querySelector(
            '[data-testid="sidebar"], .sidebar, nav, aside, main',
          );
          if (target) {
            target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
            target.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
          }
        } catch {
          // Best-effort keep-alive only.
        }
      })
      .catch(() => {});
  } catch (err: any) {
    if (page.isClosed()) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Target page, context or browser has been closed") ||
      msg.includes("Browser has been closed") ||
      msg.includes("Target closed") ||
      msg.includes("Target crashed") ||
      msg.includes("Page crashed") ||
      msg.includes("Connection closed")
    ) {
      return;
    }
    throw err;
  }
}
