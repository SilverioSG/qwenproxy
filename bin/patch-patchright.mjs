#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, realpathSync, existsSync, openSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Focused backport of Patchright PR #247 (86be858e9c): dispatch paused
// responses through the existing network manager instead of retaining one
// CDP listener and RouteImpl instance for every request on a long-lived page.
export const networkPatchSegments = [
  {
    from: `        if (this._alreadyTrackedNetworkIds.has(event.networkId)) return;`,
    to: `        if (this._alreadyTrackedNetworkIds.has(event.networkId))
          return this._requestIdToRequest.get(event.networkId)?._originalRequestRoute?._networkRequestIntercepted(event);`,
  },
  {
    from: `        eventsHelper.addEventListener(
          this._session,
          "Fetch.requestPaused",
          async (e) => await this._networkRequestIntercepted(e)
        );`,
    to: `        // QwenProxy: paused responses are dispatched by CRNetworkManager (upstream #247).`,
  },
];

export function patchDependencySource(source, version) {
  let patched = patchContextSource(source, version);
  for (const { from, to } of networkPatchSegments) {
    const before = patched.split(from).length - 1;
    const after = patched.split(to).length - 1;
    if (before === 1 && after === 0) patched = patched.replace(from, to);
    else if (before !== 0 || after !== 1) throw new Error("Unexpected Patchright network dispatch source");
  }
  return patched;
}

export function installContextPatch(packagePath = require.resolve("patchright-core/package.json")) {
  const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
  const bundlePath = join(dirname(packagePath), "lib", "coreBundle.js");
  const original = readFileSync(bundlePath, "utf8");
  const patched = patchDependencySource(original, version);
  if (patched === original) return false;
  const temporaryPath = `${bundlePath}.qwenproxy-${process.pid}.tmp`;
  let created = false;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", statSync(bundlePath).mode & 0o777);
    created = true;
    writeFileSync(descriptor, patched);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, bundlePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { if (created) unlinkSync(temporaryPath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return true;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = installContextPatch();
  console.log(`[Patchright] Context and request-listener fixes ${changed ? "installed" : "already installed"}`);
}
