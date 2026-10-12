// Turso (libSQL) database client wrapper.
//
// Credentials are resolved from environment variables by NAME PATTERN, not by
// one exact name, because the Vercel <-> Turso integration prefixes variables
// with the project/database name (e.g. TURSO_DATABASE_URL / TURSO_AUTH_TOKEN or
// MENTAL_TURSO_*). We accept any variable matching *TURSO*DATABASE_URL /
// *TURSO*AUTH_TOKEN, preferring exact canonical names first, then prefixed
// variants. This way manually-created unprefixed vars AND integration-provided
// prefixed vars both work without code changes.
//
// IMPORTANT — why there is NO local fallback anymore:
// A previous version silently fell back to a local ./local.db whenever Turso
// rejected the credentials. On Vercel serverless filesystems are ephemeral, so
// every request created an empty local DB, migrations never touched Turso
// ("no tables in Turso"), and the app appeared to work locally while
// production was broken. Now we connect ONLY to Turso and fail loudly with
// actionable diagnostics instead of masking the problem.
//
// A real Turso auth token is an ES256 JWT: three dot-separated base64url
// segments. A placeholder/corrupted token (e.g. "dummytoken") makes the Turso
// HTTP API reject EVERY statement with "HTTP status 400" before it is even
// parsed — which is exactly why migrations failed and no tables were created.
const { createClient } = require('@libsql/client');

const clean = (s) => String(s).trim().replace(/^["']|["']$/g, '');

/**
 * Collect all env vars whose name matches a pattern (case-insensitive),
 * returning [{name, value}] sorted so that shorter names win
 * (canonical unprefixed names take priority over prefixed ones).
 */
function collectEnv(pattern) {
  const re = new RegExp(pattern, 'i');
  return Object.entries(process.env)
    .filter(([k, v]) => re.test(k) && v && clean(v))
    .map(([name, value]) => ({ name, value: clean(value) }))
    .sort((a, b) => a.name.length - b.name.length);
}

const urlCandidates = collectEnv('TURSO.*DATABASE_URL|TURSO_DB_URL|DATABASE_URL.*TURSO');
const tokenCandidates = collectEnv('TURSO.*AUTH_TOKEN|TURSO.*TOKEN|AUTH_TOKEN.*TURSO');

// A USABLE Turso auth token must be an ES256 JWT: exactly three dot-separated
// segments and a reasonable length. Anything else ("dummytoken", empty strings,
// truncated pastes) is a broken/placeholder value that the Turso server rejects
// with "JWT error: InvalidToken" — such values are SKIPPED entirely so they can
// never shadow a good token stored in another env var (e.g. a manually created
// unprefixed TURSO_AUTH_TOKEN next to an integration-provided prefixed one).
function looksLikeTursoJwt(v) {
  if (!v) return false;
  const parts = v.split('.');
  return parts.length === 3 && v.length > 80 && /^eyJ/.test(parts[0]);
}
const usableTokens = tokenCandidates.filter((c) => looksLikeTursoJwt(c.value));

const urlSource = urlCandidates[0] || null;
// Prefer variables whose NAME says AUTH_TOKEN (shortest name wins), but only
// among tokens that actually look valid; fall back to any candidate for
// diagnostics purposes.
const byAuthName = usableTokens.filter((c) => /AUTH_TOKEN/i.test(c.name));
const tokenSource = byAuthName[0] || usableTokens[0] || tokenCandidates[0] || null;

const rawUrl = urlSource ? urlSource.value : '';
const rawToken = tokenSource ? tokenSource.value : '';

const envNamesFound = {
  url: urlCandidates.map((c) => c.name),
  token: tokenCandidates.map((c) => c.name),
  // Token variables whose VALUE is a syntactically valid Turso JWT. If this
  // list is empty while `token` is not — every token var in the environment
  // contains a broken/placeholder value (the classic "dummytoken" case).
  usableToken: usableTokens.map((c) => c.name),
};

// Normalize values: Vercel env vars sometimes carry stray whitespace or quotes
// copy-pasted from the dashboard — both break the Turso handshake.
const url = rawUrl.trim().replace(/^["']|["']$/g, '');
const authToken = rawToken.trim().replace(/^["']|["']$/g, '');

if (!url) {
  console.error('FATAL: No Turso database URL found in the environment.');
  console.error('Looked for env vars matching *TURSO*DATABASE_URL (e.g. TURSO_DATABASE_URL,');
  console.error('MENTAL_TURSO_DATABASE_URL). Set one in Vercel: Settings -> Environment');
  console.error('Variables (or make sure the Turso integration populates it for Production).');
  process.exit(1);
}

/**
 * Validate that the token looks like a genuine Turso JWT (header.payload.signature).
 * Returns null when valid, otherwise a human-readable problem description.
 */
function validateToken(tok) {
  if (!tok) return 'No Turso auth token found in the environment (looked for *TURSO*AUTH_TOKEN vars).';
  const parts = tok.split('.');
  if (parts.length !== 3) {
    return `Turso auth token is not a JWT (segments: ${parts.length}, expected 3). ` +
      'The env var contains a placeholder/corrupted value instead of a real Turso token.';
  }
  try {
    const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!hdr.alg) return 'JWT without alg field';
  } catch (e) {
    return 'First segment of the Turso auth token does not decode as a JWT header (broken base64 or placeholder value).';
  }
  return null;
}

const tokenProblem = validateToken(authToken);
if (tokenProblem) {
  console.error('CRITICAL: ' + tokenProblem);
  console.error(`Env vars containing "TURSO" found: URL=[${envNamesFound.url.join(', ')}] TOKEN=[${envNamesFound.token.join(', ')}]`);
  console.error('Every query to Turso will fail (HTTP 400) until this is fixed.');
  console.error('Fix: run `turso db tokens create <db-name>` (or use the Turso dashboard:');
  console.error('Database -> Show API parameters -> Auth token), then update the');
  console.error('auth-token env var in Vercel and REDEPLOY.');
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
  envNamesFound,
  urlEnvName: urlSource ? urlSource.name : null,
  tokenEnvName: tokenSource ? tokenSource.name : null,
};
