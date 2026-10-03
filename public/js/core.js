// Shared helpers: API client, escaping, formatting, toasts, cached reference data.
const TOKEN_KEY = 'zordon.token';

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token()) init.headers.Authorization = `Bearer ${token()}`;
  if (raw !== undefined) {
    init.body = raw;
    init.headers['content-type'] ||= 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    const t = prompt('This Zordon server is protected. Enter the access token (ZORDON_API_TOKEN):');
    if (t) {
      try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch { /* storage blocked */ }
      return api(path, { method, body, raw, headers });
    }
  }
  if (!res.ok) {
    const msg = await res.json().then((j) => j.error, () => res.statusText);
    throw new Error(msg || `Request failed (${res.status})`);
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.blob();
}

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function fmtDate(d, opts = { month: 'short', day: 'numeric' }) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, opts);
}
export function fmtTime(dt) {
  if (!dt || dt.length < 16) return '';
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function relDays(d, today) {
  if (!d) return '';
  const n = Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n}d` : `${-n}d late`;
}

export function avatar(person, cls = '') {
  if (!person?.name) return `<span class="avatar ${cls}" style="--c:#24344d;color:var(--muted)" title="Unassigned">?</span>`;
  return `<span class="avatar c-${esc(person.color)} ${cls}" title="${esc(person.name)}">${esc(initials(person.name))}</span>`;
}

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

export async function guard(fn) {
  try { return await fn(); } catch (err) { toast(err.message, 'error'); return undefined; }
}

// Reference data used across views; refreshed after edits.
export const store = { people: [], projects: [], meta: { statuses: [], priorities: [], colors: [] } };
export async function refreshRefs() {
  const [people, projects, meta] = await Promise.all([api('/api/people'), api('/api/projects'), api('/api/meta')]);
  Object.assign(store, { people, projects, meta });
  const banner = document.getElementById('demo-banner');
  if (banner) {
    banner.hidden = !meta.demo;
    banner.textContent = meta.vault_set
      ? 'DEMO DATA: Zordon can\'t find Zordon/zordon-roster.json in your OneDrive. Check ZORDON_VAULT in .env, then restart Zordon.'
      : 'DEMO DATA: set ZORDON_VAULT in the .env file to your GEC2 OneDrive folder, then restart Zordon. Your real team and jobs replace this automatically.';
  }
  return store;
}
export const personById = (id) => store.people.find((p) => p.id === id);
export const projectById = (id) => store.projects.find((p) => p.id === id);

export function options(list, selected, { empty, value = (x) => x.id, text = (x) => x.name } = {}) {
  const head = empty !== undefined ? `<option value="">${esc(empty)}</option>` : '';
  return head + list.map((x) => `<option value="${esc(value(x))}" ${String(value(x)) === String(selected ?? '') ? 'selected' : ''}>${esc(text(x))}</option>`).join('');
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function downloadDoc(doc) {
  const blob = await api(`/api/documents/${doc.id}/file`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.path.split('/').pop();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
