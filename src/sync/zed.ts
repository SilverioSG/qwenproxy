import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function parseJsonWithComments(raw: string): Record<string, any> {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const nextCh = raw[i + 1] || "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && nextCh === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === "/" && nextCh === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && nextCh === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    result += ch;
  }

  const cleaned = result.replace(/,\s*([\}\]])/g, "$1");
  return JSON.parse(cleaned);
}

function buildZedAvailableModels(primaryModel: string = "qwen3.8-max", models?: string[]): any[] {
  const modelList = Array.from(
    new Set([primaryModel, ...(models && models.length > 0 ? models : [primaryModel, "qwen3.7-plus"])].filter(Boolean)),
  );
  const zedModels: any[] = [];

  for (const m of modelList) {
    zedModels.push({
      name: m,
      max_tokens: 1000000,
      max_output_tokens: 131072,
      max_completion_tokens: 131072,
      capabilities: {
        tools: true,
        images: true,
        parallel_tool_calls: true,
        prompt_cache_key: true,
        chat_completions: true,
        interleaved_reasoning: true,
      },
    });
    if (m === primaryModel) {
      zedModels.push(
        {
          name: `${m}-thinking`,
          max_tokens: 1000000,
          max_output_tokens: 131072,
          max_completion_tokens: 131072,
          capabilities: {
            tools: true,
            images: true,
            parallel_tool_calls: true,
            prompt_cache_key: true,
            chat_completions: true,
            interleaved_reasoning: true,
          },
        },
        {
          name: `${m}-fast`,
          max_tokens: 1000000,
          max_output_tokens: 131072,
          max_completion_tokens: 131072,
          capabilities: {
            tools: true,
            images: true,
            parallel_tool_calls: true,
            prompt_cache_key: true,
            chat_completions: true,
            interleaved_reasoning: true,
          },
        },
      );
    }
  }
  return zedModels;
}


export function syncZed(options: SyncOptions): ClientSyncResult {
  const { filePath, baseUrl, model = "qwen3.8-max", models, setActive = true } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let existingSettings: Record<string, any> = {};

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        existingSettings = parseJsonWithComments(content);
      } catch {
        existingSettings = {};
      }
    }

    const languageModels = existingSettings.language_models || {};
    const openaiCompatible = languageModels.openai_compatible || {};

    openaiCompatible.QwenProxy = {
      api_url: baseUrl,
      available_models: buildZedAvailableModels(model, models),
    };

    const updatedSettings: Record<string, any> = {
      ...existingSettings,
      language_models: {
        ...languageModels,
        openai_compatible: openaiCompatible,
      },
    };

    if (setActive) {
      const existingAgent = existingSettings.agent || {};
      updatedSettings.agent = {
        ...existingAgent,
        default_model: {
          provider: "QwenProxy",
          model,
          enable_thinking: true,
        },
      };
    }

    fs.writeFileSync(filePath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf-8");

    return {
      client: "zed",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Zed Editor with QwenProxy (${baseUrl}) and model ${model}`,
    };
  } catch (err: any) {
    return {
      client: "zed",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreZed(filePath: string, backupPath?: string): ClientSyncResult {
  const restoredFromBackup = restoreFromBackup(filePath, backupPath);

  let manuallyCleaned = false;
  if (fs.existsSync(filePath)) {
    try {
      let content = fs.readFileSync(filePath, "utf-8");
      if (content.includes("127.0.0.1:7936") || content.includes("qwen3.8-max")) {
        const data = parseJsonWithComments(content);
        if (data.language_models?.openai?.api_url?.includes("7936")) {
          delete data.language_models.openai;
          if (Object.keys(data.language_models).length === 0) {
            delete data.language_models;
          }
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
          manuallyCleaned = true;
        }
      }
    } catch {}
  }

  const success = restoredFromBackup || manuallyCleaned;
  return {
    client: "zed",
    filePath,
    backupPath,
    success,
    action: success ? "restored" : "failed",
    message: success
      ? restoredFromBackup
        ? "Restored Zed settings from backup"
        : "Removed QwenProxy configuration from Zed settings"
      : "Backup file not found",
  };
}
