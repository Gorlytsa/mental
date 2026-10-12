// Mental Turso — backend API + static frontend.
// All business logic lives behind /api/* so it can later be wrapped into a Telegram bot.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = '7d';

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------------- auth helpers ---------------- */
function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Human-readable DB error for logs/responses (never leaks secrets). */
function dbErrorInfo(e) {
  const msg = String((e && e.message) || e || '');
  // Surface the exact env-var problem instead of a generic 500.
  if (!db.tokenLooksValid()) {
    return 'База данных Turso недоступна: ' + db.tokenProblem() +
      ' Получите реальный токен (Turso dashboard -> Database -> Show API parameters -> Auth token,' +
      ' или `turso db tokens create <db>`) и обновите MENTAL_TURSO_AUTH_TOKEN в Vercel, затем Redeploy.';
  }
  if (/401|Unauthorized|Invalid JWT|empty JWT/i.test(msg))
    return 'База данных недоступна: MENTAL_TURSO_AUTH_TOKEN не принят сервером Turso (401).' +
      ' Токен устарел или отозван — создайте новый (`turso db tokens create <db>`) и обновите переменную окружения в Vercel, затем Redeploy.';
  if (/400|SERVER_ERROR/i.test(msg))
    return 'База данных недоступна: Turso отклонил запрос (HTTP 400).' +
      ' Проверьте MENTAL_TURSO_DATABASE_URL и MENTAL_TURSO_AUTH_TOKEN в Vercel' +
      ' (без пробелов/кавычек, токен должен быть JWT из Turso dashboard), затем Redeploy.';
  return msg || 'Внутренняя ошибка сервера';
}

function authRequired(req, res, next) {
  // Session token comes from the httpOnly cookie (web SPA) or an Authorization
  // header (API clients / future Telegram bot): "Authorization: Bearer <jwt>".
  let token = req.cookies && req.cookies.mt_token ? req.cookies.mt_token : null;
  if (!token) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1];
  }
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Сессия истекла, войдите заново' });
  }
}

/* ---------------- diagnostics ---------------- */
app.get('/api/health', async (req, res) => {
  const info = {
    ok: false,
    databaseUrlHost: (() => {
      try { return new URL(dbUrlForHealth()).host; } catch (e) { return null; }
    })(),
    tokenLooksValid: db.tokenLooksValid(),
    tokenProblem: db.tokenProblem(),          // exact env-var problem, if any
    usingLocalFallback: db.isLocalFallback(), // always false now (no fallback)
    tables: [],
    rolesSeeded: 0,
    error: null,
  };
  try {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    info.tables = rows.map((r) => r.name);
    const roleCount = await db.get('SELECT COUNT(*) AS n FROM roles');
    info.rolesSeeded = roleCount ? Number(roleCount.n) : 0;
    info.ok = true;
  } catch (e) {
    info.error = dbErrorInfo(e);
    info.lastConnectError = db.lastConnectError();
  }
  // 503 when DB is down so monitoring/Vercel shows the deployment as unhealthy.
  res.status(info.ok ? 200 : 503).json(info);
});
function dbUrlForHealth() {
  return process.env.MENTAL_TURSO_DATABASE_URL || 'http://invalid';
}

/* ---------------- auth routes ---------------- */
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { email, password, name, telegram } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email))
      return res.status(400).json({ error: 'Укажите корректный email' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    const exists = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (exists) return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.run(
      'INSERT INTO users (email, password_hash, name, telegram) VALUES (?, ?, ?, ?)',
      [email.toLowerCase(), hash, name || null, telegram || null]
    );
    const userId = Number(r.lastInsertRowid);
    // Create the "self" contact for this user (notes from own page, portrait of self).
    await db.run(
      `INSERT INTO contacts (user_id, self, first_name, last_name, telegram) VALUES (?, 1, ?, ?, ?)`,
      [userId, name || 'Я', '', telegram || null]
    );
    const user = { id: userId, email: email.toLowerCase(), name: name || null };
    const token = signToken(user);
    res.cookie('mt_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ user, token }); // token also returned in body for API/bot usage
  } catch (e) { next(e); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Нужны email и пароль' });
    const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Неверный email или пароль' });
    const u = { id: user.id, email: user.email, name: user.name };
    const token = signToken(u);
    res.cookie('mt_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ user: u, token });
  } catch (e) { next(e); }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('mt_token');
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, async (req, res, next) => {
  try {
    const u = await db.get('SELECT id, email, name, telegram FROM users WHERE id = ?', [req.userId]);
    if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user: u });
  } catch (e) { next(e); }
});

