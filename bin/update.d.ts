export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function detectPackageManager(): PackageManager;
export function getUpdateArgs(
  pm: PackageManager,
  packageName: string,
  targetVersion?: string,
): { cmd: string; args: string[] };
export function isNewerVersion(current: string, latest: string): boolean;
export function fetchLatestNpmVersion(packageName: string): Promise<string>;
export function runUpdateCommand(): Promise<void>;
