process.env.TURSO_DATABASE_URL = 'libsql://mental-gorlytsa.aws-ap-northeast-1.turso.io';
process.env.TURSO_AUTH_TOKEN = process.argv[2];
process.env.JWT_SECRET = 'smoke-test-secret';
const { spawn } = require('child_process');
const srv = spawn('node', ['src/server.js'], { env: process.env, stdio: ['ignore','pipe','pipe'] });
srv.stderr.on('data', d => process.stderr.write('[srv!] ' + d));
const base = 'http://127.0.0.1:3000';
async function req(path, opts = {}) {
  const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', cookie: opts.cookie || '' } });
  let b=null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, cookie: (r.headers.get('set-cookie')||'').split(';')[0] };
}
(async () => {
  await new Promise(r=>setTimeout(r,2500));
  const res0 = await req('/api/auth/register', { method:'POST', body: JSON.stringify({ email:`s2_${Date.now()}@t.local`, password:'pass1234', name:'Тестер' }) });
  const ck = res0.cookie;
  const a = await req('/api/contacts', { method:'POST', cookie:ck, body: JSON.stringify({ first_name:'Анна' }) });
  const b = await req('/api/contacts', { method:'POST', cookie:ck, body: JSON.stringify({ first_name:'Борис' }) });
  // asymmetric: Анна — Руководитель Бориса (role 5), opposite auto -> Подчиненный(6? no, id of Подчиненный)
  const c1 = await req('/api/connections', { method:'POST', cookie:ck, body: JSON.stringify({ contact1_id:a.body.contact.id, role1_id:5, contact2_id:b.body.contact.id }) });
  console.log('ASYM', c1.status, JSON.stringify(c1.body.connection||c1.body).slice(0,300));
  // symmetric: Друг (1)
  const c2 = await req('/api/connections', { method:'POST', cookie:ck, body: JSON.stringify({ contact1_id:a.body.contact.id, role1_id:1, contact2_id:b.body.contact.id }) });
  console.log('SYM', c2.status, JSON.stringify(c2.body.connection||c2.body).slice(0,300));
  // note on contact page
  const n = await req('/api/notes', { method:'POST', cookie:ck, body: JSON.stringify({ text:'Заметка об Анне', contact_id:a.body.contact.id }) });
  console.log('NOTE-PAGE', n.status, JSON.stringify(n.body.note||n.body).slice(0,250));
  const list = await req('/api/connections', { cookie:ck });
  console.log('CONN LIST', list.status, JSON.stringify(list.body).slice(0,400));
  srv.kill(); process.exit(0);
})().catch(e=>{console.error('FAIL',e);srv.kill();process.exit(1)});
