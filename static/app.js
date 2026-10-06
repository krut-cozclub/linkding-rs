(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const app = $('#app');
const PER = 30;
let profile = {};
let tagStats = null;
let anon = false;

// ---------------------------------------------------------------- helpers
function errText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d.detail) return d.detail;
  if (d.error) return d.error;
  return Object.entries(d).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join('\n');
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {'X-Requested-With': 'ld', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (r.status === 401 && !anon) {
    location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('auth');
  }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(errText(data) || r.statusText); e.data = data; throw e; }
  return data;
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
const fail = e => { if (e.message !== 'auth') toast(e.message || 'Something went wrong'); };

function rel(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (profile.bookmark_date_display === 'absolute') return d.toLocaleDateString();
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return d.toLocaleDateString();
}
const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function applyTheme() {
  const t = profile.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function getTags(force) {
  if (!tagStats || force) { try { tagStats = await api('GET', '/api/tags/stats/'); } catch { tagStats = tagStats || []; } }
  return tagStats;
}

// ---------------------------------------------------------------- routing
function nav(url, replace) {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  route();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); nav(a.getAttribute('href')); }
});
addEventListener('popstate', route);

function route() {
  const p = location.pathname, qs = new URLSearchParams(location.search);
  $$('nav a').forEach(a => a.classList.toggle('on', p === a.getAttribute('href') || (a.getAttribute('href') !== '/bookmarks' && p.startsWith(a.getAttribute('href')))));
  $('#q').value = qs.get('q') || '';
  if (p === '/bookmarks/close') { window.close(); app.innerHTML = '<p class="empty">You can close this window.</p>'; return; }
  if (p === '/tags') return tagsView();
  if (p === '/settings' || p === '/settings/general') return settingsView();
  const kind = p === '/bookmarks/archived' ? 'archived' : p === '/bookmarks/shared' ? 'shared' : 'active';
  if (p === '/bookmarks/new') {
    listView('active', qs).then(() => openForm(null, {url: qs.get('url') || '', title: qs.get('title') || '', description: qs.get('description') || '', notes: qs.get('notes') || '', tags: qs.get('tags') || '', autoClose: qs.has('auto_close')}));
    return;
  }
  const m = p.match(/^\/bookmarks\/(\d+)\/edit$/);
  if (m) { listView('active', qs).then(() => api('GET', `/api/bookmarks/${m[1]}/`).then(b => openForm(b)).catch(fail)); return; }
  listView(kind, qs);
}

// ---------------------------------------------------------------- list
let listState = {kind: 'active', items: [], count: 0};

async function listView(kind, qs) {
  const q = qs.get('q') || '', page = Math.max(0, parseInt(qs.get('page') || '0', 10) || 0);
  const pref = profile.search_preferences || {};
  const sort = qs.get('sort') || pref.sort || 'added_desc';
  const unread = qs.has('unread') ? qs.get('unread') : (pref.unread && pref.unread !== 'off' ? pref.unread : '');
  const sharedF = qs.has('shared') ? qs.get('shared') : (pref.shared && pref.shared !== 'off' ? pref.shared : '');
  const bundle = qs.get('bundle') || '';
  const norm = v => (v === 'off' ? '' : v);
  if (!app.querySelector('.layout') || listState.kind !== kind) {
    app.innerHTML = `<div class="layout"><aside id="side"></aside><section><div id="tb" class="toolbar"></div><div id="bulk"></div><ul id="list" class="bms"></ul><div id="pager" class="pager"></div></section></div>`;
    $('#list').addEventListener('click', onListClick);
    $('#list').addEventListener('change', updateBulk);
    listState.bulkMode = false;
  }
  Object.assign(listState, {kind, q, page, sort, unread: norm(unread), shared: norm(sharedF), bundle});
  const base = kind === 'archived' ? '/api/bookmarks/archived/' : kind === 'shared' ? '/api/bookmarks/shared/' : '/api/bookmarks/';
  const p = new URLSearchParams({limit: PER, offset: page * PER, sort});
  if (q) p.set('q', q);
  if (norm(unread)) p.set('unread', norm(unread));
  if (norm(sharedF)) p.set('shared', norm(sharedF));
  if (bundle) p.set('bundle', bundle);
  // sidebar data loads in parallel with the list
  const sideP = kind === 'shared' ? Promise.resolve([[], []]) : Promise.all([getTags(), getBundles()]);
  let data;
  try { data = await api('GET', base + '?' + p); } catch (e) { fail(e); return; }
  listState.items = data.results; listState.count = data.count;
  renderToolbar(); renderList(); renderPager();
  sideP.then(([t, b]) => renderSide(t, b));
  scrollTo(0, 0);
}

