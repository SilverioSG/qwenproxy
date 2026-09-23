import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup, formatModelDisplayName } from "./utils.ts";

function findKeyObjectSpan(content: string, key: string): { start: number; end: number; hasTrailingComma: boolean } | null {
  const regex = new RegExp(`"${key}"\\s*:\\s*\\{`);
  const match = content.match(regex);
  if (!match || match.index === undefined) return null;

  const startIndex = match.index;
  const braceIndex = content.indexOf("{", startIndex + match[0].length - 1);
  if (braceIndex === -1) return null;

  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = braceIndex; i < content.length; i++) {
    const ch = content[i];
    const nextCh = content[i + 1] || "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
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
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        let endIndex = i + 1;
        let hasTrailingComma = false;
        while (endIndex < content.length && /[\s,]/.test(content[endIndex])) {
          if (content[endIndex] === ",") {
            hasTrailingComma = true;
            endIndex++;
            break;
          }
          if (content[endIndex] === "\n") {
            break;
          }
          endIndex++;
        }
        return { start: startIndex, end: endIndex, hasTrailingComma };
      }
    }
  }

  return null;
}

function buildOpenClawProviderObject(
  baseUrl: string,
  apiKey: string,
  model: string = "qwen3.8-max",
  models?: string[],
): Record<string, any> {
  const modelList = Array.from(
    new Set([model, ...(models && models.length > 0 ? models : [model, "qwen3.7-plus"])].filter(Boolean)),
  );
  const modelEntries = modelList.map((m) => ({
    id: m,
    name: formatModelDisplayName(m),
    reasoning: true,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
    contextWindow: 1000000,
    maxTokens: 65536,
  }));

  return {
    baseUrl,
    apiKey,
    api: "openai-completions",
    models: modelEntries,
  };
}

export function syncOpenClaw(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max", models, reasoningEffort = "high" } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const providerObj = buildOpenClawProviderObject(baseUrl, apiKey, model, models);
    const providerJson = JSON.stringify(providerObj, null, 6)
      .split("\n")
      .map((line, idx) => (idx === 0 ? line : `        ${line}`))
      .join("\n");

    const qwenEntry = `        "qwenproxy": ${providerJson}`;

    if (!content.trim()) {
      const initial = {
        models: {
          mode: "merge",
          providers: {
            qwenproxy: providerObj,
          },
        },
        agents: {
          defaults: {
            model: {
              primary: `qwenproxy/${model}`,
            },
            thinking: {
              effort: reasoningEffort,
            },
          },
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
    } else {
      // Check if "qwenproxy" already exists under providers
      const existingSpan = findKeyObjectSpan(content, "qwenproxy");
      if (existingSpan) {
        const comma = existingSpan.hasTrailingComma ? "," : "";
        content =
          content.slice(0, existingSpan.start) +
          `"qwenproxy": ${providerJson}${comma}` +
          content.slice(existingSpan.end);
      } else {
        const providersMatch = content.match(/"providers"\s*:\s*\{/);
        if (providersMatch && providersMatch.index !== undefined) {
          const insertIdx = providersMatch.index + providersMatch[0].length;
          content =
            content.slice(0, insertIdx) +
            "\n" +
            qwenEntry +
            "," +
            content.slice(insertIdx);
        } else {
          // If "providers" does not exist, check if "models" exists
          const modelsMatch = content.match(/"models"\s*:\s*\{/);
          if (modelsMatch && modelsMatch.index !== undefined) {
            const insertIdx = modelsMatch.index + modelsMatch[0].length;
            const providersBlock = `\n    "providers": {\n${qwenEntry}\n    },`;
            content = content.slice(0, insertIdx) + providersBlock + content.slice(insertIdx);
          } else {
            // Append models before the last closing brace
            const lastBraceIdx = content.lastIndexOf("}");
            if (lastBraceIdx !== -1) {
              const comma = content.slice(0, lastBraceIdx).trimEnd().endsWith("{") ? "" : ",";
              const modelsBlock = `${comma}\n  "models": {\n    "mode": "merge",\n    "providers": {\n${qwenEntry}\n    }\n  }\n`;
              content = content.slice(0, lastBraceIdx).trimEnd() + modelsBlock + "}\n";
            }
          }
        }
      }

      fs.writeFileSync(filePath, content, "utf-8");
    }

    return {
      client: "openclaw",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured OpenClaw with provider qwenproxy (${baseUrl}) and reasoning effort ${reasoningEffort}`,
    };
  } catch (err: any) {
    return {
      client: "openclaw",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreOpenClaw(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "openclaw",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored OpenClaw config from backup" : "Backup file not found",
  };
}
