/* Mental Turso SPA (hash routing). Talks only to /api/* — the same API will back the Telegram bot. */
'use strict';

const appEl = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

let ME = null;        // current user
let ROLES = [];       // cached roles

/* ---------------- API helper ---------------- */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/register' && path !== '/auth/me') {
      ME = null; render();
    }
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fullName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Без имени';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function go(hash) { location.hash = hash; }

/* ---------------- modal ---------------- */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'modal-overlay';
  ov.innerHTML = '<div class="modal">' + html + '</div>';
  ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  return ov;
}
function closeModal() {
  const ov = document.getElementById('modal-overlay');
  if (ov) ov.remove();
}

/* ---------------- auth screens ---------------- */
function renderAuth(mode) {
  mode = mode || 'login';
  tabbar.hidden = true;
  appEl.innerHTML = `
    <div class="auth-wrap">
      <h1 style="text-align:center">Mental Turso</h1>
      <p class="muted" style="text-align:center">Платформа наблюдений за людьми</p>
      <div class="auth-tabs">
        <button id="tab-login" class="${mode === 'login' ? 'active' : ''}">Вход</button>
        <button id="tab-register" class="${mode === 'register' ? 'active' : ''}">Регистрация</button>
      </div>
      <div class="card">
        ${mode === 'register' ? `
          <label>Ваше имя</label>
          <input type="text" id="f-name" placeholder="Например, Алексей" />
          <label>Telegram</label>
          <input type="text" id="f-telegram" placeholder="@username (необязательно)" />
        ` : ''}
        <label>Email</label>
        <input type="email" id="f-email" placeholder="you@example.com" />
        <label>Пароль</label>
        <input type="password" id="f-password" placeholder="минимум 6 символов" />
        <div class="error-msg" id="auth-error"></div>
        <button class="btn block" id="auth-submit">${mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
      </div>
    </div>`;
  document.getElementById('tab-login').onclick = () => renderAuth('login');
  document.getElementById('tab-register').onclick = () => renderAuth('register');
  document.getElementById('auth-submit').onclick = async () => {
    const btn = document.getElementById('auth-submit');
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const body = {
        email: document.getElementById('f-email').value.trim(),
        password: document.getElementById('f-password').value,
      };
      if (mode === 'register') {
        body.name = document.getElementById('f-name').value.trim();
        body.telegram = document.getElementById('f-telegram').value.trim();
      }
      const data = await api('/auth/' + mode, { method: 'POST', body });
      ME = data.user;
      await loadRoles();
      go('#/');
    } catch (e) {
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  };
}

