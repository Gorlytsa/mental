// Verify Turso DB state. Usage: TURSO_URL=... TURSO_TOKEN=... node verify_turso.js
const { createClient } = require('@libsql/client');
(async () => {
  const c = createClient({ url: process.env.TURSO_URL.trim(), authToken: process.env.TURSO_TOKEN.trim() });
  const t = await c.execute("SELECT type, name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  console.log('OBJECTS:', JSON.stringify(t.rows));
  const r = await c.execute('SELECT id, name, opposite_name, symmetric FROM roles ORDER BY id');
  console.log('ROLES:', JSON.stringify(r.rows));
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
