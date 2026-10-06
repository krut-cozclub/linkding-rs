/* linkding-rs frontend: vanilla JS that renders the same DOM (and uses the same stylesheets) as linkding. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const V = document.documentElement.dataset.v;
const ico = (n, w = 20, h = w) => `<svg width="${w}" height="${h}"><use href="/static/icons.svg?v=${V}#${n}"></use></svg>`;
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const content = $('#content'), nav = $('#nav'), modals = $('.modals');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };

let profile = {};
let anon = false;
let tagCache = null;
let bundleCache = null;

// ---------------------------------------------------------------- api / helpers
function errText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d.detail) return d.detail;
  if (d.error) return d.error;
  return Object.values(d).flat().join(' ');
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
  if (!r.ok) { const e = new Error(errText(data) || r.statusText); e.data = data; e.status = r.status; throw e; }
  return data;
}

function flash(msg, type = 'success') {
  $('#messages').innerHTML = `<div class="toast toast-${type}" role="alert">${esc(msg)}</div>`;
}
const clearFlash = () => { $('#messages').innerHTML = ''; };
const fail = e => { if (e && e.message !== 'auth') flash(e.message || 'Something went wrong', 'error'); };
const safeReturn = u => (u && u[0] === '/' && u[1] !== '/') ? u : '/bookmarks';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dateDelta(now, v) {
  let years = now.getFullYear() - v.getFullYear();
  if (now.getMonth() < v.getMonth() || (now.getMonth() === v.getMonth() && now.getDate() < v.getDate())) years--;
  let months = (now.getFullYear() - v.getFullYear()) * 12 + (now.getMonth() - v.getMonth());
  if (now.getDate() < v.getDate()) months--;
  const weeks = Math.floor((now - v) / 86400000 / 7);
  return {years: Math.max(0, years), months: Math.max(0, months), weeks: Math.max(0, weeks)};
}
const plural = n => (n === 1 ? '' : 's');
function humanDate(iso, mode) {
  if (mode === 'hidden') return '';
  const v = new Date(iso), now = new Date(), d = dateDelta(now, v), y = new Date(now - 86400000);
  if (mode === 'absolute') {
    if (d.years > 0 || d.months > 0 || d.weeks > 0) return v.toLocaleDateString('en-US', {month: '2-digit', day: '2-digit', year: 'numeric'});
  } else {
    if (d.years > 0) return `${d.years} year${plural(d.years)} ago`;
    if (d.months > 0) return `${d.months} month${plural(d.months)} ago`;
    if (d.weeks > 0) return `${d.weeks} week${plural(d.weeks)} ago`;
  }
  if (v.getDate() === now.getDate()) return 'Today';
  if (v.getDate() === y.getDate()) return 'Yesterday';
  return WEEKDAYS[v.getDay()];
}

// Small, safe Markdown subset for notes (escapes HTML first).
function markdown(src) {
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null, code = null, para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.t}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.t}>`); list = null; } };
  for (const line of String(src).replace(/\r\n/g, '\n').split('\n')) {
    if (code !== null) { if (line.startsWith('```')) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; } else code.push(line); continue; }
    if (line.startsWith('```')) { flushPara(); flushList(); code = []; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ul') { flushList(); list = {t: 'ul', items: []}; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ol') { flushList(); list = {t: 'ol', items: []}; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushPara(); flushList();
  return out.join('');
}

async function getTags(force) {
  if (!tagCache || force) { try { tagCache = (await api('GET', '/api/tags/?limit=5000')).results; } catch { tagCache = tagCache || []; } }
  return tagCache;
}
async function getBundles(force) {
  if (!bundleCache || force) { try { bundleCache = (await api('GET', '/api/bundles/?limit=500')).results; } catch { bundleCache = bundleCache || []; } }
  return bundleCache;
}

function applyTheme() {
  const t = profile.theme, d = $('#css-dark'), l = $('#css-light');
  if (t === 'light') { d.media = 'not all'; l.media = 'all'; }
  else if (t === 'dark') { l.media = 'not all'; d.media = 'all'; }
  else { d.media = '(prefers-color-scheme: dark)'; l.media = '(prefers-color-scheme: light)'; }
  lsSet('ld.theme', t === 'light' || t === 'dark' ? t : '');
  let css = $('#css-custom');
  if (profile.custom_css) {
    if (!css) { css = document.createElement('link'); css.id = 'css-custom'; css.rel = 'stylesheet'; document.head.appendChild(css); }
    css.href = '/custom_css?v=' + encodeURIComponent(profile.custom_css.length + ':' + profile.custom_css.slice(0, 40));
  } else if (css) css.remove();
}

// ---------------------------------------------------------------- floating things
function placeFixed(anchor, overlay, {placement = 'bottom', offset = 4, arrow = null, autoWidth = false} = {}) {
  const a = anchor.getBoundingClientRect();
  overlay.style.position = 'fixed';
  if (autoWidth) overlay.style.width = a.width + 'px';
  const o = overlay.getBoundingClientRect();
  let top = a.bottom + offset, side = 'bottom';
  if (top + o.height > innerHeight - 8 && a.top - offset - o.height > 8) { top = a.top - offset - o.height; side = 'top'; }
  let left = placement.endsWith('start') ? a.left : a.left + a.width / 2 - o.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - o.width - 8));
  overlay.style.left = left + 'px'; overlay.style.top = top + 'px';
  overlay.classList.toggle('top-aligned', side === 'top');
  if (arrow) arrow.style.left = Math.max(4, Math.min(a.left + a.width / 2 - left - 8, o.width - 20)) + 'px';
}

// confirm dropdown for buttons with data-confirm
let confirmEl = null;
function closeConfirm() { if (confirmEl) { confirmEl.remove(); confirmEl = null; } }
function showConfirm(button) {
  closeConfirm();
  const el = document.createElement('div');
  el.className = 'dropdown confirm-dropdown active';
  el.innerHTML = `<div class="menu with-arrow" role="alertdialog" aria-modal="true"><span style="font-weight: bold;">${esc(button.dataset.confirmQuestion || 'Are you sure?')}</span>
    <button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-error" data-ok>Confirm</button><div class="menu-arrow"></div></div>`;
  document.body.appendChild(el);
  confirmEl = el;
  const menu = $('.menu', el);
  placeFixed(button, menu, {offset: 12, arrow: $('.menu-arrow', menu)});
  $('[data-ok]', el).focus();
  $('[data-cancel]', el).onclick = () => { closeConfirm(); button.focus(); };
  $('[data-ok]', el).onclick = () => { closeConfirm(); button.dataset.confirmed = '1'; button.click(); delete button.dataset.confirmed; };
}

// generic modal
function openModal(inner, cls = '', onClose) {
  const m = document.createElement('div');
  m.className = `modal active ${cls}`;
  m.innerHTML = `<div class="modal-overlay" data-close-modal></div><div class="modal-container" role="dialog" aria-modal="true">${inner}</div>`;
  modals.appendChild(m);
  document.body.classList.add('scroll-lock');
  let closed = false;
  m.close = () => {
    if (closed) return; closed = true;
    const finish = () => { m.remove(); if (!$('.modal')) document.body.classList.remove('scroll-lock'); if (onClose) onClose(); };
    m.classList.add('closing');
    m.addEventListener('animationend', e => { if (e.animationName === 'fade-out') finish(); }, {once: true});
    setTimeout(finish, 400);
  };
  m.addEventListener('click', e => { if (e.target.closest('[data-close-modal]')) { e.preventDefault(); m.close(); } });
  return m;
}
const modalHeader = title => `<div class="modal-header"><h2 class="title">${esc(title)}</h2><button type="button" class="btn btn-noborder close" aria-label="Close dialog" data-close-modal>${ico('close', 24)}</button></div>`;
const closeAllModals = () => $$('.modal').forEach(m => m.close ? m.close() : m.remove());

// ---------------------------------------------------------------- global listeners
document.addEventListener('click', e => {
  // links that navigate inside the app
  const a = e.target.closest('a[data-nav], a[href^="?"]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && !a.target) {
    const href = a.getAttribute('href');
    e.preventDefault();
    go(href.startsWith('?') ? location.pathname + href : href);
    return;
  }
  // confirmation dropdowns
  const cb = e.target.closest('button[data-confirm]');
  if (cb && !cb.dataset.confirmed) { e.preventDefault(); e.stopPropagation(); showConfirm(cb); return; }
  if (confirmEl && !e.target.closest('.confirm-dropdown')) closeConfirm();
  // dropdown menus
  const tg = e.target.closest('.dropdown-toggle');
  const dd = tg && tg.closest('.dropdown');
  $$('.dropdown.active:not(.confirm-dropdown)').forEach(d => { if (d !== dd) d.classList.remove('active'); });
  if (dd) { dd.classList.toggle('active'); tg.setAttribute('aria-expanded', String(dd.classList.contains('active'))); }
}, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeConfirm();
  $$('.dropdown.active:not(.confirm-dropdown)').forEach(d => d.classList.remove('active'));
  if (!/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.nodeName)) { const m = $$('.modal').pop(); if (m && m.close) m.close(); }
});
addEventListener('popstate', route);
addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 's') { const i = $('.search-container input[type=search]'); if (i) { e.preventDefault(); i.focus(); } }
  if (e.key === 'n') { e.preventDefault(); go('/bookmarks/new'); }
  if (e.key === 'e') { $$('.bookmark-list').forEach(l => l.classList.toggle('show-notes')); }
});

// ---------------------------------------------------------------- router
function go(url, replace) {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  return route();
}

function setParams(patch, replace = true) {
  const qs = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v === '' || v == null) qs.delete(k); else qs.set(k, v); }
  if (!('page' in patch)) qs.delete('page');
  return go(location.pathname + (qs.toString() ? '?' + qs : ''), replace);
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  closeConfirm();
  $$('.dropdown.active').forEach(d => d.classList.remove('active'));
  const p = (location.pathname.replace(/\/+$/, '') || '/'), qs = new URLSearchParams(location.search);
  if (p !== '/bookmarks/close') clearFlash();
  let m;
  if (p === '/bookmarks/close') { document.title = 'Linkding'; content.innerHTML = '<div class="empty"><p class="empty-title h5">Bookmark saved</p><p class="empty-subtitle">You can close this window.</p></div>'; window.close(); return; }
  if (p === '/bookmarks/new') return formPage(null, qs);
  if ((m = p.match(/^\/bookmarks\/(\d+)\/edit$/))) return formPage(+m[1], qs);
  if (p === '/bookmarks' || p === '/bookmarks/archived' || p === '/bookmarks/shared') {
    return bookmarksPage(p === '/bookmarks/archived' ? 'archived' : p === '/bookmarks/shared' ? 'shared' : 'active', qs, seq);
  }
  if (p === '/tags') return tagsPage(qs);
  if (p === '/bundles') return bundlesPage();
  if (p === '/bundles/new') return bundleFormPage(null, qs);
  if ((m = p.match(/^\/bundles\/(\d+)\/edit$/))) return bundleFormPage(+m[1]);
  if (p === '/settings' || p === '/settings/general') return settingsPage();
  if (p === '/settings/integrations') return integrationsPage();
  if (p === '/change-password') return passwordPage();
  return go('/bookmarks', true);
}

// ---------------------------------------------------------------- nav
function renderNav() {
  if (anon) { nav.innerHTML = '<a href="/login/" class="btn btn-link">Login</a>'; return; }
  const sharing = profile.enable_sharing;
  nav.innerHTML = `
<div class="hide-md">
  <a href="/bookmarks/new" data-nav class="btn btn-primary mr-2">Add bookmark</a>
  <ld-dropdown class="dropdown" style="--dropdown-focus-display:none">
    <button class="btn btn-link dropdown-toggle" tabindex="0" aria-expanded="false">Bookmarks</button>
    <ul class="menu" role="list" tabindex="-1">
      <li class="menu-item"><a href="/bookmarks" data-nav class="menu-link">Active</a></li>
      <li class="menu-item"><a href="/bookmarks/archived" data-nav class="menu-link">Archived</a></li>
      ${sharing ? '<li class="menu-item"><a href="/bookmarks/shared" data-nav class="menu-link">Shared</a></li>' : ''}
      <li class="menu-item"><a href="/bookmarks?unread=yes" data-nav class="menu-link">Unread</a></li>
      <li class="menu-item"><a href="/bookmarks?q=!untagged" data-nav class="menu-link">Untagged</a></li>
    </ul>
  </ld-dropdown>
  <ld-dropdown class="dropdown" style="--dropdown-focus-display:none">
    <button class="btn btn-link dropdown-toggle" tabindex="0" aria-expanded="false">Settings</button>
    <ul class="menu" role="list" tabindex="-1">
      <li class="menu-item"><a href="/settings/general" data-nav class="menu-link">General</a></li>
      <li class="menu-item"><a href="/settings/integrations" data-nav class="menu-link">Integrations</a></li>
    </ul>
  </ld-dropdown>
  <form class="d-inline" action="/logout/" method="post"><button type="submit" class="btn btn-link">Logout</button></form>
</div>
<div class="show-md">
  <a href="/bookmarks/new" data-nav aria-label="Add bookmark" class="btn btn-primary">${ico('plus', 24)}</a>
  <ld-dropdown class="dropdown dropdown-right" style="--dropdown-focus-display:none">
    <button class="btn btn-link dropdown-toggle" aria-label="Navigation menu" tabindex="0" aria-expanded="false">${ico('menu', 24)}</button>
    <ul class="menu" role="list" tabindex="-1">
      <li class="menu-item"><a href="/bookmarks" data-nav class="menu-link">Bookmarks</a></li>
      <li class="menu-item"><a href="/bookmarks/archived" data-nav class="menu-link">Archived bookmarks</a></li>
      ${sharing ? '<li class="menu-item"><a href="/bookmarks/shared" data-nav class="menu-link">Shared bookmarks</a></li>' : ''}
      <li class="menu-item"><a href="/bookmarks?unread=yes" data-nav class="menu-link">Unread</a></li>
      <li class="menu-item"><a href="/bookmarks?q=!untagged" data-nav class="menu-link">Untagged</a></li>
      <div class="divider"></div>
      <li class="menu-item"><a href="/settings/general" data-nav class="menu-link">Settings</a></li>
      <li class="menu-item"><a href="/settings/integrations" data-nav class="menu-link">Integrations</a></li>
      <div class="divider"></div>
      <li class="menu-item"><form class="d-inline" action="/logout/" method="post"><button type="submit" class="btn btn-link menu-link">Logout</button></form></li>
    </ul>
  </ld-dropdown>
</div>`;
}

// ---------------------------------------------------------------- tag input (autocomplete)
function wordBounds(input) {
  const v = input.value, pos = input.selectionStart ?? v.length;
  let s = pos, e = pos;
  while (s > 0 && !/\s/.test(v[s - 1])) s--;
  while (e < v.length && !/\s/.test(v[e])) e++;
  return {start: s, end: e};
}
function wordAt(input) { const b = wordBounds(input); return input.value.slice(b.start, b.end); }

function tagInputHTML({id = '', name = '', value = '', placeholder = ' ', small = false, cls = ''}) {
  return `<div class="form-autocomplete${small ? ' small' : ''}" data-tag-ac>
    <div class="form-autocomplete-input form-input"><input ${id ? `id="${id}"` : ''} ${name ? `name="${name}"` : ''} value="${esc(value)}" placeholder="${esc(placeholder)}" class="form-input ${cls}" type="text" autocomplete="off" autocapitalize="off"></div>
    <ul class="menu"></ul></div>`;
}

function initTagInputs(root) {
  $$('[data-tag-ac]', root).forEach(box => {
    if (box.dataset.ready) return;
    box.dataset.ready = '1';
    const input = $('input', box), menu = $('.menu', box), wrap = $('.form-autocomplete-input', box);
    let items = [], sel = 0;
    const close = () => { menu.classList.remove('open'); menu.style.display = ''; items = []; };
    const render = () => {
      menu.innerHTML = items.map((t, i) => `<li class="menu-item${i === sel ? ' selected' : ''}"><a href="#" data-i="${i}">${esc(t.name)}</a></li>`).join('');
      if (items.length) { menu.classList.add('open'); menu.style.display = 'block'; placeFixed(input, menu, {placement: 'bottom-start', offset: 2}); } else close();
    };
    const complete = t => {
      const b = wordBounds(input);
      input.value = input.value.slice(0, b.start) + t.name + ' ' + input.value.slice(b.end);
      input.dispatchEvent(new Event('input', {bubbles: true}));
      close();
    };
    input.addEventListener('focus', () => wrap.classList.add('is-focused'));
    input.addEventListener('blur', () => { wrap.classList.remove('is-focused'); setTimeout(close, 120); });
    input.addEventListener('input', async () => {
      const word = wordAt(input).toLowerCase();
      if (!word) return close();
      const tags = await getTags();
      const have = input.value.toLowerCase().split(/\s+/);
      items = tags.filter(t => t.name.toLowerCase().startsWith(word) && !(have.includes(t.name.toLowerCase()) && t.name.toLowerCase() !== word)).slice(0, 8);
      sel = 0; render();
    });
    input.addEventListener('keydown', e => {
      if (!items.length) return;
      if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { complete(items[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
    });
    menu.addEventListener('mousedown', e => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); complete(items[+a.dataset.i]); } });
  });
}

// ---------------------------------------------------------------- search box
const HISTORY_KEY = 'ld.searchHistory';
function recentSearches(prefix) {
  let h = []; try { h = JSON.parse(lsGet(HISTORY_KEY, '[]')); } catch { h = []; }
  return h.filter(s => s && (!prefix || s.toLowerCase().includes(prefix.toLowerCase()) && s !== prefix)).slice(0, 5);
}
function pushSearch(q) {
  if (!q) return;
  let h = []; try { h = JSON.parse(lsGet(HISTORY_KEY, '[]')); } catch { h = []; }
  h = [q, ...h.filter(s => s !== q)].slice(0, 30);
  lsSet(HISTORY_KEY, JSON.stringify(h));
}

function initSearchAutocomplete(box, sp, mode) {
  const input = $('input[name=q]', box), menu = $('.menu', box), wrap = $('.form-autocomplete-input', box);
  let list = [], sel;
  const close = () => { menu.classList.remove('open'); menu.style.display = ''; sel = undefined; list = []; };
  const render = () => {
    const groups = [['Tags', 'tag'], ['Recent Searches', 'search'], ['Bookmarks', 'bookmark']];
    menu.innerHTML = groups.map(([title, type]) => {
      const g = list.filter(x => x.type === type); if (!g.length) return '';
      return `<li class="menu-item group-item">${title}</li>` + g.map(x => `<li class="menu-item${x.idx === sel ? ' selected' : ''}"><a href="#" data-i="${x.idx}">${esc(x.label)}</a></li>`).join('');
    }).join('');
    if (list.length) { menu.classList.add('open'); menu.style.display = 'block'; menu.style.maxHeight = '400px'; placeFixed(input, menu, {placement: 'bottom-start', offset: 2, autoWidth: true}); } else close();
  };
  const choose = x => {
    if (x.type === 'search') { input.value = x.value; close(); input.form.requestSubmit(); }
    else if (x.type === 'bookmark') { window.open(x.url, profile.bookmark_link_target === '_self' ? '_self' : '_blank'); close(); }
    else { const b = wordBounds(input); input.value = input.value.slice(0, b.start) + '#' + x.name + ' ' + input.value.slice(b.end); close(); }
  };
  const load = async () => {
    const out = []; let n = 0;
    const w = wordAt(input);
    if (w.length > 1 && w[0] === '#') {
      const tags = await getTags();
      tags.filter(t => t.name.toLowerCase().startsWith(w.slice(1).toLowerCase())).slice(0, 5).forEach(t => out.push({type: 'tag', idx: n++, label: '#' + t.name, name: t.name}));
    }
    recentSearches(input.value).forEach(s => out.push({type: 'search', idx: n++, label: s, value: s}));
    if (input.value.length >= 3) {
      const p = new URLSearchParams({q: input.value, limit: 5});
      if (sp.user) p.set('user', sp.user);
      try {
        const r = await api('GET', MODES[mode].api + '?' + p);
        r.results.forEach(b => out.push({type: 'bookmark', idx: n++, label: (b.title || b.url).slice(0, 60), url: b.url}));
      } catch { /* suggestions are optional */ }
    }
    list = out; sel = undefined; render();
  };
  input.addEventListener('input', debounce(load, 200));
  input.addEventListener('focus', () => wrap.classList.add('is-focused'));
  input.addEventListener('blur', () => { wrap.classList.remove('is-focused'); setTimeout(close, 120); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { if (!list.length) load(); else { sel = sel === undefined ? 0 : (sel + 1) % list.length; render(); } e.preventDefault(); }
    else if (e.key === 'ArrowUp' && list.length) { sel = sel === undefined ? list.length - 1 : (sel - 1 + list.length) % list.length; render(); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && sel !== undefined && list[sel]) { choose(list[sel]); e.preventDefault(); }
    else if (e.key === 'Escape' && list.length) { close(); e.preventDefault(); e.stopPropagation(); }
  });
  menu.addEventListener('mousedown', e => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); choose(list[+a.dataset.i]); } });
}

