// Document control: RFIs and submittals from Procore, Autodesk (ACC / Forma) and notification emails.
import { isoDate } from './db.js';

// Spec sections are CSI MasterFormat ("26 05 19", "260519", "08 44 13.11").
export const WATCH_GROUPS = [
  { key: 'div26', label: 'Div 26 — Electrical', spec: /^26/, words: /\b(electrical|switchgear|panelboard|lighting|transformer|generator|feeder|conduit)\b/i },
  { key: 'div27', label: 'Div 27 — Communications', spec: /^27/, words: /\b(communications?|data cabling|low voltage|telecom|structured cabling|AV|audio.?visual)\b/i },
  { key: 'div28', label: 'Div 28 — Electronic Safety & Security', spec: /^28/, words: /\b(fire alarm|access control|security|cctv|intrusion|nurse call)\b/i },
  { key: 'hvac', label: 'HVAC equipment', spec: /^23/, words: /\b(hvac|rtu|ahu|vrf|vav|chiller|boiler|cooling tower|exhaust fan|split system|heat pump|ductwork|mechanical equipment)\b/i },
  { key: 'plumbing', label: 'Plumbing equipment', spec: /^22/, words: /\b(plumbing|water heater|booster pump|fixtures?|backflow|sump|domestic water|grease interceptor)\b/i },
  { key: 'millwork', label: 'Millwork', spec: /^06 ?4|^12 ?3/, words: /\b(millwork|casework|cabinets?|countertops?|architectural woodwork)\b/i },
  { key: 'glazing', label: 'Special glazing', spec: /^08 ?[4-8]/, words: /\b(glazing|curtain ?wall|storefront|fire.?rated glass|skylights?|glass)\b/i },
  { key: 'framing', label: 'Framing', spec: /^05 ?4|^06 ?1|^09 ?2[12]/, words: /\b(framing|metal studs?|cfmf|cold.?formed|wood framing|shaft ?wall)\b/i },
];

export function normalizeSpec(spec) {
  const digits = String(spec || '').replace(/[^\d.]/g, '');
  const m = digits.match(/^(\d{2})(\d{2})(\d{2})(\.\d+)?/);
  return m ? `${m[1]} ${m[2]} ${m[3]}${m[4] || ''}` : (spec || '').trim() || null;
}

export function classify({ spec_section, title = '', description = '' }) {
  const spec = normalizeSpec(spec_section) || '';
  const text = `${title} ${description}`;
  // The spec section is authoritative; keywords are only a fallback when it is missing or unmatched.
  const bySpec = spec ? WATCH_GROUPS.filter((g) => g.spec.test(spec)) : [];
  return (bySpec.length ? bySpec : WATCH_GROUPS.filter((g) => g.words.test(text))).map((g) => g.key);
}

const CLOSED = /^(closed|approved|approved as noted|reviewed|void|answered|complete|distributed|no exceptions taken)/i;
export const isOpen = (status) => !CLOSED.test(String(status || '').trim());