/* ---------------- layout helpers ---------------- */
function setTab(name) {
  tabbar.hidden = false;
  document.querySelectorAll('.tabbar .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
}

async function loadRoles() {
  if (!ROLES.length) {
    try { ROLES = (await api('/roles')).roles; } catch (e) { /* ignore */ }
  }
}

/* ---------------- home page ---------------- */
async function renderHome() {
  setTab('home');
  appEl.innerHTML = '<div class="loading">Загрузка…</div>';
  const [notesData, contactsData] = await Promise.all([api('/notes'), api('/contacts')]);
  const notes = notesData.notes;
  const contacts = contactsData.contacts;
  const others = contacts.filter((c) => !c.self);

  appEl.innerHTML = `
    <h1>Наблюдения</h1>
    <div class="card">
      <h3>Новое общее наблюдение</h3>
      <p class="muted">Может касаться любых контактов. Позже AI разнесёт его по людям.</p>
      <textarea id="note-text" placeholder="Что вы заметили? Например: «Иван на совещании перебил всех и начал защищать свой план…»"></textarea>
      <div class="row wrap" style="margin-top:8px">
        <span class="muted">Упомянуть контакт:</span>
        ${others.map((c) => `<button class="btn small secondary mention" data-id="${c.id}">@${esc(c.first_name)}</button>`).join('')}
      </div>
      <div class="error-msg" id="note-error"></div>
      <button class="btn" id="note-add" style="margin-top:10px">Добавить заметку</button>
    </div>

    <h2>Лента заметок</h2>
    <div id="notes-list">
      ${notes.length ? notes.map(noteCardHtml).join('') : '<p class="muted">Пока нет заметок. Добавьте первое наблюдение выше.</p>'}
    </div>`;

  document.getElementById('note-add').onclick = async () => {
    const ta = document.getElementById('note-text');
    const errEl = document.getElementById('note-error');
    errEl.textContent = '';
    if (!ta.value.trim()) { errEl.textContent = 'Введите текст наблюдения'; return; }
    const btn = document.getElementById('note-add');
    btn.disabled = true;
    try {
      await api('/notes', { method: 'POST', body: { text: ta.value } });
      renderHome();
    } catch (e) {
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  };
  document.querySelectorAll('.mention').forEach((b) => {
    b.onclick = () => {
      const ta = document.getElementById('note-text');
      ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@' + b.textContent.slice(1) + ' ';
      ta.focus();
    };
  });
  bindNoteDelete(() => renderHome());
}

function noteCardHtml(n) {
  const tag = n.contact_first_name
    ? `<span class="chip accent">о: ${esc(fullName({ first_name: n.contact_first_name, last_name: n.contact_last_name }))}</span>`
    : `<span class="chip">общая</span>`;
  return `
    <div class="card note-card" data-note="${n.id}">
      <div class="meta"><span>${fmtDate(n.created_at)}</span>${tag}</div>
      <div class="text">${esc(n.text)}</div>
      <div class="row" style="margin-top:8px">
        <div class="spacer"></div>
        <button class="btn danger del-note" data-id="${n.id}">Удалить</button>
      </div>
    </div>`;
}

function bindNoteDelete(after) {
  document.querySelectorAll('.del-note').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Удалить заметку?')) return;
      try { await api('/notes/' + b.dataset.id, { method: 'DELETE' }); after(); }
      catch (e) { alert(e.message); }
    };
  });
}

/* ---------------- contacts list ---------------- */
async function renderContacts() {
  setTab('contacts');
  appEl.innerHTML = '<div class="loading">Загрузка…</div>';
  const { contacts } = await api('/contacts');
  appEl.innerHTML = `
    <div class="row">
      <h1 class="spacer">Контакты</h1>
      <button class="btn small" id="add-contact">+ Добавить</button>
    </div>
    ${contacts.map((c) => `
      <a class="list-row" href="#/contact/${c.id}">
        <div>
          <div class="title">${esc(fullName(c))} ${c.self ? '<span class="badge">это вы</span>' : ''}</div>
          <div class="sub">${c.telegram ? esc(c.telegram) + ' · ' : ''}${c.connections_count} связей · ${c.notes_count} заметок</div>
        </div>
        <span class="muted">›</span>
      </a>`).join('') || '<p class="muted">Список пуст.</p>'}`;
  document.getElementById('add-contact').onclick = () => contactForm(null);
}

function contactForm(contact) {
  const editing = !!contact;
  const ov = openModal(`
    <h3>${editing ? 'Редактировать контакт' : 'Новый контакт'}</h3>
    <label>Имя *</label>
    <input type="text" id="c-first" value="${editing ? esc(contact.first_name) : ''}" />
    <label>Фамилия</label>
    <input type="text" id="c-last" value="${editing ? esc(contact.last_name || '') : ''}" />
    <label>Telegram</label>
    <input type="text" id="c-tg" value="${editing ? esc(contact.telegram || '') : ''}" placeholder="@username" />
    <div class="error-msg" id="c-error"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn secondary" id="c-cancel">Отмена</button>
      <div class="spacer"></div>
      <button class="btn" id="c-save">${editing ? 'Сохранить' : 'Создать'}</button>
    </div>`);
  ov.querySelector('#c-cancel').onclick = closeModal;
  ov.querySelector('#c-save').onclick = async () => {
    const errEl = ov.querySelector('#c-error');
    const body = {
      first_name: ov.querySelector('#c-first').value,
      last_name: ov.querySelector('#c-last').value,
      telegram: ov.querySelector('#c-tg').value.trim() || null,
    };
    try {
      if (editing) await api('/contacts/' + contact.id, { method: 'PUT', body });
      else await api('/contacts', { method: 'POST', body });
      closeModal();
      render(); // refresh current route
    } catch (e) { errEl.textContent = e.message; }
  };
}

