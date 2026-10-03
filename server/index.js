// Zordon Command Center — HTTP API + static UI, no framework.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, seedIfEmpty, isoDate, STATUSES, PRIORITIES, RANGER_COLORS } from './db.js';
import { analyzeEmail, aiEnabled, resolveRefs } from './intel.js';
import { moneyPriority, dashboard, listTasks, getTask, listMeetings, projectSummaries, reminderDrafts, realityCheck, myNudges } from './ops.js';
import { WATCH_GROUPS, parseNotificationEmail, upsertItems, listItems, docControlSummary, getSetting, setSetting, mePersonId } from './doccontrol.js';
import { importSchedule, lookahead, equipmentLog, runRoutines } from './schedule.js';
import { connectorStatus, syncAll } from './connectors.js';
import { createVoiceSession, greeting, say, FAREWELL } from './voice.js';
import { projectWeather } from './weather.js';
import { leadTime, createElectricalPlan, LEAD_TIMES } from './electrical.js';
import { loadBuiltinSkills, listSkills, saveSkill, createJob, listJobs, syncControl, importJobResult, filingRules,
  importProposal, decideProposal, listProposals } from './claude.js';
import { CATEGORY_NAMES, CATEGORY_FOLDERS, suggestName, finalize, textSnippet, uniquePath, saveFile, moveFile, deleteFile, vaultPath,
  ensureProjectFolders, inboxFiles, readVaultFile, projectFolder, isJobNumber, JOB_TEMPLATE, CONTROL_DIR, INBOX, findJobFolder } from './vault.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STATIC_DIRS = {
  '/vendor/three/': join(ROOT, 'node_modules/three/'),
  '/vendor/fonts/': join(ROOT, 'node_modules/@fontsource/'),
  '/': join(ROOT, 'public/'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const required = (v, name) => { if (v === undefined || v === null || v === '') throw new HttpError(400, `${name} is required`); return v; };
const oneOf = (v, list, name) => { if (v !== undefined && !list.includes(v)) throw new HttpError(400, `${name} must be one of ${list.join(', ')}`); return v; };
const dateOrNull = (v, name) => {
  if (v === undefined || v === null || v === '') return v === '' ? null : v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return v;
};

function update(db, table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), Number(id));
}

function mustExist(row, what) {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
}

function taskFields(body, { creating }) {
  const f = pick(body, ['project_id', 'title', 'description', 'owner_id', 'status', 'priority', 'start_date', 'due_date', 'source', 'source_ref']);
  if (creating) required(f.title, 'title');
  oneOf(f.status, STATUSES, 'status');
  oneOf(f.priority, PRIORITIES, 'priority');
  for (const k of ['start_date', 'due_date']) if (k in f) f[k] = dateOrNull(f[k], k);
  for (const k of ['project_id', 'owner_id']) if (k in f) f[k] = f[k] === null || f[k] === '' ? null : Number(f[k]);
  return f;
}

function createTask(db, body) {
  const f = taskFields(body, { creating: true });
  if (f.status === 'done') f.completed_at = isoDate();
  f.priority = moneyPriority(f);
  const keys = Object.keys(f);
  const { lastInsertRowid } = db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => f[k]));
  return Number(lastInsertRowid);
}

