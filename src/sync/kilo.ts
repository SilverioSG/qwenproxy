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

function buildKiloProviderObject(
  baseUrl: string,
  apiKey: string,
  primaryModel: string = "qwen3.8-max",
  models?: string[],
): Record<string, any> {
  const modelsObj: Record<string, any> = {};
  const modelList = Array.from(
    new Set([primaryModel, ...(models && models.length > 0 ? models : [primaryModel, "qwen3.7-plus"])].filter(Boolean)),
  );

  for (const m of modelList) {
    modelsObj[m] = {
      name: formatModelDisplayName(m),
      limit: { context: 1048576, output: 65536 },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: true,
      variants: {
        low: { effort: "low" },
        medium: { effort: "medium" },
        high: { effort: "high" },
      },
    };
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    name: "QwenProxy",
    options: {
      baseURL: baseUrl,
      apiKey: apiKey,
    },
    models: modelsObj,
  };
}

export function syncKilo(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max", models, setActive = true } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const providerObj = buildKiloProviderObject(baseUrl, apiKey, model, models);
    const providerJson = JSON.stringify(providerObj, null, 6)
      .split("\n")
      .map((line, idx) => (idx === 0 ? line : `    ${line}`))
      .join("\n");

    const qwenEntry = `    "qwenproxy": ${providerJson}`;

    if (!content.trim()) {
      const initial: Record<string, any> = {
        $schema: "https://kilo.ai/config.json",
        provider: {
          qwenproxy: providerObj,
        },
      };
      if (setActive) {
        initial.model = `qwenproxy/${model}`;
      }
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
    } else {
      const existingSpan = findKeyObjectSpan(content, "qwenproxy");
      if (existingSpan) {
        const comma = existingSpan.hasTrailingComma ? "," : "";
        content =
          content.slice(0, existingSpan.start) +
          `"qwenproxy": ${providerJson}${comma}` +
          content.slice(existingSpan.end);
      } else {
        const providerMatch = content.match(/"provider"\s*:\s*\{/);
        if (providerMatch && providerMatch.index !== undefined) {
          const insertIdx = providerMatch.index + providerMatch[0].length;
          content =
            content.slice(0, insertIdx) +
            "\n" +
            qwenEntry +
            "," +
            content.slice(insertIdx);
        } else {
          const lastBraceIdx = content.lastIndexOf("}");
          if (lastBraceIdx !== -1) {
            const comma = content.slice(0, lastBraceIdx).trimEnd().endsWith("{") ? "" : ",";
            content =
              content.slice(0, lastBraceIdx).trimEnd() +
              `${comma}\n  "provider": {\n${qwenEntry}\n  }\n}\n`;
          }
        }
      }

      if (setActive) {
        const modelRegex = /"model"\s*:\s*"[^"]*"/;
        if (modelRegex.test(content)) {
          content = content.replace(modelRegex, `"model": "qwenproxy/${model}"`);
        }
      }

      fs.writeFileSync(filePath, content, "utf-8");
    }

    return {
      client: "kilo",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Kilo Code with provider qwenproxy (${baseUrl})`,
    };
  } catch (err: any) {
    return {
      client: "kilo",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreKilo(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "kilo",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored Kilo Code config from backup" : "Backup file not found",
  };
}
