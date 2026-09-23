import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup, formatModelDisplayName } from "./utils.ts";

function buildOmpProviderYaml(
  baseUrl: string,
  apiKey: string,
  primaryModel: string = "qwen3.8-max",
  models?: string[],
): string {
  const modelList = Array.from(
    new Set([primaryModel, ...(models && models.length > 0 ? models : [primaryModel, "qwen3.7-plus"])].filter(Boolean)),
  );
  const formattedModels = modelList
    .map(
      (m) => `      - id: ${m}
        name: ${formatModelDisplayName(m).replace(/\s+/g, "")}
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 131072
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]`,
    )
    .join("\n");

  return `  qwenproxy:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: "${apiKey}"
    compat:
      supportsStore: true
      supportsReasoningEffort: true
      maxTokensField: max_completion_tokens
    models:
${formattedModels}
`;
}

export function syncOmp(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max", models } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const providerBlock = buildOmpProviderYaml(baseUrl, apiKey, model, models);
    if (!content.trim()) {
      content = `providers:\n${providerBlock}`;
    } else {
      // Check if "qwenproxy:" already exists under "providers:"
      const existingQwenRegex = /^ {2}qwenproxy:[\s\S]*?(?=(?:^ {2}[a-zA-Z0-9_-]+:|\Z))/m;
      if (existingQwenRegex.test(content)) {
        content = content.replace(existingQwenRegex, providerBlock);
      } else {
        const providersMatch = content.match(/^providers:\s*$/m);
        if (providersMatch && providersMatch.index !== undefined) {
          const insertIdx = providersMatch.index + providersMatch[0].length;
          content =
            content.slice(0, insertIdx) +
            "\n" +
            providerBlock +
            content.slice(insertIdx);
        } else {
          content = content.trimEnd() + "\n\nproviders:\n" + providerBlock;
        }
      }
    }

    fs.writeFileSync(filePath, content.trimEnd() + "\n", "utf-8");

    return {
      client: "omp",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured OMP with provider qwenproxy (${baseUrl})`,
    };
  } catch (err: any) {
    return {
      client: "omp",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreOmp(filePath: string, backupPath?: string): ClientSyncResult {
  const restoredFromBackup = restoreFromBackup(filePath, backupPath);

  let manuallyCleaned = false;
  if (fs.existsSync(filePath)) {
    try {
      let content = fs.readFileSync(filePath, "utf-8");
      if (content.includes("qwenproxy:")) {
        const regex = /^\s*qwenproxy:\s*\r?\n(?:^[ \t].*\r?\n?)*/m;
        content = content.replace(regex, "");
        fs.writeFileSync(filePath, content, "utf-8");
        manuallyCleaned = true;
      }
    } catch {}
  }

  const success = restoredFromBackup || manuallyCleaned;
  return {
    client: "omp",
    filePath,
    backupPath,
    success,
    action: success ? "restored" : "failed",
    message: success
      ? restoredFromBackup
        ? "Restored OMP models config from backup"
        : "Removed QwenProxy configuration from OMP config"
      : "Backup file not found",
  };
}
