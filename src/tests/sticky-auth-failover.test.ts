/**
 * Sticky-thread 401 failover (live bug: vidaamber 12:43:43).
 *
 * Contract under test:
 * - sticky account A selected first for its conversation;
 * - A answers unauthorized (HTTP 401 or app-level Unauthorized), classified by
 *   the REAL retry policy as account_initialization_failed and parked with
 *   AuthInitFailed (exactly what the inner loop does);
 * - the sticky rotation decision MUST consult that policy classification, so
 *   the SAME request continues on B instead of breaking into a 502;
 * - A stays excluded for the rest of the request (triedSet);
 * - a healthy sticky account never rotates; a terminal_local error never
 *   rotates.
 *
 * Level: real account picker (getNextAvailableAccount), real classifier
 * (classifyRetryAction), real sticky predicate (shouldRotateStickyAccount),
 * real cooldown store. The network/browser attempt itself is not executed
 * (no Chromium in unit tests); the failure is the exact live error object.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	clearAccountCooldown,
	getAccountCooldownInfo,
	getNextAvailableAccount,
	markAccountRateLimited,
} from "../core/account-manager.ts";
import { markAccountFailed } from "../core/account-priority.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import { ValidationError } from "../core/errors.ts";
import {
	resolveInitialAccount,
	shouldRotateStickyAccount,
} from "../routes/chat/account.ts";
import {
	classifyRetryAction,
	isAccountInitializationError,
	isTerminalLocalError,
} from "../routes/chat/retry-policy.ts";
import { QwenUpstreamError } from "../services/qwen-errors.ts";
import {
	clearAllSessionsForAccount,
	getLogicalThreadState,
	updateLogicalThreadState,
} from "../services/qwen-thread-state.ts";

const ACC_A = { id: "sticky-a", email: "a@test.com", password: "p" };
const ACC_B = { id: "sticky-b", email: "b@test.com", password: "p" };

function withTempAccounts(fn: () => void | Promise<void>) {
	return async () => {
		const originalEnv = process.env.QWEN_ACCOUNTS;
		delete process.env.QWEN_ACCOUNTS;
		const originalMock = process.env.TEST_MOCK_QWEN_AUTH;
		delete process.env.TEST_MOCK_QWEN_AUTH;

		const db = getDatabase();
		const existing = db
			.prepare("SELECT id, email, password FROM accounts")
			.all() as Array<{ id: string; email: string; password: string }>;
		db.prepare("DELETE FROM accounts").run();
		invalidateAccountsCache();

		const insert = db.prepare(
			"INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
		);
		for (const acc of [ACC_A, ACC_B]) {
			insert.run(acc.id, acc.email, acc.password);
			clearAccountCooldown(acc.id);
		}
		invalidateAccountsCache();

		try {
			await fn();
		} finally {
			for (const acc of [ACC_A, ACC_B]) {
				clearAccountCooldown(acc.id);
				try {
					clearAllSessionsForAccount(acc.id);
				} catch {}
			}
			db.prepare("DELETE FROM accounts").run();
			const restore = db.prepare(
				"INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
			);
			for (const row of existing) {
				restore.run(row.id, row.email, row.password);
			}
			invalidateAccountsCache();
			if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
			if (originalMock !== undefined) {
				process.env.TEST_MOCK_QWEN_AUTH = originalMock;
			} else {
				process.env.TEST_MOCK_QWEN_AUTH = "true";
			}
		}
	};
}

function bindSticky(sessionId: string, accountId: string): void {
	updateLogicalThreadState(sessionId, {
		accountId,
		chatSessionId: "chat-sticky-1",
		parentId: "parent-1",
		instructionsSent: true,
	});
	const state = getLogicalThreadState(sessionId);
	assert.equal(state?.accountId, accountId);
}

/** Mirror of the inner loop: classify, park, return the policy. */
function failAccountLikeInnerLoop(accountId: string, err: unknown) {
	const policy = classifyRetryAction(err, { requestAborted: false });
	if (policy.accountCooldownMs || policy.accountCooldownReason) {
		markAccountFailed(accountId);
		markAccountRateLimited(
			accountId,
			policy.accountCooldownMs,
			policy.accountCooldownReason,
		);
	}
	return policy;
}