function createMeeting(db, body) {
  const f = pick(body, ['project_id', 'title', 'starts_at', 'duration_min', 'location', 'attendee_ids', 'agenda', 'notes', 'source', 'source_ref']);
  required(f.title, 'title');
  required(f.starts_at, 'starts_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f.starts_at)) throw new HttpError(400, 'starts_at must be YYYY-MM-DDTHH:MM');
  f.attendee_ids = JSON.stringify(f.attendee_ids || []);
  const keys = Object.keys(f);
  return Number(db.prepare(`INSERT INTO meetings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => f[k])).lastInsertRowid);
}

async function ingestEmail(db, body, today) {
  required(body.body, 'body');
  const email = { sender: body.sender || body.from || null, subject: body.subject || null, body: body.body };
  const ctx = {
    people: db.prepare('SELECT id, name, role, trade FROM people WHERE active = 1').all(),
    projects: db.prepare("SELECT id, name, code FROM projects WHERE status != 'closed'").all(),
    today,
  };
  const { analyzer, ...analysis } = await analyzeEmail(email, ctx);
  const { lastInsertRowid } = db.prepare('INSERT INTO emails (sender, subject, body, received_at, analysis, analyzer) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email.sender, email.subject, email.body, body.received_at || new Date().toISOString(), JSON.stringify(analysis), analyzer);
  const id = Number(lastInsertRowid);
  const items = parseNotificationEmail(email, today);
  if (items.length) upsertItems(db, items, today);
  // Automations can ask for suggestions to be accepted immediately so nothing waits on manual triage.
  if (body.auto_accept) acceptEmail(db, id, { tasks: analysis.tasks, meetings: analysis.meetings });
  return { ...getEmail(db, id), doc_items: items };
}

function getEmail(db, id) {
  const e = mustExist(db.prepare('SELECT * FROM emails WHERE id = ?').get(Number(id)), 'Email');
  return { ...e, analysis: e.analysis ? JSON.parse(e.analysis) : null };
}

function acceptEmail(db, id, { tasks = [], meetings = [] }) {
  const email = getEmail(db, id);
  const created = { tasks: [], meetings: [] };
  db.exec('BEGIN');
  try {
    for (const t of tasks) {
      created.tasks.push(createTask(db, {
        ...t,
        description: t.description ?? `From email: ${email.subject || '(no subject)'}${email.sender ? ` — ${email.sender}` : ''}`,
        source: 'email', source_ref: email.id,
      }));
    }
    for (const m of meetings) created.meetings.push(createMeeting(db, { ...m, source: 'email', source_ref: email.id }));
    db.prepare("UPDATE emails SET status = 'processed' WHERE id = ?").run(email.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return created;
}

const fileExists = (p) => stat(p).then(() => true, () => false);
const docSelect = `SELECT d.*, pr.name AS project_name, pr.code AS project_code, t.title AS task_title
  FROM documents d LEFT JOIN projects pr ON pr.id = d.project_id LEFT JOIN tasks t ON t.id = d.task_id`;

// Name and file one document. `buffer` is new content; `fromRel` moves a file already in the vault (the _Inbox).
export async function fileDocument(db, vaultRoot, { buffer, fromRel, filename, project_id, task_id, hint, title, category, mime, notes }, today = isoDate()) {
  const ctx = { projects: db.prepare('SELECT id, name, code FROM projects').all(), today };
  const content = buffer ?? await readVaultFile(vaultRoot, fromRel);
  const suggestion = await suggestName({ filename, text: textSnippet(content, filename), project_id: project_id || null, hint: hint || '' }, ctx);
  // Explicit choices from the user win over the suggestion.
  const chosen = (title || category || project_id)
    ? finalize({
      title: title || suggestion.title,
      category: CATEGORY_NAMES.includes(category) ? category : suggestion.category,
      project: ctx.projects.find((p) => p.id === Number(project_id || suggestion.project_id)) || null,
      ext: filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : '',
      today,
    })
    : suggestion;
  const rel = await uniquePath(vaultRoot, chosen.folder, chosen.filename, fileExists);
  if (fromRel) await moveFile(vaultRoot, fromRel, rel);
  else await saveFile(vaultRoot, rel, content);
  const id = db.prepare(`INSERT INTO documents (project_id, task_id, title, category, original_name, path, size, mime, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chosen.project_id, task_id ? Number(task_id) : null, chosen.title, chosen.category,
    filename, rel, content.length, mime || null, notes || null).lastInsertRowid;
  return { id: Number(id), analyzer: suggestion.analyzer };
}

// A batch of already-analyzed emails, written to the vault's _Inbox by the hourly Claude email check.
// { "type": "zordon.emails", "auto_accept": true, "projects": [{ name, code, short_name, location }], "emails": [{ message_id, sender, subject, received_at, summary, body,
//   tasks: [{ title, owner, project, due_date, priority }], meetings: [{ title, starts_at, location, project }] }] }
export function importEmailBatch(db, batch, today = isoDate()) {
  if (batch?.type !== 'zordon.emails' || !Array.isArray(batch.emails)) throw new Error('Not a zordon.emails batch');
  const result = { emails: 0, duplicates: 0, tasks: 0, meetings: 0, doc_items: 0, new_projects: 0 };
  // Jobs seen in email that Zordon doesn't know yet: { name, code, location }.
  for (const p of Array.isArray(batch.projects) ? batch.projects : []) {
    if (!p?.name) continue;
    const exists = db.prepare('SELECT id FROM projects WHERE (code IS NOT NULL AND lower(code) = lower(?)) OR lower(name) = lower(?)').get(p.code || '', p.name);
    if (!exists) {
      db.prepare('INSERT INTO projects (name, code, short_name, folder, location) VALUES (?, ?, ?, ?, ?)')
        .run(String(p.name), p.code || null, p.short_name || null, p.folder && !String(p.folder).includes('..') ? p.folder : null, p.location || null);
      result.new_projects++;
    }
  }
  const people = db.prepare('SELECT id, name, email FROM people WHERE active = 1').all();
  const projects = db.prepare('SELECT id, name, code FROM projects').all();
  const seen = db.prepare('SELECT id FROM emails WHERE message_id = ?');
  for (const e of batch.emails) {
    if (e.message_id && seen.get(String(e.message_id))) { result.duplicates++; continue; }
    const tasks = (e.tasks || []).filter((t) => t?.title).map((t) => resolveRefs(t, people, projects));
    const meetings = (e.meetings || []).filter((m) => m?.title && m?.starts_at).map((m) => resolveRefs(m, people, projects));
    for (const t of tasks) {
      if (!PRIORITIES.includes(t.priority)) t.priority = 'medium';
      if (t.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(t.due_date)) t.due_date = null;
    }
    const analysis = { summary: e.summary || '', urgency: e.urgency || 'normal', tasks, meetings: meetings.filter((m) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(m.starts_at)) };
    const id = Number(db.prepare(`INSERT INTO emails (sender, subject, body, received_at, analysis, analyzer, message_id)
      VALUES (?, ?, ?, ?, ?, 'claude-hourly', ?)`).run(e.sender || null, e.subject || null, e.body || e.summary || '', e.received_at || new Date().toISOString(),
      JSON.stringify(analysis), e.message_id ? String(e.message_id) : null).lastInsertRowid);
    result.emails++;
    const items = parseNotificationEmail({ sender: e.sender || '', subject: e.subject || '', body: e.body || '' }, today);
    if (items.length) { upsertItems(db, items, today); result.doc_items += items.length; }
    if (batch.auto_accept !== false && (analysis.tasks.length || analysis.meetings.length)) {
      const created = acceptEmail(db, id, analysis);
      result.tasks += created.tasks.length;
      result.meetings += created.meetings.length;
    } else if (!analysis.tasks.length && !analysis.meetings.length) {
      db.prepare("UPDATE emails SET status = 'processed' WHERE id = ?").run(id);
    }
  }
  return result;
}

// Point each job at the folder it already has in OneDrive (job number, "G#### - Title", or a matching name).
// Only fills in jobs without a folder; a folder set by hand is never replaced.
export async function linkJobFolders(db, vaultRoot) {
  const linked = [];
  for (const p of db.prepare("SELECT * FROM projects WHERE folder IS NULL AND status != 'closed'").all()) {
    const folder = await findJobFolder(vaultRoot, p);
    if (folder && folder !== projectFolder(p)) {
      db.prepare('UPDATE projects SET folder = ? WHERE id = ?').run(folder, p.id);
      linked.push({ id: p.id, code: p.code, folder });
    }
  }
  return linked;
}

// Who and what Zordon knows, so the hourly email check can assign owners and projects by name.
export async function writeRoster(db, vaultRoot) {
  const roster = {
    updated_at: new Date().toISOString(),
    me: db.prepare('SELECT name, email FROM people WHERE id = ?').get(mePersonId(db) ?? -1) || null,
    people: db.prepare('SELECT name, role, trade, email FROM people WHERE active = 1').all(),
    projects: db.prepare("SELECT name, code, short_name, folder, location FROM projects WHERE status != 'closed'").all(),
  };
  await saveFile(vaultRoot, `${CONTROL_DIR}/zordon-roster.json`, Buffer.from(JSON.stringify(roster, null, 2)), { overwrite: true });
}

const categoryForPath = (path) => Object.entries(CATEGORY_FOLDERS).find(([, f]) => f && path.includes(`/${f}/`))?.[0] || 'General';

export async function processInbox(db, vaultRoot, today = isoDate()) {
  const filed = [];
  let linked = false;
  const link = async () => { if (!linked) { linked = true; await linkJobFolders(db, vaultRoot).catch(() => {}); } };
  for (const f of await inboxFiles(vaultRoot)) {
    try {
      if (/\.proposal\.zordon\.json$/i.test(f.name)) {
        importProposal(db, JSON.parse((await readVaultFile(vaultRoot, f.rel)).toString('utf8')));
        await moveFile(vaultRoot, f.rel, `${f.rel.replace(/[^/]+$/, '')}.imported/${f.name}`);
        console.log(`[claude] new proposal: ${f.name}`);
        continue;
      }
      if (/\.result\.zordon\.json$/i.test(f.name)) {
        const r = await importJobResult(db, vaultRoot, JSON.parse((await readVaultFile(vaultRoot, f.rel)).toString('utf8')), { categoryFor: categoryForPath });
        await moveFile(vaultRoot, f.rel, `${f.rel.replace(/[^/]+$/, '')}.imported/${f.name}`);
        console.log(`[claude] job #${r.job_id} ${r.status} (${r.outputs} file(s))`);
        continue;
      }
      if (/\.zordon\.json$/i.test(f.name)) {
        const result = importEmailBatch(db, JSON.parse((await readVaultFile(vaultRoot, f.rel)).toString('utf8')), today);
        linked = false; // new jobs may have arrived
        await moveFile(vaultRoot, f.rel, `${f.rel.replace(/[^/]+$/, '')}.imported/${f.name}`);
        console.log(`[email] imported ${result.emails} email(s): ${result.tasks} task(s), ${result.meetings} meeting(s), ${result.duplicates} already seen`);
        continue;
      }
      await link();
      filed.push(await fileDocument(db, vaultRoot, { fromRel: f.rel, filename: f.name }, today));
    } catch (err) {
      console.warn(`[vault] could not file ${f.name}: ${err.message}`);
    }
  }
  return filed;
}

export function buildRoutes(db, { today = () => isoDate(), vaultRoot = process.env.ZORDON_VAULT || join(ROOT, 'files'), voice = createVoiceSession() } = {}) {
  const projectsCtx = () => ({ projects: db.prepare('SELECT id, name, code FROM projects').all(), today: today() });
  const getDoc = (id) => mustExist(db.prepare(`${docSelect} WHERE d.id = ?`).get(Number(id)), 'Document');
  return [
    ['GET', '/api/health', () => ({ ok: true, ai: aiEnabled() })],
    // Voice: the server speaks through the computer so Zordon can greet without a click.
    ['POST', '/api/voice/hello', ({ body }) => {
      const me = db.prepare('SELECT name FROM people WHERE id = ?').get(mePersonId(db) ?? -1);
      return { ...voice.hello(body.text || greeting(me?.name?.split(/\s+/)[0])), voice: voice.enabled() };
    }],
    ['POST', '/api/voice/goodbye', () => voice.goodbye()],
    ['POST', '/api/voice/say', ({ body }) => ({ spoken: say(required(body.text, 'text')) })],
    ['GET', '/api/meta', () => ({ statuses: STATUSES, priorities: PRIORITIES, colors: RANGER_COLORS, ai: aiEnabled(), today: today() })],
    ['GET', '/api/dashboard', () => {
      runRoutines(db, today());
      return {
        ...dashboard(db, today()),
        doccontrol: docControlSummary(db, today()),
        focus_person_id: mePersonId(db),
        systems: { ai: aiEnabled(), voice: voice.enabled(), connectors: connectorStatus() },
      };
    }],

    ['GET', '/api/weather', () => projectWeather(db)],

    ['GET', '/api/people', () => db.prepare('SELECT * FROM people ORDER BY active DESC, id').all()],
    ['POST', '/api/people', ({ body }) => {
      const f = pick(body, ['name', 'role', 'trade', 'email', 'phone', 'color']);
      required(f.name, 'name');
      oneOf(f.color, RANGER_COLORS, 'color');
      const keys = Object.keys(f);
      const id = db.prepare(`INSERT INTO people (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => f[k])).lastInsertRowid;
      return db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    }],
    ['PATCH', '/api/people/:id', ({ params, body }) => {
      mustExist(db.prepare('SELECT id FROM people WHERE id = ?').get(Number(params.id)), 'Person');
      const f = pick(body, ['name', 'role', 'trade', 'email', 'phone', 'color', 'active']);
      oneOf(f.color, RANGER_COLORS, 'color');
      if ('active' in f) f.active = f.active ? 1 : 0;
      update(db, 'people', params.id, f);
      return db.prepare('SELECT * FROM people WHERE id = ?').get(Number(params.id));
    }],

    ['GET', '/api/projects', () => projectSummaries(db, today())],
    ['POST', '/api/projects', async ({ body }) => {
      required(body.name, 'name');
      const id = db.prepare('INSERT INTO projects (name, code, short_name, location) VALUES (?, ?, ?, ?)').run(body.name, body.code || null, body.short_name || null, body.location || null).lastInsertRowid;
      await linkJobFolders(db, vaultRoot).catch(() => {});
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      // Real GEC2 jobs (G####) get the job start-up folders; other projects are left alone.
      if (isJobNumber(project.code)) await ensureProjectFolders(vaultRoot, project).catch((err) => console.warn(`[vault] ${err.message}`));
      return project;
    }],
    ['PATCH', '/api/projects/:id', async ({ params, body }) => {
      const before = mustExist(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(params.id)), 'Project');
      const f = pick(body, ['name', 'code', 'short_name', 'folder', 'location', 'status']);
      if ('folder' in f && f.folder && (String(f.folder).includes('..') || /^[a-z]:|^\//i.test(f.folder))) throw new HttpError(400, 'Folder must be a path inside the OneDrive, e.g. 5. PROJECTS/LAUSD 32ND ST');
      oneOf(f.status, ['active', 'on_hold', 'closed'], 'status');
      if ('location' in f) Object.assign(f, { lat: null, lon: null }); // re-geocode for weather
      update(db, 'projects', params.id, f);
      const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(params.id));
      // Renamed project: move its folder and keep every document path pointing at the right place.
      const [from, to] = [projectFolder(before), projectFolder(after)];
      if (from !== to && await fileExists(vaultPath(vaultRoot, from))) {
        if (await fileExists(vaultPath(vaultRoot, to))) throw new HttpError(409, `Folder ${to} already exists in the vault`);
        await moveFile(vaultRoot, from, to);
        db.prepare('UPDATE documents SET path = ? || substr(path, ?) WHERE project_id = ? AND path LIKE ?')
          .run(to, from.length + 1, after.id, `${from}/%`);
      }
      return after;
    }],

    ['GET', '/api/electrical/lead-time', ({ query }) => leadTime(query.name || '')],
    ['GET', '/api/electrical/lead-times', () => LEAD_TIMES.map(({ label, weeks, range }) => ({ label, weeks, range }))],
    ['POST', '/api/projects/:id/electrical-plan', ({ params, body }) => {
      mustExist(db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(params.id)), 'Project');
      const energization = dateOrNull(required(body.energization_date, 'energization_date'), 'energization_date');
      return { created: createElectricalPlan(db, Number(params.id), energization, today()).length };
    }],

    ['GET', '/api/tasks', ({ query }) => listTasks(db, query, today())],
    ['POST', '/api/tasks', ({ body }) => getTask(db, createTask(db, body), today())],
    ['GET', '/api/tasks/:id', ({ params }) => {
      const task = mustExist(getTask(db, params.id, today()), 'Task');
      task.updates = db.prepare(`SELECT u.*, p.name AS author_name, p.color AS author_color FROM task_updates u
        LEFT JOIN people p ON p.id = u.author_id WHERE u.task_id = ? ORDER BY u.created_at DESC, u.id DESC`).all(task.id);
      return task;
    }],
    ['PATCH', '/api/tasks/:id', ({ params, body }) => {
      const before = mustExist(getTask(db, params.id), 'Task');
      const f = taskFields(body, { creating: false });
      if (f.status && f.status !== before.status) {
        f.completed_at = f.status === 'done' ? isoDate() : null;
        db.prepare('INSERT INTO task_updates (task_id, author_id, body) VALUES (?, ?, ?)')
          .run(before.id, body.author_id ?? null, `Status: ${before.status.replace('_', ' ')} → ${f.status.replace('_', ' ')}`);
      }
      if ('due_date' in f && f.due_date !== before.due_date && before.due_date) {
        db.prepare('INSERT INTO task_updates (task_id, author_id, body) VALUES (?, ?, ?)')
          .run(before.id, body.author_id ?? null, `Due date moved ${before.due_date} → ${f.due_date || 'none'}`);
      }
      f.updated_at = new Date().toISOString();
      update(db, 'tasks', params.id, f);
      return getTask(db, params.id, today());
    }],
    ['DELETE', '/api/tasks/:id', ({ params }) => {
      mustExist(getTask(db, params.id), 'Task');
      db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(params.id));
      return { deleted: true };
    }],
    ['POST', '/api/tasks/:id/updates', ({ params, body }) => {
      mustExist(getTask(db, params.id), 'Task');
      required(body.body, 'body');
      db.prepare('INSERT INTO task_updates (task_id, author_id, body) VALUES (?, ?, ?)').run(Number(params.id), body.author_id ?? null, body.body);
      return { ok: true };
    }],

    ['GET', '/api/meetings', ({ query }) => listMeetings(db, query)],
    ['POST', '/api/meetings', ({ body }) => listMeetings(db).find((m) => m.id === createMeeting(db, body))],
    ['PATCH', '/api/meetings/:id', ({ params, body }) => {
      mustExist(db.prepare('SELECT id FROM meetings WHERE id = ?').get(Number(params.id)), 'Meeting');
      const f = pick(body, ['project_id', 'title', 'starts_at', 'duration_min', 'location', 'attendee_ids', 'agenda', 'notes']);
      if (f.attendee_ids) f.attendee_ids = JSON.stringify(f.attendee_ids);
      update(db, 'meetings', params.id, f);
      return listMeetings(db).find((m) => m.id === Number(params.id));
    }],
    ['DELETE', '/api/meetings/:id', ({ params }) => {
      db.prepare('DELETE FROM meetings WHERE id = ?').run(Number(params.id));
      return { deleted: true };
    }],

    ['GET', '/api/emails', () => db.prepare('SELECT id, sender, subject, received_at, analyzer, status FROM emails ORDER BY received_at DESC LIMIT 200').all()],
    ['GET', '/api/emails/:id', ({ params }) => getEmail(db, params.id)],
    ['POST', '/api/emails', ({ body }) => ingestEmail(db, body, today())],
    ['POST', '/api/emails/:id/accept', ({ params, body }) => acceptEmail(db, params.id, body)],
    ['POST', '/api/emails/:id/dismiss', ({ params }) => {
      getEmail(db, params.id);
      db.prepare("UPDATE emails SET status = 'dismissed' WHERE id = ?").run(Number(params.id));
      return { ok: true };
    }],

    ['GET', '/api/documents', ({ query }) => {
      const where = [];
      const args = [];
      if (query.project_id) { where.push('d.project_id = ?'); args.push(Number(query.project_id)); }
      if (query.category) { where.push('d.category = ?'); args.push(query.category); }
      if (query.q) { where.push('(d.title LIKE ? OR d.original_name LIKE ? OR d.notes LIKE ? OR d.path LIKE ?)'); args.push(...Array(4).fill(`%${query.q}%`)); }
      return db.prepare(`${docSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC, d.id DESC`).all(...args);
    }],
    ['GET', '/api/documents/categories', () => CATEGORY_NAMES],
    // Name/folder suggestion without uploading, e.g. for files saved to OneDrive or SharePoint.
    ['POST', '/api/documents/suggest', ({ body }) => suggestName(pick(body, ['filename', 'text', 'project_id', 'hint']), projectsCtx())],
    ['POST', '/api/documents', async ({ query, raw }) => {
      const filename = required(query.filename, 'filename');
      await linkJobFolders(db, vaultRoot).catch(() => {});
      if (!raw?.length) throw new HttpError(400, 'File content is empty');
      const { id, analyzer } = await fileDocument(db, vaultRoot, { ...query, buffer: raw, filename }, today());
      return { ...getDoc(id), analyzer };
    }],
    ['POST', '/api/vault/inbox', async () => {
      const filed = await processInbox(db, vaultRoot, today());
      return filed.map(({ id, analyzer }) => ({ ...getDoc(id), analyzer }));
    }],
    ['POST', '/api/vault/folders', async () => {
      const projects = db.prepare("SELECT * FROM projects WHERE status != 'closed'").all().filter((p) => isJobNumber(p.code));
      for (const p of projects) await ensureProjectFolders(vaultRoot, p);
      return { root: vaultRoot, projects: projects.map((p) => projectFolder(p)), folders: JOB_TEMPLATE };
    }],
    ['GET', '/api/vault', () => ({ root: vaultRoot, inbox: join(vaultRoot, INBOX), projects_dir: join(vaultRoot, projectFolder({ code: '<Job #>' })), folders: JOB_TEMPLATE })],
    ['GET', '/api/documents/:id/file', ({ params }) => {
      const d = getDoc(params.id);
      return { __file: vaultPath(vaultRoot, d.path), name: d.path.split('/').pop(), mime: d.mime };
    }],
    ['PATCH', '/api/documents/:id', async ({ params, body }) => {
      const d = getDoc(params.id);
      const ctx = projectsCtx();
      const projectId = 'project_id' in body ? (body.project_id ? Number(body.project_id) : null) : d.project_id;
      const category = body.category ?? d.category;
      oneOf(category, CATEGORY_NAMES, 'category');
      const next = finalize({
        title: body.title ?? d.title,
        category,
        project: ctx.projects.find((p) => p.id === projectId) || null,
        ext: d.path.includes('.') ? `.${d.path.split('.').pop()}` : '',
        today: d.created_at.slice(0, 10),
      });
      let rel = d.path;
      if (`${next.folder}/${next.filename}` !== d.path) {
        rel = await uniquePath(vaultRoot, next.folder, next.filename, fileExists);
        await moveFile(vaultRoot, d.path, rel);
      }
      update(db, 'documents', d.id, {
        title: next.title, category, project_id: projectId, path: rel,
        ...pick(body, ['notes']), ...('task_id' in body ? { task_id: body.task_id ? Number(body.task_id) : null } : {}),
      });
      return getDoc(d.id);
    }],
    ['DELETE', '/api/documents/:id', async ({ params }) => {
      const d = getDoc(params.id);
      await deleteFile(vaultRoot, d.path);
      db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
      return { deleted: true };
    }],

    // ----- Doc control: RFIs & submittals -----
    ['GET', '/api/doccontrol', () => ({ ...docControlSummary(db, today()), connectors: connectorStatus() })],
    ['GET', '/api/items', ({ query }) => listItems(db, { ...query, mine: query.mine === '1', open: query.open === '1' })],
    // Push from automations (Procore webhooks, Zapier/Power Automate, Claude routines). Body: { items: [...] } or [...]
    ['POST', '/api/items', ({ body }) => ({ changes: upsertItems(db, Array.isArray(body) ? body : body.items || [body], today()) })],
    ['PATCH', '/api/items/:id', ({ params, body }) => {
      const row = mustExist(db.prepare('SELECT * FROM tracked_items WHERE id = ?').get(Number(params.id)), 'Item');
      return { changes: upsertItems(db, [{ ...row, groups: undefined, ...body, origin: row.origin, external_id: row.external_id }], today()) };
    }],
    ['POST', '/api/integrations/sync', () => syncAll((items) => upsertItems(db, items, today()))],
    ['GET', '/api/settings', () => ({
      me_person_id: mePersonId(db),
      capacity_hours_per_day: getSetting(db, 'capacity_hours_per_day', 4),
      watch_groups: getSetting(db, 'watch_groups', WATCH_GROUPS.map((g) => g.key)),
      all_groups: WATCH_GROUPS.map(({ key, label }) => ({ key, label })),
    })],
    ['PATCH', '/api/settings', ({ body }) => {
      for (const k of ['me_person_id', 'capacity_hours_per_day', 'watch_groups', 'team_domain']) if (k in body) setSetting(db, k, body[k]);
      return { ok: true };
    }],

    // ----- My focus: nudges + reality check -----
    ['GET', '/api/focus', ({ query }) => {
      const me = Number(query.person_id) || mePersonId(db);
      if (!me) return { person: null, nudges: [], reality: null };
      return {
        person: db.prepare('SELECT * FROM people WHERE id = ?').get(me),
        nudges: myNudges(db, me, today()),
        reality: realityCheck(db, me, today(), Number(getSetting(db, 'capacity_hours_per_day', 4))),
      };
    }],

    // ----- Schedule & equipment -----
    ['GET', '/api/schedule/lookahead', ({ query }) => lookahead(db, { project_id: query.project_id, weeks: Number(query.weeks) || 3 }, today())],
    ['POST', '/api/schedule/import', ({ query, raw, body }) => {
      required(query.project_id, 'project_id');
      const text = raw ? raw.toString('utf8') : body.csv;
      required(text, 'CSV content');
      try { return importSchedule(db, query.project_id, text, query.mode === 'baseline' ? 'baseline' : 'current'); } catch (err) { throw new HttpError(400, err.message); }
    }],
    ['GET', '/api/equipment', ({ query }) => equipmentLog(db, query, today())],
    ['POST', '/api/equipment', ({ body }) => {
      required(body.name, 'name');
      const f = pick(body, ['project_id', 'name', 'spec_section', 'vendor', 'submittal_item_id', 'activity_id', 'need_by_date', 'lead_time_weeks', 'buffer_days', 'released_at', 'delivered_at', 'notes']);
      if (f.lead_time_weeks == null || f.lead_time_weeks === '') {
        const typical = leadTime(f.name);
        if (typical) Object.assign(f, { lead_time_weeks: typical.weeks, notes: f.notes || `Typical lead time ${typical.range} wks (${typical.label}) — confirm with vendor` });
      }
      const keys = Object.keys(f);
      const id = db.prepare(`INSERT INTO equipment (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => f[k] === '' ? null : f[k])).lastInsertRowid;
      return equipmentLog(db, {}, today()).find((e) => e.id === Number(id));
    }],
    ['PATCH', '/api/equipment/:id', ({ params, body }) => {
      mustExist(db.prepare('SELECT id FROM equipment WHERE id = ?').get(Number(params.id)), 'Equipment');
      const f = pick(body, ['project_id', 'name', 'spec_section', 'vendor', 'submittal_item_id', 'activity_id', 'need_by_date', 'lead_time_weeks', 'buffer_days', 'released_at', 'delivered_at', 'notes']);
      for (const k of Object.keys(f)) if (f[k] === '') f[k] = null;
      update(db, 'equipment', params.id, f);
      return equipmentLog(db, {}, today()).find((e) => e.id === Number(params.id));
    }],
    ['DELETE', '/api/equipment/:id', ({ params }) => {
      db.prepare('DELETE FROM equipment WHERE id = ?').run(Number(params.id));
      return { deleted: true };
    }],
    ['GET', '/api/routines', () => db.prepare(`SELECT r.*, p.name AS owner_name, pr.name AS project_name FROM routines r
      LEFT JOIN people p ON p.id = r.owner_id LEFT JOIN projects pr ON pr.id = r.project_id ORDER BY r.id`).all()],
    ['POST', '/api/routines', ({ body }) => {
      required(body.title, 'title');
      const id = db.prepare('INSERT INTO routines (title, description, owner_id, project_id, weekday, day_of_month, every_weeks, estimate_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(body.title, body.description || null, body.owner_id ?? mePersonId(db), body.project_id || null, Number(body.weekday ?? 1), body.day_of_month ? Number(body.day_of_month) : null, Number(body.every_weeks || 1), body.estimate_hours ?? null).lastInsertRowid;
      runRoutines(db, today());
      return db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
    }],
    ['PATCH', '/api/routines/:id', ({ params, body }) => {
      const f = pick(body, ['title', 'description', 'owner_id', 'project_id', 'weekday', 'day_of_month', 'every_weeks', 'estimate_hours', 'active']);
      if ('active' in f) f.active = f.active ? 1 : 0;
      update(db, 'routines', params.id, f);
      return db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(params.id));
    }],

    // ----- Claude Link: skills library and jobs for Claude (Cowork) -----
    ['GET', '/api/claude/skills', () => listSkills(db)],
    ['PUT', '/api/claude/skills/:name', async ({ params, body }) => {
      let skill;
      try { skill = saveSkill(db, { ...body, name: params.name }); } catch (err) { throw new HttpError(400, err.message); }
      await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
      return skill;
    }],
    ['DELETE', '/api/claude/skills/:name', ({ params }) => {
      const s = mustExist(db.prepare('SELECT * FROM skills WHERE name = ?').get(params.name), 'Skill');
      if (s.builtin) throw new HttpError(400, 'Starter skills can be edited but not deleted');
      db.prepare('DELETE FROM skills WHERE name = ?').run(s.name);
      return { deleted: true };
    }],
    ['GET', '/api/claude/jobs', () => listJobs(db)],
    ['POST', '/api/claude/jobs', async ({ body }) => {
      let job;
      try { job = createJob(db, body); } catch (err) { throw new HttpError(400, err.message); }
      await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
      return job;
    }],
    ['POST', '/api/claude/jobs/:id/cancel', async ({ params }) => {
      db.prepare("UPDATE claude_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'needs_input')").run(Number(params.id));
      const j = db.prepare('SELECT * FROM claude_jobs WHERE id = ?').get(Number(params.id));
      await deleteFile(vaultRoot, `${CONTROL_DIR}/jobs/${String(j.id).padStart(4, '0')}-${j.skill}.json`).catch(() => {});
      return j;
    }],
    ['GET', '/api/claude/filing', () => ({ markdown: filingRules(db) })],
    ['GET', '/api/claude/proposals', () => listProposals(db)],
    ['POST', '/api/claude/proposals/:id/:decision', async ({ params }) => {
      if (!['approve', 'dismiss'].includes(params.decision)) throw new HttpError(404, 'Not found');
      let p;
      try { p = decideProposal(db, params.id, params.decision === 'approve', today()); } catch (err) { throw new HttpError(400, err.message); }
      await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
      return p;
    }],

    ['GET', '/api/reminders/drafts', () => reminderDrafts(db, today())],
    ['GET', '/api/reminders', () => db.prepare(`SELECT r.*, p.name AS person_name FROM reminders r LEFT JOIN people p ON p.id = r.person_id
      ORDER BY r.created_at DESC LIMIT 100`).all()],
    ['POST', '/api/reminders', ({ body }) => {
      required(body.person_id, 'person_id');
      required(body.subject, 'subject');
      required(body.body, 'body');
      const id = db.prepare('INSERT INTO reminders (person_id, task_ids, subject, body, channel, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Number(body.person_id), JSON.stringify(body.task_ids || []), body.subject, body.body, body.channel || 'email', body.status || 'sent').lastInsertRowid;
      return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    }],
  ].map(([method, path, handler]) => {
    const names = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    return { method, re, names, handler };
  });
}

// Set ZORDON_API_TOKEN before exposing the server beyond localhost; the UI and automations then send it as a Bearer token.
function authorized(req) {
  const token = process.env.ZORDON_API_TOKEN;
  if (!token) return true;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_UPLOAD = Number(process.env.ZORDON_MAX_UPLOAD_MB || 100) * 1024 * 1024;

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const raw = await readRaw(req, 2_000_000);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function serveStatic(pathname, res) {
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length) || 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir)) break;
    try {
      const info = await stat(file);
      if (info.isDirectory()) rel = join(rel, 'index.html');
      const target = info.isDirectory() ? join(file, 'index.html') : file;
      res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' });
      res.end(await readFile(target));
      return true;
    } catch {
      break;
    }
  }
  return false;
}

export function createApp(db, opts = {}) {
  const routes = buildRoutes(db, opts);
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req) && url.pathname !== '/api/health') throw new HttpError(401, 'Unauthorized');
        for (const r of routes) {
          const m = r.method === req.method && url.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
          const isJson = (req.headers['content-type'] || 'application/json').includes('json');
          const raw = req.method !== 'GET' && !isJson ? await readRaw(req, MAX_UPLOAD) : null;
          const body = req.method === 'GET' || raw ? {} : await readBody(req);
          const result = await r.handler({ params, body, raw, query: Object.fromEntries(url.searchParams) });
          if (result?.__file) {
            const data = await readFile(result.__file).catch(() => { throw new HttpError(404, 'File missing from vault'); });
            res.writeHead(200, {
              'content-type': result.mime || MIME[extname(result.name)] || 'application/octet-stream',
              'content-disposition': `inline; filename="${result.name.replace(/"/g, '')}"`,
            });
            return res.end(data);
          }
          return send(200, result);
        }
        throw new HttpError(404, 'Not found');
      }
      if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
      if (req.method === 'GET' && await serveStatic('/index.html', res)) return;
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(err.status || 500, { error: err.status ? err.message : 'Internal error' });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  if (process.env.ZORDON_SEED !== 'off' && seedIfEmpty(db)) console.log('Seeded demo data (set ZORDON_SEED=off to skip).');
  const voice = createVoiceSession();
  const me = db.prepare('SELECT name FROM people WHERE id = ?').get(mePersonId(db) ?? -1);
  // Powering up: greet right away, and say goodbye when the server is shut down.
  if (say(greeting(me?.name?.split(/\s+/)[0]))) voice.markGreeted();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      say(FAREWELL);
      setTimeout(() => process.exit(0), 2500);
    });
  }
  const port = Number(process.env.PORT || 4000);
  // Background duty cycle: create routine tasks and pull Procore / Autodesk updates.
  const cycle = async () => {
    try {
      runRoutines(db);
      const results = await syncAll((items) => upsertItems(db, items));
      for (const r of results) if (r.error) console.warn(`[sync] ${r.name}: ${r.error}`);
    } catch (err) {
      console.warn(`[cycle] ${err.message}`);
    }
  };
  cycle();
  setInterval(cycle, Number(process.env.ZORDON_SYNC_MINUTES || 30) * 60_000).unref();
  // File anything saved into the vault's _Inbox folder every minute (documents, and hourly email batches).
  const vaultRoot = process.env.ZORDON_VAULT || join(ROOT, 'files');
  await loadBuiltinSkills(db);
  for (const l of await linkJobFolders(db, vaultRoot).catch(() => [])) console.log(`[vault] ${l.code || l.id} → ${l.folder}`);
  await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
  const roster = () => writeRoster(db, vaultRoot).catch((err) => console.warn(`[vault] roster: ${err.message}`));
  roster();
  setInterval(roster, 15 * 60_000).unref();
  setInterval(() => processInbox(db, vaultRoot).then((f) => f.length && console.log(`[vault] filed ${f.length} file(s) from _Inbox`)), 60_000).unref();
  createServer(createApp(db, { voice })).listen(port, () => {
    console.log(`\n  ⚡ Zordon Command Center online → http://localhost:${port}`);
    console.log(`  Email intelligence: ${aiEnabled() ? 'Claude' : 'rule-based (set ANTHROPIC_API_KEY to enable Claude)'}\n`);
  });
}
