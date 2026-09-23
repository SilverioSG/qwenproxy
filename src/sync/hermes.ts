import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function buildHermesModelBlock(
  baseUrl: string,
  apiKey: string,
  model: string = "qwen3.8-max",
  reasoningEffort: string = "high",
): string {
  return `model:
  default: "${model}"
  provider: "custom"
  base_url: "${baseUrl}"
  api_key: "${apiKey}"
  reasoning_effort: "${reasoningEffort}"
  reasoning_overrides:
    "qwen3.8-max": "${reasoningEffort}"
    "qwen3.7-plus": "medium"
`;
}

function buildHermesProviderBlock(baseUrl: string, apiKey: string): string {
  return `  qwenproxy:
    base_url: "${baseUrl}"
    api_mode: chat_completions
    api_key: "${apiKey}"
`;
}

export function syncHermes(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max", reasoningEffort = "high" } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const modelBlock = buildHermesModelBlock(baseUrl, apiKey, model, reasoningEffort);
    const providerBlock = buildHermesProviderBlock(baseUrl, apiKey);

    // Replace or insert model: block
    const modelRegex = /^model:[\s\S]*?(?=(?:^[a-zA-Z0-9_-]+:|\Z))/m;
    if (modelRegex.test(content)) {
      content = content.replace(modelRegex, modelBlock);
    } else {
      content = modelBlock + "\n" + content.trimStart();
    }

    // Replace or insert qwenproxy under providers:
    if (!content.includes("providers:")) {
      content = content.trimEnd() + "\n\nproviders:\n" + providerBlock;
    } else {
      const existingQwenRegex = /^ {2}qwenproxy:[\s\S]*?(?=(?:^ {2}[a-zA-Z0-9_-]+:|^[a-zA-Z0-9_-]+:|\Z))/m;
      if (existingQwenRegex.test(content)) {
        content = content.replace(existingQwenRegex, providerBlock);
      } else {
        const providersMatch = content.match(/^providers:\s*$/m);
        if (providersMatch && providersMatch.index !== undefined) {
          const insertIdx = providersMatch.index + providersMatch[0].length;
          content = content.slice(0, insertIdx) + "\n" + providerBlock + content.slice(insertIdx);
        } else {
          content = content.trimEnd() + "\n\nproviders:\n" + providerBlock;
        }
      }
    }

    fs.writeFileSync(filePath, content.trimEnd() + "\n", "utf-8");

    return {
      client: "hermes",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Hermes Agent with model ${model} and reasoning effort ${reasoningEffort}`,
    };
  } catch (err: any) {
    return {
      client: "hermes",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreHermes(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "hermes",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored Hermes config from backup" : "Backup file not found",
  };
}
