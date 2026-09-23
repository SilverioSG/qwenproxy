/**
 * QwenProxy TUI - User Preferences & Settings Persistence
 * Automatically saves and restores chosen model, reasoning effort, last active tab, and log filters.
 */

import fs from "node:fs";
import path from "node:path";
import { getTuiSettingsPath } from "../core/paths.ts";

export interface TuiSettings {
  lastTab?: number;
  chat?: {
    model?: string;
    effort?: "high" | "medium" | "low";
    mode?: "thread" | "thread-temp" | "stateless" | "stateless-temp";
  };
  logs?: {
    filter?: "all" | "warn" | "error";
  };
}

const defaultSettings: TuiSettings = {
  lastTab: 1,
  chat: {
    model: "qwen3.8-max",
    effort: "high",
    mode: "thread",
  },
  logs: {
    filter: "all",
  },
};

let cachedSettings: TuiSettings | null = null;

export function resetTuiSettingsCacheForTests(): void {
  cachedSettings = null;
}

export function loadTuiSettings(): TuiSettings {
  if (cachedSettings) {
    return {
      ...cachedSettings,
      chat: { ...cachedSettings.chat },
      logs: { ...cachedSettings.logs },
    };
  }

  const filePath = getTuiSettingsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const loaded: TuiSettings = {
        ...defaultSettings,
        ...parsed,
        chat: { ...defaultSettings.chat, ...(parsed.chat || {}) },
        logs: { ...defaultSettings.logs, ...(parsed.logs || {}) },
      };
      cachedSettings = loaded;
      return {
        ...loaded,
        chat: { ...loaded.chat },
        logs: { ...loaded.logs },
      };
    }
  } catch {}

  const finalSettings: TuiSettings = {
    ...defaultSettings,
    chat: { ...defaultSettings.chat },
    logs: { ...defaultSettings.logs },
  };
  cachedSettings = finalSettings;
  return {
    ...finalSettings,
    chat: { ...finalSettings.chat },
    logs: { ...finalSettings.logs },
  };
}

export function saveTuiSettings(updates: Partial<TuiSettings>): void {
  try {
    const current = loadTuiSettings();
    const merged: TuiSettings = {
      ...current,
      ...updates,
      chat: { ...current.chat, ...(updates.chat || {}) },
      logs: { ...current.logs, ...(updates.logs || {}) },
    };

    cachedSettings = merged;

    const filePath = getTuiSettingsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
  } catch {}
}