function setQuery(patch) {
  const qs = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v === '' || v == null) qs.delete(k); else qs.set(k, v); }
  if (!('page' in patch)) qs.delete('page');
  nav(location.pathname + (qs.toString() ? '?' + qs : ''), true);
}

function renderToolbar() {
  const {count, sort, unread, shared, page, kind, bulkMode} = listState;
  const from = count ? page * PER + 1 : 0, to = Math.min(count, (page + 1) * PER);
  const readOnly = kind === 'shared';
  const filtOpen = !!($('#filt') && $('#filt').open);
  $('#tb').innerHTML = `<span><b>${count}</b> ${kind === 'archived' ? 'archived ' : kind === 'shared' ? 'shared ' : ''}bookmark${count === 1 ? '' : 's'}${count ? ` · ${from}–${to}` : ''}</span><span class="sp"></span>
    <details id="filt" class="filter"><summary class="btn sm" title="Sort and filter">⚙ Filters</summary><div class="pop">
      <label>Sort<select id="sortsel"><option value="added_desc">Added ↓</option><option value="added_asc">Added ↑</option><option value="title_asc">Title A–Z</option><option value="title_desc">Title Z–A</option><option value="modified_desc">Modified ↓</option><option value="modified_asc">Modified ↑</option></select></label>
      <label>Unread<select id="unreadsel"><option value="">All</option><option value="yes">Unread only</option><option value="no">Read only</option></select></label>
      ${profile.enable_sharing ? '<label>Shared<select id="sharedsel"><option value="">All</option><option value="yes">Shared only</option><option value="no">Not shared</option></select></label>' : ''}
      <div class="row"><button class="btn sm" id="saveprefs" type="button">Save as default</button></div></div></details>
    ${readOnly ? '' : `<button class="btn sm${bulkMode ? ' primary' : ''}" id="bulkbtn" type="button" title="Select several bookmarks">✎ Bulk edit</button>`}`;
  $('#filt').open = filtOpen;
  $('#unreadsel').value = unread; $('#sortsel').value = sort;
  if ($('#sharedsel')) { $('#sharedsel').value = shared; $('#sharedsel').onchange = e => setQuery({shared: e.target.value || 'off'}); }
  $('#unreadsel').onchange = e => setQuery({unread: e.target.value || 'off'});
  $('#sortsel').onchange = e => setQuery({sort: e.target.value});
  $('#saveprefs').onclick = async () => {
    try {
      profile = await api('PATCH', '/api/user/profile/', {search_preferences: {sort: listState.sort, unread: listState.unread || 'off', shared: listState.shared || 'off'}});
      toast('Saved as default'); $('#filt').open = false;
    } catch (e) { fail(e); }
  };
  if ($('#bulkbtn')) $('#bulkbtn').onclick = () => { listState.bulkMode = !listState.bulkMode; $('#list').classList.toggle('bulk-on', listState.bulkMode); $('#bulkbtn').classList.toggle('primary', listState.bulkMode); if (!listState.bulkMode) $$('.sel').forEach(c => c.checked = false); updateBulk(); };
  $('#list').classList.toggle('bulk-on', !!bulkMode);
}

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function renderSide(tags, bundles) {
  const side = $('#side'); if (!side) return;
  if (listState.kind === 'shared') { side.innerHTML = ''; return; }
  const q = listState.q.toLowerCase();
  const on = n => new RegExp('(^|\\s)#' + reEsc(n.toLowerCase()) + '(\\s|$)').test(q);
  const bOpen = lsGet('ld.bundles', '1') === '1', tOpen = lsGet('ld.tags', '1') === '1';
  const groups = new Map();
  for (const t of tags) {
    const c = t.name[0] || '#', k = /[a-z0-9]/i.test(c) ? c.toUpperCase() : c;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const tagHTML = tags.length ? [...groups].map(([k, ts]) => `<div class="tg">${ts.map(t => {
    const cls = on(t.name) ? ' class="on"' : '';
    return `<a href="#" data-tag="${esc(t.name)}"${cls} title="${t.count}"><u>${esc(t.name[0])}</u>${esc(t.name.slice(1))}</a>`;
  }).join(' ')}</div>`).join('') : '<p class="note">No tags yet.</p>';
  const bundleHTML = bundles.length ? bundles.map(b => `<div class="bd${String(b.id) === listState.bundle ? ' on' : ''}"><a href="#" data-bundle="${b.id}">${esc(b.name)}</a><button class="link" data-bedit="${b.id}" title="Edit bundle">✎</button></div>`).join('') : '<p class="note">No bundles yet.</p>';
  side.innerHTML = `<section><div class="sh"><h3>Bundles</h3><button class="btn sm" data-toggle="bundles" title="Show / hide" aria-expanded="${bOpen}">≡</button></div>${bOpen ? bundleHTML + '<p><button class="link" data-bnew>+ New bundle</button></p>' : ''}</section>
    <section><div class="sh"><h3>Tags</h3><button class="btn sm" data-toggle="tags" title="Show / hide" aria-expanded="${tOpen}">≡</button></div>${tOpen ? tagHTML : ''}</section>`;
  side.onclick = e => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) { lsSet('ld.' + tg.dataset.toggle, lsGet('ld.' + tg.dataset.toggle, '1') === '1' ? '0' : '1'); return renderSide(tags, bundles); }
    if (e.target.closest('[data-bnew]')) return openBundle(null);
    const be = e.target.closest('[data-bedit]');
    if (be) return openBundle(bundles.find(b => b.id === +be.dataset.bedit));
    const bl = e.target.closest('a[data-bundle]');
    if (bl) { e.preventDefault(); return setQuery({bundle: String(bl.dataset.bundle) === listState.bundle ? '' : bl.dataset.bundle}); }
    const a = e.target.closest('a[data-tag]'); if (!a) return;
    e.preventDefault();
    const t = a.dataset.tag, cur = listState.q;
    const re = new RegExp('(^|\\s)#' + reEsc(t) + '(?=\\s|$)', 'i');
    setQuery({q: re.test(cur) ? cur.replace(re, ' ').trim() : (cur + ' #' + t).trim()});
  };
}

