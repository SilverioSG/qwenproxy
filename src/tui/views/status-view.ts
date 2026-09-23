/**
 * QwenProxy TUI - Status and Live Dashboard View (Tab 1)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate, setClipboardText } from "../theme.ts";
import { fetchProxyStatus, resetAllCooldowns, formatUptime } from "../proxy-client.ts";
import { ServerManager } from "../server-manager.ts";
import { getRuntimeChatMode, cycleNextChatMode } from "../../core/config.ts";
import { saveTuiSettings } from "../settings.ts";

export function renderProgressBar(
  pct: number,
  width = 8,
  colorFn: (s: string) => string = theme.cyan,
): string {
  const safePct = Math.max(0, Math.min(100, isNaN(pct) ? 0 : pct));
  const rawFilled = Math.round((safePct / 100) * width);
  const filled = safePct > 0.05 ? Math.max(1, rawFilled) : 0;
  const empty = Math.max(0, width - filled);
  return colorFn("█".repeat(filled)) + theme.muted("░".repeat(empty));
}
export function getAccountReadinessScore(acc: {
  onCooldown: boolean;
  headersReady: boolean;
  activeStreams?: number;
  isInitialized?: boolean;
  cooldownReason?: string | null;
}): number {
  if (acc.onCooldown) {
    const reason = acc.cooldownReason || "";
    if (
      reason.startsWith("AuthFailed") ||
      reason.startsWith("AuthPermanentFailure") ||
      reason.includes("login methods exhausted")
    ) {
      return 0; // Auth Fail at the very bottom
    }
    return 10; // Other cooldowns (RateLimited, WafChallenge, etc.)
  }
  if (acc.activeStreams && acc.activeStreams > 0 && acc.headersReady) {
    return 100; // Actively generating code
  }
  if (acc.headersReady) {
    return 80; // Ready / Warm
  }
  if (acc.isInitialized) {
    return 60; // Warming up
  }
  return 40; // Healthy standby
}


export class StatusView implements TuiView {
  public readonly id = "status";
  public readonly title = "Status";
  public readonly tabNumber = 1;

  private statusData: ProxyStatusSnapshot | null = null;
  private actionMessage = "";
  private actionMessageTimeout: NodeJS.Timeout | null = null;
  private hoveredActionRow: number | null = null;
  private isBaseUrlHovered = false;
  private copiedRecently = false;
  private copiedTimeout: NodeJS.Timeout | null = null;
  private lastBaseUrl = "http://127.0.0.1:7936/v1";
  private lastBaseUrlRow = 6;
  private lastModoApiRow = 7;
  private lastLeftW = 38;
  private lastActionRecarregarRow = 20;
  private lastActionZerarRow = 21;
  private lastActionModoRow = 22;
  private lastActionCopiarRow = 23;

  constructor() {
    this.refresh();
  }
  public async refresh(): Promise<void> {
    try {
      if (process.stdout.isTTY && !process.env.NODE_TEST_CONTEXT) {
        const sManager = ServerManager.getInstance();
        if (sManager.getState() === "error") {
          void sManager.ensureStarted();
        }
      }
      this.statusData = await fetchProxyStatus();
    } catch {}
  }

  public onActivate(): void {
    this.refresh();
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "r", label: "Recarregar" },
      { key: "z", label: "Zerar Cooldowns" },
      { key: "m", label: "Alternar Modo" },
      { key: "c", label: "Copiar URL" },
    ];
  }

  private setMessage(msg: string): void {
    this.actionMessage = msg;
    clearTimeout(this.actionMessageTimeout!);
    this.actionMessageTimeout = setTimeout(() => {
      this.actionMessage = "";
    }, 4000);
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover over quick actions or Base URL
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 38;
      const isOverLeft = col >= 2 && col <= leftW - 1;
      const isOverBaseUrl = isOverLeft && row === this.lastBaseUrlRow;
      const isOverAction =
        isOverLeft &&
        (row === this.lastActionRecarregarRow ||
          row === this.lastActionZerarRow ||
          row === this.lastActionModoRow ||
          row === this.lastActionCopiarRow);

      let changed = false;
      if (isOverBaseUrl !== this.isBaseUrlHovered) {
        this.isBaseUrlHovered = isOverBaseUrl;
        changed = true;
      }
      if (isOverAction) {
        if (this.hoveredActionRow !== row) {
          this.hoveredActionRow = row;
          changed = true;
        }
      } else if (this.hoveredActionRow !== null) {
        this.hoveredActionRow = null;
        changed = true;
      }
      if (changed) return true;
    }

    // Mouse click interactions
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 38;
      if (col >= 2 && col <= leftW - 1) {
        if (row === this.lastBaseUrlRow || row === this.lastActionCopiarRow) {
          setClipboardText(this.lastBaseUrl);
          this.copiedRecently = true;
          if (this.copiedTimeout) clearTimeout(this.copiedTimeout);
          this.copiedTimeout = setTimeout(() => {
            this.copiedRecently = false;
            this.copiedTimeout = null;
          }, 2500);
          this.setMessage(theme.green(`✓ Base URL copiada: ${this.lastBaseUrl}`));
          return true;
        }
        if (row === this.lastActionRecarregarRow) {
          await this.refresh();
          this.setMessage(theme.green("✓ Status atualizado"));
          return true;
        }
        if (row === this.lastActionZerarRow) {
          const cleared = resetAllCooldowns();
          await this.refresh();
          this.setMessage(theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) liberada(s)`));
          return true;
        }
        if (row === this.lastActionModoRow || row === this.lastModoApiRow) {
          const nextMode = cycleNextChatMode();
          saveTuiSettings({ chat: { mode: nextMode } });
          await this.refresh();
          this.setMessage(theme.green(`✓ Modo global da API: ${nextMode}`));
          return true;
        }
      }
    }
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.setMessage(theme.green("✓ Status atualizado"));
      return true;
    }

    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setMessage(theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) liberada(s)`));
      return true;
    }

    if ((key.name === "m" || key.name === "M") && !key.ctrl) {
      const nextMode = cycleNextChatMode();
      saveTuiSettings({ chat: { mode: nextMode } });
      await this.refresh();
      this.setMessage(theme.green(`✓ Modo global da API: ${nextMode}`));
      return true;
    }

    if ((key.name === "c" || key.name === "C") && !key.ctrl && !key.meta) {
      setClipboardText(this.lastBaseUrl);
      this.copiedRecently = true;
      if (this.copiedTimeout) clearTimeout(this.copiedTimeout);
      this.copiedTimeout = setTimeout(() => {
        this.copiedRecently = false;
        this.copiedTimeout = null;
      }, 2500);
      this.setMessage(theme.green(`✓ Base URL copiada: ${this.lastBaseUrl}`));
      return true;
    }
  }
  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const data = snapshot || this.statusData;
    const isOnline = data?.online ?? false;
    const contentH = Math.max(10, height);

    // Two-column layout: give left box 48-52 cols so rich metrics never truncate,
    // and right box takes the remaining width (at least 38 cols).
    const leftW = width >= 96
      ? Math.min(52, Math.max(48, Math.floor(width * 0.48)))
      : Math.min(46, Math.max(38, Math.floor(width * 0.50)));
    this.lastLeftW = leftW;
    const rightW = Math.max(36, width - leftW - 1);
    const serverState = ServerManager.getInstance().getState();
    let onlineBadge: string;
    if (isOnline || serverState === "online") {
      onlineBadge = theme.green(`${glyphs.bullet} Online`);
    } else if (serverState === "warming") {
      onlineBadge = theme.yellow(`🟡 Iniciando...`);
    } else if (serverState === "error") {
      onlineBadge = theme.red(`✗ Erro`);
    } else {
      onlineBadge = theme.muted(`${glyphs.circle} Offline`);
    }

    const uptimeSecs = data?.uptimeSeconds || Math.floor(process.uptime());
    const uptimeStr = formatUptime(uptimeSecs);
    const baseUrl = `http://${data?.host || "127.0.0.1"}:${data?.port || 7936}/v1`;
    this.lastBaseUrl = baseUrl;
    this.lastBaseUrlRow = 6;
    this.lastModoApiRow = 7;
    const m = data?.metrics;
    const reqsTotal = m?.requestsTotal ?? 0;
    const reqsErrors = m?.requestsErrors ?? 0;
    const successPct = m?.successRate ?? (reqsTotal > 0 ? Number((((reqsTotal - reqsErrors) / reqsTotal) * 100).toFixed(1)) : 100);
    const latencyAvg = m?.latencyAvgMs ? `${m.latencyAvgMs}ms` : "–";
    const deltasCount = m?.deltasCount ?? 0;
    const fullCount = m?.fullReplaysCount ?? 0;
    const deltaRatio = m?.deltaRatio != null ? `${m.deltaRatio}%` : "–";
    const toolCalls = m?.toolCallsCount ?? 0;
    const toolRecovered = m?.toolCallsRecovered ?? 0;
    const captchasDetected = m?.captchasDetected ?? 0;
    const captchasSolved = m?.captchasSolved ?? 0;
    const chatsCleaned = m?.chatsCleaned ?? 0;
    const lbl = (s: string) => pad(s, 13);
    const innerLeftW = Math.max(30, leftW - 2);
    const deltaDetail = innerLeftW < 44
      ? `(${deltasCount}d / ${fullCount}f)`
      : `(${deltasCount} delta / ${fullCount} full)`;
    const ramPct = data?.systemMemoryPct || 0;
    const ramBarColor = ramPct >= 80 ? theme.red : ramPct >= 60 ? theme.yellow : theme.cyan;
    const ramBar = renderProgressBar(ramPct, 7, ramBarColor);
    const ramStr = `${data?.rssMb || 0} MB [${ramBar}] ${ramPct}%`;

    let connsStr = "0 ativas";
    if (data?.activeStreams && data.activeStreams > 0) {
      connsStr = theme.yellow(`⚡ ${data.activeStreams} ativa(s)`);
    } else {
      connsStr = theme.dim("0 ativas");
    }
    if (data?.waitingStreams && data.waitingStreams > 0) {
      connsStr += theme.peach(` (${data.waitingStreams} na fila)`);
    }
    let urlDisplay: string;
    if (this.copiedRecently) {
      urlDisplay = theme.bold(theme.green(baseUrl));
    } else if (this.isBaseUrlHovered) {
      urlDisplay = theme.bold(theme.underline(theme.cyan(baseUrl)));
    } else {
      urlDisplay = theme.cyan(baseUrl);
    }

    const leftContent: string[] = [
      `  ${theme.bold(lbl("Status:"))} ${onlineBadge}`,
      `  ${theme.bold(lbl("Base URL:"))} ${urlDisplay}`,
      `  ${theme.bold(lbl("Modo API:"))} ${
        getRuntimeChatMode() === "thread"
          ? theme.cyan("[thread]")
          : getRuntimeChatMode() === "thread-temp"
            ? theme.green("[thread-temp]")
            : getRuntimeChatMode() === "stateless-temp"
              ? theme.yellow("[stateless-temp]")
              : theme.lavender("[stateless]")
      } ${theme.dim("('M' alternar)")}`,
      `  ${theme.bold(lbl("Uptime:"))} ${theme.cyan(uptimeStr)}`,
      `  ${theme.bold(lbl("Conexões:"))} ${connsStr}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
      `  ${theme.bold("Tráfego & Performance:")}`,
      `    ${theme.dim(lbl("Requisições:"))} ${theme.cyan(String(reqsTotal))} ${theme.green(`(${successPct}% ok)`)} · ${reqsErrors > 0 ? theme.red(`${reqsErrors} err`) : theme.dim("0 err")}`,
      `    ${theme.dim(lbl("Latência:"))} ${theme.yellow(latencyAvg)} méd`,
      `    ${theme.dim(lbl("Deltas:"))} ${theme.green(deltaRatio)} ${theme.dim(deltaDetail)}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
      `  ${theme.bold("Agentes & Operações:")}`,
      `    ${theme.dim(lbl("Tool Calls:"))} ${theme.cyan(String(toolCalls))} ${toolRecovered > 0 ? theme.green(`(${toolRecovered} curadas)`) : ""}`,
      `    ${theme.dim(lbl("Captchas:"))} ${captchasSolved > 0 ? theme.green(`${captchasSolved}/${captchasDetected} resolvidos`) : theme.dim(`${captchasDetected} detectados`)}`,
      `    ${theme.dim(lbl("Chats Limpos:"))} ${theme.cyan(String(chatsCleaned))} ${theme.dim("excluídos (>24h)")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
      `  ${theme.bold("Ações:")}`,
    ];

    const recarregarIdx = leftContent.length;
    const zerarIdx = leftContent.length + 1;
    const modoIdx = leftContent.length + 2;
    const copiarIdx = leftContent.length + 3;

    this.lastActionRecarregarRow = 5 + recarregarIdx;
    this.lastActionZerarRow = 5 + zerarIdx;
    this.lastActionModoRow = 5 + modoIdx;
    this.lastActionCopiarRow = 5 + copiarIdx;

    leftContent.push(
      `   ${this.hoveredActionRow === this.lastActionRecarregarRow ? theme.bgHover(` ${theme.cyan("[ R ] Recarregar")} `) : ` ${theme.cyan("[ R ]")} Recarregar`}`,
      `   ${this.hoveredActionRow === this.lastActionZerarRow ? theme.bgHover(` ${theme.yellow("[ Z ] Zerar Cooldowns")} `) : ` ${theme.yellow("[ Z ]")} Zerar Cooldowns`}`,
      `   ${this.hoveredActionRow === this.lastActionModoRow ? theme.bgHover(` ${theme.lavender("[ M ] Alternar Modo")} `) : ` ${theme.lavender("[ M ]")} Alternar Modo`}`,
      `   ${this.hoveredActionRow === this.lastActionCopiarRow ? theme.bgHover(` ${theme.green("[ C ] Copiar URL")} `) : ` ${theme.green("[ C ]")} Copiar URL`}`,
    );

    const boxHeight = Math.max(contentH, leftContent.length + 2);

    const leftBox = drawBox({
      title: "Sistema & Performance",
      width: leftW,
      height: boxHeight,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
      footer: this.actionMessage || undefined,
      content: leftContent,
    });
    // Right Column: Accounts Pool Status
    const rawAccounts = data?.accounts || [];
    const accounts = [...rawAccounts].sort((a, b) => {
      const scoreA = getAccountReadinessScore(a);
      const scoreB = getAccountReadinessScore(b);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return 0;
    });
    const availableCount = accounts.filter((a) => !a.onCooldown).length;
    const readyCount = accounts.filter((a) => !a.onCooldown && a.headersReady).length;
    const standbyCount = accounts.filter((a) => !a.onCooldown && !a.headersReady).length;
    const cooldownCount = accounts.filter((a) => a.onCooldown).length;
    const poolPct = accounts.length > 0 ? Math.round((availableCount / accounts.length) * 100) : 0;
    const poolColor = poolPct >= 70 ? theme.green : poolPct >= 40 ? theme.yellow : theme.red;
    const poolBar = renderProgressBar(poolPct, 8, poolColor);
    const innerRightW = Math.max(30, rightW - 2);
    const emailWidth = Math.max(16, Math.min(20, innerRightW - 27));
    const rightContent: string[] = [
      `  ${theme.bold("Disponibilidade:")} [${poolBar}] ${poolColor(`${availableCount}/${accounts.length} (${poolPct}%)`)}`,
      `  ${theme.dim("─".repeat(Math.max(32, innerRightW - 2)))}`,
      `  ${theme.dim(`#   ${pad("Conta", emailWidth)} Carga  Status`)}`,
      `  ${theme.dim("─".repeat(Math.max(32, innerRightW - 2)))}`,
    ];

    if (accounts.length === 0) {
      rightContent.push(`  ${theme.muted("Nenhuma conta adicionada. (Vá em [5] Contas)")}`);
    } else {
      const maxVisibleAccounts = Math.max(6, boxHeight - 7);
      accounts.slice(0, maxVisibleAccounts).forEach((acc, idx) => {
        const num = pad(String(idx + 1) + ".", 4);
        const name = pad(truncate(acc.emailOrName, emailWidth - 1), emailWidth);
        const active = acc.activeStreams || 0;
        const limit = acc.streamLimit || 1;
        const loadBadge = active > 0 ? theme.yellow(`[${active}/${limit}]`) : theme.dim(`[0/${limit}]`);

        let status = theme.green(`${glyphs.bullet} Pronto`);
        if (active > 0 && !acc.onCooldown && acc.headersReady) {
          status = theme.yellow(`● Gerando `);
        } else if (acc.onCooldown) {
          const reason = acc.cooldownReason || "";
          if (
            reason.startsWith("AuthFailed") ||
            reason.startsWith("AuthPermanentFailure") ||
            reason.includes("login methods exhausted")
          ) {
            status = theme.red(`❌ Auth Fail`);
          } else if (reason === "WafChallenge") {
            status = theme.peach(`🛡️ WAF Block`);
          } else {
            const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
            status = theme.yellow(`⚠️ ${mins}m cd`);
          }
        } else if (!acc.headersReady) {
          status = acc.isInitialized
            ? theme.yellow(`◐ Aquecendo...`)
            : theme.muted(`○ Standby`);
        }
        rightContent.push(`  ${num}${name} ${loadBadge} ${status}`);
      });
    }

    const summaryParts: string[] = [];
    if (readyCount > 0) summaryParts.push(`${readyCount} warm`);
    if (standbyCount > 0) summaryParts.push(`${standbyCount} standby`);
    if (cooldownCount > 0) summaryParts.push(`${cooldownCount} cd`);
    const rightFooter = summaryParts.length > 0 ? `💡 ${summaryParts.join(" · ")} · [5] Contas` : undefined;

    const rightBox = drawBox({
      title: `Contas Pool (${availableCount}/${accounts.length})`,
      width: rightW,
      height: boxHeight,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
      footer: rightFooter,
      content: rightContent,
    });

    // Merge columns side by side
    const mergedLines: string[] = [];
    const maxRows = Math.max(leftBox.length, rightBox.length);
    for (let r = 0; r < maxRows; r++) {
      const leftRow = leftBox[r] || " ".repeat(leftW);
      const rightRow = rightBox[r] || " ".repeat(rightW);
      mergedLines.push(leftRow + " " + rightRow);
    }

    return mergedLines;
  }
}
