// Schedule control: baseline vs current, 3-week look-ahead, equipment releases, recurring routines.
import { addDays, isoDate } from './db.js';
import { isOpen } from './doccontrol.js';
import { moneyPriority } from './ops.js';

// ---------- CSV import (P6 / MS Project / Excel exports) ----------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const COLS = {
  activity_id: /^(activity ?id|task ?id|id|act ?id|unique ?id|wbs)$/i,
  name: /^(activity ?name|task ?name|name|description|activity)$/i,
  start: /^(start|start ?date|early ?start|planned ?start|forecast ?start|current ?start)$/i,
  finish: /^(finish|finish ?date|end|end ?date|early ?finish|planned ?finish|forecast ?finish|current ?finish)$/i,
  baseline_start: /^(bl|baseline)[ \d_-]*(project ?)?start$/i,
  baseline_finish: /^(bl|baseline)[ \d_-]*(project ?)?finish$/i,
  percent: /%|percent/i,
  trade: /^(trade|responsibility|resource|area|responsible|sub(contractor)?)$/i,
};

export function parseScheduleDate(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/[A*]+$/, '').trim(); // P6 marks actuals with "A" or "*"
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) return fmt(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[1]), Number(m[2]));
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{2,4})/);
  if (m) return fmt(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), monthIdx(m[2]), Number(m[1]));
  m = s.match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{2,4})/);
  if (m) return fmt(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), monthIdx(m[1]), Number(m[2]));
  return null;
}
const monthIdx = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.toLowerCase().slice(0, 3)) + 1;
const fmt = (y, mo, d) => (mo < 1 || d < 1 ? null : `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

export function importSchedule(db, projectId, csvText, mode = 'current') {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one activity');
  const header = rows[0].map((h) => h.trim());
  const col = {};
  for (const [key, re] of Object.entries(COLS)) {
    const idx = header.findIndex((h, i) => re.test(h) && !Object.values(col).includes(i));
    if (idx >= 0) col[key] = idx;
  }
  if (col.activity_id === undefined || col.name === undefined) throw new Error('Could not find Activity ID and Activity Name columns');

  const get = (r, k) => (col[k] === undefined ? null : r[col[k]]?.trim() || null);
  const upsert = db.prepare(`INSERT INTO schedule_activities (project_id, activity_id, name, trade, baseline_start, baseline_finish, current_start, current_finish, percent_complete, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, activity_id) DO UPDATE SET
      name = excluded.name,
      trade = COALESCE(excluded.trade, trade),
      baseline_start = COALESCE(excluded.baseline_start, baseline_start),
      baseline_finish = COALESCE(excluded.baseline_finish, baseline_finish),
      current_start = COALESCE(excluded.current_start, current_start),
      current_finish = COALESCE(excluded.current_finish, current_finish),
      percent_complete = COALESCE(excluded.percent_complete, percent_complete),
      updated_at = excluded.updated_at`);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows.slice(1)) {
      const id = get(r, 'activity_id');
      const name = get(r, 'name');
      if (!id || !name) continue;
      const start = parseScheduleDate(get(r, 'start'));
      const finish = parseScheduleDate(get(r, 'finish'));
      const bls = parseScheduleDate(get(r, 'baseline_start')) ?? (mode === 'baseline' ? start : null);
      const blf = parseScheduleDate(get(r, 'baseline_finish')) ?? (mode === 'baseline' ? finish : null);
      const pct = get(r, 'percent');
      upsert.run(Number(projectId), id, name, get(r, 'trade'), bls, blf,
        mode === 'baseline' ? null : start, mode === 'baseline' ? null : finish,
        pct == null ? null : Number(String(pct).replace('%', '')) || 0);
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported: count, columns: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, header[i]])) };
}

const days = (a, b) => (a && b ? Math.round((Date.parse(a) - Date.parse(b)) / 86400000) : null);

// ---------- 3-week look-ahead vs baseline ----------
export function lookahead(db, { project_id, weeks = 3 } = {}, today = isoDate()) {
  const end = addDays(today, weeks * 7);
  const rows = db.prepare(`SELECT a.*, p.name AS project_name, p.code AS project_code FROM schedule_activities a
    JOIN projects p ON p.id = a.project_id ${project_id ? 'WHERE a.project_id = ?' : ''} ORDER BY COALESCE(a.current_start, a.baseline_start)`)
    .all(...(project_id ? [Number(project_id)] : []));
  const items = rows.map((a) => {
    const start = a.current_start || a.baseline_start;
    const finish = a.current_finish || a.baseline_finish;
    const finishVar = days(finish, a.baseline_finish);
    const startVar = days(start, a.baseline_start);
    const done = (a.percent_complete ?? 0) >= 100;
    let flag = 'on_track';
    if (!done && finish && finish < today) flag = 'overdue';
    else if (finishVar > 0) flag = 'slipped';
    else if (finishVar < 0) flag = 'ahead';
    if (!done && start && start < today && !(a.percent_complete > 0)) flag = flag === 'on_track' ? 'not_started_late' : flag;
    return { ...a, start, finish, start_variance: startVar, finish_variance: finishVar, done, flag };
  });
  const inWindow = items.filter((a) => !a.done && a.start && a.start <= end && (a.finish || a.start) >= today);
  // Work the baseline promised for this window that has been pushed out of it.
  const pushedOut = items.filter((a) => !a.done && a.baseline_start && a.baseline_start <= end && a.baseline_start >= today && a.start > end);
  const behind = items.filter((a) => !a.done && (a.flag === 'overdue' || a.flag === 'not_started_late'));
  return {
    window: { from: today, to: end, weeks },
    activities: inWindow,
    pushed_out: pushedOut,
    behind,
    stats: {
      in_window: inWindow.length,
      slipped: inWindow.filter((a) => a.finish_variance > 0).length,
      worst_slip_days: Math.max(0, ...items.map((a) => a.finish_variance || 0)),
      has_baseline: items.some((a) => a.baseline_finish),
    },
  };
}

// ---------- Equipment release log ----------
export function equipmentLog(db, { project_id } = {}, today = isoDate()) {
  const rows = db.prepare(`SELECT e.*, p.name AS project_name, p.code AS project_code,
      a.name AS activity_name, COALESCE(a.current_start, a.baseline_start) AS activity_start,
      i.number AS submittal_number, i.status AS submittal_status, i.title AS submittal_title
    FROM equipment e LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN schedule_activities a ON a.project_id = e.project_id AND a.activity_id = e.activity_id
    LEFT JOIN tracked_items i ON i.id = e.submittal_item_id
    ${project_id ? 'WHERE e.project_id = ?' : ''} ORDER BY e.id`).all(...(project_id ? [Number(project_id)] : []));
  return rows.map((e) => {
    const needBy = e.activity_start || e.need_by_date; // the linked schedule activity drives the date when present
    const releaseBy = needBy && e.lead_time_weeks != null ? addDays(needBy, -(e.lead_time_weeks * 7 + (e.buffer_days ?? 7))) : null;
    const submittalOpen = e.submittal_item_id ? isOpen(e.submittal_status) : false;
    let state;
    if (e.delivered_at) state = 'delivered';
    else if (e.released_at) state = needBy && addDays(e.released_at, e.lead_time_weeks * 7) > needBy ? 'released_late_risk' : 'released';
    else if (!releaseBy) state = 'needs_info';
    else if (releaseBy < today) state = 'release_overdue';
    else if (releaseBy <= addDays(today, 14)) state = submittalOpen ? 'blocked_by_submittal' : 'release_soon';
    else state = 'planned';
    return {
      ...e,
      need_by: needBy,
      release_by: releaseBy,
      days_to_release: releaseBy ? days(releaseBy, today) : null,
      submittal_open: submittalOpen,
      state,
    };
  });
}

// ---------- Recurring routines (weekly look-ahead review, etc.) ----------
// Creates the next occurrence as a task a few days ahead so the nudges pick it up.
export function runRoutines(db, today = isoDate(), leadDays = 3) {
  const routines = db.prepare('SELECT * FROM routines WHERE active = 1').all();
  const created = [];
  for (const r of routines) {
    const [y, m, d] = today.split('-').map(Number);
    let next;
    if (r.day_of_month) {
      // Monthly (e.g. pay application on the 20th). Short months clamp to their last day.
      const clamp = (yy, mm) => Math.min(r.day_of_month, new Date(yy, mm, 0).getDate());
      next = isoDate(new Date(y, m - 1, clamp(y, m)));
      if (next < today) next = isoDate(new Date(y, m, clamp(y, m + 1)));
      if (next > addDays(today, Math.max(leadDays, 5))) continue; // billing gets a longer runway
      if (r.last_due && r.last_due >= next) continue;
    } else {
      const dow = new Date(y, m - 1, d).getDay();
      next = addDays(today, (r.weekday - dow + 7) % 7);
      if (next > addDays(today, leadDays)) continue;
      if (r.last_due && r.last_due >= next) continue;
      if (r.last_due && r.every_weeks > 1 && days(next, r.last_due) < r.every_weeks * 7) continue;
    }
    const id = db.prepare(`INSERT INTO tasks (project_id, title, description, owner_id, priority, due_date, source, source_ref, estimate_hours)
      VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?)`)
      .run(r.project_id, r.title, r.description, r.owner_id, moneyPriority({ ...r, priority: 'medium', due_date: next }, today), next, r.id, r.estimate_hours).lastInsertRowid;
    db.prepare('UPDATE routines SET last_due = ? WHERE id = ?').run(next, r.id);
    created.push(Number(id));
  }
  return created;
}
