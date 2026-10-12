// One-shot migration runner for Turso. Usage:
//   TURSO_URL=... TURSO_TOKEN=... node run_migration.js
const { createClient } = require('@libsql/client');

const url = (process.env.TURSO_URL || process.env.MENTAL_TURSO_DATABASE_URL || '').trim();
const token = (process.env.TURSO_TOKEN || process.env.MENTAL_TURSO_AUTH_TOKEN || '').trim();
if (!url || !token) { console.error('Set TURSO_URL and TURSO_TOKEN'); process.exit(1); }

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT, telegram TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), self INTEGER NOT NULL DEFAULT 0, first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', telegram TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)`,
  `CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, opposite_name TEXT NOT NULL, symmetric INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), contact1_id INTEGER NOT NULL REFERENCES contacts(id), role1_id INTEGER NOT NULL REFERENCES roles(id), contact2_id INTEGER NOT NULL REFERENCES contacts(id), role2_id INTEGER NOT NULL REFERENCES roles(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (contact1_id, contact2_id, role1_id))`,
  `CREATE INDEX IF NOT EXISTS idx_conn_user ON connections(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_c1 ON connections(contact1_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_c2 ON connections(contact2_id)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), author_contact_id INTEGER REFERENCES contacts(id), contact_id INTEGER REFERENCES contacts(id), text TEXT NOT NULL, file_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id)`,
];
const ROLE_SEED = [
  [1, 'Друг', 'Друг', 1], [2, 'Приятель', 'Приятель', 1], [3, 'Знакомый', 'Знакомый', 1],
  [4, 'Коллега', 'Коллега', 1], [5, 'Руководитель', 'Подчиненный', 0],
  [6, 'Супруг', 'Супруга', 0], [7, 'Учитель', 'Ученик', 0],
];

(async () => {
  const client = createClient({ url, authToken: token });
  for (const sql of SCHEMA_STATEMENTS) { await client.execute({ sql, args: [] }); console.log('OK:', sql.slice(0, 60)); }
  for (const [id, name, opp, sym] of ROLE_SEED) {
    await client.execute({ sql: 'INSERT OR IGNORE INTO roles (id, name, opposite_name, symmetric) VALUES (?, ?, ?, ?)', args: [id, name, opp, sym] });
  }
  const t = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const r = await client.execute('SELECT id, name, opposite_name, symmetric FROM roles ORDER BY id');
  console.log('TABLES:', t.rows.map(x => x.name).join(', '));
  console.log('ROLES:', JSON.stringify(r.rows));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
