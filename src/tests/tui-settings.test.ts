import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getTuiSettingsPath } from "../core/paths.ts";
import {
  loadTuiSettings,
  saveTuiSettings,
  resetTuiSettingsCacheForTests,
} from "../tui/settings.ts";
import { ChatView } from "../tui/views/chat-view.ts";
import { LogsView } from "../tui/views/logs-view.ts";

test("TUI Settings: loads defaults when settings file does not exist", () => {
  resetTuiSettingsCacheForTests();
  const settingsPath = getTuiSettingsPath();
  const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : null;

  try {
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    resetTuiSettingsCacheForTests();

    const settings = loadTuiSettings();
    assert.equal(settings.lastTab, 1);
    assert.equal(settings.chat?.model, "qwen3.8-max");
    assert.equal(settings.chat?.effort, "high");
    assert.equal(settings.logs?.filter, "all");
  } finally {
    if (backup !== null) {
      fs.writeFileSync(settingsPath, backup, "utf-8");
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    resetTuiSettingsCacheForTests();
  }
});

test("TUI Settings: saves and restores chat model, effort, and log filter", () => {
  resetTuiSettingsCacheForTests();
  const settingsPath = getTuiSettingsPath();
  const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : null;

  try {
    saveTuiSettings({
      lastTab: 5,
      chat: {
        model: "qwen3.7-plus",
        effort: "medium",
      },
      logs: {
        filter: "error",
      },
    });

    resetTuiSettingsCacheForTests();
    const loaded = loadTuiSettings();

    assert.equal(loaded.lastTab, 5);
    assert.equal(loaded.chat?.model, "qwen3.7-plus");
    assert.equal(loaded.chat?.effort, "medium");
    assert.equal(loaded.logs?.filter, "error");
  } finally {
    if (backup !== null) {
      fs.writeFileSync(settingsPath, backup, "utf-8");
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    resetTuiSettingsCacheForTests();
  }
});

test("TUI Settings: ChatView initializes with saved model and effort", () => {
  resetTuiSettingsCacheForTests();
  const settingsPath = getTuiSettingsPath();
  const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : null;

  try {
    saveTuiSettings({
      chat: {
        model: "qwen3.7-plus",
        effort: "low",
      },
    });

    const chatView = new ChatView();
    const activeModel = (chatView as any).availableModels[(chatView as any).selectedModelIndex];
    assert.equal(activeModel, "qwen3.7-plus", "ChatView must restore saved model qwen3.7-plus");
    assert.equal((chatView as any).selectedEffort, "low", "ChatView must restore saved effort low");
  } finally {
    if (backup !== null) {
      fs.writeFileSync(settingsPath, backup, "utf-8");
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    resetTuiSettingsCacheForTests();
  }
});

test("TUI Settings: LogsView initializes with saved log filter", () => {
  resetTuiSettingsCacheForTests();
  const settingsPath = getTuiSettingsPath();
  const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : null;

  try {
    saveTuiSettings({
      logs: {
        filter: "warn",
      },
    });

    const logsView = new LogsView();
    assert.equal((logsView as any).filter, "warn", "LogsView must restore saved filter warn");
  } finally {
    if (backup !== null) {
      fs.writeFileSync(settingsPath, backup, "utf-8");
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
    resetTuiSettingsCacheForTests();
  }
});
