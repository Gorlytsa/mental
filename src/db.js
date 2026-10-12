// Turso (libSQL) database client wrapper.
// Reads credentials from environment variables:
//   MENTAL_TURSO_DATABASE_URL  - libsql:// URL of the database
//   MENTAL_TURSO_AUTH_TOKEN    - JWT auth token for the database
const { createClient } = require('@libsql/client');

const url = process.env.MENTAL_TURSO_DATABASE_URL;
const authToken = process.env.MENTAL_TURSO_AUTH_TOKEN || undefined;

if (!url) {
  console.error('FATAL: MENTAL_TURSO_DATABASE_URL is not set');
  process.exit(1);
}

const client = createClient({ url, authToken });

let usingLocalFallback = false;

/** Currently active client (Turso, or local file fallback after a 401). */
async function activeClient() {
  if (!usingLocalFallback) {
    try {
      await client.execute('SELECT 1');
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/401|Unauthorized|empty JWT/i.test(msg)) {
        console.warn('Turso auth failed (401). Falling back to local SQLite at ./local.db');
        globalThis.__mt_local = createClient({ url: 'file:' + require('path').join(process.cwd(), 'local.db') });
        usingLocalFallback = true;
        // Re-create schema in the local DB.
        await migrateRaw(globalThis.__mt_local);
      } else {
        throw e;
      }
    }
  }
  return usingLocalFallback ? globalThis.__mt_local : client;
}

/** Execute a single statement, return raw result */
async function run(sql, args = []) {
  const c = await activeClient();
  return await c.execute({ sql, args });
}

/** Return all rows of a query */
async function all(sql, args = []) {
  const c = await activeClient();
  const res = await c.execute({ sql, args });
  return res.rows;
}

/** Return the first row or null */
async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

/** Create schema on a given client (idempotent). */
async function migrateRaw(c) {
  const statements = [
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
      self INTEGER NOT NULL DEFAULT 0,          -- 1 for the auto-created "me" contact
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      telegram TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)`,
    // Role pairs are symmetric or asymmetric; the opposite role is derived automatically.
    `CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY,                   -- fixed ids 1..7
      name TEXT NOT NULL,                       -- role for side A
      opposite_name TEXT NOT NULL,              -- auto role for side B
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
      author_contact_id INTEGER REFERENCES contacts(id), -- who authored it (the "self" contact)
      contact_id INTEGER REFERENCES contacts(id),        -- page context, if any
      text TEXT NOT NULL,
      file_path TEXT,                                     -- attached file (LLM processing later)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id)`,
  ];
  for (const sql of statements) {
    await c.execute(sql);
  }
  // Seed the 7 relationship roles (pairs from CONCEPT.md).
  const seed = [
    [1, 'Друг', 'Друг', 1],
    [2, 'Приятель', 'Приятель', 1],
    [3, 'Знакомый', 'Знакомый', 1],
    [4, 'Коллега', 'Коллега', 1],
    [5, 'Руководитель', 'Подчиненный', 0],
    [6, 'Супруг', 'Супруга', 0],
    [7, 'Учитель', 'Ученик', 0],
  ];
  for (const [id, name, opposite, sym] of seed) {
    await c.execute({
      sql: `INSERT INTO roles (id, name, opposite_name, symmetric) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, opposite_name=excluded.opposite_name, symmetric=excluded.symmetric`,
      args: [id, name, opposite, sym],
    });
  }
}

/** Create schema on the active client. Called once at startup. */
async function migrate() {
  const c = await activeClient();
  await migrateRaw(c);
}

module.exports = { client, run, all, get, migrate, isLocalFallback: () => usingLocalFallback };
