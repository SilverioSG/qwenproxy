import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { StatusView } from "../tui/views/status-view.ts";
import { updateEnvVariable, persistServerPort, persistCustomApiKey } from "../core/local-auth.ts";
import { stripAnsi } from "../tui/theme.ts";

StatusView.prototype.refresh = async () => {};

function createTempEnvFile(): { dir: string; envPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-env-test-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PORT=7936\nAPI_KEY=sk-qwenproxy-local\n", "utf-8");
  return {
    dir,
    envPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("local-auth: updateEnvVariable updates existing key or appends new key in .env", () => {
  const { envPath, cleanup } = createTempEnvFile();
  try {
    updateEnvVariable("PORT", "8080", envPath);
    const content1 = fs.readFileSync(envPath, "utf-8");
    assert.ok(content1.includes("PORT=8080"), "PORT must be updated to 8080");
    assert.ok(!content1.includes("PORT=7936"), "Old PORT must be replaced");
    assert.ok(content1.includes("API_KEY=sk-qwenproxy-local"), "API_KEY must be preserved");

    updateEnvVariable("NEW_SETTING", "custom_val", envPath);
    const content2 = fs.readFileSync(envPath, "utf-8");
    assert.ok(content2.includes("NEW_SETTING=custom_val"), "NEW_SETTING must be appended");
  } finally {
    cleanup();
  }
});

test("TUI StatusView: exposes 'p' (Alterar Porta) and 'k' (Alterar API Key) shortcuts", () => {
  const view = new StatusView();
  const shortcuts = view.getShortcuts();
  assert.ok(shortcuts.some((s) => s.key === "p"), "Must expose 'p' shortcut");
  assert.ok(shortcuts.some((s) => s.key === "k"), "Must expose 'k' shortcut");
});

test("TUI StatusView: pressing 'p' opens port modal, typing numbers updates port, and Esc cancels", async () => {
  const view = new StatusView();
  view.render(80, 24);

  // Press 'p' to open port modal
  await view.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
  assert.equal((view as any).isPortModalOpen, true, "Port modal must be open");
  assert.equal(view.isCapturingText(), true, "Must capture text when port modal is open");

  // Type new port 8000
  (view as any).portInput = "";
  await view.handleKey({ name: "8", char: "8", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "0", char: "0", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "0", char: "0", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "0", char: "0", ctrl: false, shift: false, meta: false });
  assert.equal((view as any).portInput, "8000");

  const modalRender = view.render(80, 24).join("\n");
  const clean = stripAnsi(modalRender);
  assert.ok(clean.includes("Alterar Porta do Servidor"), "Must render port modal title");
  assert.ok(clean.includes("8000"), "Must render entered port");

  // Press Esc to cancel
  await view.handleKey({ name: "escape", ctrl: false, shift: false, meta: false });
  assert.equal((view as any).isPortModalOpen, false, "Port modal must be closed on Esc");
});

test("TUI StatusView: port modal validation rejects invalid ports and accepts valid ports on Enter", async () => {
  const origPort = process.env.PORT;
  try {
    const view = new StatusView();
    view.render(80, 24);

    // Open modal
    await view.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isPortModalOpen, true);

    // Set invalid port 99999
    (view as any).portInput = "99999";
    (view as any).portCursor = 5;
    await view.handleKey({ name: "enter", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isPortModalOpen, true, "Modal must stay open on invalid port");
    assert.ok((view as any).portError.length > 0, "Must set port error message");

    // Backspace to edit
    await view.handleKey({ name: "backspace", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).portInput, "9999");
    assert.equal((view as any).portError, "", "Error must be cleared on edit");

    // Press Enter with valid port 9999
    await view.handleKey({ name: "enter", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isPortModalOpen, false, "Modal must close on valid port");
  } finally {
    if (origPort !== undefined) {
      process.env.PORT = origPort;
    } else {
      delete process.env.PORT;
    }
  }
});

test("TUI StatusView: pressing 'k' opens API key modal, typing updates key, and Esc cancels", async () => {
  const view = new StatusView();
  view.render(80, 24);

  // Press 'k' to open API key modal
  await view.handleKey({ name: "k", ctrl: false, shift: false, meta: false });
  assert.equal((view as any).isApiKeyModalOpen, true, "API key modal must be open");
  assert.equal(view.isCapturingText(), true, "Must capture text when API key modal is open");

  // Type new key
  (view as any).apiKeyInput = "sk-custom-secret";
  const modalRender = view.render(80, 24).join("\n");
  const clean = stripAnsi(modalRender);
  assert.ok(clean.includes("Configurar API Key"), "Must render API key modal title");
  assert.ok(clean.includes("sk-custom-secret"), "Must render entered API key");

  // Press Esc to cancel
  await view.handleKey({ name: "escape", ctrl: false, shift: false, meta: false });
  assert.equal((view as any).isApiKeyModalOpen, false, "API key modal must be closed on Esc");
});

test("TUI StatusView: API key modal saves on Enter and updates process.env.API_KEY", async () => {
  const origApiKey = process.env.API_KEY;
  try {
    const view = new StatusView();
    view.render(80, 24);

    // Open modal
    await view.handleKey({ name: "k", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isApiKeyModalOpen, true);

    (view as any).apiKeyInput = "sk-test-saved-key";
    (view as any).apiKeyCursor = "sk-test-saved-key".length;
    await view.handleKey({ name: "enter", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isApiKeyModalOpen, false, "Modal must close on Enter");
    assert.equal(process.env.API_KEY, "sk-test-saved-key", "API_KEY must be updated");
  } finally {
    if (origApiKey !== undefined) {
      process.env.API_KEY = origApiKey;
    } else {
      delete process.env.API_KEY;
    }
  }
});

test("TUI StatusView: mouse hover and click on Save/Cancel buttons in Port and API Key modals", async () => {
  const origPort = process.env.PORT;
  const origApiKey = process.env.API_KEY;
  try {
    const view = new StatusView();
    view.render(80, 24);

    // 1. Port Modal Mouse Tests
    await view.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isPortModalOpen, true);
    view.render(80, 24);

    const portBtnRow = (view as any).lastPortModalBtnRow;
    const portLeftPad = (view as any).lastPortModalLeftPad;
    assert.ok(portBtnRow > 0, "portBtnRow must be calculated");

    // Hover over Save button
    await view.handleKey({
      name: "hover",
      mouse: { type: "hover", row: portBtnRow, col: portLeftPad + 10 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).portModalHoveredBtn, "save", "Save button must be hovered");

    // Hover over Cancel button
    await view.handleKey({
      name: "hover",
      mouse: { type: "hover", row: portBtnRow, col: portLeftPad + 35 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).portModalHoveredBtn, "cancel", "Cancel button must be hovered");

    // Click Cancel button closes modal
    await view.handleKey({
      name: "click",
      mouse: { type: "click", row: portBtnRow, col: portLeftPad + 35 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).isPortModalOpen, false, "Port modal must close on Cancel click");

    // Reopen, set port 8888 and click Save button
    await view.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
    (view as any).portInput = "8888";
    view.render(80, 24);
    await view.handleKey({
      name: "click",
      mouse: { type: "click", row: portBtnRow, col: portLeftPad + 10 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).isPortModalOpen, false, "Port modal must close on Save click");
    assert.equal(process.env.PORT, "8888", "PORT must be updated to 8888");

    // 2. API Key Modal Mouse Tests
    await view.handleKey({ name: "k", ctrl: false, shift: false, meta: false });
    assert.equal((view as any).isApiKeyModalOpen, true);
    view.render(80, 24);

    const apiKeyBtnRow = (view as any).lastApiKeyModalBtnRow;
    const apiKeyLeftPad = (view as any).lastApiKeyModalLeftPad;
    assert.ok(apiKeyBtnRow > 0, "apiKeyBtnRow must be calculated");

    // Hover over Save button
    await view.handleKey({
      name: "hover",
      mouse: { type: "hover", row: apiKeyBtnRow, col: apiKeyLeftPad + 10 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).apiKeyModalHoveredBtn, "save", "API Key Save button must be hovered");

    // Hover over Cancel button
    await view.handleKey({
      name: "hover",
      mouse: { type: "hover", row: apiKeyBtnRow, col: apiKeyLeftPad + 35 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).apiKeyModalHoveredBtn, "cancel", "API Key Cancel button must be hovered");

    // Click Cancel button
    await view.handleKey({
      name: "click",
      mouse: { type: "click", row: apiKeyBtnRow, col: apiKeyLeftPad + 35 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).isApiKeyModalOpen, false, "API Key modal must close on Cancel click");

    // Reopen, set key and click Save button
    await view.handleKey({ name: "k", ctrl: false, shift: false, meta: false });
    (view as any).apiKeyInput = "sk-mouse-saved-key";
    view.render(80, 24);
    await view.handleKey({
      name: "click",
      mouse: { type: "click", row: apiKeyBtnRow, col: apiKeyLeftPad + 10 },
      ctrl: false,
      shift: false,
      meta: false,
    });
    assert.equal((view as any).isApiKeyModalOpen, false, "API Key modal must close on Save click");
    assert.equal(process.env.API_KEY, "sk-mouse-saved-key", "API_KEY must be updated");
  } finally {
    if (origPort !== undefined) process.env.PORT = origPort;
    else delete process.env.PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
  }
});
