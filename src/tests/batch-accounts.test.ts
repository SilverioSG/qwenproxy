import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "qwenproxy-test-key";
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
delete process.env.QWEN_ACCOUNTS;

import {
  parseBatchAccounts,
  addAccountsBatch,
  getAccountCredentials,
  loadAccounts,
  invalidateAccountsCache,
  removeAccount,
  isPlaceholderAccountEmail,
  removeAccountFromEnv,
} from "../core/accounts.ts";
import { closeDatabase, getDatabase } from "../core/database.ts";

interface AccountRow {
  id: string;
  email: string;
  password: string;
  cooldown_until?: number;
  cooldown_reason?: string | null;
}

function snapshotAccounts(): AccountRow[] {
  return getDatabase()
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC",
    )
    .all() as AccountRow[];
}

function restoreAccounts(rows: AccountRow[]): void {
  closeDatabase();
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.email,
      row.password,
      row.cooldown_until ?? 0,
      row.cooldown_reason ?? null,
    );
  }
  invalidateAccountsCache();
}

let restoreRows: AccountRow[] | null = null;

afterEach(() => {
  if (restoreRows) {
    restoreAccounts(restoreRows);
    restoreRows = null;
  }

  if (originalQwenAccounts === undefined) {
    delete process.env.QWEN_ACCOUNTS;
  } else {
    process.env.QWEN_ACCOUNTS = originalQwenAccounts;
  }
});

test("parseBatchAccounts: parses lines with email:password and various separators", () => {
  const raw = `
# Lista de contas
user1@gmail.com:senha123
user2@passinbox.com---senha456
user3@empresa.com.br,minha,senha,com,virgula
user4@domain.org\tsenha_com_tab
user5@domain.io | senha_com_pipe
`;

  const { entries, invalid } = parseBatchAccounts(raw);
  assert.equal(entries.length, 5);
  assert.equal(invalid.length, 0);

  assert.deepEqual(entries[0], { email: "user1@gmail.com", password: "senha123" });
  assert.deepEqual(entries[1], { email: "user2@passinbox.com", password: "senha456" });
  assert.deepEqual(entries[2], { email: "user3@empresa.com.br", password: "minha,senha,com,virgula" });
  assert.deepEqual(entries[3], { email: "user4@domain.org", password: "senha_com_tab" });
  assert.deepEqual(entries[4], { email: "user5@domain.io", password: "senha_com_pipe" });
});

test("parseBatchAccounts: parses QWEN_ACCOUNTS format with quotes, commas and semicolons", () => {
  const raw1 = `QWEN_ACCOUNTS="u1@test.com:pass1,u2@test.com:pass2"`;
  const res1 = parseBatchAccounts(raw1);
  assert.equal(res1.entries.length, 2);
  assert.equal(res1.entries[0].email, "u1@test.com");
  assert.equal(res1.entries[1].email, "u2@test.com");

  const raw2 = `u3@test.com:p3;u4@test.com:p4;u5@test.com:p5`;
  const res2 = parseBatchAccounts(raw2);
  assert.equal(res2.entries.length, 3);
  assert.equal(res2.entries[0].email, "u3@test.com");
  assert.equal(res2.entries[2].email, "u5@test.com");
});

test("parseBatchAccounts: preserves passwords containing special characters (colons, @, etc.)", () => {
  const raw = `admin@mycompany.com:P@ss:w0rd!#$123:super`;
  const { entries } = parseBatchAccounts(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].email, "admin@mycompany.com");
  assert.equal(entries[0].password, "P@ss:w0rd!#$123:super");
});

test("parseBatchAccounts: ignores empty lines and flags invalid lines", () => {
  const raw = `
user1@test.com:pass1

invalid-no-email:pass2
sem-dois-pontos-nem-senha
user2@test.com:pass3
`;
  const { entries, invalid } = parseBatchAccounts(raw);
  assert.equal(entries.length, 2);
  assert.equal(invalid.length, 2);
  assert.ok(invalid.includes("invalid-no-email:pass2"));
  assert.ok(invalid.includes("sem-dois-pontos-nem-senha"));
});
test("parseBatchAccounts: strips quotes and trailing commas cleanly from pasted entries", () => {
  const raw = `
  "user_quoted1@test.com:pass_quoted1",
  'user_quoted2@test.com:pass_quoted2';
  \`user_quoted3@test.com:pass_quoted3\`
  `;
  const { entries, invalid } = parseBatchAccounts(raw);
  assert.equal(entries.length, 3);
  assert.equal(invalid.length, 0);
  assert.equal(entries[0].email, "user_quoted1@test.com");
  assert.equal(entries[0].password, "pass_quoted1");
  assert.equal(entries[1].email, "user_quoted2@test.com");
  assert.equal(entries[1].password, "pass_quoted2");
  assert.equal(entries[2].email, "user_quoted3@test.com");
  assert.equal(entries[2].password, "pass_quoted3");
});

