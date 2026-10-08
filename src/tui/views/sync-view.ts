/**
 * QwenProxy TUI - Selective Client Sync View (Tab 3)
 */

import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import {
  syncAllClients,
  restoreAllClients,
  getDefaultPaths,
  inspectClientSyncStatus,
} from "../../sync/index.ts";
import type { SyncClientName } from "../../sync/types.ts";
import { fetchLiveModels, DEFAULT_FALLBACK_MODELS } from "../proxy-client.ts";

interface ClientOption {
  id: SyncClientName;
  name: string;
  path: string;
  selected: boolean;
  detected: boolean;
  synced: boolean;
  configuredModel?: string;
}
export class SyncView implements TuiView {
  public readonly id = "sync";
  public readonly title = "Sync";
  public readonly tabNumber = 3;
  private clients: ClientOption[] = [];
  private selectedRowIndex = 0; // 0..9 for clients, 10 for model, 11 for scope, 12 for sync, 13 for restore
  private hoveredActionRow: number | null = null;
  private availableModels = [...DEFAULT_FALLBACK_MODELS];
  private modelIndex = 0;
  private syncAllModels = true;
  private actionLog: string[] = [];
  private lastLeftW = 46;
  private lastClientStartRow = 8;
  private lastClientEndRow = 17;
  private lastModelRow = 20;
  private lastScopeRow = 21;
  private lastSyncRow = 24;
  private lastRestoreRow = 25;
  constructor() {
    this.detectClients();
  }

  public onActivate(): void {
    this.detectClients();
    void this.refreshModels();
  }
  public async refreshModels(): Promise<void> {
    try {
      const live = await fetchLiveModels();
      if (live && live.length > 0) {
        const current = this.availableModels[this.modelIndex];
        this.availableModels = live;
        const foundIdx = this.availableModels.indexOf(current);
        this.modelIndex = foundIdx !== -1 ? foundIdx : 0;
      }
    } catch {}
  }

  private appendLog(msg: string): void {
    this.actionLog.push(msg);
    if (this.actionLog.length > 500) {
      this.actionLog.shift();
    }
  }

