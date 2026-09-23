import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function updateYamlKeyValue(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${value}`;
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  return content.trimEnd() + (content.length > 0 ? "\n" : "") + line + "\n";
}

export function syncAider(options: SyncOptions): ClientSyncResult {
  const {
    filePath,
    apiKey,
    baseUrl,
    model = "qwen3.8-max",
    reasoningEffort = "high",
    modelSettingsPath,
  } = options;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let confContent = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      confContent = fs.readFileSync(filePath, "utf-8");
    }

    const fullModelName = model.startsWith("openai/") ? model : `openai/${model}`;
    const weakModelName = "openai/qwen3.7-plus";

    confContent = updateYamlKeyValue(confContent, "openai-api-base", baseUrl);
    confContent = updateYamlKeyValue(confContent, "openai-api-key", apiKey);
    confContent = updateYamlKeyValue(confContent, "model", fullModelName);
    confContent = updateYamlKeyValue(confContent, "editor-model", fullModelName);
    confContent = updateYamlKeyValue(confContent, "weak-model", weakModelName);

    fs.writeFileSync(filePath, confContent.trimEnd() + "\n", "utf-8");

    // Configure model settings YAML if path provided
    let extraBackupPath: string | undefined;
    const resolvedSettingsPath =
      modelSettingsPath || path.join(path.dirname(filePath), ".aider.model.settings.yml");

    if (resolvedSettingsPath) {
      fs.mkdirSync(path.dirname(resolvedSettingsPath), { recursive: true });
      let settingsContent = "";

      if (fs.existsSync(resolvedSettingsPath)) {
        extraBackupPath = createTimestampBackup(resolvedSettingsPath);
        settingsContent = fs.readFileSync(resolvedSettingsPath, "utf-8");
      }

      const modelBlock = `- name: ${fullModelName}
  extra_params:
    extra_body:
      reasoning_effort: ${reasoningEffort}
  streaming: true
`;

      const existingModelRegex = new RegExp(`- name: ${fullModelName}[\\s\\S]*?(?=(?:^-[ \\t]+name:|\\Z))`, "m");
      if (existingModelRegex.test(settingsContent)) {
        settingsContent = settingsContent.replace(existingModelRegex, modelBlock.trimEnd() + "\n");
      } else {
        settingsContent = settingsContent.trimEnd() + (settingsContent.length > 0 ? "\n\n" : "") + modelBlock;
      }

      fs.writeFileSync(resolvedSettingsPath, settingsContent.trimEnd() + "\n", "utf-8");
    }

    return {
      client: "aider",
      filePath,
      backupPath,
      extraBackupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Aider with model ${fullModelName} and reasoning effort ${reasoningEffort}`,
    };
  } catch (err: any) {
    return {
      client: "aider",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreAider(
  filePath: string,
  backupPath?: string,
  modelSettingsPath?: string,
  extraBackupPath?: string,
): ClientSyncResult {
  const mainRestored = restoreFromBackup(filePath, backupPath);
  if (modelSettingsPath && extraBackupPath) {
    restoreFromBackup(modelSettingsPath, extraBackupPath);
  }

  return {
    client: "aider",
    filePath,
    backupPath,
    extraBackupPath,
    success: mainRestored,
    action: mainRestored ? "restored" : "failed",
    message: mainRestored ? "Restored Aider settings from backup" : "Backup file not found",
  };
}
