import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

import { syncHermes, restoreHermes } from "../sync/hermes.ts";
import { syncOpenClaw, restoreOpenClaw } from "../sync/openclaw.ts";
import { syncKilo, restoreKilo } from "../sync/kilo.ts";
import { syncCline, restoreCline } from "../sync/cline.ts";
import { syncZed, restoreZed } from "../sync/zed.ts";
import { syncAider, restoreAider } from "../sync/aider.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-top10-test-"));
}

test("sync Hermes Agent: preserves existing YAML settings, configures custom provider and reasoning effort, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "config.yaml");

  const originalYaml = `# Hermes Agent Config
database:
  journal_mode: "wal"

human_delay:
  mode: "off"

providers:
  existing-provider:
    base_url: "https://api.existing.com/v1"
    api_key: "secret-key"
`;
  fs.writeFileSync(filePath, originalYaml, "utf-8");

  const res = syncHermes({
    filePath,
    apiKey: "sk-hermes-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  // Existing settings preserved
  assert.ok(updated.includes('journal_mode: "wal"'));
  assert.ok(updated.includes("existing-provider:"));
  assert.ok(updated.includes('https://api.existing.com/v1'));

  // QwenProxy settings injected
  assert.ok(updated.includes('provider: "custom"'));
  assert.ok(updated.includes('base_url: "http://127.0.0.1:7936/v1"'));
  assert.ok(updated.includes('api_key: "sk-hermes-test"'));
  assert.ok(updated.includes('reasoning_effort: "high"'));
  assert.ok(updated.includes("qwenproxy:"));

  // Restore
  const restored = restoreHermes(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalYaml);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync OpenClaw: preserves existing JSON5 settings, registers provider with effort levels, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "openclaw.json");

  const originalJson = `{
  // OpenClaw config
  "worktreeRoot": "/tmp/worktrees",
  "models": {
    "providers": {
      "other-llm": {
        "baseUrl": "https://api.other.com/v1",
        "apiKey": "other-key"
      }
    }
  }
}
`;
  fs.writeFileSync(filePath, originalJson, "utf-8");

  const res = syncOpenClaw({
    filePath,
    apiKey: "sk-openclaw-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  // Preserves existing
  assert.ok(updated.includes("/tmp/worktrees"));
  assert.ok(updated.includes("other-llm"));

  // Injects qwenproxy with effort levels
  assert.ok(updated.includes("qwenproxy"));
  assert.ok(updated.includes("http://127.0.0.1:7936/v1"));
  assert.ok(updated.includes("sk-openclaw-test"));
  assert.ok(updated.includes("supportedReasoningEfforts"));
  assert.ok(updated.includes('"high"'));

  // Restore
  const restored = restoreOpenClaw(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalJson);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Kilo Code: preserves comments and existing providers, registers qwenproxy with reasoning variants, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "kilo.json");

  const originalJsonc = `{
  "$schema": "https://kilo.ai/config.json",
  "provider": {
    // Other AI Provider
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MyProvider",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "secret"
      }
    }
  }
}
`;
  fs.writeFileSync(filePath, originalJsonc, "utf-8");

  const res = syncKilo({
    filePath,
    apiKey: "sk-kilo-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  assert.ok(updated.includes("// Other AI Provider"));
  assert.ok(updated.includes("my-provider"));
  assert.ok(updated.includes('"qwenproxy": {'));
  assert.ok(updated.includes('"baseURL": "http://127.0.0.1:7936/v1"'));
  assert.ok(updated.includes('"qwen3.8-max": {'));
  assert.ok(updated.includes('"high": {'));
  assert.ok(updated.includes('"effort": "high"'));

  // Restore
  const restored = restoreKilo(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalJsonc);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Cline: preserves SQLite ItemTable, injects provider with reasoning effort in state.vscdb, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "state.vscdb");

  // Create SQLite test DB
  const db = new Database(filePath);
  db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)`);
  db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
    "existing.extension.key",
    JSON.stringify({ preserved: true }),
  );
  db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
    "ZooCodeOrganization.zoo-code",
    JSON.stringify({
      listApiConfigMeta: [{ name: "existing-profile", id: "prof-1", apiProvider: "anthropic" }],
      currentApiConfigName: "existing-profile",
    }),
  );
  db.close();

  const res = syncCline({
    filePath,
    apiKey: "sk-cline-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  // Verify database state
  const dbVerify = new Database(filePath, { readonly: true });
  const rowPreserved = dbVerify.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get("existing.extension.key") as any;
  assert.deepEqual(JSON.parse(rowPreserved.value), { preserved: true });

  const rowCline = dbVerify.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get("saoudrizwan.claude-dev") as any;
  assert.ok(rowCline);
  const parsedCline = JSON.parse(rowCline.value);
  assert.equal(parsedCline.apiProvider, "openai");
  assert.equal(parsedCline.openAiBaseUrl, "http://127.0.0.1:7936/v1");
  assert.equal(parsedCline.openAiModelId, "qwen3.8-max");
  assert.equal(parsedCline.enableReasoningEffort, true);
  assert.equal(parsedCline.reasoningEffort, "high");

  const rowZoo = dbVerify.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get("ZooCodeOrganization.zoo-code") as any;
  assert.ok(rowZoo);
  const parsedZoo = JSON.parse(rowZoo.value);
  assert.equal(parsedZoo.apiProvider, "openai");
  assert.equal(parsedZoo.openAiBaseUrl, "http://127.0.0.1:7936/v1");
  assert.equal(parsedZoo.enableReasoningEffort, true);
  assert.equal(parsedZoo.reasoningEffort, "high");
  // Preserved existing profile in listApiConfigMeta and added QwenProxy
  assert.ok(parsedZoo.listApiConfigMeta.some((p: any) => p.name === "existing-profile"));
  assert.ok(parsedZoo.listApiConfigMeta.some((p: any) => p.name === "QwenProxy"));

  dbVerify.close();

  // Restore
  const restored = restoreCline(filePath, res.backupPath);
  assert.equal(restored.success, true);

  const dbRestored = new Database(filePath, { readonly: true });
  const rowClineAfterRestore = dbRestored.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get("saoudrizwan.claude-dev");
  assert.equal(rowClineAfterRestore, undefined);
  dbRestored.close();

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Zed Editor: preserves existing OpenAI-compatible providers, adds QwenProxy with model variants, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "settings.json");

  const originalSettings = {
    theme: "Tokyo Night",
    language_models: {
      openai_compatible: {
        ExistingProvider: {
          api_url: "https://api.existing.com/v1",
          available_models: [{ name: "gpt-4o" }],
        },
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(originalSettings, null, 2), "utf-8");

  const res = syncZed({
    filePath,
    apiKey: "sk-zed-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.equal(updated.theme, "Tokyo Night");
  assert.ok(updated.language_models.openai_compatible.ExistingProvider);

  const qwenProxy = updated.language_models.openai_compatible.QwenProxy;
  assert.ok(qwenProxy);
  assert.equal(qwenProxy.api_url, "http://127.0.0.1:7936/v1");
  assert.ok(qwenProxy.available_models.some((m: any) => m.name === "qwen3.8-max"));
  assert.ok(qwenProxy.available_models.some((m: any) => m.name === "qwen3.8-max-thinking"));
  assert.ok(qwenProxy.available_models.some((m: any) => m.name === "qwen3.8-max-fast"));
  assert.equal(updated.agent.default_model.provider, "QwenProxy");
  assert.equal(updated.agent.default_model.enable_thinking, true);

  // Restore
  const restored = restoreZed(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), originalSettings);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Aider: preserves existing config, sets up .aider.conf.yml and model reasoning settings, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, ".aider.conf.yml");
  const modelSettingsPath = path.join(tmp, ".aider.model.settings.yml");

  const originalConf = `model: gpt-4o
auto-commits: true
`;
  fs.writeFileSync(filePath, originalConf, "utf-8");

  const res = syncAider({
    filePath,
    modelSettingsPath,
    apiKey: "sk-aider-test",
    baseUrl: "http://127.0.0.1:7936/v1",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updatedConf = fs.readFileSync(filePath, "utf-8");
  assert.ok(updatedConf.includes("auto-commits: true"));
  assert.ok(updatedConf.includes("openai-api-base: http://127.0.0.1:7936/v1"));
  assert.ok(updatedConf.includes("openai-api-key: sk-aider-test"));
  assert.ok(updatedConf.includes("model: openai/qwen3.8-max"));

  const updatedSettings = fs.readFileSync(modelSettingsPath, "utf-8");
  assert.ok(updatedSettings.includes("openai/qwen3.8-max"));
  assert.ok(updatedSettings.includes("reasoning_effort: high"));

  // Restore
  const restored = restoreAider(filePath, res.backupPath, modelSettingsPath, res.extraBackupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalConf);

  fs.rmSync(tmp, { recursive: true, force: true });
});