/* ---------------- contact page ---------------- */
async function renderContact(id) {
  setTab('contacts');
  appEl.innerHTML = '<div class="loading">Загрузка…</div>';
  let contact, connections, notes;
  try {
    [contact, connections, notes] = await Promise.all([
      api('/contacts/' + id).then((d) => d.contact),
      api('/connections?contact_id=' + id).then((d) => d.connections),
      api('/notes?contact_id=' + id).then((d) => d.notes),
    ]);
  } catch (e) {
    appEl.innerHTML = `<div class="topbar"><a class="back" href="#/contacts">← Назад</a></div><p class="error-msg">${esc(e.message)}</p>`;
    return;
  }
  const { contacts } = await api('/contacts');
  const others = contacts.filter((c) => c.id !== contact.id);

  appEl.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/contacts">← Контакты</a>
      <div class="spacer"></div>
      ${contact.self ? '' : `<button class="btn small danger" id="del-contact">Удалить</button>
      <button class="btn small secondary" id="edit-contact">Изменить</button>`}
    </div>
    <div class="card">
      <h3>${esc(fullName(contact))} ${contact.self ? '<span class="badge">это вы</span>' : ''}</h3>
      <div class="muted">${contact.telegram ? esc(contact.telegram) + ' · ' : ''}контакт #${contact.id}</div>
      <p class="muted">Психологический портрет будет строиться на основе собранных здесь фактов (скоро).</p>
    </div>

    <h2>Связи</h2>
    <div id="conn-list">
      ${connections.map(connHtml).join('') || '<p class="muted">Связей пока нет.</p>'}
    </div>
    <button class="btn small" id="add-conn" ${others.length ? '' : 'disabled'}>+ Установить связь</button>

    <h2>Частные наблюдения</h2>
    <div class="card">
      <textarea id="note-text" placeholder="Наблюдение именно за ${esc(contact.first_name)}…"></textarea>
      <div class="error-msg" id="note-error"></div>
      <button class="btn" id="note-add" style="margin-top:10px">Добавить заметку</button>
    </div>
    <div id="notes-list">
      ${notes.length ? notes.map(noteCardHtml).join('') : '<p class="muted">Заметок по этому контакту пока нет.</p>'}
    </div>`;

  if (!contact.self) {
    document.getElementById('edit-contact').onclick = () => contactForm(contact);
    document.getElementById('del-contact').onclick = async () => {
      if (!confirm('Удалить контакт и все его связи?')) return;
      try { await api('/contacts/' + contact.id, { method: 'DELETE' }); go('#/contacts'); }
      catch (e) { alert(e.message); }
    };
  }
  document.getElementById('add-conn').onclick = () => connectionForm(contact, contacts);
  document.querySelectorAll('.del-conn').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Удалить связь?')) return;
      try { await api('/connections/' + b.dataset.id, { method: 'DELETE' }); renderContact(contact.id); }
      catch (e) { alert(e.message); }
    };
  });
  document.getElementById('note-add').onclick = async () => {
    const ta = document.getElementById('note-text');
    const errEl = document.getElementById('note-error');
    errEl.textContent = '';
    if (!ta.value.trim()) { errEl.textContent = 'Введите текст наблюдения'; return; }
    const btn = document.getElementById('note-add');
    btn.disabled = true;
    try {
      await api('/notes', { method: 'POST', body: { text: ta.value, contact_id: contact.id } });
      renderContact(contact.id);
    } catch (e) { errEl.textContent = e.message; btn.disabled = false; }
  };
  bindNoteDelete(() => renderContact(contact.id));
}

function connHtml(x) {
  // Show relation from this page's perspective is handled by caller ordering; generic view:
  return `
    <div class="list-row" style="cursor:default">
      <div>
        <div class="title">${esc(x.contact1_first_name)} <span class="chip">${esc(x.role1_name)}</span> ↔
        <span class="chip">${esc(x.role2_name)}</span> ${esc(x.contact2_first_name)}</div>
      </div>
      <button class="btn danger del-conn" data-id="${x.id}">✕</button>
    </div>`;
}

/**
 * Connection form. Side A defaults to the contact whose page we're on,
 * side B is chosen among the rest. Role for side A is picked; side B's role
 * is auto-derived (symmetric or opposite) and shown as a preview.
 */
function connectionForm(pageContact, allContacts) {
  const others = allContacts.filter((c) => c.id !== pageContact.id);
  const roleOpts = ROLES.map((r) => `<option value="${r.id}">${esc(r.name)}${r.symmetric ? '' : ' → ' + esc(r.opposite_name)}</option>`).join('');
  const contactOpts = others.map((c) => `<option value="${c.id}">${esc(fullName(c))}</option>`).join('');
  const ov = openModal(`
    <h3>Новая связь</h3>
    <label>Кто (сторона A)</label>
    <div class="chip accent" style="font-size:14px">${esc(fullName(pageContact))}</div>
    <label>С кем (сторона B)</label>
    <select id="k-target">${contactOpts}</select>
    <label>Роль для стороны A</label>
    <select id="k-role">${roleOpts}</select>
    <p class="muted" id="k-preview"></p>
    <div class="error-msg" id="k-error"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn secondary" id="k-cancel">Отмена</button>
      <div class="spacer"></div>
      <button class="btn" id="k-save">Создать связь</button>
    </div>`);

  const upd = () => {
    const rid = Number(ov.querySelector('#k-role').value);
    const r = ROLES.find((x) => x.id === rid);
    const target = others.find((c) => c.id === Number(ov.querySelector('#k-target').value));
    const bName = r.symmetric ? r.name : r.opposite_name;
    ov.querySelector('#k-preview').textContent =
      `${pageContact.first_name} — ${r.name.toLowerCase()} для ${target ? target.first_name : '?'}, ` +
      `${target ? target.first_name : '?'} — ${bName.toLowerCase()} для ${pageContact.first_name}.`;
  };
  ov.querySelector('#k-role').onchange = upd;
  ov.querySelector('#k-target').onchange = upd;
  upd();

  ov.querySelector('#k-cancel').onclick = closeModal;
  ov.querySelector('#k-save').onclick = async () => {
    const errEl = ov.querySelector('#k-error');
    try {
      await api('/connections', {
        method: 'POST',
        body: {
          contact1_id: pageContact.id,
          contact2_id: Number(ov.querySelector('#k-target').value),
          role1_id: Number(ov.querySelector('#k-role').value),
        },
      });
      closeModal();
      render();
    } catch (e) { errEl.textContent = e.message; }
  };
}

/* ---------------- profile ---------------- */
function renderProfile() {
  setTab('profile');
  appEl.innerHTML = `
    <h1>Профиль</h1>
    <div class="card">
      <h3>${esc(ME.name || ME.email)}</h3>
      <div class="muted">${esc(ME.email)}</div>
      <p class="muted" style="margin-top:10px">Свой профиль доступен как контакт «это вы» — там можно вести наблюдения о себе.</p>
    </div>
    <button class="btn secondary block" id="logout">Выйти</button>`;
  document.getElementById('logout').onclick = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    ME = null;
    go('#/');
    renderAuth('login');
  };
}

/* ---------------- router ---------------- */
async function render() {
  const h = location.hash || '#/';
  if (!ME) return renderAuth('login');
  await loadRoles();
  const mContact = h.match(/^#\/contact\/(\d+)/);
  try {
    if (mContact) return await renderContact(Number(mContact[1]));
    if (h.startsWith('#/contacts')) return await renderContacts();
    if (h.startsWith('#/profile')) return renderProfile();
    return await renderHome();
  } catch (e) {
    console.error(e);
    appEl.innerHTML = `<div class="card"><h3>Ошибка</h3><p class="error-msg">${esc(e.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    const d = await api('/auth/me');
    ME = d.user;
  } catch (e) { ME = null; }
  render();
})();