// ---------------------------------------------------------------- bookmarks page
const MODES = {
  active: {title: 'Bookmarks', path: '/bookmarks', api: '/api/bookmarks/', bulk: true, disabled: ['bulk_unarchive']},
  archived: {title: 'Archived bookmarks', path: '/bookmarks/archived', api: '/api/bookmarks/archived/', bulk: true, disabled: ['bulk_archive']},
  shared: {title: 'Shared bookmarks', path: '/bookmarks/shared', api: '/api/bookmarks/shared/', bulk: false, disabled: []}
};
const SORTS = [['added_asc', 'Added ↑'], ['added_desc', 'Added ↓'], ['modified_asc', 'Modified ↑'], ['modified_desc', 'Modified ↓'], ['title_asc', 'Title ↑'], ['title_desc', 'Title ↓']];
const DEFAULTS = {sort: 'added_desc', shared: 'off', unread: 'off'};
let bm = {mode: null, items: [], total: 0, sp: {}, details: null};

function searchParams(qs) {
  const pref = profile.search_preferences || {};
  const sp = {
    q: qs.get('q') || '',
    sort: qs.get('sort') || pref.sort || DEFAULTS.sort,
    shared: qs.get('shared') || pref.shared || DEFAULTS.shared,
    unread: qs.get('unread') || pref.unread || DEFAULTS.unread,
    bundle: qs.get('bundle') || '',
    user: qs.get('user') || '',
    page: Math.max(1, parseInt(qs.get('page') || '1', 10) || 1)
  };
  sp.modified = ['sort', 'shared', 'unread'].filter(k => sp[k] !== (pref[k] ?? DEFAULTS[k]));
  return sp;
}
const perPage = () => Math.max(10, parseInt(profile.items_per_page, 10) || 30);