  private detectClients(): void {
    const paths = getDefaultPaths();
    const defs: Array<{ id: SyncClientName; name: string; path: string }> = [
      { id: "hermes", name: "Hermes Agent", path: paths.hermes },
      { id: "opencode", name: "OpenCode", path: paths.openCode },
      { id: "claude-code", name: "Claude Code", path: paths.claudeCode },
      { id: "openclaw", name: "OpenClaw", path: paths.openClaw },
      { id: "kilo", name: "Kilo Code", path: paths.kilo },
      { id: "cline", name: "Cline", path: paths.cline },
      { id: "omp", name: "OMP (Oh My Pi)", path: paths.omp },
      { id: "codex", name: "Codex CLI", path: paths.codex },
      { id: "zed", name: "Zed Editor", path: paths.zed },
      { id: "aider", name: "Aider", path: paths.aider },
    ];

    this.clients = defs.map((d) => {
      const status = inspectClientSyncStatus(d.id, d.path);
      return {
        id: d.id,
        name: d.name,
        path: d.path,
        selected: false,
        detected: status.installed,
        synced: status.synced,
        configuredModel: status.model,
      };
    });
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "Espaço", label: "Marcar/Desmarcar" },
      { key: "Enter", label: "Sincronizar" },
      { key: "r", label: "Restaurar Backups" },
      { key: "a", label: "Alternar Todos" },
    ];
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover interactions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        if (row >= this.lastClientStartRow && row <= this.lastClientEndRow) {
          const targetRow = row - this.lastClientStartRow;
          let changed = false;
          if (this.selectedRowIndex !== targetRow) {
            this.selectedRowIndex = targetRow;
            changed = true;
          }
          if (this.hoveredActionRow !== null) {
            this.hoveredActionRow = null;
            changed = true;
          }
          if (changed) return true;
        } else if (row === this.lastModelRow) {
          let changed = false;
          if (this.selectedRowIndex !== 10) {
            this.selectedRowIndex = 10;
            changed = true;
          }
          if (this.hoveredActionRow !== null) {
            this.hoveredActionRow = null;
            changed = true;
          }
          if (changed) return true;
        } else if (row === this.lastScopeRow) {
          let changed = false;
          if (this.selectedRowIndex !== 11) {
            this.selectedRowIndex = 11;
            changed = true;
          }
          if (this.hoveredActionRow !== null) {
            this.hoveredActionRow = null;
            changed = true;
          }
          if (changed) return true;
        } else if (row === this.lastSyncRow) {
          let changed = false;
          if (this.selectedRowIndex !== 12) {
            this.selectedRowIndex = 12;
            changed = true;
          }
          if (this.hoveredActionRow !== this.lastSyncRow) {
            this.hoveredActionRow = this.lastSyncRow;
            changed = true;
          }
          if (changed) return true;
        } else if (row === this.lastRestoreRow) {
          let changed = false;
          if (this.selectedRowIndex !== 13) {
            this.selectedRowIndex = 13;
            changed = true;
          }
          if (this.hoveredActionRow !== this.lastRestoreRow) {
            this.hoveredActionRow = this.lastRestoreRow;
            changed = true;
          }
          if (changed) return true;
        } else if (this.hoveredActionRow !== null) {
          this.hoveredActionRow = null;
          return true;
        }
      } else if (this.hoveredActionRow !== null) {
        this.hoveredActionRow = null;
        return true;
      }
    }

    // Mouse click interactions
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        // Rows 8..17: Toggle client
        if (row >= this.lastClientStartRow && row <= this.lastClientEndRow) {
          const client = this.clients[row - this.lastClientStartRow];
          if (client) {
            client.selected = !client.selected;
            this.selectedRowIndex = row - this.lastClientStartRow;
            this.hoveredActionRow = null;
            return true;
          }
        }
        // Model selector
        if (row === this.lastModelRow) {
          this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
          this.selectedRowIndex = 10;
          this.hoveredActionRow = null;
          return true;
        }
        // Scope selector
        if (row === this.lastScopeRow) {
          this.syncAllModels = !this.syncAllModels;
          this.selectedRowIndex = 11;
          this.hoveredActionRow = null;
          return true;
        }
        // Sincronizar button
        if (row === this.lastSyncRow) {
          this.selectedRowIndex = 12;
          this.hoveredActionRow = this.lastSyncRow;
          this.executeSync();
          return true;
        }
        // Restaurar button
        if (row === this.lastRestoreRow) {
          this.selectedRowIndex = 13;
          this.hoveredActionRow = this.lastRestoreRow;
          this.executeRollback();
          return true;
        }
      }
    }

    // Navigate rows (Mouse wheel or Up/Down keys)
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      this.selectedRowIndex = Math.max(0, this.selectedRowIndex - 1);
      return true;
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      this.selectedRowIndex = Math.min(13, this.selectedRowIndex + 1);
      return true;
    }

    // Toggle client selection with Space
    if (key.name === "space") {
      if (this.selectedRowIndex < this.clients.length) {
        const client = this.clients[this.selectedRowIndex];
        if (client) {
          client.selected = !client.selected;
        }
      } else if (this.selectedRowIndex === 10) {
        // Cycle model with space
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      } else if (this.selectedRowIndex === 11) {
        this.syncAllModels = !this.syncAllModels;
      }
      return true;
    }

    // Cycle model left/right on row 10
    if (this.selectedRowIndex === 10 && (key.name === "left" || key.name === "right")) {
      if (key.name === "left") {
        this.modelIndex =
          (this.modelIndex - 1 + this.availableModels.length) %
          this.availableModels.length;
      } else {
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      }
      return true;
    }
    // Toggle all with 'a'
    if (key.name === "a" && !key.ctrl) {
      const allSelected = this.clients.every((c) => c.selected);
      for (const c of this.clients) {
        c.selected = !allSelected;
      }
      this.appendLog(
        allSelected ? "Desmarcados todos os clientes." : "Selecionados todos os clientes.",
      );
      return true;
    }

    // Rollback with 'r'
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      this.executeRollback();
      return true;
    }

    // Confirm action on Enter
    if (key.name === "return") {
      if (this.selectedRowIndex === 13) {
        this.executeRollback();
      } else {
        this.executeSync();
      }
      return true;
    }
  }

  private executeSync(): void {
    const selectedTargets = this.clients
      .filter((c) => c.selected)
      .map((c) => c.id);

    if (selectedTargets.length === 0) {
      this.appendLog(theme.yellow("⚠ Nenhum cliente selecionado para sincronizar."));
      return;
    }
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    this.appendLog(
      theme.cyan(`⏳ Sincronizando [${selectedTargets.join(", ")}] com modelo ${currentModel}...`),
    );
    try {
      const res = syncAllClients({
        targets: selectedTargets,
        model: currentModel,
        models: this.availableModels,
        syncAllModels: this.syncAllModels,
      });

      let successCount = 0;
      for (const [key, clientRes] of Object.entries(res.clients)) {
        if (clientRes && clientRes.success) {
          successCount++;
          this.appendLog(
            theme.green(`✓ [${key}] ${clientRes.message || "Configurado com sucesso"}`),
          );
        } else if (clientRes) {
          this.appendLog(
            theme.red(`✗ [${key}] Falha: ${clientRes.error || "Erro desconhecido"}`),
          );
        }
      }

      this.appendLog(
        theme.green(`🎉 Concluído: ${successCount} cliente(s) sincronizado(s) com zero perdas!`),
      );
      this.detectClients();
    } catch (err: any) {
      this.appendLog(
        theme.red(`✗ Erro na sincronização: ${err?.message || String(err)}`),
      );
    }
  }

  private executeRollback(): void {
    const selectedTargets = this.clients
      .filter((c) => c.selected)
      .map((c) => c.id);

    const targetDesc = selectedTargets.length > 0 ? `[${selectedTargets.join(", ")}]` : "todos os clientes";
    this.appendLog(theme.yellow(`⏳ Restaurando backups anteriores de ${targetDesc}...`));
    try {
      const res = restoreAllClients({
        targets: selectedTargets.length > 0 ? selectedTargets : undefined,
      });
      this.appendLog(
        theme.green(`✓ Rollback concluído: ${res.restoredCount} arquivo(s) restaurados com sucesso.`),
      );
      this.detectClients();
    } catch (err: any) {
      this.appendLog(theme.red(`✗ Erro ao restaurar backups: ${err?.message || String(err)}`));
    }
  }

  public render(width: number, height: number): string[] {
    const contentH = Math.max(22, height);
    const leftW = Math.max(48, Math.floor(width * 0.52));
    this.lastLeftW = leftW;
    this.lastClientStartRow = 8;
    this.lastClientEndRow = 8 + this.clients.length - 1;
    this.lastModelRow = this.lastClientEndRow + 3;
    this.lastScopeRow = this.lastModelRow + 1;
    this.lastSyncRow = this.lastScopeRow + 3;
    this.lastRestoreRow = this.lastSyncRow + 1;
    const rightW = Math.max(30, width - leftW - 1);

    // Left Panel: Options and Selectors
    const leftContent: string[] = [
      "",
      `  ${theme.bold("Clientes:")} (Espaço para marcar)`,
      "",
    ];

    this.clients.forEach((c, idx) => {
      const isFocused = this.selectedRowIndex === idx;
      const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
      const check = c.selected ? theme.green(glyphs.checkOn) : theme.muted(glyphs.checkOff);
      const name = pad(c.name, 16);

      let status: string;
      if (c.synced) {
        status = theme.green(`${glyphs.check} Sincronizado`);
      } else if (c.detected) {
        status = theme.yellow(`${glyphs.bullet} Outro provedor`);
      } else {
        status = theme.muted(`${glyphs.circle} Não instalado`);
      }

      const line = `${pointer}${check} ${name} ${status}`;
      leftContent.push(isFocused ? theme.bgSelected(line) : line);
    });

    leftContent.push("");
    leftContent.push(`  ${theme.bold("Modelo:")}`);

    // Row index 10: Model Selector
    const isModelFocused = this.selectedRowIndex === 10;
    const modelPointer = isModelFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    const modelText = `${currentModel} (${this.modelIndex + 1}/${this.availableModels.length})`;

    const modelLine = this.syncAllModels
      ? `${modelPointer}${theme.dim(`${modelText}`)}`
      : `${modelPointer}${theme.cyan(modelText)}`;

    leftContent.push(isModelFocused ? theme.bgSelected(modelLine) : modelLine);

    // Row index 11: Scope Selector
    const isScopeFocused = this.selectedRowIndex === 11;
    const scopePointer = isScopeFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const scopeCheck = this.syncAllModels ? theme.green(glyphs.radioOn) : theme.muted(glyphs.radioOff);
    const scopeLine = `${scopePointer}${scopeCheck} Registrar todos os modelos`;
    leftContent.push(isScopeFocused ? theme.bgSelected(scopeLine) : scopeLine);
    leftContent.push("");
    leftContent.push(`  ${theme.bold("Ações:")}`);
    // Row index 12: Sincronizar
    const isSyncFocused = this.selectedRowIndex === 12;
    const isSyncHovered = this.hoveredActionRow === this.lastSyncRow;
    const syncLine = `    ${isSyncHovered || isSyncFocused ? theme.bgHover(` ${theme.cyan("[ Enter ] Sincronizar")} `) : `${theme.cyan("[ Enter ]")} Sincronizar`}`;
    leftContent.push(syncLine);

    // Row index 13: Restaurar
    const isRestoreFocused = this.selectedRowIndex === 13;
    const isRestoreHovered = this.hoveredActionRow === this.lastRestoreRow;
    const restoreLine = `    ${isRestoreHovered || isRestoreFocused ? theme.bgHover(` ${theme.yellow("[ R ] Restaurar")} `) : `${theme.yellow("[ R ]")} Restaurar`}`;
    leftContent.push(restoreLine);

    const leftBox = drawBox({
      title: "Configurar",
      width: leftW,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Panel: Action Log & Backups
    const rightContent: string[] = [
      "",
      `  ${theme.bold("Histórico:")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (this.actionLog.length === 0) {
      rightContent.push("");
      rightContent.push(theme.muted("  Nenhuma sincronização recente executada nesta sessão."));
      rightContent.push("");
      rightContent.push(
        theme.muted("  Pressione [ Enter ] para sincronizar os clientes selecionados."),
      );
      rightContent.push(
        theme.muted("  Backups (.bak) são criados automaticamente antes de cada alteração."),
      );
    } else {
      const maxLogs = Math.max(5, contentH - 5);
      const visibleLogs = this.actionLog.slice(-maxLogs);
      for (const log of visibleLogs) {
        rightContent.push(`  ${log}`);
      }
    }
    const rightBox = drawBox({
      title: "Histórico & Backups",
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
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
