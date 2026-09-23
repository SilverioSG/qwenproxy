import test from "node:test";
import assert from "node:assert";
import { LogsView } from "../tui/views/logs-view.ts";
import { ServerManager } from "../tui/server-manager.ts";
import { getServerLogFilePath } from "../core/paths.ts";
import { getClipboardText } from "../tui/theme.ts";

test("TUI LogsView: copyLogs(false) copies all logs even when a line is selected", async () => {
  const sm = ServerManager.getInstance();
  sm.clearLogs();

  (sm as any).logEntries = [
    { time: "10:00:00", level: "INFO", message: "First message" },
    { time: "10:00:01", level: "WARN", message: "Second warning" },
    { time: "10:00:02", level: "ERROR", message: "Third error" },
  ];

  const view = new LogsView();
  (view as any).selectedLogIndex = 1;

  (view as any).copyLogs(false);

  const copied = getClipboardText();
  assert.ok(copied.includes("First message"), "Must include first message");
  assert.ok(copied.includes("Second warning"), "Must include second warning");
  assert.ok(copied.includes("Third error"), "Must include third error");
});

test("TUI LogsView: copyLogs(true) copies only the single selected line", async () => {
  const sm = ServerManager.getInstance();
  sm.clearLogs();

  (sm as any).logEntries = [
    { time: "10:00:00", level: "INFO", message: "First message" },
    { time: "10:00:01", level: "WARN", message: "Second warning" },
  ];

  const view = new LogsView();
  (view as any).selectedLogIndex = 1;

  (view as any).copyLogs(true);

  const copied = getClipboardText();
  assert.ok(!copied.includes("First message"), "Must NOT include first message");
  assert.ok(copied.includes("Second warning"), "Must include selected message only");
});

test("Paths: getServerLogFilePath returns path in data/logs directory", () => {
  const logPath = getServerLogFilePath();
  assert.ok(logPath.endsWith("server.log"));
  assert.ok(logPath.includes("logs"));
});

test("ServerLogBuffer: prevents duplicate logs when called consecutively in the same second", async () => {
  const { recordServerLog, getServerLogHistory } = await import("../core/server-log-buffer.ts");
  const startLen = getServerLogHistory().length;
  recordServerLog("INFO", "De-dup test message unique 12345");
  recordServerLog("INFO", "De-dup test message unique 12345");
  const history = getServerLogHistory().slice(startLen);
  const matching = history.filter((h) => h.message === "De-dup test message unique 12345");
  assert.equal(matching.length, 1, "Must only record duplicate message once");
});

test("ServerManager + hookServerConsoleForLogging: logs are never duplicated in log history", async () => {
  const { recordServerLog, getServerLogHistory, hookServerConsoleForLogging } = await import("../core/server-log-buffer.ts");
  const sm = ServerManager.getInstance();
  sm.interceptLogs();
  hookServerConsoleForLogging();

  const startLen = getServerLogHistory().length;
  console.log("No duplicate logging test 98765");
  sm.restoreLogs();

  const history = getServerLogHistory().slice(startLen);
  const matching = history.filter((h) => h.message === "No duplicate logging test 98765");
  assert.equal(matching.length, 1, "Must record console.log exactly once across TUI and server buffer");
});
