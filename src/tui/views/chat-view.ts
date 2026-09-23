/**
 * QwenProxy TUI - Interactive Chat Tester View (Tab 2)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, stringWidth, truncate, stripAnsi, pad, wrapContentLine } from "../theme.ts";
import {
  fetchLiveModels,
  streamChatCompletions,
  DEFAULT_FALLBACK_MODELS,
} from "../proxy-client.ts";
import { ServerManager } from "../server-manager.ts";
import { formatMarkdown, formatReasoning } from "../markdown.ts";
import { loadTuiSettings, saveTuiSettings } from "../settings.ts";
import { setRuntimeChatMode, getRuntimeChatMode } from "../../core/config.ts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  ttfbMs?: number;
  totalTimeMs?: number;
  cachedContentLines?: string[];
  cachedReasoningBox?: string[];
  cachedWidth?: number;
}
export function classifyModel(modelId: string): {
  badge: string;
  category: string;
  supportsReasoning: boolean;
} {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("image") ||
    lower.startsWith("z-image") ||
    lower.includes("t2i") ||
    lower.includes("i2i")
  ) {
    return {
      badge: theme.lavender("[Imagem]"),
      category: "Geração de Imagem",
      supportsReasoning: false,
    };
  }
  if (lower.includes("video") || lower.includes("t2v") || lower.includes("i2v")) {
    return {
      badge: theme.peach("[Vídeo] "),
      category: "Geração de Vídeo",
      supportsReasoning: false,
    };
  }
  if (
    lower.includes("omni") ||
    lower.includes("audio") ||
    lower.includes("speech")
  ) {
    return {
      badge: theme.green("[Omni]  "),
      category: "Multimodal / Omni",
      supportsReasoning: true,
    };
  }
  return {
    badge: theme.cyan("[Texto] "),
    category: "Texto & Raciocínio",
    supportsReasoning: true,
  };
}

export class ChatView implements TuiView {
  public readonly id = "chat";
  public readonly title = "Chat";
  public readonly tabNumber = 2;

  private availableModels = [...DEFAULT_FALLBACK_MODELS];
  private selectedModelIndex = 0;
  private messages: ChatMessage[] = [];
  private inputBuffer = "";
  private cursorPos = 0;
  private scrollOffset = 0; // 0 = follow bottom (newest messages)
  private lastWidth = 80;
  private lastHeight = 24;
  private lastMaxOffset = 0;
  private lastVisibleCapacity = 0;
  private hoveredHeaderBtn: "model" | "effort" | "mode" | null = null;
  private isScrollbarHovered = false;
  private isDraggingScrollbar = false;
  private modelBtnStartCol = 0;
  private modelBtnEndCol = 0;
  private effortBtnStartCol = 0;
  private effortBtnEndCol = 0;
  private modeBtnStartCol = 0;
  private modeBtnEndCol = 0;
  private isModelModalOpen = false;
  private modalSelectedIndex = 0;
  private availableEfforts: Array<{
    id: "high" | "medium" | "low";
    label: string;
    desc: string;
    badge: string;
  }> = [
    {
      id: "high",
      label: "High (Thinking)",
      desc: "Raciocínio profundo ativado (ideal para código)",
      badge: theme.green("[High]"),
    },
    {
      id: "medium",
      label: "Medium (Auto)",
      desc: "Raciocínio dinâmico (Qwen decide quando pensar)",
      badge: theme.yellow("[Medium]"),
    },
    {
      id: "low",
      label: "Low (Fast)",
      desc: "Raciocínio desativado (respostas ultrarrápidas)",
      badge: theme.cyan("[Low]"),
    },
  ];
  private selectedEffort: "high" | "medium" | "low" = "high";
  private isEffortModalOpen = false;
  private effortSelectedIndex = 0;
  private availableModes: Array<{
    id: "thread" | "thread-temp" | "stateless" | "stateless-temp";
    label: string;
    desc: string;
    badge: string;
  }> = [
    {
      id: "thread",
      label: "thread (Padrão)",
      desc: "Persistente Web (Delta ~1KB, salva na conta Qwen)",
      badge: theme.cyan("[thread]"),
    },
    {
      id: "thread-temp",
      label: "thread-temp",
      desc: "Efêmero Rápido (Delta ~1KB, não salva no site)",
      badge: theme.green("[thread-temp]"),
    },
    {
      id: "stateless-temp",
      label: "stateless-temp",
      desc: "Oficial OpenAI Efêmero (Histórico total, não salva)",
      badge: theme.yellow("[stateless-temp]"),
    },
    {
      id: "stateless",
      label: "stateless",
      desc: "Oficial OpenAI Salvo (Histórico total, salva no site)",
      badge: theme.lavender("[stateless]"),
    },
  ];
  private selectedChatMode: "thread" | "thread-temp" | "stateless" | "stateless-temp" = "thread";
  private isModeModalOpen = false;
  private modeSelectedIndex = 0;
  private isGenerating = false;
  private currentAbortController: AbortController | null = null;
  private statusNote = "";
  private lastSnapshot: ProxyStatusSnapshot | null = null;
  private onNeedsRender?: () => void;
  private renderThrottleTimer: NodeJS.Timeout | null = null;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIndex = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;

  private scheduleRender(): void {
    if (this.renderThrottleTimer) return;
    this.renderThrottleTimer = setTimeout(() => {
      this.renderThrottleTimer = null;
      this.onNeedsRender?.();
    }, 40);
  }
  private flushRender(): void {
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = null;
    }
    this.onNeedsRender?.();
  }

  constructor(onNeedsRender?: () => void) {
    this.onNeedsRender = onNeedsRender;
    const saved = loadTuiSettings();
    if (saved.chat?.model) {
      const idx = this.availableModels.indexOf(saved.chat.model);
      if (idx !== -1) {
        this.selectedModelIndex = idx;
      }
    }
    const savedEffort = saved.chat?.effort;
    if (savedEffort && ["high", "medium", "low"].includes(savedEffort)) {
      this.selectedEffort = savedEffort;
      const effIdx = this.availableEfforts.findIndex((e) => e.id === savedEffort);
      if (effIdx !== -1) {
        this.effortSelectedIndex = effIdx;
      }
    }
    const runtimeMode = getRuntimeChatMode();
    this.selectedChatMode = runtimeMode;
    const mIdx = this.availableModes.findIndex((m) => m.id === runtimeMode);
    if (mIdx !== -1) {
      this.modeSelectedIndex = mIdx;
    }
    void this.refreshModels();
  }
  public onActivate(): void {
    const runtimeMode = getRuntimeChatMode();
    this.selectedChatMode = runtimeMode;
    const mIdx = this.availableModes.findIndex((m) => m.id === runtimeMode);
    if (mIdx !== -1) {
      this.modeSelectedIndex = mIdx;
    }
    void this.refreshModels();
  }

  public isModalOpen(): boolean {
    return this.isModelModalOpen || this.isEffortModalOpen || this.isModeModalOpen;
  }

  public async refreshModels(): Promise<void> {
    try {
      const live = await fetchLiveModels();
      if (live.length > 0) {
        const current = this.availableModels[this.selectedModelIndex];
        this.availableModels = live;
        let foundIdx = this.availableModels.indexOf(current);
        if (foundIdx === -1) {
          const saved = loadTuiSettings();
          if (saved.chat?.model) {
            foundIdx = this.availableModels.indexOf(saved.chat.model);
          }
        }
        this.selectedModelIndex = foundIdx !== -1 ? foundIdx : 0;
        this.onNeedsRender?.();
      }
    } catch {}
  }
  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.isModelModalOpen) {
      return [
        { key: "Enter", label: `${glyphs.enter} Escolher` },
        { key: "Esc", label: `${glyphs.cross} Fechar` },
      ];
    }
    if (this.isEffortModalOpen) {
      return [
        { key: "Enter", label: `${glyphs.enter} Confirmar` },
        { key: "Esc", label: `${glyphs.cross} Manter` },
      ];
    }
    if (this.isModeModalOpen) {
      return [
        { key: "Enter", label: `${glyphs.enter} Confirmar` },
        { key: "Esc", label: `${glyphs.cross} Manter` },
      ];
    }
    return [
      { key: "Enter", label: `${glyphs.enter} Enviar` },
      { key: "Esc", label: `${glyphs.cross} Parar` },
      { key: "Ctrl+L", label: `${glyphs.broom} Limpar` },
    ];
  }

  private applyChosenModel(idx: number): void {
    const chosen = this.availableModels[idx];
    if (!chosen) return;
    this.selectedModelIndex = idx;
    this.isModelModalOpen = false;
    saveTuiSettings({
      chat: {
        model: chosen,
        effort: this.selectedEffort,
        mode: this.selectedChatMode,
      },
    });
    const info = classifyModel(chosen);
    if (info.supportsReasoning) {
      this.isEffortModalOpen = true;
      const effIdx = this.availableEfforts.findIndex((e) => e.id === this.selectedEffort);
      this.effortSelectedIndex = effIdx !== -1 ? effIdx : 0;
      this.statusNote = `Modelo ${chosen} escolhido. Escolha o esforço de raciocínio (Effort):`;
    } else {
      this.statusNote = `Modelo alterado para ${chosen}`;
    }
    this.onNeedsRender?.();
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    if (this.isModelModalOpen) {
      if (key.name === "hover" && key.mouse) {
        const { row } = key.mouse;
        if (row >= 9 && row < 9 + this.availableModels.length) {
          const hoverIdx = row - 9;
          if (this.modalSelectedIndex !== hoverIdx) {
            this.modalSelectedIndex = hoverIdx;
            this.onNeedsRender?.();
            return true;
          }
        }
      }
      if (key.name === "click" && key.mouse) {
        const { row } = key.mouse;
        if (row >= 9 && row < 9 + this.availableModels.length) {
          const chosenIdx = row - 9;
          this.applyChosenModel(chosenIdx);
          return true;
        }
        this.isModelModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
        this.modalSelectedIndex = Math.max(0, this.modalSelectedIndex - 1);
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
        this.modalSelectedIndex = Math.min(
          this.availableModels.length - 1,
          this.modalSelectedIndex + 1,
        );
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "return") {
        this.applyChosenModel(this.modalSelectedIndex);
        return true;
      }
      if (key.name === "escape") {
        this.isModelModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      return true;
    }
    // 2. Effort Selection Modal Active
    if (this.isEffortModalOpen) {
      if (key.name === "hover" && key.mouse) {
        const { row } = key.mouse;
        const startRow = 12;
        if (row >= startRow && row < startRow + this.availableEfforts.length) {
          const hoverIdx = row - startRow;
          if (this.effortSelectedIndex !== hoverIdx) {
            this.effortSelectedIndex = hoverIdx;
            this.onNeedsRender?.();
            return true;
          }
        }
      }
      if (key.name === "click" && key.mouse) {
        const { row } = key.mouse;
        const startRow = 12;
        if (row >= startRow && row < startRow + this.availableEfforts.length) {
          const chosenIdx = row - startRow;
          this.selectedEffort = this.availableEfforts[chosenIdx].id;
          this.isEffortModalOpen = false;
          const currentM = this.availableModels[this.selectedModelIndex];
          saveTuiSettings({
            chat: {
              model: currentM,
              effort: this.selectedEffort,
            },
          });
          this.statusNote = `Modelo: ${currentM} | Effort: ${this.availableEfforts[chosenIdx].label}`;
          this.onNeedsRender?.();
          return true;
        }
        this.isEffortModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
        this.effortSelectedIndex = Math.max(0, this.effortSelectedIndex - 1);
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
        this.effortSelectedIndex = Math.min(
          this.availableEfforts.length - 1,
          this.effortSelectedIndex + 1,
        );
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "return") {
        this.selectedEffort = this.availableEfforts[this.effortSelectedIndex].id;
        this.isEffortModalOpen = false;
        const currentM = this.availableModels[this.selectedModelIndex];
        saveTuiSettings({
          chat: {
            model: currentM,
            effort: this.selectedEffort,
            mode: this.selectedChatMode,
          },
        });
        this.statusNote = `Modelo: ${currentM} | Effort: ${this.availableEfforts[this.effortSelectedIndex].label}`;
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "escape") {
        this.isEffortModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      return true;
    }

    // 3. Chat Mode Selection Modal Active
    if (this.isModeModalOpen) {
      if (key.name === "hover" && key.mouse) {
        const { row } = key.mouse;
        const startRow = 12;
        if (row >= startRow && row < startRow + this.availableModes.length) {
          const hoverIdx = row - startRow;
          if (this.modeSelectedIndex !== hoverIdx) {
            this.modeSelectedIndex = hoverIdx;
            this.onNeedsRender?.();
            return true;
          }
        }
      }
      if (key.name === "click" && key.mouse) {
        const { row } = key.mouse;
        const startRow = 12;
        if (row >= startRow && row < startRow + this.availableModes.length) {
          const chosenIdx = row - startRow;
          this.selectedChatMode = this.availableModes[chosenIdx].id;
          this.isModeModalOpen = false;
          setRuntimeChatMode(this.selectedChatMode);
          saveTuiSettings({
            chat: {
              model: this.availableModels[this.selectedModelIndex],
              effort: this.selectedEffort,
              mode: this.selectedChatMode,
            },
          });
          this.statusNote = theme.green(`✓ Modo global da API alterado para: ${this.selectedChatMode}`);
          this.onNeedsRender?.();
          return true;
        }
        this.isModeModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
        this.modeSelectedIndex = Math.max(0, this.modeSelectedIndex - 1);
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
        this.modeSelectedIndex = Math.min(
          this.availableModes.length - 1,
          this.modeSelectedIndex + 1,
        );
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "return") {
        this.selectedChatMode = this.availableModes[this.modeSelectedIndex].id;
        this.isModeModalOpen = false;
        setRuntimeChatMode(this.selectedChatMode);
        saveTuiSettings({
          chat: {
            model: this.availableModels[this.selectedModelIndex],
            effort: this.selectedEffort,
            mode: this.selectedChatMode,
          },
        });
        this.statusNote = theme.green(`✓ Modo global da API alterado para: ${this.selectedChatMode}`);
        this.onNeedsRender?.();
        return true;
      }
      if (key.name === "escape") {
        this.isModeModalOpen = false;
        this.onNeedsRender?.();
        return true;
      }
      return true;
    }

    // 4. Header button hover (rows 4 to 6: Model, Effort, Mode)
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      if (row >= 4 && row <= 6 && !this.isModelModalOpen && !this.isEffortModalOpen && !this.isModeModalOpen) {
        let target: "model" | "effort" | "mode" | null = null;
        if (this.modelBtnStartCol > 0 && col >= this.modelBtnStartCol - 1 && col <= this.modelBtnEndCol + 1) {
          target = "model";
        } else if (this.effortBtnStartCol > 0 && col >= this.effortBtnStartCol - 1 && col <= this.effortBtnEndCol + 1) {
          target = "effort";
        } else if (this.modeBtnStartCol > 0 && col >= this.modeBtnStartCol - 1 && col <= this.modeBtnEndCol + 1) {
          target = "mode";
        }
        if (this.hoveredHeaderBtn !== target) {
          this.hoveredHeaderBtn = target;
          this.onNeedsRender?.();
          return true;
        }
      } else if (this.hoveredHeaderBtn !== null) {
        this.hoveredHeaderBtn = null;
        this.onNeedsRender?.();
        return true;
      }
    }

    // 5. Header button click (rows 4 to 6: Model, Effort, Mode)
    if (
      key.name === "click" &&
      key.mouse &&
      key.mouse.row >= 4 &&
      key.mouse.row <= 6 &&
      !this.isModelModalOpen &&
      !this.isEffortModalOpen &&
      !this.isModeModalOpen
    ) {
      const col = key.mouse.col;
      if (this.modelBtnStartCol > 0 && col >= this.modelBtnStartCol - 1 && col <= this.modelBtnEndCol + 1) {
        void this.refreshModels();
        this.isModelModalOpen = true;
        this.modalSelectedIndex = this.selectedModelIndex;
        this.hoveredHeaderBtn = null;
        this.onNeedsRender?.();
        return true;
      }
      if (this.effortBtnStartCol > 0 && col >= this.effortBtnStartCol - 1 && col <= this.effortBtnEndCol + 1) {
        this.isEffortModalOpen = true;
        const idx = this.availableEfforts.findIndex((e) => e.id === this.selectedEffort);
        this.effortSelectedIndex = idx !== -1 ? idx : 0;
        this.hoveredHeaderBtn = null;
        this.onNeedsRender?.();
        return true;
      }
      if (this.modeBtnStartCol > 0 && col >= this.modeBtnStartCol - 1 && col <= this.modeBtnEndCol + 1) {
        this.isModeModalOpen = true;
        const idx = this.availableModes.findIndex((m) => m.id === this.selectedChatMode);
        this.modeSelectedIndex = idx !== -1 ? idx : 0;
        this.hoveredHeaderBtn = null;
        this.onNeedsRender?.();
        return true;
      }
    }

    // Keyboard shortcuts to open modals
    if (
      key.name === "f2" ||
      (key.ctrl && key.name === "o") ||
      (key.meta && key.name === "m")
    ) {
      void this.refreshModels();
      this.isModelModalOpen = true;
      this.modalSelectedIndex = this.selectedModelIndex;
      this.onNeedsRender?.();
      return true;
    }

    if (key.name === "f3") {
      const currentM = this.availableModels[this.selectedModelIndex] || "qwen3.8-max";
      const info = classifyModel(currentM);
      if (info.supportsReasoning) {
        this.isEffortModalOpen = true;
        const idx = this.availableEfforts.findIndex((e) => e.id === this.selectedEffort);
        this.effortSelectedIndex = idx !== -1 ? idx : 0;
        this.onNeedsRender?.();
        return true;
      }
    }

    if (key.name === "f4") {
      this.isModeModalOpen = true;
      const idx = this.availableModes.findIndex((m) => m.id === this.selectedChatMode);
      this.modeSelectedIndex = idx !== -1 ? idx : 0;
      this.onNeedsRender?.();
      return true;
    }

    // 5. Scrollbar hover, click & drag
    const isMouseOnScrollbar = (col: number, row: number) => {
      return (
        col >= this.lastWidth - 2 &&
        col <= this.lastWidth &&
        row >= 8 &&
        row <= 7 + this.lastVisibleCapacity
      );
    };

    if (key.name === "hover" && key.mouse && !this.isModelModalOpen && !this.isEffortModalOpen) {
      const onScrollbar = isMouseOnScrollbar(key.mouse.col, key.mouse.row);
      if (this.isScrollbarHovered !== onScrollbar) {
        this.isScrollbarHovered = onScrollbar;
        this.onNeedsRender?.();
        return true;
      }
    }

    if (key.name === "click" && key.mouse && !this.isModelModalOpen && !this.isEffortModalOpen) {
      if (isMouseOnScrollbar(key.mouse.col, key.mouse.row)) {
        if (this.lastMaxOffset > 0 && this.lastVisibleCapacity > 0) {
          this.isDraggingScrollbar = true;
          const r = key.mouse.row - 8;
          const pct = Math.max(0, Math.min(1, r / Math.max(1, this.lastVisibleCapacity - 1)));
          const targetScrollFromTop = Math.round(pct * this.lastMaxOffset);
          this.scrollOffset = Math.max(0, Math.min(this.lastMaxOffset, this.lastMaxOffset - targetScrollFromTop));
          this.onNeedsRender?.();
          return true;
        }
      }
    }

    if (key.name === "drag" && key.mouse && !this.isModelModalOpen && !this.isEffortModalOpen) {
      if (this.isDraggingScrollbar && this.lastMaxOffset > 0 && this.lastVisibleCapacity > 0) {
        const r = key.mouse.row - 8;
        const pct = Math.max(0, Math.min(1, r / Math.max(1, this.lastVisibleCapacity - 1)));
        const targetScrollFromTop = Math.round(pct * this.lastMaxOffset);
        this.scrollOffset = Math.max(0, Math.min(this.lastMaxOffset, this.lastMaxOffset - targetScrollFromTop));
        this.onNeedsRender?.();
        return true;
      }
    }

    if (key.name === "release") {
      if (this.isDraggingScrollbar) {
        this.isDraggingScrollbar = false;
        this.onNeedsRender?.();
        return true;
      }
    }

    // 5. Chat history scrolling (Mouse wheel / PageUp / PageDown / Up / Down)
    if (key.name === "wheelup") {
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 2) : this.scrollOffset + 2;
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "wheeldown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 2);
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "pageup") {
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 6) : this.scrollOffset + 6;
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 6);
      this.onNeedsRender?.();
      return true;
    }
    if ((key.ctrl || key.shift) && key.name === "up") {
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 2) : this.scrollOffset + 2;
      this.onNeedsRender?.();
      return true;
    }
    if ((key.ctrl || key.shift) && key.name === "down") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 2);
      this.onNeedsRender?.();
      return true;
    }
    if (!this.isGenerating && this.inputBuffer.length === 0 && key.name === "up") {
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 1) : this.scrollOffset + 1;
      this.onNeedsRender?.();
      return true;
    }
    if (!this.isGenerating && this.inputBuffer.length === 0 && key.name === "down") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "home") {
      this.scrollOffset = this.lastMaxOffset;
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "end") {
      this.scrollOffset = 0;
      this.onNeedsRender?.();
      return true;
    }

    // 5. Cursor movement within input line using Left / Right
    if (key.name === "left") {
      this.cursorPos = Math.max(0, this.cursorPos - 1);
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "right") {
      this.cursorPos = Math.min(this.inputBuffer.length, this.cursorPos + 1);
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "home") {
      this.cursorPos = 0;
      this.onNeedsRender?.();
      return true;
    }
    if (key.name === "end") {
      this.cursorPos = this.inputBuffer.length;
      this.onNeedsRender?.();
      return true;
    }
    // 5. Paste from clipboard with Ctrl+V
    if (key.ctrl && (key.name === "v" || key.raw === "\x16")) {
      const { getClipboardText } = require("../theme.ts");
      const pasted = getClipboardText();
      if (pasted) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          pasted +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos += pasted.length;
        this.onNeedsRender?.();
        return true;
      }
    }

    // 6. Clear history with Ctrl+L
    if (key.ctrl && key.name === "l") {
      this.messages = [];
      this.statusNote = "Histórico do chat limpo.";
      this.onNeedsRender?.();
      return true;
    }

    // 6. Clear input line with single Ctrl+C (standard CLI behavior)
    if (key.ctrl && key.name === "c" && this.inputBuffer.length > 0) {
      this.inputBuffer = "";
      this.cursorPos = 0;
      this.onNeedsRender?.();
      return true;
    }

    // 7. Backspace at cursor
    if (key.name === "backspace") {
      if (this.cursorPos > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos - 1) +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos--;
        this.onNeedsRender?.();
      }
      return true;
    }

    // 7. Delete at cursor
    if (key.name === "delete") {
      if (this.cursorPos < this.inputBuffer.length) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          this.inputBuffer.slice(this.cursorPos + 1);
        this.onNeedsRender?.();
      }
      return true;
    }

    // 8. Submit message on Enter
    if (key.name === "return") {
      const text = this.inputBuffer.trim();
      if (!text || this.isGenerating) return true;

      // Block submitting if there are 0 accounts configured
      if (this.lastSnapshot && this.lastSnapshot.accounts.length === 0) {
        this.statusNote = theme.yellow("[!] Adicione uma conta na aba [5] Contas antes de iniciar o chat.");
        this.onNeedsRender?.();
        return true;
      }

      const serverState = ServerManager.getInstance().getState();
      if (serverState === "warming") {
        this.statusNote = theme.yellow("Aguarde: inicializando proxy...");
        this.onNeedsRender?.();
        return true;
      }
      if (serverState === "error") {
        this.statusNote = theme.red("Servidor com erro. Verifique a aba Logs.");
        this.onNeedsRender?.();
        return true;
      }
      this.inputBuffer = "";
      this.cursorPos = 0;
      this.scrollOffset = 0;
      this.sendMessage(text);
      return true;
    }

    // 9. Ignore Tab key (handled globally for tab switching)
    if (key.name === "tab") {
      return;
    }
    // 10. Character typing (insert at cursor position)
    if (key.char && !key.ctrl && !key.meta && key.name !== "tab") {
      if (key.char >= " ") {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          key.char +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos += key.char.length;
        this.onNeedsRender?.();
        return true;
      }
    }
  }

  private async sendMessage(userText: string): Promise<void> {
    const serverState = ServerManager.getInstance().getState();
    if (serverState === "warming") {
      this.statusNote = theme.yellow("Aguarde: inicializando proxy...");
      return;
    }

    const model = this.availableModels[this.selectedModelIndex] || "qwen3.8-max";

    this.messages.push({
      role: "user",
      content: userText,
    });
    const assistantMsgIndex = this.messages.length;
    this.messages.push({
      role: "assistant",
      content: "",
      reasoning: "",
      model,
    });
    this.isGenerating = true;
    this.spinnerIndex = 0;
    clearInterval(this.spinnerInterval!);
    this.spinnerInterval = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.scheduleRender();
    }, 100);
    this.statusNote = "";
    this.currentAbortController = new AbortController();
    this.flushRender();

    const conversationPayload = this.messages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const isReasoning = classifyModel(model).supportsReasoning;
      const result = await streamChatCompletions({
        model,
        reasoning_effort: isReasoning ? this.selectedEffort : undefined,
        chatMode: this.selectedChatMode,
        messages: conversationPayload,
        signal: this.currentAbortController.signal,
        onReasoning: (chunk) => {
          const current = this.messages[assistantMsgIndex];
          if (current) {
            current.reasoning = (current.reasoning || "") + chunk;
            this.scheduleRender();
          }
        },
        onToken: (chunk) => {
          const current = this.messages[assistantMsgIndex];
          if (current) {
            current.content += chunk;
            this.scheduleRender();
          }
        },
      });

      const current = this.messages[assistantMsgIndex];
      if (current) {
        current.ttfbMs = result.ttfbMs;
        current.totalTimeMs = result.totalTimeMs;
      }
      this.statusNote = theme.green(
        `✓ Resposta concluída em ${(result.totalTimeMs / 1000).toFixed(2)}s (TTFB: ${result.ttfbMs}ms)`,
      );
    } catch (err: any) {
      const current = this.messages[assistantMsgIndex];
      let rawMsg = err?.message || String(err);
      try {
        const jsonMatch = rawMsg.match(/\{.*"error"\s*:\s*\{.*\}\s*\}/s);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.error?.message) {
            rawMsg = parsed.error.message;
          }
        }
      } catch {}

      if (
        rawMsg.includes("Target page, context or browser has been closed") ||
        rawMsg.includes("browserType.launchPersistentContext")
      ) {
        rawMsg = "Falha ao iniciar o navegador da conta. Feche outras instâncias do QwenProxy ou do Chrome e execute 'qpx reset'.";
      }

      if (current) {
        current.content = `\n  ${theme.red("❌ " + rawMsg)}`;
      }
      this.statusNote = theme.red(`✗ ${rawMsg.slice(0, 80)}`);
    } finally {
      clearInterval(this.spinnerInterval!);
      this.spinnerInterval = null;
      this.isGenerating = false;
      this.currentAbortController = null;
      this.flushRender();
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    this.lastWidth = width;
    this.lastHeight = height;
    if (snapshot !== undefined) {
      this.lastSnapshot = snapshot ?? null;
    }
    const hasAccounts = !this.lastSnapshot || this.lastSnapshot.accounts.length > 0;
    const totalLines: string[] = [];

    // 1. Model Header with F2 Shortcut
    const currentModel = this.availableModels[this.selectedModelIndex] || "qwen3.8-max";
    const currentInfo = classifyModel(currentModel);
    const totalModels = this.availableModels.length;
    const isReasoning = currentInfo.supportsReasoning;

    const modelLabel = `[ ${currentModel} ]`;
    const styledModel = this.hoveredHeaderBtn === "model"
      ? theme.bgHover(` ${theme.bold(theme.white(modelLabel))} `)
      : theme.cyan(modelLabel);

    const effortLabel = isReasoning
      ? this.selectedEffort === "high"
        ? "[ Effort: High ]"
        : this.selectedEffort === "medium"
          ? "[ Effort: Med ]"
          : "[ Effort: Low ]"
      : "";

    let styledEffort = "";
    if (isReasoning) {
      styledEffort = this.hoveredHeaderBtn === "effort"
        ? theme.bgHover(` ${theme.bold(theme.white(effortLabel))} `)
        : this.selectedEffort === "high"
          ? theme.green(effortLabel)
          : this.selectedEffort === "medium"
            ? theme.yellow(effortLabel)
            : theme.cyan(effortLabel);
    }

    const modeLabel = `[ Modo: ${this.selectedChatMode} ]`;
    const styledMode = this.hoveredHeaderBtn === "mode"
      ? theme.bgHover(` ${theme.bold(theme.white(modeLabel))} `)
      : this.selectedChatMode === "thread"
        ? theme.cyan(modeLabel)
        : this.selectedChatMode === "thread-temp"
          ? theme.green(modeLabel)
          : this.selectedChatMode === "stateless-temp"
            ? theme.yellow(modeLabel)
            : theme.lavender(modeLabel);

    const shortcutsLabel = `[ F2: Modelo${isReasoning ? " | F3: Effort" : ""} | F4: Modo ]`;
    const styledShortcuts = theme.yellow(shortcutsLabel);

    // Non-text models show their category badge ([Imagem] / [Vídeo]), while text models omit [Texto]
    const nonTextBadge = !isReasoning && currentInfo.badge ? `${currentInfo.badge}  ` : "";
    const nonTextCategory = !isReasoning ? theme.muted(`• ${currentInfo.category}`) : "";

    const headerLine = hasAccounts
      ? `  ${theme.bold("Modelo:")} ${styledModel}  ${nonTextBadge}${isReasoning ? styledEffort + "  " : nonTextCategory + "  "}${styledMode}   ${styledShortcuts}`
      : `  ${theme.bold("Modelo:")} ${styledModel}   ${theme.yellow("[ [!] Sem Contas: Adicione em [5] Contas ]")}`;

    // Compute dynamic interactive column bounds:
    const modelStart = 1 + stringWidth("  Modelo: ") + 1; // col 12
    const modelEnd = modelStart + stringWidth(modelLabel) - 1;
    this.modelBtnStartCol = modelStart;
    this.modelBtnEndCol = modelEnd;

    let nextStart = modelEnd + 3;
    if (isReasoning) {
      const effortStart = nextStart;
      const effortEnd = effortStart + stringWidth(effortLabel) - 1;
      this.effortBtnStartCol = effortStart;
      this.effortBtnEndCol = effortEnd;
      nextStart = effortEnd + 3;
    } else {
      this.effortBtnStartCol = 0;
      this.effortBtnEndCol = 0;
      if (nonTextCategory) {
        nextStart = modelEnd + stringWidth(`  ${nonTextBadge}${nonTextCategory}  `);
      }
    }

    const modeStart = nextStart;
    const modeEnd = modeStart + stringWidth(modeLabel) - 1;
    this.modeBtnStartCol = modeStart;
    this.modeBtnEndCol = modeEnd;
    const headerBox = drawBox({
      title: "Chat Tester",
      width,
      height: 3,
      borderColor: theme.borderActive,
      titleColor: theme.blue,
      content: [headerLine],
    });
    totalLines.push(...headerBox);

    // 2. Main Middle Area: Either Vertical Model Modal OR Chat Conversation
    const chatHeight = Math.max(6, height - 6);
    const innerChatW = width - 4;

    if (this.isModelModalOpen) {
      const modalLines: string[] = [""];
      for (let i = 0; i < this.availableModels.length; i++) {
        const m = this.availableModels[i];
        const isSel = i === this.modalSelectedIndex;
        const pointer = isSel ? theme.cyan("▸ ") : "  ";
        const info = classifyModel(m);
        const line = `${pointer}${info.badge} ${pad(m, 20)} • ${info.category}`;
        modalLines.push(isSel ? theme.bgSelected(line) : line);
      }
      modalLines.push("");

      const modalBox = drawBox({
        title: "Selecionar Modelo [ Enter: Escolher  •  Esc: Fechar ]",
        width,
        height: chatHeight,
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalLines,
      });
      totalLines.push(...modalBox);
    } else if (this.isEffortModalOpen) {
      const modalLines: string[] = [
        "",
        `  ${theme.bold("Modelo:")} ${theme.cyan(currentModel)} (${currentInfo.category})`,
        `  ${theme.dim("Escolha o nível de esforço de raciocínio (reasoning_effort):")}`,
        "",
      ];
      for (let i = 0; i < this.availableEfforts.length; i++) {
        const eff = this.availableEfforts[i];
        const isSel = i === this.effortSelectedIndex;
        const isCurrent = eff.id === this.selectedEffort;
        const pointer = isSel ? theme.cyan("▸ ") : "  ";
        const radio = isCurrent ? theme.green(glyphs.radioOn) : theme.muted(glyphs.radioOff);
        const line = `${pointer}${radio} ${eff.badge} ${pad(eff.label, 18)} • ${eff.desc}`;
        modalLines.push(isSel ? theme.bgSelected(line) : line);
      }
      modalLines.push("");

      const modalBox = drawBox({
        title: "Nível de Raciocínio / Effort [ Enter: Confirmar  •  Esc: Manter ]",
        width,
        height: chatHeight,
        borderColor: theme.borderActive,
        titleColor: theme.yellow,
        content: modalLines,
      });
      totalLines.push(...modalBox);
    } else if (this.isModeModalOpen) {
      const modalLines: string[] = [
        "",
        `  ${theme.bold("Modo de Conversa:")} ${theme.cyan(this.selectedChatMode)}`,
        `  ${theme.dim("Escolha como o histórico é transmitido e persistido no Qwen:")}`,
        "",
      ];
      for (let i = 0; i < this.availableModes.length; i++) {
        const m = this.availableModes[i];
        const isSel = i === this.modeSelectedIndex;
        const isCurrent = m.id === this.selectedChatMode;
        const pointer = isSel ? theme.cyan("▸ ") : "  ";
        const radio = isCurrent ? theme.green(glyphs.radioOn) : theme.muted(glyphs.radioOff);
        const line = `${pointer}${radio} ${pad(m.badge, 17)} ${pad(m.label, 17)} • ${m.desc}`;
        modalLines.push(isSel ? theme.bgSelected(line) : line);
      }
      modalLines.push("");

      const modalBox = drawBox({
        title: "Selecionar Modo de Conversa [ Enter: Confirmar  •  Esc: Manter ]",
        width,
        height: chatHeight,
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalLines,
      });
      totalLines.push(...modalBox);
    } else {
      const chatContent: string[] = [];

      if (this.lastSnapshot && this.lastSnapshot.accounts.length === 0) {
        chatContent.push("");
        chatContent.push(`  ${theme.yellow("[!] Nenhuma conta Qwen configurada no servidor.")}`);
        chatContent.push(`  ${theme.muted("   Pressione ")}${theme.cyan("Tab")}${theme.muted(" para ir até ")}${theme.bold(theme.white("[5] Contas"))}${theme.muted(" e pressione ")}${theme.bold(theme.white("'A'"))}${theme.muted(" para adicionar seu e-mail e senha.")}`);
      } else if (this.messages.length === 0) {
        chatContent.push("");
        const serverState = ServerManager.getInstance().getState();
        if (serverState === "warming") {
          chatContent.push(theme.yellow("  [!] Inicializando proxy..."));
        } else {
          chatContent.push(theme.muted("  Digite sua mensagem..."));
        }
      }
      for (const msg of this.messages) {
        if (msg.role === "user") {
          chatContent.push("");
          const cardW = Math.max(20, innerChatW - 4);
          const userLines = wrapContentLine(msg.content, cardW - 4);

          // Top padding inside user card (gives height and breathability)
          chatContent.push(`  ${theme.cyan("▌")}${theme.bgUserCard(" ".repeat(cardW))}`);

          // Content lines with distinct lighter background
          for (const u of userLines) {
            chatContent.push(
              `  ${theme.cyan("▌")}${theme.bgUserCard("   " + pad(theme.bold(theme.white(u)), cardW - 3))}`,
            );
          }

          // Bottom padding inside user card
          chatContent.push(`  ${theme.cyan("▌")}${theme.bgUserCard(" ".repeat(cardW))}`);
          chatContent.push("");
        } else {
          const messageModel = msg.model || currentModel;

          // 1. OpenCode-style Thinking (Reasoning): Clean, indented, dimmed and unboxed
          if (msg.reasoning && msg.reasoning.trim().length > 0) {
            chatContent.push("");
            const isStillThinking = this.isGenerating && !msg.content && this.messages.indexOf(msg) === this.messages.length - 1;
            const spinner = this.spinnerFrames[this.spinnerIndex] || "⠋";

            if (isStillThinking) {
              chatContent.push(`    ${theme.yellow(`🧠 ${spinner} Raciocinando...`)}`);
            } else {
              chatContent.push(`    ${theme.yellow("🧠 Raciocínio:")}`);
            }

            const rLines = formatReasoning(msg.reasoning, innerChatW - 8);
            for (const r of rLines) {
              chatContent.push(`      ${r}`);
            }
            chatContent.push("");
          }

          // 2. Final Response - Bright, crisp, full rich Markdown!
          if (msg.content) {
            let contentLines: string[];
            if (msg.cachedWidth === innerChatW && msg.cachedContentLines) {
              contentLines = msg.cachedContentLines;
            } else {
              contentLines = formatMarkdown(msg.content, innerChatW - 6, { dim: false });
              if (!this.isGenerating) {
                msg.cachedContentLines = contentLines;
                msg.cachedWidth = innerChatW;
              }
            }
            for (const line of contentLines) {
              chatContent.push(`    ${line}`);
            }
          } else if (this.isGenerating && !msg.reasoning && this.messages.indexOf(msg) === this.messages.length - 1) {
            const spinner = this.spinnerFrames[this.spinnerIndex] || "⠋";
            chatContent.push(`    ${theme.yellow(`${spinner} Pensando...`)}`);
          }

          // 3. OpenCode-style execution badge with model and timing metadata
          const isDoneGenerating = !this.isGenerating || this.messages.indexOf(msg) !== this.messages.length - 1;
          if (isDoneGenerating && (msg.content || msg.reasoning)) {
            const timingStr = msg.totalTimeMs
              ? ` ${theme.dim("·")} ${theme.dim(`${(msg.totalTimeMs / 1000).toFixed(2)}s`)}${msg.ttfbMs ? ` ${theme.dim(`(TTFB ${msg.ttfbMs}ms)`)}` : ""}`
              : "";
            chatContent.push("");
            chatContent.push(
              `    ${theme.cyan("▣")} ${theme.bold("Qwen")} ${theme.dim("·")} ${theme.cyan(messageModel)}${timingStr}`,
            );
          }
          chatContent.push("");
        }
      }

    // Flatten and pre-wrap chatContent to innerChatW so every element maps strictly 1:1 to terminal rows
    const flatChatContent: string[] = [];
    for (const item of chatContent) {
      const sub = String(item ?? "").split(/\r?\n/);
      for (const s of sub) {
        if (stringWidth(s) <= innerChatW) {
          flatChatContent.push(s);
        } else {
          flatChatContent.push(...wrapContentLine(s, innerChatW));
        }
      }
    }

    // Auto-scroll window calculation supporting 1:1 smooth and precise history scrolling
    const visibleCapacity = Math.max(1, chatHeight - 2);
    const total = flatChatContent.length;
    const maxOffset = Math.max(0, total - visibleCapacity);
    this.lastMaxOffset = maxOffset;
    this.lastVisibleCapacity = visibleCapacity;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const clampedOffset = this.scrollOffset;
    const scrollFromTop = maxOffset - clampedOffset;

    const startIndex = Math.max(0, total - visibleCapacity - clampedOffset);
    const visibleChatLines = flatChatContent.slice(startIndex, startIndex + visibleCapacity);

    // Lateral scrollbar calculation
    const hasScrollbar = total > visibleCapacity;
    const thumbSize = hasScrollbar
      ? Math.max(1, Math.round((visibleCapacity / total) * visibleCapacity))
      : 0;
    const trackRange = Math.max(1, visibleCapacity - thumbSize);
    const thumbTop = hasScrollbar
      ? Math.min(
          visibleCapacity - thumbSize,
          Math.max(0, Math.round((scrollFromTop / maxOffset) * trackRange)),
        )
      : 0;

    const boxInnerW = Math.max(1, width - 2);
    const formattedChatRows: string[] = [];
    for (let r = 0; r < visibleCapacity; r++) {
      if (r < visibleChatLines.length) {
        const line = visibleChatLines[r];
        if (hasScrollbar) {
          const isThumb = r >= thumbTop && r < thumbTop + thumbSize;
          const isHighlighted = this.isScrollbarHovered || this.isDraggingScrollbar;
          let scrollChar: string;
          if (isThumb) {
            scrollChar = isHighlighted ? `\x1b[48;2;45;35;85m\x1b[38;2;0;255;255m\x1b[1m█\x1b[0m` : theme.cyan("█");
          } else {
            scrollChar = isHighlighted ? theme.cyan("│") : theme.dark("│");
          }
          const padded = pad(line, boxInnerW - 1);
          formattedChatRows.push(`${padded}${scrollChar}`);
        } else {
          formattedChatRows.push(line);
        }
      } else {
        formattedChatRows.push("");
      }
    }

    const historyBox = drawBox({
      title: `Conversa (${this.messages.length})`,
      width,
      height: chatHeight,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
      content: formattedChatRows,
    });
    totalLines.push(...historyBox);
  }

    // 3. Bottom Input Box
    const inputPrompt = "  ❯ ";
    const beforeCursor = this.inputBuffer.slice(0, this.cursorPos);
    const atCursor = this.inputBuffer[this.cursorPos] || " ";
    const afterCursor = this.inputBuffer.slice(this.cursorPos + 1);
    const styledCursor = this.isGenerating ? "" : theme.inverse(atCursor);
    const formattedInput = `${beforeCursor}${styledCursor}${afterCursor}`;
    const availableInputW = width - stringWidth(inputPrompt) - 4;
    const displayInput = truncate(formattedInput, availableInputW);
    const spinner = this.spinnerFrames[this.spinnerIndex] || "⠋";

    const inputContent = [`${theme.cyan(inputPrompt)}${displayInput}`];
    const actionLabel = !hasAccounts
      ? "[!] Nenhuma conta configurada — adicione uma conta na aba [5] Contas"
      : currentInfo.category === "Geração de Imagem"
        ? "Prompt da Imagem"
        : currentInfo.category === "Geração de Vídeo"
          ? "Prompt do Vídeo"
          : "Mensagem";

    const inputTitle = this.isGenerating
      ? `${spinner} Gerando... (Esc para cancelar)`
      : actionLabel;

    const defaultFooter = `${currentModel} · ${isReasoning ? `Effort: ${this.selectedEffort}` : currentInfo.category} · Modo: ${this.selectedChatMode}`;
    const inputFooter = this.statusNote
      ? stripAnsi(this.statusNote)
      : defaultFooter;

    const inputBox = drawBox({
      title: inputTitle,
      width,
      height: 3,
      borderColor: this.isGenerating ? theme.yellow : theme.borderActive,
      titleColor: this.isGenerating ? theme.yellow : theme.cyan,
      footer: inputFooter,
      content: inputContent,
    });
    totalLines.push(...inputBox);

    return totalLines;
  }
}
