/**
 * Personalization in-flight dedup (port of upstream 71770f7, dedup block).
 *
 * Contract:
 * - N concurrent syncs for the same account+instruction identity share ONE
 *   underlying execution (one browser navigation, not N);
 * - all callers receive the same result; the entry is removed afterwards;
 * - a shared failure reaches every waiter and leaves no zombie entry, so a
 *   later call starts a fresh sync;
 * - different accounts never share; different instruction identities on the
 *   same account never share (key = account + instruction hash, upstream key).
 *
 * Mock-mode execution (no browser): the dedup wrapper is backend-agnostic,
 * and upstream tests the same seam with TEST_PERSONALIZATION_DELAY_MS.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetInFlightPersonalizationSyncsForTests,
  getInFlightPersonalizationCount,
  syncQwenRequestPersonalization,
} from "../services/qwen.ts";

function enableMockSync(delayMs = 50): void {
  process.env.TEST_MOCK_QWEN_AUTH = "true";
  process.env.TEST_PERSONALIZATION_DELAY_MS = String(delayMs);
  delete process.env.TEST_PERSONALIZATION_SYNC_FAIL;
  _resetInFlightPersonalizationSyncsForTests();
}

function disableMockSync(): void {
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.TEST_PERSONALIZATION_DELAY_MS;
  delete process.env.TEST_PERSONALIZATION_SYNC_FAIL;
  _resetInFlightPersonalizationSyncsForTests();
}

test("same-account concurrent syncs share one in-flight execution", async () => {
  enableMockSync();
  try {
    const accountId = "test-dedup-acc";
    const instruction = "Test Instructions for Dedup " + Date.now();

    assert.equal(getInFlightPersonalizationCount(), 0);

    const calls = Array.from({ length: 5 }, () =>
      syncQwenRequestPersonalization(instruction, accountId, { forceSync: true }),
    );
    // While in flight, all 5 calls share the EXACT same single promise.
    assert.equal(getInFlightPersonalizationCount(), 1);

    const results = await Promise.all(calls);
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.equal(r, true);
    }

    assert.equal(getInFlightPersonalizationCount(), 0);
  } finally {
    disableMockSync();
  }
});

test("shared failure reaches all waiters, cleans up, next call retries fresh", async () => {
  enableMockSync();
  try {
    process.env.TEST_PERSONALIZATION_SYNC_FAIL = "true";
    const accountId = "test-dedup-fail";
    const instruction = "Fail Instructions " + Date.now();

    const a = syncQwenRequestPersonalization(instruction, accountId, { forceSync: true });
    const b = syncQwenRequestPersonalization(instruction, accountId, { forceSync: true });
    assert.equal(getInFlightPersonalizationCount(), 1);

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, false);
    assert.equal(rb, false);
    assert.equal(getInFlightPersonalizationCount(), 0);

    // No zombie entry: a later call executes a brand-new sync (now passing).
    delete process.env.TEST_PERSONALIZATION_SYNC_FAIL;
    const rc = await syncQwenRequestPersonalization(instruction, accountId, {
      forceSync: true,
    });
    assert.equal(rc, true);
    assert.equal(getInFlightPersonalizationCount(), 0);
  } finally {
    disableMockSync();
  }
});

test("different accounts never share an in-flight sync", async () => {
  enableMockSync();
  try {
    const instruction = "Shared Instructions " + Date.now();
    const a = syncQwenRequestPersonalization(instruction, "test-dedup-a", {
      forceSync: true,
    });
    const b = syncQwenRequestPersonalization(instruction, "test-dedup-b", {
      forceSync: true,
    });
    // Two distinct identities in flight at once: no coalescing, no blocking.
    assert.equal(getInFlightPersonalizationCount(), 2);

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, true);
    assert.equal(rb, true);
    assert.equal(getInFlightPersonalizationCount(), 0);
  } finally {
    disableMockSync();
  }
});

test("different instruction identities on one account never share", async () => {
  enableMockSync();
  try {
    const accountId = "test-dedup-ident";
    const a = syncQwenRequestPersonalization("Instructions Alpha " + Date.now(), accountId, {
      forceSync: true,
    });
    const b = syncQwenRequestPersonalization("Instructions Beta " + Date.now(), accountId, {
      forceSync: true,
    });
    assert.equal(getInFlightPersonalizationCount(), 2);

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, true);
    assert.equal(rb, true);
    assert.equal(getInFlightPersonalizationCount(), 0);
  } finally {
    disableMockSync();
  }
});