function apiQuery(sp, extra = {}) {
  const p = new URLSearchParams({sort: sp.sort});
  if (sp.q) p.set('q', sp.q);
  if (sp.unread !== 'off') p.set('unread', sp.unread);
  if (sp.shared !== 'off') p.set('shared', sp.shared);
  if (sp.bundle) p.set('bundle', sp.bundle);
  if (sp.user) p.set('user', sp.user);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

function tagLink(q) {
  const qs = new URLSearchParams(location.search);
  if (q) qs.set('q', q); else qs.delete('q');
  qs.delete('page'); qs.delete('details');
  return '?' + qs.toString();
}
const tagsIn = q => [...q.matchAll(/(^|\s)#(\S+)/g)].map(m => m[2]);
function addTagQuery(q, tag) { return `${/\bor\b/i.test(q) ? `(${q})` : q} #${tag}`.trim(); }
function removeTagQuery(q, tag) {
  return q.replace(new RegExp('(^|\\s)#' + reEsc(tag) + '(?=\\s|$)', 'ig'), ' ').replace(/\s+/g, ' ').trim();
}
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
function detailsQuery(id) { const qs = new URLSearchParams(location.search); qs.set('details', id); return '?' + qs; }

function bookmarkItemHTML(b, mode) {
  const shared = mode === 'shared';
  const target = profile.bookmark_link_target === '_self' ? '_self' : '_blank';
  const inline = (profile.bookmark_description_display || 'inline') === 'inline';
  const classes = [b.unread ? 'unread' : '', b.shared ? 'shared' : ''].filter(Boolean).join(' ');
  const favicon = profile.enable_favicons ? `<img class="favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(b.url))}&sz=32" alt="" loading="lazy">` : '';
  const tags = b.tag_names.map(t => `<a href="${tagLink(addTagQuery(bm.sp.q || '', t))}">${esc(t)}</a>`).join('');
  let desc;
  if (inline) {
    desc = `<div class="description inline truncate">${tags ? `<span class="tags">${tags}</span>` : ''}${tags && b.description ? ' | ' : ''}${b.description ? `<span>${esc(b.description)}</span>` : ''}</div>`;
  } else {
    desc = (b.description ? `<div class="description separate">${esc(b.description)}</div>` : '') + (tags ? `<div class="tags">${tags}</div>` : '');
  }
  const date = humanDate(b.date_added, profile.bookmark_date_display || 'relative');
  const snap = profile.web_archive_integration === 'enabled' ? b.web_archive_snapshot_url : '';
  const dateHTML = date ? (snap ? `<a href="${esc(snap)}" title="Show snapshot on the Internet Archive Wayback Machine" target="${target}" rel="noopener">${date}</a>` : `<span>${date}</span>`) + '<span>|</span>' : '';
  const show = k => profile[k] !== false;
  const showNotesBtn = b.notes && !profile.permanent_notes;
  const own = !shared;
  const extra = (b.unread && own) || (b.shared && profile.enable_sharing && own) || showNotesBtn;
  return `<li data-bookmark-id="${b.id}" role="listitem"${classes ? ` class="${classes}"` : ''}>
  <div class="content">
    <div class="title">
      ${own ? '<label class="form-checkbox bulk-edit-checkbox"><input type="checkbox" name="bookmark_id" value="' + b.id + '"><i class="form-icon"></i></label>' : ''}
      ${favicon}<a href="${esc(b.url)}" target="${target}" rel="noopener"><span>${esc(b.title || b.url)}</span></a>
    </div>
    ${profile.display_url ? `<div class="url-path truncate"><a href="${esc(b.url)}" target="${target}" rel="noopener" class="url-display">${esc(b.url)}</a></div>` : ''}
    ${desc}
    ${b.notes ? `<div class="notes"><div class="markdown">${markdown(b.notes)}</div></div>` : ''}
    <div class="actions">
      ${dateHTML}
      ${show('display_view_bookmark_action') ? `<a href="${location.pathname}${detailsQuery(b.id)}" class="view-action" data-details="${b.id}">View</a>` : ''}
      ${own ? `
        ${show('display_edit_bookmark_action') ? `<a href="/bookmarks/${b.id}/edit?return_url=${encodeURIComponent(location.pathname + location.search)}" data-nav>Edit</a>` : ''}
        ${show('display_archive_bookmark_action') ? `<button type="button" data-act="${b.is_archived ? 'unarchive' : 'archive'}" class="btn btn-link btn-sm">${b.is_archived ? 'Unarchive' : 'Archive'}</button>` : ''}
        ${show('display_remove_bookmark_action') ? '<button type="button" data-act="remove" data-confirm class="btn btn-link btn-sm">Remove</button>' : ''}
      ` : ''}
      ${extra ? `<div class="extra-actions"><span class="hide-sm">|</span>
        ${b.unread && own ? `<button type="button" data-act="read" data-confirm data-confirm-question="Mark as read?" class="btn btn-link btn-sm btn-icon">${ico('unread', 16)} Unread</button>` : ''}
        ${b.shared && profile.enable_sharing && own ? `<button type="button" data-act="unshare" data-confirm data-confirm-question="Unshare?" class="btn btn-link btn-sm btn-icon">${ico('share', 16)} Shared</button>` : ''}
        ${showNotesBtn ? `<button type="button" class="btn btn-link btn-sm btn-icon toggle-notes">${ico('note', 16)} Notes</button>` : ''}
      </div>` : ''}
    </div>
  </div>
</li>`;
}

function paginationHTML(page, pages) {
  if (pages <= 1) return '';
  const vis = new Set([1, pages]);
  for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) vis.add(i);
  const nums = [...vis].sort((a, b) => a - b);
  const link = n => { const qs = new URLSearchParams(location.search); qs.delete('details'); qs.set('page', n); return location.pathname + '?' + qs; };
  let html = '<ul class="pagination">';
  html += page > 1 ? `<li class="page-item"><a href="${link(page - 1)}" data-nav tabindex="-1">Previous</a></li>` : '<li class="page-item disabled"><a href="#" tabindex="-1">Previous</a></li>';
  let last = 0;
  for (const n of nums) {
    if (last && n > last + 1) html += '<li class="page-item"><span>...</span></li>';
    html += `<li class="page-item ${n === page ? 'active' : ''}"><a href="${link(n)}" data-nav>${n}</a></li>`;
    last = n;
  }
  html += page < pages ? `<li class="page-item"><a href="${link(page + 1)}" data-nav tabindex="-1">Next</a></li>` : '<li class="page-item disabled"><a href="#" tabindex="-1">Next</a></li>';
  return html + '</ul>';
}

function listHTML(mode) {
  const {items, total, sp} = bm;
  if (!items.length) {
    if (sp.invalid) {
      return '<div class="empty mt-4"><p class="empty-title h5">Invalid search query</p><p class="empty-subtitle">The search query you entered is not valid. Common reasons are unclosed parentheses or a logical operator (AND, OR, NOT) without operands.</p></div>';
    }
    return '<div class="empty mt-4"><p class="empty-title h5">You have no bookmarks yet</p><p class="empty-subtitle">You can get started by <a href="/bookmarks/new" data-nav>adding</a> bookmarks, <a href="/settings/general" data-nav>importing</a> your existing bookmarks or configuring the <a href="/settings/integrations" data-nav>browser extension</a> or the <a href="/settings/integrations" data-nav>bookmarklet</a>.</p></div>';
  }
  const pages = Math.ceil(total / perPage());
  return `<section aria-label="Bookmark list"><ul class="bookmark-list${profile.permanent_notes ? ' show-notes' : ''}" role="list" tabindex="-1" style="--ld-bookmark-description-max-lines:${profile.bookmark_description_max_lines || 1}" data-bookmarks-total="${total}">
    ${items.map(b => bookmarkItemHTML(b, mode)).join('')}</ul>
    <div class="bookmark-pagination${profile.sticky_pagination ? ' sticky' : ''}">${paginationHTML(sp.page, pages)}</div></section>`;
}

function tagCloudHTML(cloud, sp) {
  const selected = tagsIn(sp.q).map(t => cloud.find(c => c.toLowerCase() === t.toLowerCase()) || t);
  const uniqSel = [...new Map(selected.map(t => [t.toLowerCase(), t])).values()];
  const selSet = new Set(uniqSel.map(t => t.toLowerCase()));
  const rest = cloud.filter(t => !selSet.has(t.toLowerCase())).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const alpha = (profile.tag_grouping || 'alphabetical') === 'alphabetical';
  const groups = [];
  if (alpha) {
    let cur = null;
    for (const t of rest) {
      const ch = t[0].toLowerCase();
      if (!cur || cur.ch !== ch) { cur = {ch, tags: []}; groups.push(cur); }
      cur.tags.push(t);
    }
  } else if (rest.length) groups.push({ch: '', tags: rest});
  const sel = uniqSel.length ? `<p class="selected-tags">${uniqSel.map(t => `<a href="${tagLink(removeTagQuery(sp.q, t))}" class="text-bold mr-2"><span>-${esc(t)}</span></a>`).join('')}</p>` : '';
  const grp = groups.map(g => `<p class="group">${g.tags.map((t, i) => {
    const href = tagLink(addTagQuery(sp.q, t));
    return alpha && i === 0 ? `<a href="${href}" class="mr-2" data-is-tag-item><span class="highlight-char">${esc(t[0])}</span><span>${esc(t.slice(1))}</span></a>` : `<a href="${href}" class="mr-2" data-is-tag-item><span>${esc(t)}</span></a>`;
  }).join('')}</p>`).join('');
  return `<div class="tag-cloud">${sel}<div class="unselected-tags">${grp}</div></div>`;
}

function sidePanelHTML(mode, cloud, bundles, sp) {
  let html = '';
  if (!profile.hide_bundles && mode !== 'shared' && !anon) {
    html += `<section aria-labelledby="bundles-heading"><div class="section-header no-wrap"><h2 id="bundles-heading">Bundles</h2>
      <ld-dropdown class="dropdown dropdown-right ml-auto" style="--dropdown-focus-display:none"><button class="btn btn-noborder dropdown-toggle" aria-label="Bundles menu" aria-expanded="false">${ico('menu')}</button>
      <ul class="menu" role="list" tabindex="-1"><li class="menu-item"><a href="/bundles" data-nav class="menu-link">Manage bundles</a></li>
      ${sp.q ? `<li class="menu-item"><a href="/bundles/new?q=${encodeURIComponent(sp.q)}" data-nav class="menu-link">Create bundle from search</a></li>` : ''}</ul></ld-dropdown></div>
      <ul class="bundle-menu">${bundles.map(b => `<li class="bundle-menu-item ${String(b.id) === sp.bundle ? 'selected' : ''}"><a href="?bundle=${b.id}">${esc(b.name)}</a></li>`).join('')}</ul></section>`;
  }
  html += `<section aria-labelledby="tags-heading"><div class="section-header no-wrap"><h2 id="tags-heading">Tags</h2>
    ${anon ? '' : `<ld-dropdown class="dropdown dropdown-right ml-auto" style="--dropdown-focus-display:none"><button class="btn btn-noborder dropdown-toggle" aria-label="Tags menu" aria-expanded="false">${ico('menu')}</button>
    <ul class="menu" role="list" tabindex="-1"><li class="menu-item"><a href="/tags" data-nav class="menu-link">Manage tags</a></li></ul></ld-dropdown>`}</div>
    <div id="tag-cloud-container">${tagCloudHTML(cloud, sp)}</div></section>`;
  return html;
}

function searchHTML(mode, sp) {
  const radio = (name, val, opts) => opts.map(([v, l]) => `<label for="${name}-${v}" class="form-radio form-inline"><input type="radio" id="${name}-${v}" name="${name}" value="${v}"${val === v ? ' checked' : ''}><i class="form-icon"></i> ${l}</label>`).join('');
  return `<div class="search-container">
  <form id="search" role="search"><div class="form-autocomplete"><div class="form-autocomplete-input form-input"><input type="search" class="form-input" name="q" placeholder="Search for words or #tags" autocomplete="off" value="${esc(sp.q)}"></div><ul class="menu"></ul></div><input type="submit" value="Search" class="d-none"></form>
  <ld-dropdown class="search-options dropdown dropdown-right" style="--dropdown-focus-display:none">
    <button type="button" aria-label="Search preferences" aria-expanded="false" class="btn dropdown-toggle${sp.modified.length ? ' badge' : ''}">${ico('preferences')}</button>
    <div class="menu" tabindex="0"><form id="search_preferences">
      <div class="form-group"><label for="pref-sort" class="form-label${sp.modified.includes('sort') ? ' text-bold' : ''}">Sort by</label>
        <select id="pref-sort" name="sort" class="form-select select-sm">${SORTS.map(([v, l]) => `<option value="${v}"${sp.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      ${profile.enable_sharing && mode !== 'shared' ? `<div class="form-group radio-group" role="radiogroup"><label class="form-label${sp.modified.includes('shared') ? ' text-bold' : ''}">Shared filter</label>${radio('shared', sp.shared, [['off', 'Off'], ['yes', 'Shared'], ['no', 'Unshared']])}</div>` : ''}
      <div class="form-group radio-group" role="radiogroup"><label class="form-label${sp.modified.includes('unread') ? ' text-bold' : ''}">Unread filter</label>${radio('unread', sp.unread, [['off', 'Off'], ['yes', 'Unread'], ['no', 'Read']])}</div>
      <div class="actions"><button type="submit" class="btn btn-sm btn-primary" name="apply" value="1">Apply</button>${anon ? '' : '<button type="submit" class="btn btn-sm" name="save" value="1">Save as default</button>'}</div>
    </form></div></ld-dropdown></div>`;
}

function bulkBarHTML(mode) {
  const dis = MODES[mode].disabled;
  const opt = (v, l) => dis.includes(v) ? '' : `<option value="${v}">${l}</option>`;
  return `<div class="bulk-edit-bar"><label class="form-checkbox bulk-edit-checkbox all"><input type="checkbox"><i class="form-icon"></i></label>
    <select name="bulk_action" class="form-select select-sm">${opt('bulk_archive', 'Archive')}${opt('bulk_unarchive', 'Unarchive')}<option value="bulk_delete">Delete</option><option value="bulk_tag">Add tags</option><option value="bulk_untag">Remove tags</option><option value="bulk_read">Mark as read</option><option value="bulk_unread">Mark as unread</option>
    ${profile.enable_sharing ? '<option value="bulk_share">Share</option><option value="bulk_unshare">Unshare</option>' : ''}<option value="bulk_refresh">Refresh from website</option></select>
    ${tagInputHTML({name: 'bulk_tag_string', placeholder: 'Tag names...', small: true})}
    <button data-confirm type="button" name="bulk_execute" class="btn btn-link btn-sm"><span>Execute</span></button>
    <label class="form-checkbox select-across d-none"><input type="checkbox" name="bulk_select_across"><i class="form-icon"></i> All <span class="total">0</span> bookmarks</label></div>`;
}

async function bookmarksPage(mode, qs, seq) {
  anon = anon && mode === 'shared';
  const sp = searchParams(qs);
  const cfg = MODES[mode];
  document.title = `${cfg.title} - Linkding`;
  const params = apiQuery(sp, {limit: perPage(), offset: (sp.page - 1) * perPage()});
  const cloudParams = apiQuery(sp, {mode});
  cloudParams.delete('sort');
  let data, cloud;
  const bundlesP = anon || mode === 'shared' ? Promise.resolve([]) : getBundles();
  try {
    [data, cloud] = await Promise.all([api('GET', cfg.api + '?' + params), api('GET', '/api/tags/cloud/?' + cloudParams).catch(() => [])]);
  } catch (e) { return fail(e); }
  const bundles = await bundlesP;
  if (seq !== routeSeq) return; // a newer navigation superseded this one
  sp.invalid = !!sp.q && !checkBalanced(sp.q);
  bm = {mode, items: data.results, total: data.count, sp, details: qs.get('details')};
  pushSearch(sp.q);

  const existing = $('.bookmarks-page', content);
  if (!existing || existing.dataset.mode !== mode) {
    content.innerHTML = `<ld-bookmark-page class="bookmarks-page grid columns-md-1 ${profile.collapse_side_panel ? 'collapse-side-panel' : ''}" data-mode="${mode}"${cfg.bulk ? '' : ' no-bulk-edit'}>
      <main class="main col-2" aria-labelledby="main-heading">
        <div class="section-header ${cfg.bulk ? 'mb-0' : ''}"><h1 id="main-heading">${cfg.title}</h1><div class="header-controls"><span id="search-slot"></span>
          ${cfg.bulk ? `<button type="button" class="btn hide-sm ml-2 bulk-edit-active-toggle" title="Bulk edit">${ico('bulk-edit')}</button>` : ''}
          <ld-filter-drawer-trigger><button type="button" class="btn ml-2">Filters</button></ld-filter-drawer-trigger></div></div>
        <form class="bookmark-actions" id="bookmark-actions" autocomplete="off" onsubmit="return false">${cfg.bulk ? bulkBarHTML(mode) : ''}<div id="bookmark-list-container"></div></form>
      </main><div class="side-panel col-1 hide-md"></div></ld-bookmark-page>`;
    initTagInputs(content);
    wireBookmarksPage(mode);
  }
  $('#search-slot', content).outerHTML = '<span id="search-slot" style="display:contents">' + searchHTML(mode, sp) + '</span>';
  initSearchAutocomplete($('.search-container .form-autocomplete', content), sp, mode);
  wireSearchForms(mode, sp);
  $('#bookmark-list-container', content).innerHTML = listHTML(mode);
  const drawer = $('.modal.drawer:not(.closing) .modal-body');
  (drawer || $('.side-panel', content)).innerHTML = sidePanelHTML(mode, cloud, bundles, sp);
  resetBulk(cfg.bulk);
  scrollTo(0, 0);
  if (bm.details) openDetails(+bm.details);
}

function checkBalanced(q) {
  let d = 0;
  for (const c of q) { if (c === '(') d++; else if (c === ')') { d--; if (d < 0) return false; } }
  return d === 0 && !/(^|\s)(and|or|not)\s*$/i.test(q) && !/^\s*(and|or)(\s|$)/i.test(q);
}

function wireSearchForms(mode, sp) {
  const sf = $('#search'), pf = $('#search_preferences');
  sf.onsubmit = e => {
    e.preventDefault();
    const qs = new URLSearchParams(location.search);
    const q = sf.q.value.trim();
    if (q) qs.set('q', q); else qs.delete('q');
    qs.delete('page'); qs.delete('details');
    go(location.pathname + (qs.toString() ? '?' + qs : ''));
  };
  pf.onsubmit = async e => {
    e.preventDefault();
    const act = e.submitter && e.submitter.name;
    const vals = {sort: pf.sort.value, shared: (pf.shared && pf.shared.value) || sp.shared, unread: pf.unread.value};
    if (act === 'save') {
      try { profile = await api('PATCH', '/api/user/profile/', {search_preferences: vals}); } catch (er) { return fail(er); }
    }
    const qs = new URLSearchParams(location.search);
    qs.delete('page');
    if (act === 'save') { ['sort', 'shared', 'unread'].forEach(k => qs.delete(k)); } else { for (const [k, v] of Object.entries(vals)) qs.set(k, v); }
    await go(location.pathname + (qs.toString() ? '?' + qs : ''), true);
    if (act === 'save') flash('Search preferences saved');
  };
}

// bulk edit state
function resetBulk(enabled) {
  const page = $('.bookmarks-page');
  if (!page) return;
  $$('.toggle-notes', page).forEach(b => { b.onclick = e => { e.preventDefault(); b.closest('li').classList.toggle('show-notes'); }; });
  if (!enabled) return;
  const all = $('.bulk-edit-checkbox.all input', page), boxes = $$('.bulk-edit-checkbox:not(.all) input', page);
  const across = $('label.select-across', page), exec = $('button[name=bulk_execute]', page);
  all.checked = false; boxes.forEach(b => b.checked = false);
  across.classList.add('d-none'); $('input', across).checked = false;
  $('.total', across).textContent = bm.total;
  exec.disabled = true;
  page.dataset.bulkAction = $('select[name=bulk_action]', page).value;
}

function wireBookmarksPage() {
  const page = $('.bookmarks-page');
  const sync = () => {
    const boxes = $$('.bulk-edit-checkbox:not(.all) input', page), all = $('.bulk-edit-checkbox.all input', page);
    all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    const across = $('label.select-across', page);
    across.classList.toggle('d-none', !all.checked); if (!all.checked) $('input', across).checked = false;
    $('button[name=bulk_execute]', page).disabled = !boxes.some(b => b.checked);
  };
  page.addEventListener('change', e => {
    if (e.target.closest('.bulk-edit-checkbox.all')) { $$('.bulk-edit-checkbox:not(.all) input', page).forEach(b => b.checked = e.target.checked); sync(); }
    else if (e.target.closest('.bulk-edit-checkbox')) sync();
    else if (e.target.name === 'bulk_action') page.dataset.bulkAction = e.target.value;
  });
  const toggle = $('.bulk-edit-active-toggle', page);
  if (toggle) toggle.onclick = () => page.classList.toggle('active');
  page.addEventListener('click', async e => {
    const view = e.target.closest('a[data-details]');
    if (view) { e.preventDefault(); e.stopPropagation(); const qs = new URLSearchParams(location.search); qs.set('details', view.dataset.details); history.replaceState(null, '', location.pathname + '?' + qs); openDetails(+view.dataset.details); return; }
    if (e.target.closest('ld-filter-drawer-trigger button')) return openDrawer();
    const btn = e.target.closest('[data-act]');
    if (btn) {
      if (btn.dataset.confirm !== undefined && !btn.dataset.confirmed) return;
      const id = +btn.closest('li[data-bookmark-id]').dataset.bookmarkId;
      try {
        if (btn.dataset.act === 'remove') await api('DELETE', `/api/bookmarks/${id}/`);
        else if (btn.dataset.act === 'archive' || btn.dataset.act === 'unarchive') await api('POST', `/api/bookmarks/${id}/${btn.dataset.act}/`);
        else if (btn.dataset.act === 'read') await api('PATCH', `/api/bookmarks/${id}/`, {unread: false});
        else if (btn.dataset.act === 'unshare') await api('PATCH', `/api/bookmarks/${id}/`, {shared: false});
        tagCache = null;
        await refreshListQuiet();
      } catch (er) { fail(er); }
      return;
    }
    const exec = e.target.closest('button[name=bulk_execute]');
    if (exec && exec.dataset.confirmed) runBulk(page);
  });
}

async function runBulk(page) {
  const action = $('select[name=bulk_action]', page).value.replace('bulk_', '');
  const across = $('input[name=bulk_select_across]', page).checked;
  let ids = $$('.bulk-edit-checkbox:not(.all) input:checked', page).map(b => +b.value);
  const tags = $('input[name=bulk_tag_string]', page).value.split(/[\s,]+/).filter(Boolean);
  try {
    if (across) {
      const p = apiQuery(bm.sp, {limit: 10000}); p.delete('sort');
      ids = (await api('GET', MODES[bm.mode].api + '?' + p)).results.map(b => b.id);
    }
    if (action === 'refresh') {
      for (const id of ids) {
        const b = await api('GET', `/api/bookmarks/${id}/`);
        const meta = (await api('GET', '/api/bookmarks/check/?ignore_cache=true&url=' + encodeURIComponent(b.url))).metadata;
        const patch = {};
        if (meta.title) patch.title = meta.title;
        if (meta.description) patch.description = meta.description;
        if (Object.keys(patch).length) await api('PATCH', `/api/bookmarks/${id}/`, patch);
      }
    } else {
      if ((action === 'tag' || action === 'untag') && !tags.length) return flash('Please enter at least one tag name.', 'error');
      await api('POST', '/api/bookmarks/bulk/', {action, ids, tags});
    }
    tagCache = null;
    await route();
  } catch (er) { fail(er); }
}

// filter drawer (side panel content on small screens)
function openDrawer() {
  const panel = $('.side-panel'); if (!panel) return;
  const m = openModal(`<div class="modal-header"><h2>Filters</h2><button class="btn btn-noborder close" aria-label="Close dialog" data-close-modal>${ico('close', 24)}</button></div><div class="modal-body"></div>`, 'drawer');
  const body = $('.modal-body', m);
  body.innerHTML = panel.innerHTML; panel.innerHTML = '';
  $$('h2', body).forEach(h => { const n = document.createElement('h3'); n.id = h.id; n.textContent = h.textContent; h.replaceWith(n); });
  const restore = () => {
    const sp = $('.side-panel'); if (!sp) return;
    $$('h3', body).forEach(h => { const n = document.createElement('h2'); n.id = h.id; n.textContent = h.textContent; h.replaceWith(n); });
    sp.innerHTML = body.innerHTML;
  };
  const origClose = m.close;
  m.close = () => { restore(); origClose(); };
  m.addEventListener('click', e => { if (e.target.closest('a[href^="?"], a[data-nav]')) m.close(); });
}

// ---------------------------------------------------------------- details modal
function openDetails(id) {
  closeAllModals();
  const b = bm.items.find(x => x.id === id);
  const show = b ? Promise.resolve(b) : api('GET', `/api/bookmarks/${id}/`);
  show.then(b => renderDetails(b)).catch(() => {});
}
function renderDetails(b) {
  const own = bm.mode !== 'shared';
  const target = profile.bookmark_link_target === '_self' ? '_self' : '_blank';
  const snap = b.web_archive_snapshot_url;
  const tags = b.tag_names.map(t => `<a href="/bookmarks?q=${encodeURIComponent('#' + t)}" data-nav>${esc(t)}</a>`).join(' ');
  const chk = (n, l, on) => `<div class="form-group"><label class="form-checkbox"><input data-submit-on-change type="checkbox" name="${n}"${on ? ' checked' : ''}><i class="form-icon"></i> ${l}</label></div>`;
  const m = openModal(`${modalHeader(b.title || b.url)}<div class="modal-body"><form>
    <div class="weblinks"><a class="weblink" href="${esc(b.url)}" rel="noopener" target="${target}"><span>${esc(b.url)}</span></a>
      ${snap ? `<a class="weblink" href="${esc(snap)}" target="${target}"><span>Internet Archive</span></a>` : ''}</div>
    <div class="sections grid columns-2 columns-sm-1 gap-0">
      ${own ? `<section class="status col-2"><h3>Status</h3><div class="d-flex" style="gap: .8rem">${chk('is_archived', 'Archived', b.is_archived)}${chk('unread', 'Unread', b.unread)}${profile.enable_sharing ? chk('shared', 'Shared', b.shared) : ''}</div></section>` : ''}
      ${b.tag_names.length ? `<section class="tags col-1"><h3 id="details-modal-tags-title">Tags</h3><div>${tags}</div></section>` : ''}
      <section class="date-added col-1"><h3>Date added</h3><div><span>${new Date(b.date_added).toLocaleString()}</span></div></section>
      ${b.description ? `<section class="description col-2"><h3>Description</h3><div>${esc(b.description)}</div></section>` : ''}
      ${b.notes ? `<section class="notes col-2"><h3>Notes</h3><div class="markdown">${markdown(b.notes)}</div></section>` : ''}
    </div></form></div>
    ${own ? `<div class="modal-footer"><div class="actions"><div class="left-actions"><a class="btn btn-wide" href="/bookmarks/${b.id}/edit?return_url=${encodeURIComponent(location.pathname)}" data-nav>Edit</a></div>
    <div class="right-actions"><button data-confirm class="btn btn-error btn-wide" type="button" data-delete>Delete</button></div></div></div>` : ''}`, 'bookmark-details', () => {
    const qs = new URLSearchParams(location.search);
    if (qs.has('details')) { qs.delete('details'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }
  });
  m.addEventListener('click', e => { if (e.target.closest('a[data-nav]')) m.close(); });
  m.addEventListener('change', async e => {
    if (!e.target.matches('[data-submit-on-change]')) return;
    const f = e.target.form, body = {is_archived: f.is_archived.checked, unread: f.unread.checked};
    if (f.shared) body.shared = f.shared.checked;
    try { Object.assign(b, await api('PATCH', `/api/bookmarks/${b.id}/`, body)); } catch (er) { fail(er); }
  });
  const del = $('[data-delete]', m);
  if (del) del.addEventListener('click', async () => { if (!del.dataset.confirmed) return; try { await api('DELETE', `/api/bookmarks/${b.id}/`); tagCache = null; m.close(); await refreshListQuiet(); } catch (er) { fail(er); } });
}
async function refreshListQuiet() { const y = scrollY; await route(); scrollTo(0, y); }

// ---------------------------------------------------------------- bookmark form page
async function formPage(id, qs) {
  anon = false;
  const returnUrl = safeReturn(qs.get('return_url'));
  document.title = `${id ? 'Edit' : 'New'} bookmark - Linkding`;
  let b = null;
  if (id) { try { b = await api('GET', `/api/bookmarks/${id}/`); } catch (e) { return fail(e); } }
  const init = b || {
    url: qs.get('url') || '', title: qs.get('title') || '', description: qs.get('description') || '', notes: qs.get('notes') || '',
    tag_names: (qs.get('tags') || '').split(/[\s,]+/).filter(Boolean), unread: !!profile.default_mark_unread, shared: !!profile.default_mark_shared
  };
  const autoClose = qs.has('auto_close');
  content.innerHTML = `<div class="bookmarks-form-page"><main aria-labelledby="main-heading">
    <div class="section-header"><h1 id="main-heading">${id ? 'Edit' : 'New'} bookmark</h1></div>
    <ld-form data-submit-on-ctrl-enter><form id="bform" novalidate><div class="bookmarks-form">
      <div class="form-group"><label for="id_url" class="form-label">URL</label>
        <div class="has-icon-right"><input type="url" name="url" id="id_url" class="form-input" autofocus required value="${esc(init.url)}"><i class="form-icon loading" style="visibility:hidden"></i></div>
        <div class="form-input-hint is-error" id="err-url" hidden></div>
        <div class="form-input-hint bookmark-exists" style="display:none">This URL is already bookmarked. The form has been pre-filled with the existing bookmark, and saving the form will update the existing bookmark.</div></div>
      <div class="form-group"><label for="id_tag_string" class="form-label">Tags</label>
        ${tagInputHTML({id: 'id_tag_string', name: 'tag_string', value: init.tag_names.join(' ')})}
        <div class="form-input-hint">Enter any number of tags separated by space and <strong>without</strong> the hash (#). If a tag does not exist it will be automatically created.</div>
        <div class="form-input-hint auto-tags" style="display:none"></div></div>
      <div class="form-group"><div class="d-flex justify-between align-baseline"><label for="id_title" class="form-label">Title</label>
        <div class="flex"><button id="refresh-button" class="btn btn-link suffix-button" type="button" style="display:${id ? 'inline-block' : 'none'}">Refresh from website</button>
        <button class="ml-2 btn btn-link suffix-button" type="button" data-clear="id_title">Clear</button></div></div>
        <input type="text" name="title" id="id_title" class="form-input" maxlength="512" value="${esc(init.title)}"></div>
      <div class="form-group"><div class="d-flex justify-between align-baseline"><label for="id_description" class="form-label">Description</label>
        <button class="btn btn-link suffix-button" type="button" data-clear="id_description">Clear</button></div>
        <textarea name="description" id="id_description" class="form-input" rows="3">${esc(init.description)}</textarea></div>
      <div class="form-group"><details class="notes"${init.notes ? ' open' : ''}><summary><span class="form-label d-inline-block">Notes</span></summary>
        <label for="id_notes" class="text-assistive">Notes</label><textarea name="notes" id="id_notes" class="form-input" rows="8" aria-describedby="id_notes_help">${esc(init.notes)}</textarea>
        <div id="id_notes_help" class="form-input-hint">Additional notes, supports Markdown.</div></details></div>
      <div class="form-group"><label for="id_unread" class="form-checkbox"><input type="checkbox" name="unread" id="id_unread"${init.unread ? ' checked' : ''}><i class="form-icon"></i> Mark as unread</label>
        <div class="form-input-hint">Unread bookmarks can be filtered for, and marked as read after you had a chance to look at them.</div></div>
      ${profile.enable_sharing ? `<div class="form-group"><label for="id_shared" class="form-checkbox"><input type="checkbox" name="shared" id="id_shared"${init.shared ? ' checked' : ''}><i class="form-icon"></i> Share</label>
        <div class="form-input-hint">${profile.enable_public_sharing ? 'Share this bookmark with other registered users and anonymous users.' : 'Share this bookmark with other registered users.'}</div></div>` : ''}
      <div class="divider"></div>
      <div class="form-group d-flex justify-between"><input type="submit" value="${autoClose ? 'Save and close' : 'Save'}" class="btn btn-primary btn-wide"><a href="${esc(returnUrl)}" data-nav class="btn">Cancel</a></div>
    </div></form></ld-form></main></div>`;
  initTagInputs(content);
  const f = $('#bform'), urlIn = f.url, titleIn = f.title, descIn = f.description, hint = $('.bookmark-exists'), refresh = $('#refresh-button');
  const spinner = $('i.form-icon.loading');
  let editId = id, titleMod = !!titleIn.value, descMod = !!descIn.value;
  const setVal = (el, v) => { el.value = v ?? ''; };
  $$('[data-clear]').forEach(btn => btn.onclick = () => { const el = document.getElementById(btn.dataset.clear); el.value = ''; el.focus(); });
  titleIn.addEventListener('input', () => { titleMod = true; }); descIn.addEventListener('input', () => { descMod = true; });
  async function check(force) {
    const u = urlIn.value.trim();
    if (!u) return;
    spinner.style.visibility = 'visible';
    try {
      const d = await api('GET', '/api/bookmarks/check/?url=' + encodeURIComponent(u) + (force ? '&ignore_cache=true' : ''));
      if (force) {
        if (d.metadata.title && d.metadata.title !== d.bookmark?.title) { titleIn.value = d.metadata.title; titleIn.classList.add('modified'); }
        if (d.metadata.description && d.metadata.description !== d.bookmark?.description) { descIn.value = d.metadata.description; descIn.classList.add('modified'); }
        return;
      }
      const ex = d.bookmark;
      hint.style.display = ex ? 'block' : 'none';
      refresh.style.display = ex || id ? 'inline-block' : 'none';
      if (ex) {
        editId = ex.id; $('details.notes').open = !!ex.notes;
        setVal(titleIn, ex.title); setVal(descIn, ex.description); setVal(f.notes, ex.notes); setVal(f.tag_string, ex.tag_names.join(' '));
        f.unread.checked = ex.unread; if (f.shared) f.shared.checked = ex.shared;
      } else {
        editId = id;
        if (!titleMod) setVal(titleIn, d.metadata.title);
        if (!descMod) setVal(descIn, d.metadata.description);
      }
      const at = d.auto_tags || [], ah = $('.auto-tags');
      if (at.length) { ah.style.display = 'block'; ah.textContent = 'Auto tags: ' + at.sort().join(' '); } else ah.style.display = 'none';
    } catch { /* metadata is a convenience */ } finally { spinner.style.visibility = 'hidden'; }
  }
  refresh.onclick = () => check(true);
  if (!id) { check(); urlIn.addEventListener('input', debounce(() => check(), 500)); }
  f.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) f.requestSubmit(); });
  f.onsubmit = async e => {
    e.preventDefault();
    $('#err-url').hidden = true;
    const body = {url: urlIn.value.trim(), title: titleIn.value.trim(), description: descIn.value.trim(), notes: f.notes.value, unread: f.unread.checked, tag_names: f.tag_string.value.split(/[\s,]+/).filter(Boolean)};
    if (f.shared) body.shared = f.shared.checked;
    try {
      if (editId) await api('PATCH', `/api/bookmarks/${editId}/`, body);
      else await api('POST', '/api/bookmarks/' + (body.title && body.description ? '?disable_scraping' : ''), body);
      tagCache = null;
      if (autoClose) { go('/bookmarks/close', true); window.close(); } else go(returnUrl);
    } catch (er) {
      const m = er.data && er.data.url;
      if (m) { const x = $('#err-url'); x.textContent = [].concat(m).join(' '); x.hidden = false; urlIn.closest('.form-group').classList.add('has-error'); } else fail(er);
    }
  };
}

// ---------------------------------------------------------------- tags page
async function tagsPage(qs) {
  document.title = 'Tags - Linkding';
  let stats;
  try { stats = await api('GET', '/api/tags/stats/'); } catch (e) { return fail(e); }
  const search = qs.get('search') || '', sort = qs.get('sort') || 'name-asc', unused = qs.get('unused') === 'true';
  const rows = stats.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) && (!unused || t.count === 0));
  const cmp = {'name-asc': (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()), 'name-desc': (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()), 'count-asc': (a, b) => a.count - b.count, 'count-desc': (a, b) => b.count - a.count}[sort] || (() => 0);
  rows.sort(cmp);
  const size = 50, page = Math.max(1, parseInt(qs.get('page') || '1', 10) || 1), pages = Math.max(1, Math.ceil(rows.length / size));
  const shown = rows.slice((page - 1) * size, page * size);
  const pager = () => {
    if (pages <= 1) return '';
    const q = new URLSearchParams(qs); const link = n => { q.set('page', n); return '/tags?' + q; };
    let h = '<ul class="pagination">';
    h += page > 1 ? `<li class="page-item"><a href="${link(page - 1)}" data-nav>Previous</a></li>` : '<li class="page-item disabled"><a href="#">Previous</a></li>';
    for (let i = 1; i <= pages; i++) h += `<li class="page-item ${i === page ? 'active' : ''}"><a href="${link(i)}" data-nav>${i}</a></li>`;
    h += page < pages ? `<li class="page-item"><a href="${link(page + 1)}" data-nav>Next</a></li>` : '<li class="page-item disabled"><a href="#">Next</a></li>';
    return h + '</ul>';
  };
  content.innerHTML = `<div class="tags-page crud-page"><main aria-labelledby="main-heading">
    <div class="crud-header"><h1 id="main-heading">Tags</h1><div class="d-flex gap-2 ml-auto"><button type="button" class="btn" id="tag-new">Create Tag</button><button type="button" class="btn" id="tag-merge">Merge Tags</button></div></div>
    <div class="crud-filters"><form method="get" class="mb-2" id="tag-filter">
      <div class="form-group"><label class="form-label text-assistive" for="search">Search tags</label><div class="input-group"><input type="text" id="search" name="search" value="${esc(search)}" placeholder="Search tags..." class="form-input"><button type="submit" class="btn input-group-btn">Search</button></div></div>
      <div class="form-group"><label class="form-label text-assistive" for="sort">Sort by</label><div class="input-group"><span class="input-group-addon text-secondary">${ico('sort')}</span>
        <select id="sort" name="sort" class="form-select">${[['name-asc', 'Name A-Z'], ['name-desc', 'Name Z-A'], ['count-asc', 'Fewest bookmarks'], ['count-desc', 'Most bookmarks']].map(([v, l]) => `<option value="${v}"${sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="form-group"><label class="form-checkbox"><input type="checkbox" name="unused" value="true"${unused ? ' checked' : ''}><i class="form-icon"></i> Show only unused tags</label></div></form>
      <p class="text-secondary text-small m-0">${search || unused ? `Showing ${rows.length} of ${stats.length} tags` : `${stats.length} tags total`}</p></div>
    ${shown.length ? `<table class="table crud-table"><thead><tr><th>Name</th><th style="width: 25%">Bookmarks</th><th class="actions"><span class="text-assistive">Actions</span></th></tr></thead><tbody>
      ${shown.map(t => `<tr data-id="${t.id}" data-name="${esc(t.name)}"><td>${esc(t.name)}</td><td style="width: 25%"><a class="btn btn-link" href="/bookmarks?q=%23${encodeURIComponent(t.name)}" data-nav>${t.count}</a></td>
      <td class="actions"><button type="button" class="btn btn-link" data-a="edit">Edit</button><button type="button" class="btn btn-link text-error" data-a="delete" data-confirm>Remove</button></td></tr>`).join('')}</tbody></table>${pager()}`
    : `<div class="empty">${search || unused ? '<p class="empty-title h5">No tags found</p><p class="empty-subtitle">Try adjusting your search or filters</p>' : '<p class="empty-title h5">You have no tags yet</p><p class="empty-subtitle">Tags will appear here when you add bookmarks with tags</p>'}</div>`}
  </main></div>`;
  const f = $('#tag-filter');
  f.onsubmit = e => { e.preventDefault(); setParams({search: f.search.value.trim(), sort: f.sort.value === 'name-asc' ? '' : f.sort.value, unused: f.unused.checked ? 'true' : ''}); };
  f.sort.onchange = f.unused.onchange = () => f.requestSubmit();
  const tagForm = (title, inner, submit, onSubmit) => {
    const m = openModal(`<form novalidate>${modalHeader(title)}<div class="modal-body">${inner}</div><div class="modal-footer d-flex justify-between"><button type="button" class="btn btn-wide" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary btn-wide">${submit}</button></div></form>`, 'tag-edit-modal');
    initTagInputs(m);
    $('form', m).onsubmit = async e => {
      e.preventDefault();
      try { await onSubmit(e.target); m.close(); tagCache = null; await tagsPage(new URLSearchParams(location.search)); flash(title === 'Merge Tags' ? 'Tags merged' : 'Tag saved'); }
      catch (er) { let x = $('.form-input-hint.is-error', m); if (!x) { x = document.createElement('div'); x.className = 'form-input-hint is-error'; $('.modal-body', m).appendChild(x); } x.textContent = er.message; }
    };
    return m;
  };
  $('#tag-new').onclick = () => tagForm('Create Tag', '<div class="form-group"><label for="tag-name" class="form-label">Name</label><input type="text" name="name" id="tag-name" class="form-input" maxlength="64" required autofocus></div>', 'Save', fm => api('POST', '/api/tags/', {name: fm.name.value.trim()}));
  $('#tag-merge').onclick = () => tagForm('Merge Tags', `<details class="mb-4"><summary><span class="text-bold mb-1">How to merge tags</span></summary><ol><li>Enter the name of the tag you want to keep</li><li>Enter the names of tags to merge into the target tag</li><li>The target tag is added to all bookmarks that have any of the merge tags</li><li>The merged tags are deleted</li></ol></details>
    <div class="form-group"><label for="m-target" class="form-label">Target tag</label><input type="text" name="target" id="m-target" class="form-input" required><div class="form-input-hint">Enter the name of the tag you want to keep. The tags entered below will be merged into this one.</div></div>
    <div class="form-group"><label for="m-src" class="form-label">Tags to merge</label>${tagInputHTML({id: 'm-src', name: 'sources'})}<div class="form-input-hint">Enter the names of tags to merge into the target tag, separated by spaces. These tags will be deleted after merging.</div></div>`, 'Merge Tags',
    fm => api('POST', '/api/tags/merge/', {target: fm.target.value.trim(), sources: fm.sources.value.split(/[\s,]+/).filter(Boolean)}));
  const tbody = $('tbody', content);
  if (tbody) tbody.addEventListener('click', async e => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const tr = btn.closest('tr'), tid = tr.dataset.id, name = tr.dataset.name;
    if (btn.dataset.a === 'delete') {
      if (!btn.dataset.confirmed) return;
      try { await api('DELETE', `/api/tags/${tid}/`); tagCache = null; await tagsPage(new URLSearchParams(location.search)); flash('Tag removed'); } catch (er) { fail(er); }
    } else tagForm('Edit Tag', `<div class="form-group"><label for="tag-name" class="form-label">Name</label><input type="text" name="name" id="tag-name" class="form-input" maxlength="64" required value="${esc(name)}"></div>`, 'Save', fm => api('PATCH', `/api/tags/${tid}/`, {name: fm.name.value.trim()}));
  });
}

// ---------------------------------------------------------------- bundles pages
async function bundlesPage() {
  document.title = 'Bundles - Linkding';
  const bundles = await getBundles(true);
  content.innerHTML = `<main class="bundles-page crud-page" aria-labelledby="main-heading"><div class="crud-header"><h1 id="main-heading">Bundles</h1><a href="/bundles/new" data-nav class="btn">Add bundle</a></div>
    ${bundles.length ? `<table class="table crud-table"><thead><tr><th>Name</th><th class="actions"><span class="text-assistive">Actions</span></th></tr></thead><tbody>
    ${bundles.map(b => `<tr data-bundle-id="${b.id}" draggable="true"><td><div class="d-flex align-center">${ico('drag', 16).replace('<svg ', '<svg class="text-secondary mr-1" ')}<span>${esc(b.name)}</span></div></td>
    <td class="actions"><a class="btn btn-link" href="/bundles/${b.id}/edit" data-nav>Edit</a><button type="button" data-confirm data-remove="${b.id}" class="btn btn-link">Remove</button></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty"><p class="empty-title h5">You have no bundles yet</p><p class="empty-subtitle">Create your first bundle to get started</p></div>'}</main>`;
  const body = $('tbody', content);
  if (!body) return;
  body.addEventListener('click', async e => {
    const r = e.target.closest('[data-remove]'); if (!r || !r.dataset.confirmed) return;
    try { await api('DELETE', `/api/bundles/${r.dataset.remove}/`); bundleCache = null; await bundlesPage(); flash('Bundle removed'); } catch (er) { fail(er); }
  });
  let dragged = null;
  $$('tr', body).forEach(tr => {
    tr.addEventListener('dragstart', e => { dragged = tr; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => tr.classList.add('dragging'), 0); });
    tr.addEventListener('dragover', e => e.preventDefault());
    tr.addEventListener('dragenter', () => {
      if (tr === dragged || !dragged) return;
      const rowsNow = [...body.children];
      tr.insertAdjacentElement(rowsNow.indexOf(dragged) < rowsNow.indexOf(tr) ? 'afterend' : 'beforebegin', dragged);
    });
    tr.addEventListener('dragend', async () => {
      tr.classList.remove('dragging'); dragged = null;
      try { await Promise.all([...body.children].map((r, i) => api('PATCH', `/api/bundles/${r.dataset.bundleId}/`, {order: i}))); bundleCache = null; } catch (er) { fail(er); }
    });
  });
}

async function bundleFormPage(id, qs) {
  document.title = `${id ? 'Edit' : 'New'} bundle - Linkding`;
  let b = {name: '', search: qs ? qs.get('q') || '' : '', any_tags: '', all_tags: '', excluded_tags: '', filter_unread: 'off', filter_shared: 'off'};
  if (id) { try { b = await api('GET', `/api/bundles/${id}/`); } catch (e) { return fail(e); } }
  const sel = (n, v, o) => `<select name="${n}" id="id_${n}" class="form-select">${o.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const fld = (n, label, help, v) => `<div class="form-group"><label for="id_${n}" class="form-label">${label}</label>${tagInputHTML({id: 'id_' + n, name: n, value: v})}<div class="form-input-hint">${help}</div></div>`;
  content.innerHTML = `<main class="bundles-page crud-page" aria-labelledby="main-heading"><div class="crud-header"><h1 id="main-heading">${id ? 'Edit' : 'New'} bundle</h1></div>
    <div class="grid columns-2 columns-md-1"><div class="col-1"><form id="bundle-form" novalidate>
    <div class="form-group"><label for="id_name" class="form-label">Name</label><input type="text" name="name" id="id_name" class="form-input" maxlength="256" required value="${esc(b.name)}"><div class="form-input-hint is-error" id="err-name" hidden></div></div>
    <div class="form-group"><label for="id_search" class="form-label">Search terms</label><input type="text" name="search" id="id_search" class="form-input" maxlength="256" value="${esc(b.search)}"><div class="form-input-hint">All of these search terms must be present in a bookmark to match.</div></div>
    ${fld('any_tags', 'Tags', 'At least one of these tags must be present in a bookmark to match.', b.any_tags)}
    ${fld('all_tags', 'Required tags', 'All of these tags must be present in a bookmark to match.', b.all_tags)}
    ${fld('excluded_tags', 'Excluded tags', 'None of these tags must be present in a bookmark to match.', b.excluded_tags)}
    <div class="form-group"><label for="id_filter_unread" class="form-label">Reading State</label>${sel('filter_unread', b.filter_unread, [['off', 'All'], ['yes', 'Unread'], ['no', 'Read']])}<div class="form-input-hint">Limit matches to unread or read bookmarks.</div></div>
    <div class="form-group"><label for="id_filter_shared" class="form-label">Sharing State</label>${sel('filter_shared', b.filter_shared, [['off', 'All'], ['yes', 'Shared'], ['no', 'Unshared']])}<div class="form-input-hint">Limit matches to shared or unshared bookmarks.</div></div>
    <div class="form-footer d-flex mt-4"><input type="submit" name="save" value="Save" class="btn btn-primary btn-wide"><a href="/bundles" data-nav class="btn btn-wide ml-auto">Cancel</a></div></form></div>
    <div class="col-1"><div id="preview"></div></div></div></main>`;
  initTagInputs(content);
  const f = $('#bundle-form');
  const preview = debounce(async () => {
    const p = new URLSearchParams({pv: '1', limit: 10, pv_search: f.search.value.trim(), pv_any: f.any_tags.value.trim(), pv_all: f.all_tags.value.trim(), pv_excl: f.excluded_tags.value.trim(), pv_unread: f.filter_unread.value, pv_shared: f.filter_shared.value});
    try {
      const r = await api('GET', '/api/bookmarks/?' + p);
      $('#preview').innerHTML = `<h3 class="text-bold">Preview</h3><p class="text-secondary">${r.count} matching bookmark${r.count === 1 ? '' : 's'}</p><ul class="bookmark-list" role="list">${r.results.map(x => `<li><div class="content"><div class="title"><a href="${esc(x.url)}" target="_blank" rel="noopener"><span>${esc(x.title || x.url)}</span></a></div></div></li>`).join('')}</ul>`;
    } catch { /* preview is optional */ }
  }, 400);
  f.addEventListener('input', preview); preview();
  f.onsubmit = async e => {
    e.preventDefault();
    const body = {name: f.name.value.trim(), search: f.search.value.trim(), any_tags: f.any_tags.value.trim(), all_tags: f.all_tags.value.trim(), excluded_tags: f.excluded_tags.value.trim(), filter_unread: f.filter_unread.value, filter_shared: f.filter_shared.value};
    try { if (id) await api('PATCH', `/api/bundles/${id}/`, body); else await api('POST', '/api/bundles/', body); bundleCache = null; await go('/bundles'); flash('Bundle saved'); }
    catch (er) { const m = er.data && er.data.name; if (m) { const x = $('#err-name'); x.textContent = [].concat(m).join(' '); x.hidden = false; } else fail(er); }
  };
}

// ---------------------------------------------------------------- settings
const selectHTML = (n, v, opts) => `<select name="${n}" id="id_${n}" class="form-select width-25 width-sm-100">${opts.map(([k, l]) => `<option value="${k}"${String(v) === String(k) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const checkHTML = (n, label, v, help) => `<div class="form-group"><label for="id_${n}" class="form-checkbox"><input type="checkbox" name="${n}" id="id_${n}"${v ? ' checked' : ''}><i class="form-icon"></i> ${label}</label>${help ? `<div class="form-input-hint">${help}</div>` : ''}</div>`;

async function settingsPage() {
  document.title = 'Settings - Linkding';
  const p = profile;
  const row = (n, label, control, help) => `<div class="form-group"><label for="id_${n}" class="form-label">${label}</label>${control}${help ? `<div class="form-input-hint">${help}</div>` : ''}</div>`;
  content.innerHTML = `<main class="settings-page" aria-labelledby="main-heading"><h1 id="main-heading">Settings</h1>
  <section aria-labelledby="profile-heading"><h2 id="profile-heading">Profile</h2><p><a href="/change-password" data-nav>Change password</a></p>
  <form id="pform" novalidate>
    ${row('theme', 'Theme', selectHTML('theme', p.theme, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]), "Whether to use a light or dark theme, or automatically adjust the theme based on your system's settings.")}
    ${row('bookmark_date_display', 'Bookmark date format', selectHTML('bookmark_date_display', p.bookmark_date_display, [['relative', 'Relative'], ['absolute', 'Absolute'], ['hidden', 'Hidden']]), 'Whether to show bookmark dates as relative (how long ago), or as absolute dates. Alternatively the date can be hidden.')}
    ${row('bookmark_description_display', 'Bookmark description', selectHTML('bookmark_description_display', p.bookmark_description_display, [['inline', 'Inline'], ['separate', 'Separate']]), 'Whether to show bookmark descriptions and tags in the same line, or as separate blocks.')}
    <div class="form-group ${p.bookmark_description_display === 'inline' ? 'd-hide' : ''}" id="maxlines-group"><label for="id_bookmark_description_max_lines" class="form-label">Bookmark description max lines</label><input type="number" name="bookmark_description_max_lines" id="id_bookmark_description_max_lines" class="form-input width-25 width-sm-100" min="1" value="${esc(p.bookmark_description_max_lines || 1)}"><div class="form-input-hint">Limits the number of lines that are displayed for the bookmark description.</div></div>
    ${checkHTML('display_url', 'Show bookmark URL', p.display_url, 'When enabled, this setting displays the bookmark URL below the title.')}
    ${checkHTML('permanent_notes', 'Show notes permanently', p.permanent_notes, 'Whether to show bookmark notes permanently, without having to toggle them individually. Alternatively the keyboard shortcut <code>e</code> can be used to temporarily show all notes.')}
    <div class="form-group"><span class="form-label">Bookmark actions</span>
      ${[['display_view_bookmark_action', 'View'], ['display_edit_bookmark_action', 'Edit'], ['display_archive_bookmark_action', 'Archive'], ['display_remove_bookmark_action', 'Remove']].map(([n, l]) => `<label for="id_${n}" class="form-checkbox"><input type="checkbox" name="${n}" id="id_${n}"${p[n] !== false ? ' checked' : ''}><i class="form-icon"></i> ${l}</label>`).join('')}
      <div class="form-input-hint">Which actions to display for each bookmark.</div></div>
    ${row('bookmark_link_target', 'Open bookmarks in', selectHTML('bookmark_link_target', p.bookmark_link_target, [['_blank', 'New page'], ['_self', 'Same page']]), 'Whether to open bookmarks a new page or in the same page.')}
    ${row('items_per_page', 'Items per page', `<input type="number" name="items_per_page" id="id_items_per_page" class="form-input width-25 width-sm-100" min="10" value="${esc(p.items_per_page || 30)}">`, 'The number of bookmarks to display per page.')}
    ${checkHTML('sticky_pagination', 'Sticky pagination', p.sticky_pagination, 'When enabled, the pagination controls will stick to the bottom of the screen, so that they are always visible without having to scroll to the end of the page first.')}
    ${checkHTML('collapse_side_panel', 'Collapse side panel', p.collapse_side_panel, 'When enabled, the tags side panel will be collapsed by default to give more space to the bookmark list. Instead, the tags are shown in an expandable drawer.')}
    ${checkHTML('hide_bundles', 'Hide bundles', p.hide_bundles, "Allows to hide the bundles in the side panel if you don't intend to use them.")}
    ${row('tag_search', 'Tag search', selectHTML('tag_search', p.tag_search, [['strict', 'Strict'], ['lax', 'Lax']]), 'In strict mode, tags must be prefixed with a hash character (#). In lax mode, tags can also be searched without the hash character. Note that tags without the hash character are indistinguishable from search terms, which means the search result will also include bookmarks where a search term matches otherwise.')}
    ${row('tag_grouping', 'Tag grouping', selectHTML('tag_grouping', p.tag_grouping, [['alphabetical', 'Alphabetical'], ['disabled', 'Disabled']]), 'In alphabetical mode, tags will be grouped by the first letter. If disabled, tags will not be grouped.')}
    ${checkHTML('enable_favicons', 'Enable Favicons', p.enable_favicons, 'Shows favicons next to each bookmark. Icons are loaded from a <b>Google service</b> by your browser.')}
    ${row('web_archive_integration', 'Internet Archive integration', selectHTML('web_archive_integration', p.web_archive_integration, [['disabled', 'Disabled'], ['enabled', 'Enabled']]), 'When enabled, the bookmark date links to the snapshot of the website on the <a href="https://web.archive.org/" target="_blank" rel="noopener">Internet Archive Wayback Machine</a>.')}
    ${checkHTML('enable_sharing', 'Enable bookmark sharing', p.enable_sharing, 'Allows to share bookmarks with other users, and to view shared bookmarks. Disabling this feature will hide all previously shared bookmarks from other users.')}
    ${checkHTML('enable_public_sharing', 'Enable public bookmark sharing', p.enable_public_sharing, 'Makes shared bookmarks publicly accessible, without requiring a login. That means that anyone with a link to this instance can view shared bookmarks via the <a href="/bookmarks/shared" data-nav>shared bookmarks page</a>.')}
    ${checkHTML('default_mark_unread', 'Create bookmarks as unread by default', p.default_mark_unread, 'Sets the default state for the "Mark as unread" option when creating a new bookmark. This can be overridden when creating each new bookmark.')}
    ${checkHTML('default_mark_shared', 'Create bookmarks as shared by default', p.default_mark_shared, 'Sets the default state for the "Share" option when creating a new bookmark. This can be overridden when creating each new bookmark.')}
    <div class="form-group"><details${p.custom_css ? ' open' : ''}><summary><span class="form-label d-inline-block">Custom CSS</span></summary><label for="id_custom_css" class="text-assistive">Custom CSS</label><div><textarea name="custom_css" id="id_custom_css" class="form-input monospace" rows="6">${esc(p.custom_css || '')}</textarea></div></details><div class="form-input-hint">Allows to add custom CSS to the page.</div></div>
    <div class="form-group"><input type="submit" value="Save" class="btn btn-primary btn-wide mt-2"></div>
  </form></section>
  <section aria-labelledby="import-heading"><h2 id="import-heading">Import</h2><p>Import bookmarks and tags in the Netscape HTML format. This will execute a sync where new bookmarks are added and existing ones are updated.</p>
  <form id="iform"><div class="form-group"><label for="import_map_private_flag" class="form-checkbox"><input type="checkbox" id="import_map_private_flag" name="map_private_flag" aria-describedby="import_map_private_flag_help"><i class="form-icon"></i> Import public bookmarks as shared</label>
    <div id="import_map_private_flag_help" class="form-input-hint">When importing bookmarks from a service that supports marking bookmarks as public or private (using the <code>PRIVATE</code> attribute), enabling this option will import all bookmarks that are marked as not private as shared bookmarks. Otherwise, all bookmarks will be imported as private bookmarks.</div></div>
    <div class="form-group"><div class="input-group width-75 width-md-100"><input class="form-input" type="file" name="import_file"><input type="submit" class="input-group-btn btn btn-primary" value="Upload"></div></div></form></section>
  <section aria-labelledby="export-heading"><h2 id="export-heading">Export</h2><p>Export all bookmarks in Netscape HTML format.</p><a class="btn btn-primary" target="_blank" href="/settings/export">Download (.html)</a></section></main>`;
  const f = $('#pform');
  f.bookmark_description_display.onchange = () => $('#maxlines-group').classList.toggle('d-hide', f.bookmark_description_display.value === 'inline');
  const sharing = () => {
    if (!f.enable_sharing.checked) { f.enable_public_sharing.checked = false; f.enable_public_sharing.disabled = true; f.default_mark_shared.checked = false; f.default_mark_shared.disabled = true; }
    else { f.enable_public_sharing.disabled = false; f.default_mark_shared.disabled = false; }
  };
  sharing(); f.enable_sharing.onchange = sharing;
  f.onsubmit = async e => {
    e.preventDefault();
    const body = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') body[el.name] = el.checked;
      else if (el.type === 'number') body[el.name] = Math.max(el.min ? +el.min : 0, parseInt(el.value, 10) || 0);
      else body[el.name] = el.value;
    }
    try { profile = await api('PATCH', '/api/user/profile/', body); applyTheme(); renderNav(); await settingsPage(); flash('Profile updated'); scrollTo(0, 0); } catch (er) { fail(er); }
  };
  $('#iform').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('import_file') || !fd.get('import_file').size) return flash('Please select a file to import.', 'error');
    try {
      const r = await fetch('/settings/import', {method: 'POST', headers: {'X-Requested-With': 'ld'}, body: fd, credentials: 'same-origin'});
      const d = await r.json().catch(() => ({}));
      tagCache = null;
      if (!r.ok) return flash(d.detail || 'An error occurred during bookmark import.', 'error');
      flash(d.message, d.failed ? 'error' : 'success');
      scrollTo(0, 0);
    } catch (er) { fail(er); }
  };
}

async function integrationsPage(newToken) {
  document.title = 'Integrations - Linkding';
  let tokens = [];
  try { tokens = await api('GET', '/api/user/tokens/'); } catch (e) { return fail(e); }
  const origin = location.origin;
  const serverJs = `javascript:(function(){const d=new URL('${origin}/bookmarks/new');d.searchParams.set('url',window.location.href);d.searchParams.set('auto_close','');window.open(d.toString());})();`;
  const clientJs = `javascript:(function(){const d=new URL('${origin}/bookmarks/new');d.searchParams.set('url',window.location.href);d.searchParams.set('title',document.title);const m=document.querySelector('meta[name=description],meta[property="og:description"]');if(m)d.searchParams.set('description',m.content);d.searchParams.set('auto_close','');window.open(d.toString());})();`;
  content.innerHTML = `<main class="settings-page" aria-labelledby="main-heading"><h1 id="main-heading">Integrations</h1>
  <section aria-labelledby="browser-extension-heading"><h2 id="browser-extension-heading">Browser Extension</h2>
    <p>The browser extension allows you to quickly add new bookmarks without leaving the page that you are on. The extension is available in the official extension stores for:</p>
    <ul><li><a href="https://addons.mozilla.org/firefox/addon/linkding-extension/" target="_blank">Firefox</a></li><li><a href="https://chrome.google.com/webstore/detail/linkding-extension/beakmhbijpdhipnjhnclmhgjlddhidpe" target="_blank">Chrome</a></li></ul>
    <p>The extension is <a href="https://github.com/sissbruecker/linkding-extension" target="_blank">open source</a> as well, which enables you to build and manually load it into any browser that supports Chrome extensions.</p>
    <p>In the extension options use <code>${esc(origin)}</code> as the base URL and an API token from below.</p>
    <h2>Bookmarklet</h2>
    <p>The bookmarklet is an alternative, cross-browser way to quickly add new bookmarks without opening the linkding application first. Here's how it works:</p>
    <ul><li>Choose your preferred method for detecting website titles and descriptions below</li><li>Drag the bookmarklet below into your browser's bookmark bar / toolbar</li><li>Open the website that you want to bookmark</li><li>Click the bookmarklet in your browser's toolbar</li><li>linkding opens in a new window or tab and allows you to add a bookmark for the site</li><li>After saving the bookmark, the linkding window closes, and you are back on your website</li></ul>
    <div class="form-group radio-group" role="radiogroup" aria-labelledby="detection-method-label"><p id="detection-method-label">Choose your preferred bookmarklet:</p>
      <label for="detection-method-server" class="form-radio"><input id="detection-method-server" type="radio" name="bookmarklet-type" value="server" checked><i class="form-icon"></i> Detect title and description on the server</label>
      <label for="detection-method-client" class="form-radio"><input id="detection-method-client" type="radio" name="bookmarklet-type" value="client"><i class="form-icon"></i> Detect title and description in the browser</label></div>
    <div class="bookmarklet-container"><a id="bookmarklet-server" href="${esc(serverJs)}" class="btn btn-primary">📎 Add bookmark</a><a id="bookmarklet-client" href="${esc(clientJs)}" class="btn btn-primary" style="display:none">📎 Add bookmark</a></div></section>
  <section aria-labelledby="rest-api-heading"><h2 id="rest-api-heading">REST API</h2>
    ${newToken ? `<div class="toast toast-success mb-2">API token created successfully</div><div class="mt-4 mb-6"><p class="mb-2"><strong>Copy this token now, it will only be shown once:</strong></p><label class="text-assistive" for="new-token-key">New token key</label><div class="input-group"><input class="form-input" value="${esc(newToken)}" readonly id="new-token-key"><button id="copy-new-token-key" class="btn input-group-btn" type="button">Copy</button></div></div>` : ''}
    <p>API tokens can be used to authenticate 3rd-party applications against the REST API. <strong>Please treat tokens as you would any other credential.</strong> Any party with access to a token can access and manage all your bookmarks.</p>
    ${tokens.length ? `<table class="table crud-table mb-6"><thead><tr><th>Name</th><th>Created</th><th class="actions"><span class="text-assistive">Actions</span></th></tr></thead><tbody>${tokens.map(t => `<tr><td>${esc(t.name)}</td><td>${new Date(t.created).toLocaleString('en-US', {month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false})}</td><td class="actions"><button data-confirm type="button" data-token="${t.id}" class="btn btn-link">Delete</button></td></tr>`).join('')}</tbody></table>` : ''}
    <button type="button" class="btn" id="new-token">Create API token</button></section></main>`;
  const rs = () => { const server = $('#detection-method-server').checked; $('#bookmarklet-server').style.display = server ? 'inline-block' : 'none'; $('#bookmarklet-client').style.display = server ? 'none' : 'inline-block'; };
  $$('input[name=bookmarklet-type]').forEach(r => r.onchange = rs);
  const copy = $('#copy-new-token-key');
  if (copy) copy.onclick = () => navigator.clipboard.writeText($('#new-token-key').value).then(() => { copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = 'Copy'; }, 2000); });
  $$('[data-token]').forEach(b => b.addEventListener('click', async () => { if (!b.dataset.confirmed) return; try { await api('DELETE', `/api/user/tokens/${b.dataset.token}/`); await integrationsPage(); } catch (er) { fail(er); } }));
  $('#new-token').onclick = () => {
    const m = openModal(`<form>${modalHeader('Create API Token')}<div class="modal-body"><div class="form-group"><label class="form-label" for="token-name">Token name</label><input type="text" class="form-input" id="token-name" name="name" placeholder="e.g., Browser Extension, Mobile App" value="API Token" maxlength="128"><p class="form-input-hint">A descriptive name to identify the purpose of the token</p></div></div>
      <div class="modal-footer d-flex justify-between"><button type="button" class="btn btn-wide" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Create Token</button></div></form>`);
    $('#token-name', m).select();
    $('form', m).onsubmit = async e => { e.preventDefault(); try { const t = await api('POST', '/api/user/tokens/', {name: e.target.name.value}); m.close(); await integrationsPage(t.token); } catch (er) { fail(er); } };
  };
}

async function passwordPage() {
  document.title = 'Change password - Linkding';
  content.innerHTML = `<main class="auth-page" aria-labelledby="main-heading"><div class="section-header"><h1 id="main-heading">Change password</h1></div>
    <form id="pwform"><div class="form-group"><label for="id_current" class="form-label">Old password</label><input type="password" id="id_current" name="current" class="form-input" autocomplete="current-password" required></div>
    <div class="form-group"><label for="id_new" class="form-label">New password</label><input type="password" id="id_new" name="new" class="form-input" autocomplete="new-password" minlength="8" required><div class="form-input-hint">Your password must contain at least 8 characters.</div></div>
    <div class="form-input-hint is-error" id="pwerr" hidden></div>
    <input type="submit" value="Change my password" class="btn btn-primary mt-4"></form></main>`;
  $('#pwform').onsubmit = async e => {
    e.preventDefault();
    try { await api('POST', '/api/user/password/', {current: e.target.current.value, new: e.target.new.value}); await go('/settings/general'); flash('Your password was changed.'); }
    catch (er) { const x = $('#pwerr'); x.textContent = er.message.replace(/^(current|new): /, ''); x.hidden = false; }
  };
}

// ---------------------------------------------------------------- boot
(async () => {
  anon = location.pathname === '/bookmarks/shared';
  try { profile = await api('GET', '/api/user/profile/'); applyTheme(); }
  catch (e) { if (!anon) return; profile = {}; }
  renderNav();
  route();
})();
})();
