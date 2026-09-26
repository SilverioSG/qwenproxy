import crypto from "crypto";
import {
  addAccount,
  removeAccount,
  listAccounts,
  type QwenAccount,
} from "./core/accounts.ts";

import { maskEmail } from "./core/logger.ts";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function clear() {
  process.stdout.write("\x1Bc");
}

async function showMenu() {
  while (true) {
    const accounts = listAccounts();
    clear();
    console.log("=== QwenProxy Account Manager ===\n");
    console.log("Auth mode: Playwright (validated on server start)\n");

    if (accounts.length > 0) {
      console.log(`Configured accounts (${accounts.length}):\n`);
      for (let i = 0; i < accounts.length; i++) {
        console.log(
          `  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`,
        );
      }
    } else {
      console.log("No accounts configured yet.\n");
    }

    console.log("\nOptions:");
    console.log("  [A] Add account");
    if (accounts.length > 0) {
      console.log("  [R] Remove an account");
    }
    console.log("  [Q] Quit\n");

    const choice = (await askQuestion("Select an option: ")).toUpperCase();

    if (choice === "Q") {
      rl.close();
      process.exit(0);
    }

    if (choice === "A") {
      await addAccountFlow();
      continue;
    }

    if (choice === "R" && accounts.length > 0) {
      await removeAccountFlow();
      continue;
    }
  }
}

async function addAccountFlow() {
  clear();
  console.log("=== Add New Account ===\n");
  const email = await askQuestion("Email: ");
  if (!email || !email.trim()) {
    console.log("Email is required.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  const password = await askQuestion("Password: ");
  if (!password || !password.trim()) {
    console.log("Password is required.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  const trimmedEmail = email.trim();
  const trimmedPassword = password.trim();

  const existingAccounts = listAccounts();
  if (
    existingAccounts.some(
      (a) => a.email.toLowerCase() === trimmedEmail.toLowerCase(),
    )
  ) {
    console.log(
      `\n❌ Error: An account with email "${trimmedEmail}" already exists.`,
    );
    await askQuestion("Press Enter to continue...");
    return;
  }

  const tempId = crypto.randomUUID();
  console.log(
    `\n⏳ Validating credentials for ${maskEmail(trimmedEmail)} with Qwen via Playwright...`,
  );

  let account: QwenAccount | null = null;
  try {
    const { validateAccountLogin } = await import("./services/playwright.ts");
    const { wipeAccountSessionFiles } = await import("./core/accounts.ts");
    const { clearAccountCooldown } = await import("./core/account-manager.ts");
    const { config } = await import("./core/config.ts");

    const ok = await validateAccountLogin(
      { id: tempId, email: trimmedEmail, password: trimmedPassword },
      config.playwright.headless,
      config.playwright.browser,
    );

    if (ok) {
      account = addAccount(trimmedEmail, trimmedPassword, tempId);
      console.log(
        `\n✅ Account verified and saved: ${maskEmail(account.email)} (${account.id})`,
      );
    } else {
      wipeAccountSessionFiles(tempId);
      clearAccountCooldown(tempId);
      console.log(
        `\n❌ Authentication failed: Invalid credentials or unhandled login challenge.`,
      );
      console.log("The account was NOT saved.");
    }
  } catch (err: any) {
    const { wipeAccountSessionFiles } = await import("./core/accounts.ts");
    const { clearAccountCooldown } = await import("./core/account-manager.ts");
    wipeAccountSessionFiles(tempId);
    clearAccountCooldown(tempId);
    console.log(`\n❌ Validation error: ${err?.message || String(err)}`);
    console.log("The account was NOT saved.");
  }

  await askQuestion("\nPress Enter to continue...");
}

async function removeAccountFlow() {
  const accounts = listAccounts();
  if (accounts.length === 0) return;

  clear();
  console.log("=== Remove Account ===\n");

  for (let i = 0; i < accounts.length; i++) {
    console.log(
      `  [${i + 1}] ${maskEmail(accounts[i].email)} (ID: ${accounts[i].id})`,
    );
  }

  const input = await askQuestion(
    "\nSelect account number to remove (or 0 to cancel): ",
  );
  const idx = parseInt(input) - 1;

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== "0" ? "Invalid selection." : "Cancelled.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  const account = accounts[idx];
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `);
  if (confirm.toLowerCase() === "y") {
    if (removeAccount(account.id)) {
      try {
        const { removePlaywrightProfile } = await import("./services/playwright.ts");
        const { getAccountProfilePath } = await import("./core/paths.ts");
        removePlaywrightProfile(getAccountProfilePath(account.id));
      } catch {}
      console.log(`Account ${maskEmail(account.email)} removed.`);
    } else {
      console.log("Failed to remove account.");
    }
  } else {
    console.log("Cancelled.");
  }

  await askQuestion("Press Enter to continue...");
}

showMenu().catch((err) => {
  console.error(err);
  process.exit(1);
});