function bmHTML(b) {
  const shared = listState.kind === 'shared';
  const fav = profile.enable_favicons ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(b.url))}&sz=32" alt="" loading="lazy">` : '';
  const target = profile.bookmark_link_target === '_self' ? '_self' : '_blank';
  const tags = b.tag_names.map(t => `<a class="tag" href="/bookmarks?q=${encodeURIComponent('#' + t)}" data-nav>#${esc(t)}</a>`).join(' ');
  const line = tags || b.description ? `<div class="line">${tags}${tags && b.description ? ' <span class="sep">|</span> ' : ''}${b.description ? `<span class="desc">${esc(b.description)}</span>` : ''}</div>` : '';
  const acts = shared ? '<button data-act="view">View</button>' : `
    <button data-act="view">View</button>
    <button data-act="edit">Edit</button>
    <button data-act="${b.is_archived ? 'unarchive' : 'archive'}">${b.is_archived ? 'Unarchive' : 'Archive'}</button>
    <button class="del" data-act="delete">Remove</button>
    <span class="sep">|</span>
    <button data-act="toggleunread" class="${b.unread ? 'on' : ''}" title="Toggle unread">📖 Unread</button>
    ${profile.enable_sharing ? `<button data-act="share" class="${b.shared ? 'on' : ''}">${b.shared ? 'Shared' : 'Share'}</button>` : ''}
    ${b.notes ? '<button data-act="notes">Notes</button>' : ''}`;
  return `<li class="bm${b.unread ? ' unread' : ''}" data-id="${b.id}">
    ${shared ? '' : '<input type="checkbox" class="sel" aria-label="Select">'}
    <div class="main">
      <a class="title" href="${esc(b.url)}" target="${target}" rel="noopener noreferrer">${fav}${esc(b.title || b.url)}</a>
      ${profile.display_url || !b.title ? `<div class="url">${esc(b.url)}</div>` : ''}
      ${line}
      ${b.notes ? `<div class="notes"${profile.permanent_notes ? '' : ' hidden'}>${esc(b.notes)}</div>` : ''}
      <div class="meta"><span title="${esc(b.date_added)}">${rel(b.date_added)}</span><span class="sep">|</span>${acts}</div>
    </div></li>`;
}

