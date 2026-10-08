/**
 * QwenProxy TUI - Status and Live Dashboard View (Tab 1)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate, setClipboardText, getClipboardText } from "../theme.ts";
import { fetchProxyStatus, resetAllCooldowns, formatUptime } from "../proxy-client.ts";
import { ServerManager } from "../server-manager.ts";
import { getRuntimeChatMode, cycleNextChatMode, config } from "../../core/config.ts";
import { saveTuiSettings } from "../settings.ts";
import { persistServerPort, persistCustomApiKey } from "../../core/local-auth.ts";

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
  private lastActionPortRow = 24;
  private lastActionApiKeyRow = 25;

  public isPortModalOpen = false;
  public portInput = "";
  public portCursor = 0;
  public portError = "";
  public portModalHoveredBtn: "save" | "cancel" | null = null;
  public lastPortModalBtnRow = 0;
  public lastPortModalLeftPad = 0;

  public isApiKeyModalOpen = false;
  public apiKeyInput = "";
  public apiKeyCursor = 0;
  public apiKeyError = "";
  public apiKeyModalHoveredBtn: "save" | "cancel" | null = null;
  public lastApiKeyModalBtnRow = 0;
  public lastApiKeyModalLeftPad = 0;

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

  public isCapturingText(): boolean {
    return this.isPortModalOpen || this.isApiKeyModalOpen;
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.isPortModalOpen) {
      return [
        { key: "Enter", label: "Salvar Porta" },
        { key: "Esc", label: "Cancelar" },
      ];
    }
    if (this.isApiKeyModalOpen) {
      return [
        { key: "Enter", label: "Salvar API Key" },
        { key: "Ctrl+V", label: "Colar" },
        { key: "Esc", label: "Cancelar" },
      ];
    }
    return [
      { key: "r", label: "Recarregar" },
      { key: "z", label: "Zerar Cooldowns" },
      { key: "m", label: "Alternar Modo" },
      { key: "c", label: "Copiar URL" },
      { key: "p", label: "Alterar Porta" },
      { key: "k", label: "Alterar API Key" },
    ];
  }

  private setMessage(msg: string): void {
    this.actionMessage = msg;
    clearTimeout(this.actionMessageTimeout!);
    this.actionMessageTimeout = setTimeout(() => {
      this.actionMessage = "";
    }, 4000);
  }

  private async savePortFromModal(): Promise<boolean> {
    const val = this.portInput.trim();
    const p = parseInt(val, 10);
    if (isNaN(p) || p < 1 || p > 65535) {
      this.portError = "Porta inválida (deve ser entre 1 e 65535)";
      return false;
    }
    persistServerPort(p);
    if (config.server) {
      config.server.port = p;
    }
    this.isPortModalOpen = false;
    this.portError = "";
    this.portModalHoveredBtn = null;
    this.setMessage(theme.green(`✓ Porta alterada para ${p} (salva no .env)`));
    await this.refresh();
    const sManager = ServerManager.getInstance();
    if (sManager.getState() === "online") {
      void sManager.restart();
    }
    return true;
  }

  private async saveApiKeyFromModal(): Promise<boolean> {
    const k = this.apiKeyInput.trim();
    persistCustomApiKey(k);
    this.isApiKeyModalOpen = false;
    this.apiKeyError = "";
    this.apiKeyModalHoveredBtn = null;
    this.setMessage(theme.green(`✓ API Key salva no .env com sucesso`));
    await this.refresh();
    return true;
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // 1. Port Modal key & mouse handling
    if (this.isPortModalOpen) {
      // Mouse hover in Port Modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        if (row === this.lastPortModalBtnRow) {
          const relCol = col - this.lastPortModalLeftPad;
          let btn: "save" | "cancel" | null = null;
          if (relCol >= 2 && relCol <= 28) {
            btn = "save";
          } else if (relCol >= 29 && relCol <= 48) {
            btn = "cancel";
          }
          if (this.portModalHoveredBtn !== btn) {
            this.portModalHoveredBtn = btn;
            return true;
          }
          return false;
        }
        if (this.portModalHoveredBtn !== null) {
          this.portModalHoveredBtn = null;
          return true;
        }
        return false;
      }

      // Mouse click in Port Modal
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        if (row === this.lastPortModalBtnRow) {
          const relCol = col - this.lastPortModalLeftPad;
          if (relCol >= 2 && relCol <= 28) {
            await this.savePortFromModal();
            return true;
          }
          if (relCol >= 29 && relCol <= 48) {
            this.isPortModalOpen = false;
            this.portError = "";
            this.portModalHoveredBtn = null;
            return true;
          }
        }
        return true;
      }

      if (key.name === "escape") {
        this.isPortModalOpen = false;
        this.portError = "";
        this.portModalHoveredBtn = null;
        return true;
      }
      if (key.name === "enter") {
        await this.savePortFromModal();
        return true;
      }
      if (key.name === "backspace") {
        const cur = Math.max(0, Math.min(this.portInput.length, this.portCursor));
        if (cur > 0) {
          this.portInput =
            this.portInput.slice(0, cur - 1) +
            this.portInput.slice(cur);
          this.portCursor = cur - 1;
          this.portError = "";
        }
        return true;
      }
      if (key.name === "delete") {
        const cur = Math.max(0, Math.min(this.portInput.length, this.portCursor));
        if (cur < this.portInput.length) {
          this.portInput =
            this.portInput.slice(0, cur) +
            this.portInput.slice(cur + 1);
          this.portError = "";
        }
        return true;
      }
      if (key.name === "left") {
        this.portCursor = Math.max(0, this.portCursor - 1);
        return true;
      }
      if (key.name === "right") {
        this.portCursor = Math.min(this.portInput.length, this.portCursor + 1);
        return true;
      }
      if (key.name === "home") {
        this.portCursor = 0;
        return true;
      }
      if (key.name === "end") {
        this.portCursor = this.portInput.length;
        return true;
      }
      // Numeric input
      const ch = key.char || (key.name.length === 1 && /^\d$/.test(key.name) ? key.name : "");
      if (ch && /^\d$/.test(ch) && !key.ctrl && !key.meta) {
        if (this.portInput.length < 5) {
          const cur = Math.max(0, Math.min(this.portInput.length, this.portCursor));
          this.portInput =
            this.portInput.slice(0, cur) +
            ch +
            this.portInput.slice(cur);
          this.portCursor = cur + ch.length;
          this.portError = "";
        }
        return true;
      }
      return true; // Swallow all keys in modal
    }

    // 2. API Key Modal key & mouse handling
    if (this.isApiKeyModalOpen) {
      // Mouse hover in API Key Modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        if (row === this.lastApiKeyModalBtnRow) {
          const relCol = col - this.lastApiKeyModalLeftPad;
          let btn: "save" | "cancel" | null = null;
          if (relCol >= 2 && relCol <= 30) {
            btn = "save";
          } else if (relCol >= 31 && relCol <= 50) {
            btn = "cancel";
          }
          if (this.apiKeyModalHoveredBtn !== btn) {
            this.apiKeyModalHoveredBtn = btn;
            return true;
          }
          return false;
        }
        if (this.apiKeyModalHoveredBtn !== null) {
          this.apiKeyModalHoveredBtn = null;
          return true;
        }
        return false;
      }

      // Mouse click in API Key Modal
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        if (row === this.lastApiKeyModalBtnRow) {
          const relCol = col - this.lastApiKeyModalLeftPad;
          if (relCol >= 2 && relCol <= 30) {
            await this.saveApiKeyFromModal();
            return true;
          }
          if (relCol >= 31 && relCol <= 50) {
            this.isApiKeyModalOpen = false;
            this.apiKeyError = "";
            this.apiKeyModalHoveredBtn = null;
            return true;
          }
        }
        return true;
      }

      if (key.name === "escape") {
        this.isApiKeyModalOpen = false;
        this.apiKeyError = "";
        this.apiKeyModalHoveredBtn = null;
        return true;
      }
      if (key.name === "enter") {
        await this.saveApiKeyFromModal();
        return true;
      }
      if (key.ctrl && (key.name === "v" || key.raw === "\x16")) {
        const pasted = getClipboardText();
        if (pasted) {
          const clean = pasted.replace(/[\r\n]/g, "").trim();
          const cur = Math.max(0, Math.min(this.apiKeyInput.length, this.apiKeyCursor));
          this.apiKeyInput =
            this.apiKeyInput.slice(0, cur) +
            clean +
            this.apiKeyInput.slice(cur);
          this.apiKeyCursor = cur + clean.length;
          this.apiKeyError = "";
        }
        return true;
      }
      if (key.ctrl && key.name === "c") {
        this.apiKeyInput = "";
        this.apiKeyCursor = 0;
        return true;
      }
      if (key.name === "backspace") {
        const cur = Math.max(0, Math.min(this.apiKeyInput.length, this.apiKeyCursor));
        if (cur > 0) {
          this.apiKeyInput =
            this.apiKeyInput.slice(0, cur - 1) +
            this.apiKeyInput.slice(cur);
          this.apiKeyCursor = cur - 1;
          this.apiKeyError = "";
        }
        return true;
      }
      if (key.name === "delete") {
        const cur = Math.max(0, Math.min(this.apiKeyInput.length, this.apiKeyCursor));
        if (cur < this.apiKeyInput.length) {
          this.apiKeyInput =
            this.apiKeyInput.slice(0, cur) +
            this.apiKeyInput.slice(cur + 1);
          this.apiKeyError = "";
        }
        return true;
      }
      if (key.name === "left") {
        this.apiKeyCursor = Math.max(0, this.apiKeyCursor - 1);
        return true;
      }
      if (key.name === "right") {
        this.apiKeyCursor = Math.min(this.apiKeyInput.length, this.apiKeyCursor + 1);
        return true;
      }
      if (key.name === "home") {
        this.apiKeyCursor = 0;
        return true;
      }
      if (key.name === "end") {
        this.apiKeyCursor = this.apiKeyInput.length;
        return true;
      }
      // Text character input
      const ch = key.char || (key.name.length === 1 && !key.ctrl && !key.meta ? key.name : "");
      if (ch && ch.length === 1 && ch >= " " && !key.ctrl && !key.meta) {
        const cur = Math.max(0, Math.min(this.apiKeyInput.length, this.apiKeyCursor));
        this.apiKeyInput =
          this.apiKeyInput.slice(0, cur) +
          ch +
          this.apiKeyInput.slice(cur);
        this.apiKeyCursor = cur + ch.length;
        this.apiKeyError = "";
        return true;
      }
      return true; // Swallow all keys in modal
    }

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
          row === this.lastActionCopiarRow ||
          row === this.lastActionPortRow ||
          row === this.lastActionApiKeyRow);

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
        if (row === this.lastActionPortRow) {
          this.isPortModalOpen = true;
          this.isApiKeyModalOpen = false;
          this.portInput = String(this.statusData?.port || config.server?.port || 7936);
          this.portCursor = this.portInput.length;
          this.portError = "";
          return true;
        }
        if (row === this.lastActionApiKeyRow) {
          this.isApiKeyModalOpen = true;
          this.isPortModalOpen = false;
          this.apiKeyInput = (process.env.API_KEY || "").trim();
          this.apiKeyCursor = this.apiKeyInput.length;
          this.apiKeyError = "";
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

    if ((key.name === "p" || key.name === "P") && !key.ctrl) {
      this.isPortModalOpen = true;
      this.isApiKeyModalOpen = false;
      this.portInput = String(this.statusData?.port || config.server?.port || 7936);
      this.portCursor = this.portInput.length;
      this.portError = "";
      return true;
    }

    if ((key.name === "k" || key.name === "K") && !key.ctrl) {
      this.isApiKeyModalOpen = true;
      this.isPortModalOpen = false;
      this.apiKeyInput = (process.env.API_KEY || "").trim();
      this.apiKeyCursor = this.apiKeyInput.length;
      this.apiKeyError = "";
      return true;
    }
  }
  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const data = snapshot || this.statusData;
    const isOnline = data?.online ?? false;
    const contentH = Math.max(10, height);

    if (this.isPortModalOpen) {
      const modalW = Math.min(width - 4, 62);
      const padCount = Math.max(0, Math.floor((width - modalW) / 2));
      const padStr = " ".repeat(padCount);

      const safeCursor = Math.max(0, Math.min(this.portInput.length, this.portCursor));
      let inputDisplay: string;
      if (this.portInput.length === 0) {
        inputDisplay = `${theme.inverse(" ")} ${theme.dim("(ex: 7936)")}`;
      } else {
        const before = this.portInput.slice(0, safeCursor);
        const at = this.portInput[safeCursor] || " ";
        const after = this.portInput.slice(safeCursor + 1);
        inputDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
      }

      const modalContent: string[] = [
        "",
        `  ${theme.bold("Alterar Porta do Servidor:")}`,
        `  ${theme.dim("Digite a nova porta para o servidor QwenProxy (1-65535):")}`,
        `  ${theme.dim("────────────────────────────────────────────────────────")}`,
        `    Porta: [ ${inputDisplay} ]`,
        `  ${theme.dim("────────────────────────────────────────────────────────")}`,
      ];

      if (this.portError) {
        modalContent.push(`  ${theme.red(`❌ ${this.portError}`)}`);
      } else {
        modalContent.push(`  ${theme.dim("Porta padrão: 7936 (mnemônico Q-W-E-N no teclado)")}`);
      }

      const isSaveHovered = this.portModalHoveredBtn === "save";
      const isCancelHovered = this.portModalHoveredBtn === "cancel";

      const saveLabel = " [ Enter ] Salvar Porta ";
      const cancelLabel = " [ Esc ] Cancelar ";

      const saveBtn = isSaveHovered
        ? theme.bgHover(theme.bold(theme.green(saveLabel)))
        : theme.green(saveLabel);

      const cancelBtn = isCancelHovered
        ? theme.bgHover(theme.bold(theme.red(cancelLabel)))
        : theme.muted(cancelLabel);

      modalContent.push("");
      const btnContentIdx = modalContent.length;
      modalContent.push(
        `  ${saveBtn}  ${cancelBtn}`,
        "",
        `  ${theme.dim("Nota: Salva no arquivo .env e reinicia o servidor se estiver ativo.")}`,
      );

      const modalBox = drawBox({
        title: "Alterar Porta do Servidor",
        width: modalW,
        height: Math.min(contentH, modalContent.length + 2),
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalContent,
      });

      const topPadCount = Math.max(1, Math.floor((contentH - modalBox.length) / 3));
      this.lastPortModalBtnRow = 5 + topPadCount + btnContentIdx;
      this.lastPortModalLeftPad = padCount;

      const topPad = Array(topPadCount).fill(" ".repeat(width));
      const res = [...topPad, ...modalBox.map((line) => padStr + line)];
      while (res.length < contentH) res.push(" ".repeat(width));
      return res;
    }

    if (this.isApiKeyModalOpen) {
      const modalW = Math.min(width - 4, 68);
      const padCount = Math.max(0, Math.floor((width - modalW) / 2));
      const padStr = " ".repeat(padCount);

      const safeCursor = Math.max(0, Math.min(this.apiKeyInput.length, this.apiKeyCursor));
      let inputDisplay: string;
      if (this.apiKeyInput.length === 0) {
        inputDisplay = `${theme.inverse(" ")} ${theme.dim("(vazio = sem autenticação local)")}`;
      } else {
        const before = this.apiKeyInput.slice(0, safeCursor);
        const at = this.apiKeyInput[safeCursor] || " ";
        const after = this.apiKeyInput.slice(safeCursor + 1);
        inputDisplay = `${theme.peach(before)}${theme.inverse(at)}${theme.peach(after)}`;
      }

      const isProtected = this.apiKeyInput.trim().length > 0;
      const statusBadge = isProtected
        ? theme.green("Protegido (Requer Bearer Token)")
        : theme.yellow("Livre (Apenas Loopback 127.0.0.1)");

      const isSaveHovered = this.apiKeyModalHoveredBtn === "save";
      const isCancelHovered = this.apiKeyModalHoveredBtn === "cancel";

      const saveLabel = " [ Enter ] Salvar API Key ";
      const cancelLabel = " [ Esc ] Cancelar ";

      const saveBtn = isSaveHovered
        ? theme.bgHover(theme.bold(theme.green(saveLabel)))
        : theme.green(saveLabel);

      const cancelBtn = isCancelHovered
        ? theme.bgHover(theme.bold(theme.red(cancelLabel)))
        : theme.muted(cancelLabel);

      const modalContent: string[] = [
        "",
        `  ${theme.bold("Configurar Chave de Autenticação (API Key):")}`,
        `  ${theme.dim("Digite ou cole (Ctrl+V) a chave Bearer para proteger o proxy:")}`,
        `  ${theme.dim("────────────────────────────────────────────────────────────")}`,
        `    API Key: [ ${inputDisplay} ]`,
        `  ${theme.dim("────────────────────────────────────────────────────────────")}`,
        `  Modo de Acesso: ${statusBadge}`,
      ];

      modalContent.push("");
      const btnContentIdx = modalContent.length;
      modalContent.push(
        `  ${saveBtn}  ${cancelBtn}  ${theme.dim("(Ctrl+V colar)")}`,
        "",
        `  ${theme.dim("Nota: Salva a chave no arquivo .env. Clientes devem enviar 'Bearer <key>'.")}`,
      );

      const modalBox = drawBox({
        title: "Configurar API Key",
        width: modalW,
        height: Math.min(contentH, modalContent.length + 2),
        borderColor: theme.borderActive,
        titleColor: theme.peach,
        content: modalContent,
      });

      const topPadCount = Math.max(1, Math.floor((contentH - modalBox.length) / 3));
      this.lastApiKeyModalBtnRow = 5 + topPadCount + btnContentIdx;
      this.lastApiKeyModalLeftPad = padCount;

      const topPad = Array(topPadCount).fill(" ".repeat(width));
      const res = [...topPad, ...modalBox.map((line) => padStr + line)];
      while (res.length < contentH) res.push(" ".repeat(width));
      return res;
    }

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
    const portIdx = leftContent.length + 4;
    const apiKeyIdx = leftContent.length + 5;

    this.lastActionRecarregarRow = 5 + recarregarIdx;
    this.lastActionZerarRow = 5 + zerarIdx;
    this.lastActionModoRow = 5 + modoIdx;
    this.lastActionCopiarRow = 5 + copiarIdx;
    this.lastActionPortRow = 5 + portIdx;
    this.lastActionApiKeyRow = 5 + apiKeyIdx;

    leftContent.push(
      `   ${this.hoveredActionRow === this.lastActionRecarregarRow ? theme.bgHover(` ${theme.cyan("[ R ] Recarregar")} `) : ` ${theme.cyan("[ R ]")} Recarregar`}`,
      `   ${this.hoveredActionRow === this.lastActionZerarRow ? theme.bgHover(` ${theme.yellow("[ Z ] Zerar Cooldowns")} `) : ` ${theme.yellow("[ Z ]")} Zerar Cooldowns`}`,
      `   ${this.hoveredActionRow === this.lastActionModoRow ? theme.bgHover(` ${theme.lavender("[ M ] Alternar Modo")} `) : ` ${theme.lavender("[ M ]")} Alternar Modo`}`,
      `   ${this.hoveredActionRow === this.lastActionCopiarRow ? theme.bgHover(` ${theme.green("[ C ] Copiar URL")} `) : ` ${theme.green("[ C ]")} Copiar URL`}`,
      `   ${this.hoveredActionRow === this.lastActionPortRow ? theme.bgHover(` ${theme.cyan("[ P ] Alterar Porta")} `) : ` ${theme.cyan("[ P ]")} Alterar Porta`}`,
      `   ${this.hoveredActionRow === this.lastActionApiKeyRow ? theme.bgHover(` ${theme.peach("[ K ] Alterar API Key")} `) : ` ${theme.peach("[ K ]")} Alterar API Key`}`,
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
