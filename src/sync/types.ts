export type SyncClientName =
  | "claude-code"
  | "codex"
  | "opencode"
  | "omp"
  | "hermes"
  | "openclaw"
  | "kilo"
  | "cline"
  | "zed"
  | "aider";

export interface ClientSyncResult {
  client: SyncClientName;
  filePath: string;
  backupPath?: string;
  extraBackupPath?: string;
  success: boolean;
  action: "updated" | "created" | "skipped" | "restored" | "failed";
  message?: string;
  error?: string;
}

export interface SyncOptions {
  filePath: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  models?: string[];
  setActive?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "none";
  modelSettingsPath?: string;
}

export interface SyncAllOptions {
  apiKey?: string;
  port?: number;
  host?: string;
  setActive?: boolean;
  stateFilePath?: string;
  targets?: SyncClientName[];
  model?: string;
  models?: string[];
  syncAllModels?: boolean;
  customPaths?: {
    claudeCode?: string;
    codex?: string;
    openCode?: string;
    omp?: string;
    hermes?: string;
    openClaw?: string;
    kilo?: string;
    cline?: string;
    zed?: string;
    aider?: string;
  };
}
export interface SyncRecord {
  filePath: string;
  backupPath: string;
  existedBefore: boolean;
  syncedAt: number;
}

export interface SyncStateFile {
  version: number;
  updatedAt: string;
  apiKey: string;
  port: number;
  host: string;
  clients: {
    claudeCode?: SyncRecord;
    codex?: SyncRecord;
    openCode?: SyncRecord;
    omp?: SyncRecord;
    hermes?: SyncRecord;
    openClaw?: SyncRecord;
    kilo?: SyncRecord;
    cline?: SyncRecord;
    zed?: SyncRecord;
    aider?: SyncRecord;
  };
}