// Recognise Procore / Autodesk notification emails and pull the item out of them.
export function parseNotificationEmail({ sender = '', subject = '', body = '' }, today = isoDate()) {
  const text = `${subject}\n${body}`;
  const from = `${sender} ${body.slice(-600)}`;
  const source = /procore/i.test(from) || /procore/i.test(text) ? 'procore'
    : /autodesk|acc\.autodesk|construction cloud|forma/i.test(from) || /autodesk construction cloud|autodesk build|forma/i.test(text) ? 'autodesk'
      : null;
  if (!source) return [];

  const type = /submittal/i.test(text) ? 'submittal' : /\bRFI\b|request for information/i.test(text) ? 'rfi' : null;
  if (!type) return [];

  const num = subject.match(/(?:RFI|Submittal)\s*(?:#|No\.?|Number)?\s*:?\s*([A-Z0-9][\w .\-]*?\d[\w.\-]*)(?=\s*[:\-–—]|\s+(?:has|was|is|requires|needs)\b|$)/i)
    || text.match(/(?:RFI|Submittal)\s*#\s*([\w.\-]+(?:\s[\w.\-]+){0,2})/i);
  const spec = text.match(/\b(\d{2}\s?\d{2}\s?\d{2}(?:\.\d+)?)\b/);
  const titleM = subject.match(/(?:RFI|Submittal)[^:]*:\s*(.+)$/i) || body.match(/(?:Subject|Title)\s*:\s*(.+)/i);
  const dueM = text.match(/\b(?:due|response required by|required by|due date)\s*(?:date)?\s*:?\s*(?:on\s+)?([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const statusM = text.match(/\bstatus\s*:\s*([A-Za-z ]{3,30})/i);
  const projectM = text.match(/\bproject\s*:\s*(.+)/i);
  const assigned = /assigned to you|ball in court|your response|you have been (?:assigned|added)|awaiting your|requires your|action required/i.test(text);
  const urlM = body.match(/https?:\/\/\S*(procore\.com|autodesk\.com)\S*/i);

  return [{
    source: 'email',
    origin: source,
    type,
    number: num ? num[1].trim() : null,
    title: (titleM ? titleM[1] : subject)
      .replace(/\s*[-–—|]\s*(action required|response required|ball in court|new (item|submittal|rfi)|reminder|overdue|has been .*|requires your .*)\s*$/i, '')
      .trim().slice(0, 200),
    spec_section: spec ? normalizeSpec(spec[1]) : null,
    status: statusM ? statusM[1].trim() : 'Open',
    due_date: dueM ? toIso(dueM[1], today) : null,
    assigned_to_me: assigned,
    ball_in_court: assigned ? 'me' : null,
    project_hint: projectM ? projectM[1].trim().slice(0, 120) : null,
    url: urlM ? urlM[0].replace(/[>)\]]+$/, '') : null,
  }];
}

function toIso(s, today) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s.replace(/\./g, ''));
  if (Number.isNaN(d.getTime())) return null;
  // m/d/yy forms: Date() handles them in local time.
  const p = (n) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return iso < '2000-01-01' ? today : iso;
}

function findProject(db, item) {
  if (item.project_id && /^\d+$/.test(String(item.project_id))) return Number(item.project_id);
  if (item.project_id) { // a job number such as G2707
    const hit = db.prepare('SELECT id FROM projects WHERE lower(code) = lower(?)').get(String(item.project_id));
    if (hit) return hit.id;
  }
  const projects = db.prepare('SELECT id, name, code FROM projects').all();
  const hay = `${item.project_hint || ''} ${item.project_name || ''} ${item.title || ''}`.toLowerCase();
  const byExternal = item.external_project_id
    && db.prepare("SELECT value FROM settings WHERE key = 'project_links'").get();
  if (byExternal) {
    const links = JSON.parse(byExternal.value || '{}');
    const hit = Object.entries(links).find(([, ext]) => String(ext) === String(item.external_project_id));
    if (hit) return Number(hit[0]);
  }
  return projects.find((p) => (p.code && hay.includes(p.code.toLowerCase())) || hay.includes(p.name.toLowerCase()))?.id ?? null;
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function mePersonId(db) {
  return getSetting(db, 'me_person_id', null)
    ?? db.prepare("SELECT id FROM people WHERE role LIKE '%project manager%' AND role NOT LIKE '%assist%' ORDER BY id LIMIT 1").get()?.id
    ?? null;
}

// Insert or update tracked items; returns what changed so we can alert on it.
export function upsertItems(db, items, today = isoDate()) {
  const changes = [];
  const me = mePersonId(db);
  const find = db.prepare(`SELECT * FROM tracked_items WHERE
    (external_id IS NOT NULL AND origin = ? AND external_id = ?)
    OR (number IS NOT NULL AND type = ? AND number = ? AND IFNULL(project_id, 0) = IFNULL(?, 0))`);
  db.exec('BEGIN');
  try {
    for (const raw of items) {
      if (!raw.type || !raw.title) continue;
      const item = {
        origin: raw.origin || raw.source || 'manual',
        source: raw.source || raw.origin || 'manual',
        external_id: raw.external_id != null ? String(raw.external_id) : null,
        type: raw.type === 'submittal' ? 'submittal' : 'rfi',
        number: raw.number || null,
        title: String(raw.title).slice(0, 300),
        spec_section: normalizeSpec(raw.spec_section),
        status: raw.status || 'Open',
        ball_in_court: raw.ball_in_court || null,
        assigned_to_me: raw.assigned_to_me ? 1 : 0,
        due_date: raw.due_date || null,
        url: raw.url || null,
        project_id: findProject(db, raw),
      };
      item.groups = JSON.stringify(classify(item));
      const prev = find.get(item.origin, item.external_id, item.type, item.number, item.project_id);
      let id;
      if (!prev) {
        id = Number(db.prepare(`INSERT INTO tracked_items (origin, source, external_id, type, number, title, spec_section, status,
          ball_in_court, assigned_to_me, due_date, url, project_id, groups, first_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.origin, item.source, item.external_id, item.type, item.number,
          item.title, item.spec_section, item.status, item.ball_in_court, item.assigned_to_me, item.due_date, item.url, item.project_id,
          item.groups, today, today).lastInsertRowid);
        changes.push({ id, change: 'new' });
      } else {
        id = prev.id;
        const merged = {
          ...item,
          // An email may not carry everything the API knows; never erase known values with blanks.
          external_id: item.external_id || prev.external_id,
          number: item.number || prev.number,
          spec_section: item.spec_section || prev.spec_section,
          due_date: item.due_date || prev.due_date,
          url: item.url || prev.url,
          project_id: item.project_id ?? prev.project_id,
          assigned_to_me: item.assigned_to_me || (item.source === 'email' ? prev.assigned_to_me : 0),
        };
        merged.groups = JSON.stringify(classify(merged));
        if (prev.status !== merged.status) changes.push({ id, change: 'status', from: prev.status, to: merged.status });
        if (!prev.assigned_to_me && merged.assigned_to_me) changes.push({ id, change: 'assigned' });
        if (prev.due_date !== merged.due_date) changes.push({ id, change: 'due', from: prev.due_date, to: merged.due_date });
        db.prepare(`UPDATE tracked_items SET source = ?, external_id = ?, number = ?, title = ?, spec_section = ?, status = ?, ball_in_court = ?,
          assigned_to_me = ?, due_date = ?, url = ?, project_id = ?, groups = ?, updated_at = ? WHERE id = ?`)
          .run(merged.source, merged.external_id, merged.number, merged.title, merged.spec_section, merged.status, merged.ball_in_court,
            merged.assigned_to_me, merged.due_date, merged.url, merged.project_id, merged.groups, today, id);
      }
      syncMyTask(db, id, me);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return changes;
}

// Anything in my court becomes a task on my list, so it gets nudged like everything else.
function syncMyTask(db, itemId, me) {
  const item = db.prepare('SELECT * FROM tracked_items WHERE id = ?').get(itemId);
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'doccontrol' AND source_ref = ?").get(itemId);
  const label = `${item.type === 'rfi' ? 'RFI' : 'Submittal'}${item.number ? ` #${item.number}` : ''}`;
  if (item.assigned_to_me && isOpen(item.status)) {
    if (!task) {
      db.prepare(`INSERT INTO tasks (project_id, title, description, owner_id, status, priority, due_date, source, source_ref, estimate_hours)
        VALUES (?, ?, ?, ?, 'not_started', ?, ?, 'doccontrol', ?, ?)`)
        .run(item.project_id, `Respond to ${label} — ${item.title}`.slice(0, 200),
          `${item.spec_section ? `Spec ${item.spec_section}. ` : ''}Ball in court: you.${item.url ? `\n${item.url}` : ''}`,
          me, item.due_date ? 'high' : 'medium', item.due_date, itemId, item.type === 'submittal' ? 2 : 1);
    } else if (task.status !== 'done' && item.due_date && task.due_date !== item.due_date) {
      db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run(item.due_date, task.id);
    }
  } else if (task && task.status !== 'done' && !isOpen(item.status)) {
    db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(isoDate(), task.id);
  }
}

export function listItems(db, { group, type, mine, open, project_id, q } = {}) {
  let rows = db.prepare(`SELECT i.*, p.name AS project_name, p.code AS project_code FROM tracked_items i
    LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.due_date IS NULL, i.due_date, i.id DESC`).all()
    .map((r) => ({ ...r, groups: JSON.parse(r.groups || '[]'), open: isOpen(r.status), assigned_to_me: Boolean(r.assigned_to_me) }));
  if (group) rows = rows.filter((r) => r.groups.includes(group));
  if (type) rows = rows.filter((r) => r.type === type);
  if (mine) rows = rows.filter((r) => r.assigned_to_me);
  if (open) rows = rows.filter((r) => r.open);
  if (project_id) rows = rows.filter((r) => r.project_id === Number(project_id));
  if (q) rows = rows.filter((r) => `${r.number} ${r.title} ${r.spec_section}`.toLowerCase().includes(q.toLowerCase()));
  return rows;
}

export function docControlSummary(db, today = isoDate()) {
  const watched = new Set(getSetting(db, 'watch_groups', WATCH_GROUPS.map((g) => g.key)));
  const items = listItems(db);
  const weekAgo = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
  const inWatch = (i) => i.groups.some((g) => watched.has(g));
  return {
    groups: WATCH_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      watched: watched.has(g.key),
      open: items.filter((i) => i.open && i.groups.includes(g.key)).length,
      new_this_week: items.filter((i) => i.first_seen_at >= weekAgo && i.groups.includes(g.key)).length,
    })),
    new_this_week: items.filter((i) => i.first_seen_at >= weekAgo && inWatch(i)),
    in_my_court: items.filter((i) => i.open && i.assigned_to_me),
    overdue: items.filter((i) => i.open && i.due_date && i.due_date < today),
  };
}