test("loadAccounts: parses multiline QWEN_ACCOUNTS without requiring commas or semicolons", () => {
  restoreRows = snapshotAccounts();
  process.env.QWEN_ACCOUNTS = `
  multiline1@test.com:pass1
  multiline2@test.com:pass2
  "multiline3@test.com:pass3"
  `;
  invalidateAccountsCache();
  const accounts = loadAccounts();
  const emails = accounts.map((a) => a.email);
  assert.ok(emails.includes("multiline1@test.com"));
  assert.ok(emails.includes("multiline2@test.com"));
  assert.ok(emails.includes("multiline3@test.com"));
});

test("addAccountsBatch: inserts multiple accounts in a single transaction, skips duplicates, and encrypts passwords", () => {
  restoreRows = snapshotAccounts();

  const batchInput = [
    { email: "batch1@test.com", password: "secret-pass-1" },
    { email: "batch2@test.com", password: "secret-pass-2" },
    { email: "batch3@test.com", password: "secret-pass-3" },
  ];

  const result = addAccountsBatch(batchInput);
  assert.equal(result.added.length, 3);
  assert.equal(result.skipped.length, 0);

  // Check decrypted credentials
  const creds1 = getAccountCredentials(result.added[0].id);
  assert.ok(creds1);
  assert.equal(creds1.email, "batch1@test.com");
  assert.equal(creds1.password, "secret-pass-1");

  // Check loadAccounts has them masked
  const loaded = loadAccounts();
  assert.ok(loaded.some((a) => a.email === "batch1@test.com" && a.password === "***"));

  // Attempt to add same batch again -> all skipped without throwing error
  const duplicateResult = addAccountsBatch(batchInput);
  assert.equal(duplicateResult.added.length, 0);
  assert.equal(duplicateResult.skipped.length, 3);
  assert.ok(duplicateResult.skipped.includes("batch1@test.com"));
});

test("isPlaceholderAccountEmail: identifies placeholder example accounts and passwords", () => {
  assert.equal(isPlaceholderAccountEmail("email1@example.com"), true);
  assert.equal(isPlaceholderAccountEmail("email2@example.com"), true);
  assert.equal(isPlaceholderAccountEmail("user@example.com"), true);
  assert.equal(isPlaceholderAccountEmail("test@example.com"), true);
  assert.equal(isPlaceholderAccountEmail("myuser@domain.com", "password1"), true);
  assert.equal(isPlaceholderAccountEmail("myuser@domain.com", "realpassword123"), false);
  assert.equal(isPlaceholderAccountEmail("realuser@gmail.com"), false);
});

test("removeAccount: removes account from both SQLite and QWEN_ACCOUNTS to prevent resurrection", () => {
  restoreRows = snapshotAccounts();
  process.env.QWEN_ACCOUNTS = "keep@test.com:pass1;delete-me@test.com:pass2";

  // Force sync from env
  invalidateAccountsCache();
  const loaded = loadAccounts();
  const toDelete = loaded.find((a) => a.email === "delete-me@test.com");
  assert.ok(toDelete, "delete-me account must be loaded from env");

  // Remove the account
  const removed = removeAccount(toDelete.id);
  assert.equal(removed, true, "removeAccount must return true");

  // Verify it is removed from process.env.QWEN_ACCOUNTS
  assert.ok(
    !process.env.QWEN_ACCOUNTS.includes("delete-me@test.com"),
    "Account must be removed from process.env.QWEN_ACCOUNTS",
  );
  assert.ok(
    process.env.QWEN_ACCOUNTS.includes("keep@test.com"),
    "Kept account must remain in process.env.QWEN_ACCOUNTS",
  );

  // Invalidate cache and reload: account must NOT resurrect
  invalidateAccountsCache();
  const reloaded = loadAccounts();
  assert.ok(
    !reloaded.some((a) => a.email === "delete-me@test.com"),
    "Deleted account must not resurrect after cache invalidation",
  );
  assert.ok(
    reloaded.some((a) => a.email === "keep@test.com"),
    "Kept account must still exist in reloaded accounts",
  );
});