function renderList() {
  const el = $('#list');
  el.innerHTML = listState.items.length ? listState.items.map(bmHTML).join('') : `<li class="empty">${listState.q ? 'No bookmarks match your search.' : 'No bookmarks here yet.'}</li>`;
  updateBulk();
}

function renderPager() {
  const {count, page} = listState, last = Math.max(0, Math.ceil(count / PER) - 1);
  $('#pager').innerHTML = count > PER ? `<button class="btn" ${page <= 0 ? 'disabled' : ''} data-p="${page - 1}">← Newer</button><span>Page ${page + 1} of ${last + 1}</span><button class="btn" ${page >= last ? 'disabled' : ''} data-p="${page + 1}">Older →</button>` : '';
  $('#pager').onclick = e => { const b = e.target.closest('[data-p]'); if (b) setQuery({page: b.dataset.p === '0' ? '' : b.dataset.p}); };
}

async function onListClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const li = btn.closest('.bm'), id = +li.dataset.id, b = listState.items.find(x => x.id === id), act = btn.dataset.act;
  try {
    if (act === 'notes') { $('.notes', li).hidden = !$('.notes', li).hidden; return; }
    if (act === 'view') return openView(b);
    if (act === 'edit') return openForm(b);
    if (act === 'delete') {
      if (!confirm('Remove this bookmark?')) return;
      li.remove(); listState.count--; await api('DELETE', `/api/bookmarks/${id}/`); tagStats = null; getTags(true).then(t => renderSide(t, bundlesCache || [])); renderToolbar(); return;
    }
    if (act === 'archive' || act === 'unarchive') { li.remove(); listState.count--; await api('POST', `/api/bookmarks/${id}/${act}/`); toast(act === 'archive' ? 'Archived' : 'Unarchived'); renderToolbar(); return; }
    if (act === 'toggleunread') { b.unread = !b.unread; li.outerHTML = bmHTML(b); await api('PATCH', `/api/bookmarks/${id}/`, {unread: b.unread}); return; }
    if (act === 'share') { b.shared = !b.shared; li.outerHTML = bmHTML(b); await api('PATCH', `/api/bookmarks/${id}/`, {shared: b.shared}); return; }
  } catch (err) { fail(err); listView(listState.kind, new URLSearchParams(location.search)); }
}

// ---------------------------------------------------------------- bulk
function selectedIds() { return $$('.sel:checked').map(c => +c.closest('.bm').dataset.id); }
function updateBulk() {
  const box = $('#bulk'); if (!box) return;
  if (!listState.bulkMode) { box.innerHTML = ''; return; }
  const n = selectedIds().length;
  const arch = listState.kind === 'archived';
  box.innerHTML = `<div class="bulk"><b>${n} selected</b>
    <button class="btn sm" data-b="all">${n && $$('.sel').every(c => c.checked) ? 'Select none' : 'Select all'}</button>
    ${n ? `<button class="btn sm" data-b="${arch ? 'unarchive' : 'archive'}">${arch ? 'Unarchive' : 'Archive'}</button>
    <button class="btn sm" data-b="read">Mark read</button><button class="btn sm" data-b="unread">Mark unread</button>
    ${profile.enable_sharing ? '<button class="btn sm" data-b="share">Share</button><button class="btn sm" data-b="unshare">Unshare</button>' : ''}
    <button class="btn sm" data-b="tag">Add tags…</button><button class="btn sm" data-b="untag">Remove tags…</button>
    <button class="btn sm danger" data-b="delete">Delete</button>` : ''}</div>`;
  box.onclick = async e => {
    const a = e.target.closest('[data-b]'); if (!a) return;
    let act = a.dataset.b, tags;
    if (act === 'all') { const all = $$('.sel').every(c => c.checked); $$('.sel').forEach(c => c.checked = !all); return updateBulk(); }
    if (act === 'delete' && !confirm(`Delete ${n} bookmarks?`)) return;
    if (act === 'tag' || act === 'untag') { const t = prompt('Tags (space separated)'); if (!t) return; tags = t.split(/[\s,]+/).filter(Boolean); }
    try { await api('POST', '/api/bookmarks/bulk/', {action: act, ids: selectedIds(), tags}); tagStats = null; toast('Done'); listView(listState.kind, new URLSearchParams(location.search)); } catch (er) { fail(er); }
  };
}

