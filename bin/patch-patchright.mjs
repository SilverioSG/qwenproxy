#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const supportedVersion = "1.63.0";
const prefix = `      async _context(world) {
        if (this._isDetached()) throw new Error("Frame was detached");
        let client;
        try {
          client = this._page.delegate._sessionForFrame(this)._client;
        } catch (e) {
          client = this._page.delegate._mainFrameSession._client;
        }
`;

// Match CRSession.send's terminal check, before _sendMayFail can swallow it.
// A crashed page need not be detached. Recursing on undefined in that state
// grows pending promises indefinitely and prevents timers/cleanup from running.
export const terminalSessionGuard = `        // QwenProxy: stop context recursion on a terminal CDP session.
        if (client._crashed || client._closed || client._connection._closed || client._connection._browserDisconnectedLogs)
          throw new ProtocolError(client._crashed ? "crashed" : "closed", void 0, client._connection._browserDisconnectedLogs);
`;

export function patchContextSource(source, version) {
  if (version !== supportedVersion) {
    throw new Error(`Review the context recovery patch for patchright-core ${version}; expected ${supportedVersion}`);
  }
  const guardedPrefix = prefix + terminalSessionGuard;
  const occurrences = source.split(prefix).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one Patchright Frame._context entry, found ${occurrences}`);
  }
  if (source.includes(guardedPrefix)) return source;
  if (source.includes(terminalSessionGuard)) {
    throw new Error("Unexpected Patchright context guard placement");
  }
  return source.replace(prefix, guardedPrefix);
}

export function installContextPatch(packagePath = require.resolve("patchright-core/package.json")) {
  const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
  const bundlePath = join(dirname(packagePath), "lib", "coreBundle.js");
  const original = readFileSync(bundlePath, "utf8");
  const patched = patchContextSource(original, version);
  if (patched === original) return false;
  const temporaryPath = `${bundlePath}.qwenproxy-${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, patched, { flag: "wx", mode: statSync(bundlePath).mode & 0o777 });
    renameSync(temporaryPath, bundlePath);
  } finally {
    try { unlinkSync(temporaryPath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return true;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const changed = installContextPatch();
  console.log(`[Patchright] Terminal session context guard ${changed ? "installed" : "already installed"}`);
}
