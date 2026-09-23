import type { KeyEvent } from "./screen.ts";

export interface TuiView {
  readonly id: string;
  readonly title: string;
  readonly tabNumber: number;
  render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[];
  handleKey(key: KeyEvent): Promise<boolean | void> | boolean | void;
  onActivate?(): void;
  onDeactivate?(): void;
  getShortcuts?(): Array<{ key: string; label: string }>;
}

export interface ProxyStatusSnapshot {
  online: boolean;
  port: number;
  host: string;
  chatMode?: "thread" | "thread-temp" | "stateless" | "stateless-temp";
  overallStatus?: string;
  uptimeSeconds?: number;
  rssMb?: number;
  systemMemoryPct?: number;
  activeStreams?: number;
  waitingStreams?: number;
  metrics?: {
    requestsTotal: number;
    requestsErrors: number;
    successRate: number;
    latencyAvgMs: number;
    deltasCount: number;
    fullReplaysCount: number;
    deltaRatio: number;
    toolCallsCount: number;
    toolCallsRecovered: number;
    captchasDetected: number;
    captchasSolved: number;
    chatsCleaned: number;
    cacheHitRatio?: number;
    cacheBytesSaved?: number;
  };
  accounts: Array<{
    id: string;
    emailOrName: string;
    priority: number;
    cooldownUntil: number | null;
    onCooldown: boolean;
    remainingCooldownMs: number;
    cooldownReason?: string | null;
    headersReady: boolean;
    isInitialized?: boolean;
    activeStreams?: number;
    streamLimit?: number;
  }>;
}