// ---------------------------------------------------------------- details / bundles dialogs
let bundlesCache = null;
async function getBundles(force) {
  if (!bundlesCache || force) { try { bundlesCache = (await api('GET', '/api/bundles/?limit=500')).results; } catch { bundlesCache = bundlesCache || []; } }
  return bundlesCache;
}

function mkDialog(id) {
  let d = document.getElementById(id);
  if (!d) { d = document.createElement('dialog'); d.id = id; document.body.appendChild(d); d.addEventListener('click', e => { if (e.target === d) d.close(); }); }
  return d;
}

function openView(b) {
  const d = mkDialog('viewdlg');
  const full = iso => new Date(iso).toLocaleString();
  d.innerHTML = `<h2>${esc(b.title || b.url)}</h2>
    <p><a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${esc(b.url)}</a></p>
    ${b.tag_names.length ? `<div class="tags">${b.tag_names.map(t => `<a class="tag" href="/bookmarks?q=${encodeURIComponent('#' + t)}" data-nav>#${esc(t)}</a>`).join(' ')}</div>` : ''}
    ${b.description ? `<h4>Description</h4><p style="white-space:pre-wrap">${esc(b.description)}</p>` : ''}
    ${b.notes ? `<h4>Notes</h4><div class="notes">${esc(b.notes)}</div>` : ''}
    <table class="kv"><tr><th>Added</th><td>${full(b.date_added)}</td></tr><tr><th>Modified</th><td>${full(b.date_modified)}</td></tr>
    <tr><th>Status</th><td>${[b.is_archived ? 'archived' : 'active', b.unread ? 'unread' : 'read', b.shared ? 'shared' : 'private'].join(' · ')}</td></tr>
    <tr><th>Web archive</th><td><a href="${esc(b.web_archive_snapshot_url)}" target="_blank" rel="noopener noreferrer">Wayback Machine</a></td></tr></table>
    <div class="row" style="justify-content:flex-end;margin-top:14px">${listState.kind === 'shared' ? '' : '<button class="btn" id="vedit">Edit</button>'}<button class="btn primary" id="vclose">Close</button></div>`;
  d.querySelector('#vclose').onclick = () => d.close();
  d.querySelectorAll('a[data-nav]').forEach(a => a.addEventListener('click', () => d.close()));
  if (d.querySelector('#vedit')) d.querySelector('#vedit').onclick = () => { d.close(); openForm(b); };
  d.showModal();
}

