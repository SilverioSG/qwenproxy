export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export {
  detectPackageManager,
  getUpdateArgs,
  isNewerVersion,
  fetchLatestNpmVersion,
  runUpdateCommand,
} from "../bin/update.js";

import { runUpdateCommand } from "../bin/update.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isDirectRun =
  Boolean(process.argv[1]) &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith("update-cli.ts") ||
    process.argv[1].endsWith("update-cli.js"));

if (isDirectRun) {
  void runUpdateCommand();
}