test(
	"sticky HTTP 401 unauthorized: A fails, same request continues on B, A excluded",
	withTempAccounts(() => {
		const sessionId = "sticky-401-test-1";
		bindSticky(sessionId, ACC_A.id);

		// FIRST_ACCOUNT=A (sticky resolution feeds the loop this account).
		const first = resolveInitialAccount(ACC_A.id);
		assert.equal(first.account.id, ACC_A.id);

		// A answers the exact live failure: HTTP-flavoured unauthorized.
		const err = new QwenUpstreamError(
			"Qwen upstream error: unauthorized: 401 No autorizado.",
			"Unauthorized",
			401,
		);
	 const policy = failAccountLikeInnerLoop(ACC_A.id, err);
		assert.equal(policy.reason, "account_initialization_failed");

		// A_COOLDOWN_SET=YES with the AuthInitFailed reason.
		const cd = getAccountCooldownInfo(ACC_A.id);
		assert.ok(cd, "A must be parked");
		assert.equal(cd?.reason, "AuthInitFailed");

		// SAME_REQUEST_CONTINUED=YES: the sticky decision now recognises the
		// policy classification (before the fix this was false -> break -> 502).
		assert.equal(shouldRotateStickyAccount(err), true);

		// SECOND_ACCOUNT=B, eligible (no cooldown).
		const second = getNextAvailableAccount(new Set([ACC_A.id]));
		assert.ok(second, "a second account must be selectable");
		assert.equal(second?.id, ACC_B.id);
		assert.equal(getAccountCooldownInfo(ACC_B.id), null);

		// A_RESELECTED=NO: tried accounts are never picked again this request.
		assert.equal(getNextAvailableAccount(new Set([ACC_A.id, ACC_B.id])), null);
	}),
);

test(
	"sticky app-level Unauthorized (HTTP 200 envelope): same A -> B failover",
	withTempAccounts(() => {
		const sessionId = "sticky-401-test-2";
		bindSticky(sessionId, ACC_A.id);

		const first = resolveInitialAccount(ACC_A.id);
		assert.equal(first.account.id, ACC_A.id);

		// Logical/app-level shape: plain Error carrying the JSON envelope.
		const err = new Error(
			'create failed: {"success":false,"data":{"code":"unauthorized","details":"401 Unauthorized"}}',
		);
		const policy = failAccountLikeInnerLoop(ACC_A.id, err);
		assert.equal(policy.reason, "account_initialization_failed");

		// Pin the exact gap: the raw error matches NONE of the legacy sticky
		// predicates (this is what broke the loop into a 502 before the fix).
		assert.equal(isAccountInitializationError(err), false);
		assert.equal(isTerminalLocalError(err), false);
		assert.equal(getAccountCooldownInfo(ACC_A.id)?.reason, "AuthInitFailed");

		assert.equal(shouldRotateStickyAccount(err), true);

		const second = getNextAvailableAccount(new Set([ACC_A.id]));
		assert.equal(second?.id, ACC_B.id);
	}),
);

test(
	"sticky healthy account never rotates",
	withTempAccounts(() => {
		const sessionId = "sticky-401-test-3";
		bindSticky(sessionId, ACC_A.id);

		// No failure at all: stay.
		assert.equal(shouldRotateStickyAccount(null), false);
		assert.equal(shouldRotateStickyAccount(undefined), false);

		// A transient non-auth error is not an abandon-account signal.
		const transient = new Error("fetch failed: socket hangup");
		assert.notEqual(
			classifyRetryAction(transient, { requestAborted: false }).reason,
			"account_initialization_failed",
		);
		assert.equal(shouldRotateStickyAccount(transient), false);

		// Selection itself keeps returning the sticky account.
		assert.equal(resolveInitialAccount(ACC_A.id).account.id, ACC_A.id);
		assert.equal(getAccountCooldownInfo(ACC_A.id), null);
	}),
);

test(
	"terminal_local error never rotates the sticky account",
	withTempAccounts(() => {
		const sessionId = "sticky-401-test-4";
		bindSticky(sessionId, ACC_A.id);

		// Client/proxy validation errors must stay terminal (loop breaks).
		const err = new ValidationError("messages is required");
		assert.equal(isTerminalLocalError(err), true);
		assert.equal(
			classifyRetryAction(err, { requestAborted: false }).reason,
			"terminal_local",
		);
		assert.equal(shouldRotateStickyAccount(err), false);

		// And no cooldown was parked by such an error path.
		assert.equal(getAccountCooldownInfo(ACC_A.id), null);
	}),
);