function openBundle(b) {
  const d = mkDialog('bundledlg');
  const sel = (n, v) => `<select name="${n}">${[['off', 'Any'], ['yes', 'Yes'], ['no', 'No']].map(([k, l]) => `<option value="${k}"${(v || 'off') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  d.innerHTML = `<form method="dialog"><h2>${b ? 'Edit' : 'New'} bundle</h2>
    <label>Name<input name="name" required maxlength="256" value="${esc(b ? b.name : '')}"></label>
    <label>Search terms<input name="search" maxlength="256" placeholder="e.g. rust async" value="${esc(b ? b.search : '')}"></label>
    <label>Any of these tags<input name="any_tags" placeholder="space-separated" value="${esc(b ? b.any_tags : '')}"></label>
    <label>All of these tags<input name="all_tags" placeholder="space-separated" value="${esc(b ? b.all_tags : '')}"></label>
    <label>Exclude these tags<input name="excluded_tags" placeholder="space-separated" value="${esc(b ? b.excluded_tags : '')}"></label>
    <div class="row"><label>Unread${sel('filter_unread', b && b.filter_unread)}</label><label>Shared${sel('filter_shared', b && b.filter_shared)}</label></div>
    <p class="error" id="bderr" hidden></p>
    <div class="row" style="justify-content:flex-end">${b ? '<button class="btn danger" type="button" id="bddel" style="margin-right:auto">Delete</button>' : ''}<button class="btn" type="button" id="bdcancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
  const f = d.querySelector('form');
  d.querySelector('#bdcancel').onclick = () => d.close();
  if (b) d.querySelector('#bddel').onclick = async () => {
    if (!confirm('Delete this bundle? Bookmarks are kept.')) return;
    try { await api('DELETE', `/api/bundles/${b.id}/`); d.close(); await getBundles(true); if (String(b.id) === listState.bundle) setQuery({bundle: ''}); else renderSide(await getTags(), bundlesCache); } catch (e) { fail(e); }
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const body = {};
    for (const el of f.elements) if (el.name) body[el.name] = el.value.trim();
    try {
      if (b) await api('PATCH', `/api/bundles/${b.id}/`, body); else await api('POST', '/api/bundles/', body);
      d.close(); await getBundles(true); renderSide(await getTags(), bundlesCache); toast('Bundle saved');
    } catch (er) { const x = d.querySelector('#bderr'); x.textContent = er.message; x.hidden = false; }
  };
  d.showModal();
}

// ---------------------------------------------------------------- add / edit dialog
let dlg;
function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" id="bf" autocomplete="off"><h2 id="bt">Add bookmark</h2>
    <label>URL<input name="url" type="url" required placeholder="https://"></label><p class="note warn" id="dup" hidden>Already bookmarked — you are editing the existing entry.</p>
    <label>Tags<input name="tags" list="taglist" placeholder="space-separated"></label><datalist id="taglist"></datalist>
    <label>Title<input name="title" placeholder="Leave blank to fetch automatically"></label>
    <label>Description<textarea name="description" placeholder="Leave blank to fetch automatically"></textarea></label>
    <label>Notes<textarea name="notes"></textarea></label>
    <div class="row"><label class="chk"><input type="checkbox" name="unread"> Mark as unread</label><label class="chk" id="sharelbl"><input type="checkbox" name="shared"> Share</label></div>
    <p class="error" id="berr" hidden></p>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="bcancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
  document.body.appendChild(dlg);
  $('#bcancel', dlg).onclick = () => dlg.close();
  dlg.addEventListener('close', () => { if (/^\/bookmarks\/(new|\d+\/edit)$/.test(location.pathname)) history.replaceState(null, '', '/bookmarks'); });
  return dlg;
}

async function openForm(b, pre) {
  ensureDialog();
  const f = $('#bf', dlg);
  f.reset();
  let editId = b ? b.id : null, autoClose = pre && pre.autoClose;
  $('#bt', dlg).textContent = b ? 'Edit bookmark' : 'Add bookmark';
  $('#dup', dlg).hidden = true; $('#berr', dlg).hidden = true;
  $('#sharelbl', dlg).hidden = !profile.enable_sharing;
  const fill = x => {
    f.url.value = x.url || ''; f.title.value = x.title || ''; f.description.value = x.description || ''; f.notes.value = x.notes || '';
    f.tags.value = (x.tag_names || []).join(' '); f.unread.checked = !!x.unread; f.shared.checked = !!x.shared;
  };
  if (b) fill(b);
  else {
    const p = pre || {};
    fill({url: p.url, title: p.title, description: p.description, notes: p.notes, tag_names: (p.tags || '').split(/[\s,]+/).filter(Boolean), unread: profile.default_mark_unread});
  }
  getTags().then(t => { $('#taglist', dlg).innerHTML = t.map(x => `<option value="${esc(x.name)}">`).join(''); });
  const check = async () => {
    const u = f.url.value.trim();
    if (editId || !/^https?:\/\//i.test(u)) return;
    try {
      const r = await api('GET', '/api/bookmarks/check/?url=' + encodeURIComponent(u));
      if (r.bookmark) { editId = r.bookmark.id; fill(r.bookmark); $('#dup', dlg).hidden = false; $('#bt', dlg).textContent = 'Edit bookmark'; }
      else { if (!f.title.value) f.title.placeholder = r.metadata.title || f.title.placeholder; if (!f.description.value) f.description.placeholder = r.metadata.description || f.description.placeholder; }
    } catch { /* offline checks are optional */ }
  };
  f.url.onchange = check;
  f.onsubmit = async e => {
    e.preventDefault();
    const body = {url: f.url.value.trim(), title: f.title.value.trim(), description: f.description.value.trim(), notes: f.notes.value, unread: f.unread.checked, shared: f.shared.checked, tag_names: f.tags.value.split(/[\s,]+/).filter(Boolean)};
    try {
      if (editId) await api('PATCH', `/api/bookmarks/${editId}/`, body); else await api('POST', '/api/bookmarks/', body);
      dlg.close(); tagStats = null; toast('Saved');
      if (autoClose) { window.close(); nav('/bookmarks/close', true); } else listView(listState.kind || 'active', new URLSearchParams(location.search));
    } catch (er) { const x = $('#berr', dlg); x.textContent = er.message; x.hidden = false; }
  };
  dlg.showModal();
  if (!b) { f.url.focus(); check(); }
}

// ---------------------------------------------------------------- tags page
async function tagsView() {
  listState.kind = '';
  const tags = await getTags(true);
  app.innerHTML = `<div class="stack"><div class="card"><h2>Tags <small class="note">${tags.length}</small></h2>
    <div class="row" style="margin-bottom:10px"><input id="tagf" placeholder="Filter tags…" style="max-width:260px"><span class="sp"></span><button class="btn" id="merge" disabled>Merge selected…</button></div>
    <table><thead><tr><th></th><th>Name</th><th>Bookmarks</th><th></th></tr></thead><tbody id="tt"></tbody></table></div></div>`;
  const draw = () => {
    const f = $('#tagf').value.toLowerCase();
    $('#tt').innerHTML = tags.filter(t => t.name.toLowerCase().includes(f)).map(t => `<tr data-id="${t.id}" data-name="${esc(t.name)}"><td><input type="checkbox" class="ts"></td><td><a href="/bookmarks?q=${encodeURIComponent('#' + t.name)}" data-nav>${esc(t.name)}</a></td><td>${t.count}</td><td style="text-align:right"><button class="link" data-a="rename">Rename</button> · <button class="link" data-a="del">Delete</button></td></tr>`).join('');
  };
  draw();
  $('#tagf').oninput = draw;
  $('#tt').onchange = () => { $('#merge').disabled = $$('.ts:checked').length < 2; };
  $('#tt').onclick = async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const tr = a.closest('tr'), id = tr.dataset.id, name = tr.dataset.name;
    try {
      if (a.dataset.a === 'del') { if (!confirm(`Delete tag "${name}"? Bookmarks are kept.`)) return; await api('DELETE', `/api/tags/${id}/`); }
      else { const n = prompt('New name', name); if (!n || n === name) return; await api('PATCH', `/api/tags/${id}/`, {name: n}); }
      tagsView();
    } catch (er) { fail(er); }
  };
  $('#merge').onclick = async () => {
    const names = $$('.ts:checked').map(c => c.closest('tr').dataset.name);
    const target = prompt(`Merge ${names.join(', ')} into which tag?`, names[0]);
    if (!target) return;
    try { await api('POST', '/api/tags/merge/', {target, sources: names.filter(n => n !== target)}); toast('Merged'); tagsView(); } catch (er) { fail(er); }
  };
}

// ---------------------------------------------------------------- settings
async function settingsView() {
  listState.kind = '';
  let tokens = [];
  try { tokens = await api('GET', '/api/user/tokens/'); } catch (e) { fail(e); }
  const origin = location.origin;
  const bookmarklet = `javascript:(function(){window.open('${origin}/bookmarks/new?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+'&description='+encodeURIComponent((document.querySelector('meta[name=description]')||{}).content||'')+'&auto_close','_blank','width=540,height=680')})()`;
  const sel = (n, opts) => `<select name="${n}">${opts.map(([v, l]) => `<option value="${v}"${profile[n] === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const chk = (n, l) => `<label class="chk"><input type="checkbox" name="${n}"${profile[n] ? ' checked' : ''}> ${l}</label>`;
  app.innerHTML = `<div class="stack">
  <form class="card" id="pf"><h2>Preferences</h2>
    <label>Theme${sel('theme', [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']])}</label>
    <label>Date display${sel('bookmark_date_display', [['relative', 'Relative'], ['absolute', 'Absolute']])}</label>
    <label>Open links in${sel('bookmark_link_target', [['_blank', 'New tab'], ['_self', 'Same tab']])}</label>
    <label>Tag search${sel('tag_search', [['strict', 'Strict (#tag only)'], ['lax', 'Lax (plain words also match tags)']])}</label>
    ${chk('display_url', 'Show URLs')}${chk('permanent_notes', 'Always show notes')}${chk('enable_favicons', 'Show favicons (loads icons from Google)')}
    ${chk('enable_sharing', 'Enable bookmark sharing')}${chk('enable_public_sharing', 'Share publicly (no login needed at /bookmarks/shared)')}
    <div class="row" style="margin-top:10px"><button class="btn primary">Save preferences</button></div></form>

  <div class="card"><h2>Browser extension &amp; API</h2>
    <p class="note">Use these in the linkding browser extension: <b>Base URL</b> <code>${esc(origin)}</code> and an API token below.</p>
    <table><tbody id="tk">${tokens.map(t => `<tr><td>${esc(t.name || 'Token')}</td><td><code class="tokenv">${esc(t.token)}</code></td><td style="text-align:right"><button class="link" data-copy="${esc(t.token)}">Copy</button> · <button class="link" data-del="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td class="note">No tokens yet.</td></tr>'}</tbody></table>
    <div class="row" style="margin-top:10px"><input id="tname" placeholder="Token name (optional)" style="max-width:240px"><button class="btn" id="tnew">Create token</button></div>
    <p class="note" style="margin-top:12px">Bookmarklet: drag this to your bookmarks bar → <a href="${esc(bookmarklet)}">Add to linkding</a></p></div>

  <div class="card"><h2>Import &amp; export</h2>
    <form id="imp"><label>Netscape HTML bookmark file<input type="file" name="import_file" accept=".html,.htm" required></label>
      ${'<label class="chk"><input type="checkbox" name="map_private_flag"> Mark bookmarks as shared unless PRIVATE="1"</label>'}
      <div class="row"><button class="btn">Import</button><span id="impmsg" class="note"></span></div></form>
    <p style="margin-top:14px"><a class="btn" href="/settings/export">Export all bookmarks</a></p></div>

  <form class="card" id="pw"><h2>Change password</h2>
    <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
    <label>New password (min. 8 characters)<input type="password" name="new" autocomplete="new-password" minlength="8" required></label>
    <button class="btn">Change password</button> <a class="btn" href="/logout/" style="margin-left:8px">Log out</a></form></div>`;

  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, body = {};
    for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    try { profile = await api('PATCH', '/api/user/profile/', body); applyTheme(); toast('Preferences saved'); } catch (er) { fail(er); }
  };
  $('#tnew').onclick = async () => { try { await api('POST', '/api/user/tokens/', {name: $('#tname').value}); settingsView(); } catch (er) { fail(er); } };
  $('#tk').onclick = async e => {
    const c = e.target.closest('[data-copy]'), d = e.target.closest('[data-del]');
    if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied')); }
    if (d && confirm('Delete this token? Clients using it will stop working.')) { try { await api('DELETE', `/api/user/tokens/${d.dataset.del}/`); settingsView(); } catch (er) { fail(er); } }
  };
  $('#imp').onsubmit = async e => {
    e.preventDefault();
    $('#impmsg').textContent = 'Importing…';
    const r = await fetch('/settings/import', {method: 'POST', headers: {'X-Requested-With': 'ld'}, body: new FormData(e.target), credentials: 'same-origin'});
    const d = await r.json().catch(() => ({}));
    $('#impmsg').textContent = r.ok ? d.message : (d.detail || 'Import failed');
    tagStats = null;
  };
  $('#pw').onsubmit = async e => {
    e.preventDefault();
    try { await api('POST', '/api/user/password/', {current: e.target.current.value, new: e.target.new.value}); toast('Password changed'); e.target.reset(); } catch (er) { fail(er); }
  };
}

// ---------------------------------------------------------------- boot
$('#search').addEventListener('submit', e => e.preventDefault());
$('#q').addEventListener('input', debounce(() => {
  const v = $('#q').value;
  if (!/^\/bookmarks(\/archived|\/shared)?$/.test(location.pathname)) { nav('/bookmarks' + (v ? '?q=' + encodeURIComponent(v) : '')); return; }
  setQuery({q: v});
}, 160));
$('#add').addEventListener('click', () => openForm(null));
addEventListener('keydown', e => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
});

(async () => {
  anon = location.pathname === '/bookmarks/shared';
  try { profile = await api('GET', '/api/user/profile/'); applyTheme(); if (!profile.enable_sharing) $('nav a[href="/bookmarks/shared"]').hidden = true; } catch (e) { if (!anon) return; profile = {}; $('#add').hidden = true; }
  route();
})();
})();
