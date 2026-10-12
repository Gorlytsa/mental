// End-to-end API smoke test against the REAL Turso DB.
process.env.TURSO_DATABASE_URL = 'libsql://mental-gorlytsa.aws-ap-northeast-1.turso.io';
process.env.TURSO_AUTH_TOKEN = process.argv[2];
process.env.JWT_SECRET = 'smoke-test-secret';
const { spawn } = require('child_process');
const srv = spawn('node', ['src/server.js'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv!] ' + d));

const base = 'http://127.0.0.1:3000';
async function req(path, opts = {}) {
  const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', cookie: opts.cookie || '', ...(opts.headers||{}) } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
(async () => {
  await new Promise(r => setTimeout(r, 2500)); // wait for boot + migrate retry
  const email = `smoke_${Date.now()}@test.local`;
  let res = await req('/api/health'); console.log('HEALTH', res.status, JSON.stringify(res.body).slice(0,400));
  res = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'pass1234', name: 'Смоук' }) });
  console.log('REGISTER', res.status, JSON.stringify(res.body).slice(0,200));
  const cookie = res.cookie;
  res = await req('/api/roles', { cookie }); console.log('ROLES', res.status, Array.isArray(res.body) ? res.body.length : JSON.stringify(res.body).slice(0,200));
  res = await req('/api/contacts', { method: 'POST', cookie, body: JSON.stringify({ first_name: 'Анна', last_name: 'Иванова', telegram: '@anna' }) });
  console.log('CONTACT', res.status, JSON.stringify(res.body).slice(0,200));
  const cId = res.body && res.body.id;
  res = await req('/api/connections', { method: 'POST', cookie, body: JSON.stringify({ contact1_id: cId, role1_id: 5, contact2_id: cId === undefined ? -1 : undefined }) });
  // build a second contact and connect them properly
  res = await req('/api/contacts', { method: 'POST', cookie, body: JSON.stringify({ first_name: 'Борис' }) });
  const c2 = res.body && res.body.id;
  res = await req('/api/connections', { method: 'POST', cookie, body: JSON.stringify({ contact1_id: cId, role1_id: 5, contact2_id: c2, role2_id: 5 }) });
  console.log('CONNECT(asym)', res.status, JSON.stringify(res.body).slice(0,300));
  res = await req('/api/notes', { method: 'POST', cookie, body: JSON.stringify({ text: 'Тестовая заметка', contact_id: cId }) });
  console.log('NOTE', res.status, JSON.stringify(res.body).slice(0,200));
  res = await req('/api/contacts', { cookie }); console.log('LIST CONTACTS', res.status, JSON.stringify(res.body).slice(0,200));
  srv.kill('SIGTERM'); process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); srv.kill(); process.exit(1); });