/* ---------------- contacts ---------------- */
async function ownContact(userId, contactId) {
  return db.get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [contactId, userId]);
}

app.get('/api/contacts', authRequired, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM connections x WHERE x.contact1_id = c.id OR x.contact2_id = c.id) AS connections_count,
              (SELECT COUNT(*) FROM notes n WHERE n.contact_id = c.id) AS notes_count
       FROM contacts c WHERE c.user_id = ? ORDER BY c.self DESC, c.first_name, c.last_name`,
      [req.userId]
    );
    res.json({ contacts: rows });
  } catch (e) { next(e); }
});

app.get('/api/contacts/:id', authRequired, async (req, res, next) => {
  try {
    const c = await ownContact(req.userId, req.params.id);
    if (!c) return res.status(404).json({ error: 'Контакт не найден' });
    res.json({ contact: c });
  } catch (e) { next(e); }
});

app.post('/api/contacts', authRequired, async (req, res, next) => {
  try {
    const { first_name, last_name, telegram } = req.body || {};
    if (!first_name || !String(first_name).trim())
      return res.status(400).json({ error: 'Имя обязательно' });
    const r = await db.run(
      `INSERT INTO contacts (user_id, self, first_name, last_name, telegram) VALUES (?, 0, ?, ?, ?)`,
      [req.userId, String(first_name).trim(), (last_name || '').trim(), telegram || null]
    );
    const c = await db.get('SELECT * FROM contacts WHERE id = ?', [Number(r.lastInsertRowid)]);
    res.status(201).json({ contact: c });
  } catch (e) { next(e); }
});

app.put('/api/contacts/:id', authRequired, async (req, res, next) => {
  try {
    const c = await ownContact(req.userId, req.params.id);
    if (!c) return res.status(404).json({ error: 'Контакт не найден' });
    const { first_name, last_name, telegram } = req.body || {};
    if (first_name !== undefined && !String(first_name).trim())
      return res.status(400).json({ error: 'Имя не может быть пустым' });
    // For the "self" contact keep user record in sync.
    const newFirst = first_name !== undefined ? String(first_name).trim() : c.first_name;
    const newLast = last_name !== undefined ? String(last_name).trim() : c.last_name;
    const newTg = telegram !== undefined ? (telegram || null) : c.telegram;
    await db.run(
      `UPDATE contacts SET first_name=?, last_name=?, telegram=?, updated_at=datetime('now') WHERE id=?`,
      [newFirst, newLast, newTg, c.id]
    );
    if (c.self) {
      await db.run('UPDATE users SET name=?, telegram=? WHERE id=?', [newFirst, newTg, req.userId]);
    }
    const upd = await db.get('SELECT * FROM contacts WHERE id = ?', [c.id]);
    res.json({ contact: upd });
  } catch (e) { next(e); }
});

app.delete('/api/contacts/:id', authRequired, async (req, res, next) => {
  try {
    const c = await ownContact(req.userId, req.params.id);
    if (!c) return res.status(404).json({ error: 'Контакт не найден' });
    if (c.self) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    await db.run('DELETE FROM connections WHERE contact1_id=? OR contact2_id=?', [c.id, c.id]);
    await db.run('UPDATE notes SET contact_id=NULL WHERE contact_id=?', [c.id]);
    await db.run('DELETE FROM contacts WHERE id=?', [c.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- roles & connections ---------------- */
app.get('/api/roles', authRequired, async (req, res, next) => {
  try {
    const roles = await db.all('SELECT * FROM roles ORDER BY id');
    res.json({ roles });
  } catch (e) { next(e); }
});

/**
 * Create a connection between any two of the user's contacts.
 * Body: {contact1_id, contact2_id, role1_id}. role2_id is derived automatically
 * (symmetric pair or opposite role). Multiple connections are allowed, but an
 * exact duplicate (same pair + same role on side A) is rejected.
 */
app.post('/api/connections', authRequired, async (req, res, next) => {
  try {
    const { contact1_id, contact2_id, role1_id } = req.body || {};
    const id1 = Number(contact1_id), id2 = Number(contact2_id), rid = Number(role1_id);
    if (!id1 || !id2 || !rid) return res.status(400).json({ error: 'Укажите оба контакта и роль' });
    if (id1 === id2) return res.status(400).json({ error: 'Нельзя связать контакт сам с собой' });
    const c1 = await ownContact(req.userId, id1);
    const c2 = await ownContact(req.userId, id2);
    if (!c1 || !c2) return res.status(404).json({ error: 'Один из контактов не найден' });
    const role = await db.get('SELECT * FROM roles WHERE id = ?', [rid]);
    if (!role) return res.status(404).json({ error: 'Роль не найдена' });
    // Opposite role: symmetric => same role; asymmetric => the unique role whose
    // name equals this role's opposite_name (e.g. Руководитель -> Подчиненный).
    const role2 = await db.get('SELECT * FROM roles WHERE name = ?', [role.opposite_name]);
    const role2Id = role.symmetric ? role.id : (role2 ? role2.id : rid);
    const dup = await db.get(
      'SELECT id FROM connections WHERE contact1_id=? AND contact2_id=? AND role1_id=?',
      [id1, id2, rid]
    );
    if (dup) return res.status(409).json({ error: 'Такая связь уже существует' });
    const r = await db.run(
      `INSERT INTO connections (user_id, contact1_id, role1_id, contact2_id, role2_id) VALUES (?,?,?,?,?)`,
      [req.userId, id1, rid, id2, role2Id]
    );
    const conn = await getConnWithNames(Number(r.lastInsertRowid));
    res.status(201).json({ connection: conn });
  } catch (e) { next(e); }
});

async function getConnWithNames(id) {
  return db.get(
    `SELECT x.*, c1.first_name AS contact1_first_name, c1.last_name AS contact1_last_name,
            c2.first_name AS contact2_first_name, c2.last_name AS contact2_last_name,
            r1.name AS role1_name, r2.name AS role2_name
     FROM connections x
     JOIN contacts c1 ON c1.id=x.contact1_id
     JOIN contacts c2 ON c2.id=x.contact2_id
     JOIN roles r1 ON r1.id=x.role1_id
     JOIN roles r2 ON r2.id=x.role2_id
     WHERE x.id=?`,
    [id]
  );
}

app.get('/api/connections', authRequired, async (req, res, next) => {
  try {
    const where = [];
    const args = [req.userId];
    if (req.query.contact_id) {
      where.push('(x.contact1_id = ? OR x.contact2_id = ?)');
      const cid = Number(req.query.contact_id);
      args.push(cid, cid);
    }
    const sql =
      `SELECT x.*, c1.first_name AS contact1_first_name, c1.last_name AS contact1_last_name,
              c2.first_name AS contact2_first_name, c2.last_name AS contact2_last_name,
              r1.name AS role1_name, r2.name AS role2_name
       FROM connections x
       JOIN contacts c1 ON c1.id=x.contact1_id
       JOIN contacts c2 ON c2.id=x.contact2_id
       JOIN roles r1 ON r1.id=x.role1_id
       JOIN roles r2 ON r2.id=x.role2_id
       WHERE x.user_id = ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
       ORDER BY x.created_at DESC`;
    const rows = await db.all(sql, args);
    res.json({ connections: rows });
  } catch (e) { next(e); }
});

/** Edit a connection: allow changing side-A role (role2 re-derived) or either contact. */
app.put('/api/connections/:id', authRequired, async (req, res, next) => {
  try {
    const conn = await db.get('SELECT * FROM connections WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!conn) return res.status(404).json({ error: 'Связь не найдена' });
    const id1 = req.body.contact1_id !== undefined ? Number(req.body.contact1_id) : conn.contact1_id;
    const id2 = req.body.contact2_id !== undefined ? Number(req.body.contact2_id) : conn.contact2_id;
    const rid = req.body.role1_id !== undefined ? Number(req.body.role1_id) : conn.role1_id;
    if (id1 === id2) return res.status(400).json({ error: 'Нельзя связать контакт сам с собой' });
    const c1 = await ownContact(req.userId, id1);
    const c2 = await ownContact(req.userId, id2);
    if (!c1 || !c2) return res.status(404).json({ error: 'Один из контактов не найден' });
    const role = await db.get('SELECT * FROM roles WHERE id = ?', [rid]);
    if (!role) return res.status(404).json({ error: 'Роль не найдена' });
    const role2Row = await db.get('SELECT * FROM roles WHERE name = ?', [role.opposite_name]);
    const role2Id = role.symmetric ? role.id : (role2Row ? role2Row.id : rid);
    const dup = await db.get(
      'SELECT id FROM connections WHERE contact1_id=? AND contact2_id=? AND role1_id=? AND id != ?',
      [id1, id2, rid, conn.id]
    );
    if (dup) return res.status(409).json({ error: 'Такая связь уже существует' });
    await db.run(
      'UPDATE connections SET contact1_id=?, role1_id=?, contact2_id=?, role2_id=? WHERE id=?',
      [id1, rid, id2, role2Id, conn.id]
    );
    res.json({ connection: await getConnWithNames(conn.id) });
  } catch (e) { next(e); }
});

app.delete('/api/connections/:id', authRequired, async (req, res, next) => {
  try {
    const conn = await db.get('SELECT * FROM connections WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!conn) return res.status(404).json({ error: 'Связь не найдена' });
    await db.run('DELETE FROM connections WHERE id=?', [conn.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- notes (observations) ---------------- */
app.get('/api/notes', authRequired, async (req, res, next) => {
  try {
    const args = [req.userId];
    let filter = '';
    if (req.query.contact_id) {
      filter = 'AND n.contact_id = ?';
      args.push(Number(req.query.contact_id));
    } else if (req.query.general === '1') {
      filter = 'AND n.contact_id IS NULL';
    }
    const rows = await db.all(
      `SELECT n.*, c.first_name AS contact_first_name, c.last_name AS contact_last_name
       FROM notes n LEFT JOIN contacts c ON c.id = n.contact_id
       WHERE n.user_id = ? ${filter}
       ORDER BY n.created_at DESC LIMIT 500`,
      args
    );
    res.json({ notes: rows });
  } catch (e) { next(e); }
});

/**
 * Create a raw note.
 * Body: {text, contact_id?} — contact_id present => private note from a contact page,
 * absent => general note from the main page.
 * @mentions parsing / LLM splitting comes later; we store raw text now.
 */
app.post('/api/notes', authRequired, async (req, res, next) => {
  try {
    const { text, contact_id } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Текст заметки обязателен' });
    let cid = null;
    if (contact_id !== undefined && contact_id !== null && contact_id !== '') {
      cid = Number(contact_id);
      const c = await ownContact(req.userId, cid);
      if (!c) return res.status(404).json({ error: 'Контакт не найден' });
    }
    const self = await db.get('SELECT id FROM contacts WHERE user_id=? AND self=1', [req.userId]);
    const r = await db.run(
      'INSERT INTO notes (user_id, author_contact_id, contact_id, text) VALUES (?,?,?,?)',
      [req.userId, self ? self.id : null, cid, String(text).trim()]
    );
    const note = await db.get(
      `SELECT n.*, c.first_name AS contact_first_name, c.last_name AS contact_last_name
       FROM notes n LEFT JOIN contacts c ON c.id=n.contact_id WHERE n.id=?`,
      [Number(r.lastInsertRowid)]
    );
    res.status(201).json({ note });
  } catch (e) { next(e); }
});

app.delete('/api/notes/:id', authRequired, async (req, res, next) => {
  try {
    const n = await db.get('SELECT * FROM notes WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!n) return res.status(404).json({ error: 'Заметка не найдена' });
    await db.run('DELETE FROM notes WHERE id=?', [n.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- SPA fallback ---------------- */
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* ---------------- error handler ---------------- */
app.use((err, req, res, next) => {
  console.error((err && err.message) || err);
  res.status(500).json({ error: dbErrorInfo(err) });
});

/* ---------------- startup ---------------- */
async function ensureSchema() {
  try {
    await db.migrate();
    console.log('DB schema ready' + (db.isLocalFallback() ? ' (LOCAL FALLBACK MODE — fix Turso credentials!)' : ''));
    return true;
  } catch (e) {
    console.error('DB migration failed:', dbErrorInfo(e));
    return false;
  }
}

// Retry migration in the background so that a transient Turso error doesn't
// leave the deployment permanently without tables.
(function migrateWithRetry(attempt = 1) {
  ensureSchema().then((ok) => {
    if (!ok && attempt < 5) {
      const delay = Math.min(30000, 2000 * attempt);
      console.log(`Retrying DB migration in ${delay}ms (attempt ${attempt + 1}/5)...`);
      setTimeout(() => migrateWithRetry(attempt + 1), delay).unref();
    }
  });
})();

app.listen(PORT, () => console.log(`Mental Turso listening on http://localhost:${PORT}`));
