import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { encrypt, isEncrypted } from "./crypto-utils.ts";

/**
 * Several suites exercise account rotation by deleting every row and restoring
 * it in a `finally`. Pointed at the real database that is one crashed test away
 * from wiping the operator's configured accounts — which is exactly how a whole
 * account set was lost once. Tests get their own file so the blast radius of a
 * failed restore is a throwaway directory.
 */
import {
  getDataDir,
  getDbDir,
  getDbPath,
  isRunningUnderNodeTest,
} from "./paths.ts";

const DATA_DIR = getDataDir();
const DB_DIR = getDbDir();
const DB_PATH = getDbPath();
const LEGACY_DB_PATH = path.join(DATA_DIR, "qwenproxy.db");
const LEGACY_DB_IN_DIR_PATH = path.join(DB_DIR, "qwenproxy.db");
const LEGACY_DB_WAL_PATH = `${LEGACY_DB_PATH}-wal`;
const LEGACY_DB_SHM_PATH = `${LEGACY_DB_PATH}-shm`;
const LEGACY_DB_IN_DIR_WAL_PATH = `${LEGACY_DB_IN_DIR_PATH}-wal`;
const LEGACY_DB_IN_DIR_SHM_PATH = `${LEGACY_DB_IN_DIR_PATH}-shm`;
const DB_WAL_PATH = `${DB_PATH}-wal`;
const DB_SHM_PATH = `${DB_PATH}-shm`;
const LEGACY_JSON_PATH = path.resolve("accounts.json");
const LEGACY_JSON_BAK_PATH = path.resolve("accounts.json.bak");
const DB_JSON_BAK_PATH = path.join(DB_DIR, "accounts.json.bak");

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  // Ensure data directory exists with proper permissions
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o755 });
    }
    const migrateLegacyDatabase = (
      legacyPath: string,
      legacyWalPath: string,
      legacyShmPath: string,
    ) => {
      if (fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
        fs.renameSync(legacyPath, DB_PATH);
        if (fs.existsSync(legacyWalPath) && !fs.existsSync(DB_WAL_PATH)) {
          fs.renameSync(legacyWalPath, DB_WAL_PATH);
        }
        if (fs.existsSync(legacyShmPath) && !fs.existsSync(DB_SHM_PATH)) {
          fs.renameSync(legacyShmPath, DB_SHM_PATH);
        }
        console.log(`📦 [Database] Migrated legacy database to ${DB_PATH}`);
      }
    };

    migrateLegacyDatabase(
      LEGACY_DB_PATH,
      LEGACY_DB_WAL_PATH,
      LEGACY_DB_SHM_PATH,
    );
    migrateLegacyDatabase(
      LEGACY_DB_IN_DIR_PATH,
      LEGACY_DB_IN_DIR_WAL_PATH,
      LEGACY_DB_IN_DIR_SHM_PATH,
    );
    if (
      fs.existsSync(LEGACY_JSON_BAK_PATH) &&
      !fs.existsSync(DB_JSON_BAK_PATH)
    ) {
      fs.renameSync(LEGACY_JSON_BAK_PATH, DB_JSON_BAK_PATH);
    }
    // Test write access
    const testFile = path.join(DB_DIR, ".write-test");
    fs.writeFileSync(testFile, "");
    fs.unlinkSync(testFile);
  } catch (err: any) {
    console.error(
      `❌ [Database] Cannot access database directory '${DB_DIR}':`,
      err.message,
    );
    console.error(
      "❌ [Database] Ensure the directory exists and has proper permissions",
    );
    console.error(
      "❌ [Database] In Docker, mount a volume: -v ./data:/app/data",
    );
    throw new Error(`Database directory not accessible: ${DB_DIR}`);
  }

  try {
    db = new Database(DB_PATH);
  } catch (err: any) {
    console.error(
      `❌ [Database] Failed to open database at '${DB_PATH}':`,
      err.message,
    );
    console.error("❌ [Database] Check file permissions and disk space");
    throw err;
  }

  // Enable WAL mode for better concurrent read performance (ideal for VPS)
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB cache
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  migrateFromJson(db);
  encryptPlaintextPasswords(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    -- Cooldown persistence columns (ignore if already exist)
    -- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
    -- so these are wrapped in try-catch at the application level.

    CREATE TABLE IF NOT EXISTS qwen_auth_sessions (
      account_id TEXT PRIMARY KEY,
      cookie TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      bx_v TEXT,
      bx_ua TEXT,
      bx_umidtoken TEXT,
      sec_ch_ua TEXT,
      sec_ch_ua_mobile TEXT,
      sec_ch_ua_platform TEXT,
      version TEXT,
      user_id TEXT,
      token_expires_at INTEGER,
      captured_at INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_qwen_auth_sessions_expires
      ON qwen_auth_sessions(token_expires_at);

    CREATE TABLE IF NOT EXISTS logical_thread_states (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      parent_id TEXT,
      instructions_sent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_thread_updated ON logical_thread_states(updated_at);

    CREATE TABLE IF NOT EXISTS personalization_cache (
      account_id TEXT PRIMARY KEY,
      instruction_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Cooldown persistence columns — wrapped in try-catch because
  // SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN.
  try {
    db.exec(
      `ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER DEFAULT 0;`,
    );
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN cooldown_reason TEXT;`);
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // qwen_auth_sessions columns migration
  const authSessionCols = [
    "sec_ch_ua TEXT",
    "sec_ch_ua_mobile TEXT",
    "sec_ch_ua_platform TEXT",
    "version TEXT",
    "captured_at INTEGER DEFAULT 0",
    // Modern auth: explicit refresh material (nullable → legacy rows keep
    // loading unchanged; the jar remains the Cookie transport either way).
    "refresh_token TEXT",
    "refresh_expires_at INTEGER",
  ];
  for (const col of authSessionCols) {
    try {
      db.exec(`ALTER TABLE qwen_auth_sessions ADD COLUMN ${col};`);
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err;
    }
  }
}

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("duplicate column name");
}

function encryptPlaintextPasswords(db: Database.Database): void {
  const rows = db.prepare("SELECT id, password FROM accounts").all() as Array<{
    id: string;
    password: string;
  }>;
  const update = db.prepare(
    "UPDATE accounts SET password = ?, updated_at = datetime('now') WHERE id = ?",
  );
  let migrated = 0;

  const migrate = db.transaction(() => {
    for (const row of rows) {
      if (row.password && !isEncrypted(row.password)) {
        update.run(encrypt(row.password), row.id);
        migrated++;
      }
    }
  });

  migrate();

  if (migrated > 0) {
    console.log(
      `[Database] Encrypted ${migrated} plaintext password(s) in database`,
    );
  }
}

/**
 * Auto-migrate existing accounts.json into SQLite on first run.
 * The legacy JSON file is moved to data/db/accounts.json.bak after successful migration.
 */
function migrateFromJson(db: Database.Database): void {
  const jsonPath = LEGACY_JSON_PATH;
  if (!fs.existsSync(jsonPath)) return;

  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const accounts = JSON.parse(raw) as Array<{
      id: string;
      email: string;
      password: string;
    }>;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      // Empty or invalid file — just rename it
      fs.renameSync(jsonPath, DB_JSON_BAK_PATH);
      return;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, email, password) VALUES (?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      for (const account of accounts) {
        if (
          account.id &&
          typeof account.email === "string" &&
          account.email.trim().length > 0
        ) {
          insert.run(account.id, account.email.trim(), account.password || "");
        }
      }
    });

    migrate();

    // Rename old file to .bak to avoid re-migration
    fs.renameSync(jsonPath, DB_JSON_BAK_PATH);
    console.log(
      `[Database] Migrated ${accounts.length} account(s) from accounts.json to SQLite`,
    );
  } catch (err: any) {
    console.error(
      "❌ [Database] Failed to migrate accounts.json:",
      err.message,
    );
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface PersistedAuthSession {
  accountId: string;
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  version?: string;
  userId?: string;
  tokenExpiresAt?: number;
  capturedAt: number;
  /**
   * Modern auth material. Null on legacy rows (pre-refresh era) — loaders
   * must treat absence as "unknown", never as "revoked".
   */
  refreshToken?: string | null;
  refreshExpiresAt?: number;
}

export function saveAuthSession(
  accountId: string,
  session: {
    cookie: string;
    userAgent: string;
    bxV?: string;
    bxUa?: string;
    bxUmidtoken?: string;
    secChUa?: string;
    secChUaMobile?: string;
    secChUaPlatform?: string;
    version?: string;
    userId?: string;
    tokenExpiresAt?: number;
    capturedAt?: number;
    refreshToken?: string | null;
    refreshExpiresAt?: number;
  },
): void {
  const database = getDatabase();
  // INSERT OR REPLACE would null out the refresh bookkeeping when callers
  // that only captured headers (no login/refresh context) persist. Preserve
  // the stored values unless the caller explicitly supplies new ones.
  // Explicit null clears the field (revocation evidence); undefined keeps it.
  let refreshToken: string | null = session.refreshToken ?? null;
  let refreshExpiresAt: number | null = session.refreshExpiresAt ?? null;
  if (session.refreshToken === undefined || session.refreshExpiresAt === undefined) {
    try {
      const prev = database
        .prepare(
          `SELECT refresh_token, refresh_expires_at
           FROM qwen_auth_sessions WHERE account_id = ?`,
        )
        .get(accountId) as
        | { refresh_token?: string | null; refresh_expires_at?: number | null }
        | undefined;
      if (session.refreshToken === undefined) {
        refreshToken = prev?.refresh_token ?? null;
      }
      if (session.refreshExpiresAt === undefined) {
        refreshExpiresAt = prev?.refresh_expires_at
          ? Number(prev.refresh_expires_at)
          : null;
      }
    } catch {
      // No previous row (or no DB): fall back to the supplied values.
    }
  }
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO qwen_auth_sessions (
      account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken,
      sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform, version,
      user_id, token_expires_at, captured_at, updated_at,
      refresh_token, refresh_expires_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, datetime('now'),
      ?, ?
    )
  `);
  stmt.run(
    accountId,
    session.cookie,
    session.userAgent,
    session.bxV || "2.5.37",
    session.bxUa || "",
    session.bxUmidtoken || "",
    session.secChUa || null,
    session.secChUaMobile || null,
    session.secChUaPlatform || null,
    session.version || null,
    session.userId || null,
    session.tokenExpiresAt || null,
    session.capturedAt ?? Date.now(),
    refreshToken,
    refreshExpiresAt,
  );
  try {
    const capturedAt = session.capturedAt ?? Date.now();
    void import("../services/session-tracer.ts")
      .then((m) =>
        m.traceSessionEvent(
          accountId,
          "DB_SESSION_WRITE",
          `captured_at=${capturedAt}`,
        ),
      )
      .catch(() => {});
  } catch {
    // Tracing must never break persistence.
  }
}

export function getValidAuthSession(
  accountId: string,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
): PersistedAuthSession | null {
  const database = getDatabase();
  const row = database
    .prepare(
      `SELECT account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken,
              sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform, version,
              user_id, token_expires_at, captured_at,
              refresh_token, refresh_expires_at
       FROM qwen_auth_sessions WHERE account_id = ?`,
    )
    .get(accountId) as any;

  if (!row) {
    try {
      void import("../services/session-tracer.ts").then((m) =>
        m.traceSessionEvent(accountId, "DB_SESSION_READ", "miss"),
      ).catch(() => {});
    } catch {}
    return null;
  }

  const capturedAt = Number(row.captured_at) || 0;
  if (capturedAt <= 0 || Date.now() - capturedAt > maxAgeMs) {
    return null;
  }

  if (row.token_expires_at) {
    const tokenExpMs = Number(row.token_expires_at) * 1000;
    // Safety margin of 5 minutes before token expires
    if (tokenExpMs <= Date.now() + 5 * 60 * 1000) {
      return null;
    }
  }

  // Ensure critical fields are non-empty
  if (!row.cookie || !row.user_agent || !row.bx_v || !row.bx_ua || !row.bx_umidtoken) {
    return null;
  }

  try {
    void import("../services/session-tracer.ts").then((m) =>
      m.traceSessionEvent(accountId, "DB_SESSION_READ", `hit age=${Date.now() - capturedAt}`),
    ).catch(() => {});
  } catch {}
  return {
    accountId: row.account_id,
    cookie: row.cookie,
    userAgent: row.user_agent,
    bxV: row.bx_v,
    bxUa: row.bx_ua,
    bxUmidtoken: row.bx_umidtoken,
    secChUa: row.sec_ch_ua || undefined,
    secChUaMobile: row.sec_ch_ua_mobile || undefined,
    secChUaPlatform: row.sec_ch_ua_platform || undefined,
    version: row.version || undefined,
    userId: row.user_id || undefined,
    tokenExpiresAt: row.token_expires_at ? Number(row.token_expires_at) : undefined,
    capturedAt,
    refreshToken: row.refresh_token ? String(row.refresh_token) : null,
    refreshExpiresAt: row.refresh_expires_at
      ? Number(row.refresh_expires_at)
      : undefined,
  };
}

/**
 * The persisted account auth token ONLY, for use as an `Authorization: Bearer`.
 *
 * Deliberately separate from `getValidAuthSession`, which additionally requires
 * `bx_ua` / `bx_umidtoken` to be non-empty. Those are anti-bot fields the direct
 * transport does not send, so requiring them here would discard sessions whose
 * token is perfectly valid. This reader checks only what actually matters for a
 * Bearer: a stored token, a recorded capture time, and not being expired.
 *
 * Returns metadata about the token, never the token itself, to keep the DB read
 * side-effect free for logging.
 */
export interface PersistedBearerToken {
  token: string;
  tokenExpiresAt?: number;
  capturedAt: number;
}

export function getPersistedBearerToken(
  accountId: string,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
): PersistedBearerToken | null {
  let database: ReturnType<typeof getDatabase>;
  try {
    database = getDatabase();
  } catch {
    // No DB (e.g. a harness): the caller falls back to the live browser state.
    return null;
  }
  const row = database
    .prepare(
      `SELECT cookie, token_expires_at, captured_at
       FROM qwen_auth_sessions WHERE account_id = ?`,
    )
    .get(accountId) as any;
  if (!row || typeof row.cookie !== "string" || !row.cookie) return null;

  const capturedAt = Number(row.captured_at) || 0;
  if (capturedAt <= 0 || Date.now() - capturedAt > maxAgeMs) return null;
  if (row.token_expires_at) {
    const expMs = Number(row.token_expires_at) * 1000;
    // Same 5 minute safety margin as getValidAuthSession.
    if (expMs <= Date.now() + 5 * 60 * 1000) return null;
  }

  // The account credential lives in the `token` cookie of the persisted jar.
  const match = String(row.cookie)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("token="));
  if (!match) return null;
  const token = match.slice(6);
  if (!token) return null;

  return {
    token,
    tokenExpiresAt: row.token_expires_at ? Number(row.token_expires_at) : undefined,
    capturedAt,
  };
}

export function deleteAuthSession(accountId: string): void {
  const database = getDatabase();
  database.prepare("DELETE FROM qwen_auth_sessions WHERE account_id = ?").run(accountId);
}

/**
 * Modern-auth read path for the no-browser refresh.
 *
 * Unlike `getValidAuthSession` (which requires a live access token plus the
 * anti-bot fields for browser transport), this returns the row even when the
 * access token is expired — expiry is exactly what the refresh heals. Only
 * the row age (refresh lifetime, default 30d) and the presence of a jar gate.
 * Returns the stored refresh bookkeeping plus the jar-derived fallback, so
 * legacy rows (refresh_token only inside the jar) work unchanged.
 */
export interface RefreshMaterial {
  accountId: string;
  /** Full persisted `Cookie:` jar. NEVER logged. */
  jar: string;
  /** Stored refresh bookkeeping, or the jar's refresh_token pair. NEVER logged. */
  refreshToken: string | null;
  /** Access-token exp (unix seconds), when recorded. */
  tokenExpiresAtSec: number | null;
  userAgent: string;
}

export function getRefreshMaterial(
  accountId: string,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
): RefreshMaterial | null {
  let database: ReturnType<typeof getDatabase>;
  try {
    database = getDatabase();
  } catch {
    return null;
  }
  const row = database
    .prepare(
      `SELECT account_id, cookie, user_agent, token_expires_at, captured_at,
              refresh_token, refresh_expires_at
       FROM qwen_auth_sessions WHERE account_id = ?`,
    )
    .get(accountId) as any;
  if (!row || typeof row.cookie !== "string" || !row.cookie) return null;

  const capturedAt = Number(row.captured_at) || 0;
  if (capturedAt <= 0 || Date.now() - capturedAt > maxAgeMs) return null;

  const jarRefresh = String(row.cookie)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("refresh_token="));
  const jarRefreshValue = jarRefresh ? jarRefresh.slice(14).trim() : "";
  const stored = typeof row.refresh_token === "string" ? row.refresh_token : "";
  return {
    accountId: row.account_id,
    jar: String(row.cookie),
    refreshToken: stored || jarRefreshValue || null,
    tokenExpiresAtSec: row.token_expires_at
      ? Number(row.token_expires_at)
      : null,
    userAgent: typeof row.user_agent === "string" ? row.user_agent : "",
  };
}

/**
 * Persist a successful no-browser refresh. Atomic read-modify-write:
 * - jar (with the new token pair, rotation and Set-Cookie already folded in)
 *   always replaces the stored jar;
 * - refresh bookkeeping is replaced only when the caller supplies it
 *   (rotation); otherwise the stored value is kept verbatim;
 * - access expiry is replaced only when the caller supplies it (JWT exp of
 *   the new token); anti-bot/user-agent fields are preserved as-is.
 * Never wipes material on failure — this runs only after a successful
 * refresh.
 */
export function saveRefreshedSession(
  accountId: string,
  refreshed: {
    cookie: string;
    refreshToken?: string | null;
    tokenExpiresAt?: number;
  },
): void {
  const database = getDatabase();
  const write = database.transaction(() => {
    const prev = database
      .prepare(
        `SELECT user_agent, bx_v, bx_ua, bx_umidtoken,
                sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform, version,
                user_id, token_expires_at, refresh_token, refresh_expires_at
         FROM qwen_auth_sessions WHERE account_id = ?`,
      )
      .get(accountId) as any;
    const nextRefreshToken =
      refreshed.refreshToken !== undefined
        ? refreshed.refreshToken
        : (prev?.refresh_token ?? null);
    const nextExpiresAt =
      refreshed.tokenExpiresAt !== undefined
        ? refreshed.tokenExpiresAt
        : (prev?.token_expires_at ?? null);
    database
      .prepare(
        `INSERT OR REPLACE INTO qwen_auth_sessions (
           account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken,
           sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform, version,
           user_id, token_expires_at, captured_at, updated_at,
           refresh_token, refresh_expires_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, datetime('now'),
           ?, ?
         )`,
      )
      .run(
        accountId,
        refreshed.cookie,
        prev?.user_agent ?? "",
        prev?.bx_v ?? "2.5.37",
        prev?.bx_ua ?? "",
        prev?.bx_umidtoken ?? "",
        prev?.sec_ch_ua ?? null,
        prev?.sec_ch_ua_mobile ?? null,
        prev?.sec_ch_ua_platform ?? null,
        prev?.version ?? null,
        prev?.user_id ?? null,
        nextExpiresAt,
        Date.now(),
        nextRefreshToken,
        prev?.refresh_expires_at ?? null,
      );
  });
  write();
}
