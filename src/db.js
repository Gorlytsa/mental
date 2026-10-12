// Turso (libSQL) database client wrapper.
// Reads credentials from environment variables:
//   MENTAL_TURSO_DATABASE_URL  - libsql:// URL of the database
//   MENTAL_TURSO_AUTH_TOKEN    - JWT auth token for the database.
//
// IMPORTANT — why there is NO local fallback anymore:
// A previous version silently fell back to a local ./local.db whenever Turso
// rejected the credentials. On Vercel serverless filesystems are ephemeral and
// read-only-ish, so every request created an empty local DB, migrations never
// touched Turso ("no tables in Turso"), and the app appeared to work locally
// while production was broken. Now we connect ONLY to Turso and fail loudly
// with actionable diagnostics instead of masking the problem.
//
// A real Turso auth token is an ES256 JWT: three dot-separated base64url
// segments. A placeholder/corrupted token (e.g. "dummytoken") makes the Turso
// HTTP API reject EVERY statement with "HTTP status 400" before it is even
// parsed — which is exactly why migrations failed and no tables were created.
const { createClient } = require('@libsql/client');

const rawUrl = process.env.MENTAL_TURSO_DATABASE_URL || '';
const rawToken = process.env.MENTAL_TURSO_AUTH_TOKEN || '';

// Normalize values: Vercel env vars sometimes carry stray whitespace or quotes
// copy-pasted from the dashboard — both break the Turso handshake.
const url = rawUrl.trim().replace(/^["']|["']$/g, '');
const authToken = rawToken.trim().replace(/^["']|["']$/g, '');

if (!url) {
  console.error('FATAL: MENTAL_TURSO_DATABASE_URL is not set.');
  console.error('Add it in Vercel: Settings -> Environment Variables (and make sure the');
  console.error('Turso Vercel integration actually populates this variable for Production).');
  process.exit(1);
}

/**
 * Validate that the token looks like a genuine Turso JWT (header.payload.signature).
 * Returns null when valid, otherwise a human-readable problem description.
 */
function validateToken(tok) {
  if (!tok) return 'MENTAL_TURSO_AUTH_TOKEN не задан (пустая переменная окружения).';
  const parts = tok.split('.');
  if (parts.length !== 3) {
    return `MENTAL_TURSO_AUTH_TOKEN не является JWT (сегментов: ${parts.length}, ожидается 3). ` +
      'В переменной окружения лежит значение-заглушка вместо реального токена Turso.';
  }
  try {
    const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!hdr.alg) return 'JWT без поля alg';
  } catch (e) {
    return 'Первая часть MENTAL_TURSO_AUTH_TOKEN не декодируется как JWT header (битый base64 или подставное значение).';
  }
  return null;
}

const tokenProblem = validateToken(authToken);
if (tokenProblem) {
  console.error('CRITICAL: ' + tokenProblem);
  console.error('Every query to Turso will fail (HTTP 400) until this is fixed.');
  console.error('Fix: run `turso db tokens create <db-name>` (or use the Turso dashboard:');
  console.error('Database -> Show API parameters -> Auth token), then update the');
  console.error('MENTAL_TURSO_AUTH_TOKEN env var in Vercel and REDEPLOY.');
}

// NOTE: pass the token only when non-empty — an empty-string authToken makes
// @libsql/client send a malformed Authorization header (also HTTP 400).
const client = createClient({ url, authToken: authToken || undefined });

const usingLocalFallback = false; // legacy flag kept for the health endpoint
let lastConnectError = null;

/** Always the Turso client. No silent fallback — errors must surface. */
async function activeClient() {
  return client;
}

/** Execute a single statement, return raw result. Records the last error for /api/health. */
async function run(sql, args = []) {
  const c = await activeClient();
  try {
    const r = await c.execute({ sql, args });
    lastConnectError = null;
    return r;
  } catch (e) {
    lastConnectError = String((e && e.message) || e);
    throw e;
  }
}

/** Return all rows of a query */
async function all(sql, args = []) {
  const c = await activeClient();
  try {
    const res = await c.execute({ sql, args });
    lastConnectError = null;
    return res.rows;
  } catch (e) {
    lastConnectError = String((e && e.message) || e);
    throw e;
  }
}

/** Return the first row or null */
async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

/**
 * Schema DDL — one statement per entry, executed individually.
 * NOTE: multi-line CREATE TABLE strings are kept without inline "-- comments"
 * after column definitions: some libSQL remote proxies mis-parse trailing
 * comments inside DDL batches. Indexes and triggers use single-line SQL only.
 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    telegram TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Every user is also a contact in their own list ("self" contact).
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    self INTEGER NOT NULL DEFAULT 0,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    telegram TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)`,
  // Role pairs are symmetric or asymmetric; the opposite role is derived automatically.
  `CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    opposite_name TEXT NOT NULL,
    symmetric INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    contact1_id INTEGER NOT NULL REFERENCES contacts(id),
    role1_id INTEGER NOT NULL REFERENCES roles(id),
    contact2_id INTEGER NOT NULL REFERENCES contacts(id),
    role2_id INTEGER NOT NULL REFERENCES roles(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (contact1_id, contact2_id, role1_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conn_user ON connections(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_c1 ON connections(contact1_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_c2 ON connections(contact2_id)`,
  // Raw notes. contact_id NULL => added from the main page (general note).
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    author_contact_id INTEGER REFERENCES contacts(id),
    contact_id INTEGER REFERENCES contacts(id),
    text TEXT NOT NULL,
    file_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id)`,
];

// The 7 relationship roles (pairs from CONCEPT.md). Fixed ids 1..7.
const ROLE_SEED = [
  [1, 'Друг', 'Друг', 1],
  [2, 'Приятель', 'Приятель', 1],
  [3, 'Знакомый', 'Знакомый', 1],
  [4, 'Коллега', 'Коллега', 1],
  [5, 'Руководитель', 'Подчиненный', 0],
  [6, 'Супруг', 'Супруга', 0],
  [7, 'Учитель', 'Ученик', 0],
];

/** Create schema on a given client (idempotent). Safe for Turso HTTP mode. */
async function migrateRaw(c) {
  for (const sql of SCHEMA_STATEMENTS) {
    await c.execute({ sql, args: [] });
  }
  // Seed roles with plain INSERT OR IGNORE (max compatibility with remote
  // libSQL servers; avoids relying on upsert syntax support). Then repair
  // names if the row already existed but drifted (only when different).
  for (const [id, name, opposite, sym] of ROLE_SEED) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO roles (id, name, opposite_name, symmetric) VALUES (?, ?, ?, ?)',
      args: [id, name, opposite, sym],
    });
    await c.execute({
      sql: 'UPDATE roles SET name = ?, opposite_name = ?, symmetric = ? WHERE id = ? AND (name != ? OR opposite_name != ? OR symmetric != ?)',
      args: [name, opposite, sym, id, name, opposite, sym],
    });
  }
}

/** Create schema on the active client. Called once at startup. */
async function migrate() {
  const c = await activeClient();
  await migrateRaw(c);
}

module.exports = {
  client,
  run,
  all,
  get,
  migrate,
  isLocalFallback: () => usingLocalFallback,
  tokenLooksValid: () => !validateToken(authToken),
  tokenProblem: () => validateToken(authToken),
  lastConnectError: () => lastConnectError,
};
