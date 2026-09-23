import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup, formatModelDisplayName } from "./utils.ts";

export function syncClaudeCode(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max" } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let existingSettings: Record<string, any> = {};

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        existingSettings = JSON.parse(content);
      } catch {
        existingSettings = {};
      }
    }

    const env = {
      ...(existingSettings.env || {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: formatModelDisplayName(model),
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: `QwenProxy ${model}`,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
      CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    };

    const updatedSettings = {
      ...existingSettings,
      env,
      model,
      enableArtifact: false,
    };

    fs.writeFileSync(filePath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf-8");

    return {
      client: "claude-code",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Claude Code with model ${model} and baseUrl ${baseUrl}`,
    };
  } catch (err: any) {
    return {
      client: "claude-code",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreClaudeCode(filePath: string, backupPath?: string): ClientSyncResult {
  const restoredFromBackup = restoreFromBackup(filePath, backupPath);

  let manuallyCleaned = false;
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data.env && (data.env.ANTHROPIC_BASE_URL?.includes("7936") || data.env.ANTHROPIC_AUTH_TOKEN === "sk-qwenproxy-local" || data.env.ANTHROPIC_MODEL?.includes("qwen"))) {
        delete data.env.ANTHROPIC_BASE_URL;
        delete data.env.ANTHROPIC_AUTH_TOKEN;
        delete data.env.ANTHROPIC_MODEL;
        delete data.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
        delete data.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME;
        delete data.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION;
        delete data.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete data.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete data.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        delete data.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
        delete data.env.CLAUDE_CODE_DISABLE_ARTIFACT;
        delete data.enableArtifact;
        if (data.model && data.model.toLowerCase().includes("qwen")) {
          delete data.model;
        }
        if (Object.keys(data.env).length === 0) {
          delete data.env;
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
        manuallyCleaned = true;
      }
    } catch {}
  }

  const success = restoredFromBackup || manuallyCleaned;
  return {
    client: "claude-code",
    filePath,
    backupPath,
    success,
    action: success ? "restored" : "failed",
    message: success
      ? restoredFromBackup
        ? "Restored Claude Code settings from backup"
        : "Removed QwenProxy configuration from Claude Code settings"
      : "Backup file not found",
  };
}
