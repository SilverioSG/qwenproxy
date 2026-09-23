/**
 * QwenProxy - Server Log Circular Buffer & Live SSE Broadcast
 * Captures server logs and streams them to connected TUI instances.
 */

import fs from "node:fs";
import { stripAnsi } from "../tui/theme.ts";
import { getServerLogFilePath, ensureDataDirs, isRunningUnderNodeTest } from "./paths.ts";

export interface ServerLogMessage {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

const MAX_LOG_HISTORY = 2000;
const logHistory: ServerLogMessage[] = [];
const subscribers = new Set<(entry: ServerLogMessage) => void>();
let consoleHooked = false;

function appendServerLogToFile(time: string, level: string, message: string): void {
  if (isRunningUnderNodeTest()) return;
  try {
    const filePath = getServerLogFilePath();
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > 20 * 1024 * 1024) { // Rotate at 20MB
        const oldPath = filePath + ".old";
        try {
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          fs.renameSync(filePath, oldPath);
        } catch {}
      }
    } else {
      ensureDataDirs();
    }
    const dateStr = new Date().toLocaleDateString("pt-BR");
    const line = `[${dateStr} ${time}] [${level}] ${message}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
  } catch {}
}

export function recordServerLog(level: "INFO" | "WARN" | "ERROR", text: string): void {
  if (!text) return;
  const clean = stripAnsi(text).trim();
  if (!clean) return;

  const time = new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const lines = clean.split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    // Filter out raw ASCII box frames and border rows
    if (/^[+\-=#]{5,}$/.test(line)) continue;
    if (/^\|\s*\|$/.test(line)) continue;
    if (line.startsWith("|") && line.endsWith("|")) continue;

    // Filter out box remnants
    if (
      line === "QwenProxy" ||
      line === "OpenAI & Anthropic Compatible API" ||
      /^Endpoint\s+http/i.test(line) ||
      /^Port\s+\d+/i.test(line) ||
      /^Accounts\s+\d+\/\d+/i.test(line) ||
      /^API Key\s+/i.test(line) ||
      /^Status\s+●/i.test(line)
    ) {
      continue;
    }

    // Clean redundant leading level tags (e.g. "WARN [Qwen]" -> "[Qwen]")
    // and normalize multi-space gaps after emojis
    line = line
      .replace(/^(?:\[?(?:INFO|WARN|WARNING|ERROR|ERR|DEBUG)\]?\s+)+/i, "")
      .replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]\uFE0F?)\s{2,}/gu, "$1 ");
    if (!line) continue;

    // Prevent identical duplicate logs within the same second window
    const isDuplicate = logHistory
      .slice(-10)
      .some((entry) => entry.time === time && entry.level === level && entry.message === line);
    if (isDuplicate) {
      continue;
    }

    const entry: ServerLogMessage = { time, level, message: line };
    logHistory.push(entry);
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.shift();
    }
    appendServerLogToFile(time, level, line);

    for (const sub of subscribers) {
      try {
        sub(entry);
      } catch {}
    }
  }
}

export function getServerLogHistory(): ServerLogMessage[] {
  return logHistory.slice();
}

export function subscribeServerLogStream(cb: (entry: ServerLogMessage) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function hookServerConsoleForLogging(): void {
  if (consoleHooked) return;
  consoleHooked = true;

  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: any[]) => {
    origLog(...args);
    recordServerLog("INFO", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  console.info = (...args: any[]) => {
    origInfo(...args);
    recordServerLog("INFO", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  console.warn = (...args: any[]) => {
    origWarn(...args);
    recordServerLog("WARN", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  console.error = (...args: any[]) => {
    origError(...args);
    recordServerLog("ERROR", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}
