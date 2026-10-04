// Zordon Command Center — HTTP API + static UI, no framework.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, seedIfEmpty, clearDemo, isoDate, addDays, STATUSES, PRIORITIES, RANGER_COLORS } from './db.js';
import { analyzeEmail, aiEnabled, resolveRefs } from './intel.js';
import { moneyPriority, dashboard, listTasks, getTask, listMeetings, projectSummaries, reminderDrafts, realityCheck, myNudges } from './ops.js';
import { WATCH_GROUPS, parseNotificationEmail, upsertItems, listItems, docControlSummary, getSetting, setSetting, mePersonId } from './doccontrol.js';
import { importSchedule, lookahead, equipmentLog, runRoutines } from './schedule.js';
import { connectorStatus, syncAll } from './connectors.js';
import { createVoiceSession, greeting, say, FAREWELL } from './voice.js';
import { projectWeather } from './weather.js';
import { scanOld, applyPlan, listArchiveLogs, undoArchive } from './cleanup.js';
import { oneDriveStatus, listFolder, openOnComputer } from './onedrive.js';
import { STAGES, packageType, stageFor, ensurePackage, coSubfolder, coLabel, specKey, recordPackage, setStage, listPackages } from './packages.js';
import { template, loadTemplate, copyTemplate, templateDir } from './template.js';
import { compileCo } from './compile.js';
import { findWorkbook, readWorkbook, readSheet } from './workbook.js';
import { leadTime, createElectricalPlan, LEAD_TIMES } from './electrical.js';
import { loadBuiltinSkills, listSkills, saveSkill, createJob, listJobs, syncControl, importJobResult, filingRules,
  importProposal, decideProposal, listProposals } from './claude.js';
import { CATEGORY_NAMES, CATEGORY_FOLDERS, suggestName, finalize, textSnippet, uniquePath, saveFile, moveFile, deleteFile, vaultPath,
  ensureProjectFolders, inboxFiles, readVaultFile, projectFolder, isJobNumber, JOB_TEMPLATE, CONTROL_DIR, INBOX, findJobFolder, refineFolder, detectVault, cleanName, titleCase } from './vault.js';

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
  applyVip(email, analysis.tasks, vipSenders(db), today);
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
  const ctx = { projects: db.prepare('SELECT id, name, code, short_name, folder FROM projects').all(), today };
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
  // Use the folder that best describes the document (the team's own subfolders count).
  const project = ctx.projects.find((p) => p.id === chosen.project_id);
  const hay = `${hint || ''} ${title || ''} ${filename} ${chosen.title}`;
  let pkg = null;
  if (project) {
    const full = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    pkg = await packageFor(db, vaultRoot, full, { ...chosen, original: filename }, hay, today);
    if (pkg) {
      chosen.folder = pkg.folder;
      if (pkg.filename) chosen.filename = `${pkg.filename}${extname(chosen.filename)}`;
    } else chosen.folder = await refineFolder(vaultRoot, chosen.folder, projectFolder(full), hay);
  }
  const rel = await uniquePath(vaultRoot, chosen.folder, chosen.filename, fileExists);
  if (fromRel) await moveFile(vaultRoot, fromRel, rel);
  else await saveFile(vaultRoot, rel, content);
  const id = db.prepare(`INSERT INTO documents (project_id, task_id, title, category, original_name, path, size, mime, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chosen.project_id, task_id ? Number(task_id) : null, chosen.title, chosen.category,
    filename, rel, content.length, mime || null, notes || null).lastInsertRowid;
  // A new CO form builds the GC package; new backup for a CO that already has a package rebuilds it.
  let compiled = null;
  if (pkg?.id && (pkg.compile || db.prepare('SELECT compiled_at FROM packages WHERE id = ?').get(pkg.id)?.compiled_at)) {
    compiled = await compilePackage(db, vaultRoot, pkg.id, today).catch((err) => { console.warn(`[co] package: ${err.message}`); return null; });
  }
  return { id: Number(id), analyzer: suggestion.analyzer, compiled };
}

// Build (or rebuild) a change order's package for the GC: CO form + pricing/backup + estimate + RFP/RFI + T&M tags.
export async function compilePackage(db, vaultRoot, packageId, today = isoDate()) {
  const pkg = mustExist(db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(packageId)), 'Change order');
  if (pkg.type !== 'cor') throw new HttpError(400, 'Only change orders are compiled');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pkg.project_id);
  const first = !pkg.compiled_at;
  const result = await compileCo(vaultRoot, pkg.folder, { label: coLabel(pkg.number), jobCode: project?.code, jobName: project?.name, desc: pkg.title, today });
  db.prepare('UPDATE packages SET compiled_at = ? WHERE id = ?').run(new Date().toISOString(), pkg.id);
  if (first) {
    createTask(db, { project_id: pkg.project_id, owner_id: mePersonId(db), title: `Review and send ${coLabel(pkg.number)} package to the GC - ${pkg.title}`,
      description: `Package: ${result.path}\n${result.included.length} file(s), ${result.pages} pages${result.skipped.length ? `\nNot included: ${result.skipped.map((x) => x.file.split('/').pop()).join(', ')}` : ''}`,
      priority: 'high', due_date: addDays(today, 1), status: 'not_started', source: 'package', source_ref: pkg.id });
  }
  console.log(`[co] ${coLabel(pkg.number)} package: ${result.pages} pages from ${result.included.length} file(s)${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`);
  return result;
}

// A CO with a number, or a submittal with a spec section, goes into its own folder as the job template lays out:
//   01 COST CONTROL/04 CHANGE ORDERS/<status>/CO 03 - <title>/<subfolder>   named "CO 03 - <description>"
//   14 SUBMITTALS/26 2416 - <TITLE>
// A document that shows a new status (submitted, approved, rejected) moves the CO folder there. Null for anything else.
async function packageFor(db, vaultRoot, project, chosen, hay, today) {
  const type = packageType(chosen.category);
  if (!type) return null;
  let desc = chosen.title.replace(/^[A-Z ]+?(\s(?:\d{2} \d{2} ?\d{2}|[\w.-]*\d[\w.-]*))?\s-\s/, '');
  let number = type === 'cor' ? chosen.title.match(/^CO (\d+)\b/)?.[1] : null;
  // A CO form PDF ("G3249 - Burbank SWA Cargo - CO 001 - Additional Lighting Circuits.pdf"): the number and the
  // description come from the file name, after "CO ###", which drops the job number and job name.
  const base = String(chosen.original || '').replace(/\.[^.]+$/, '');
  const coInName = base.match(/\b(?:CO|COR|PCO|CHANGE ORDER)\s*[#-]?\s*0*(\d{1,4})\b\s*(?:\([^)]*\))?\s*[-–:_]*\s*(.*)$/i);
  const isCoForm = type === 'cor' && /\.pdf$/i.test(chosen.original || '') && Boolean(coInName)
    && !/t\s?&\s?m|\btags?\b|ticket|quote|quotation|backup|back-up|\brfi\b|\brfp\b|bulletin|\basi\b|\bccd\b|directive|reference|approved|executed|fully signed|rejected|\bvoid\b|estimate|takeoff|photo/i.test(hay);
  if (isCoForm) {
    number = coInName[1];
    const rest = titleCase(cleanName(coInName[2].replace(/\(?\d{1,2}[.-]\d{1,2}[.-]\d{2,4}\)?|\d{4}-\d{2}-\d{2}/g, '').replace(/[_]+/g, ' '), 120)
      .replace(/^[\s\-–:]+|[\s\-–:]+$/g, ''));
    if (rest) desc = rest;
  }
  const spec_section = type === 'submittal' ? specKey(hay) : null;
  if (type === 'cor' ? !number : !spec_section) return null;
  // The CO / submittal folder is named for the change or the equipment, not for this particular document.
  const folderTitle = isCoForm ? desc : desc.replace(/^\d{2}(\s?\d{2}){0,2}\s*-?\s*/, '')
    .replace(/\b(graybar|ced|quotes?|quotation|pricing|backup|back-up|t\s?&\s?m|tags?|tickets?|proposal|cover letter|submitted|sent to (the )?gc|approved|fully signed|signed|executed|rejected|void|product data|cut ?sheets?|shop drawings?|no exceptions taken|revise and resubmit|returned|transmittal)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^(for|of|the|and|to|on|re)\b\s*/i, '') || desc;
  const found = await ensurePackage(vaultRoot, projectFolder(project), type, { number, spec_section, title: folderTitle });
  let rec = recordPackage(db, { project_id: project.id, type, number, spec_section, title: folderTitle, folder: found.folder, stage: found.stage }, today);
  const docStage = stageFor(type, hay);
  if (docStage) {
    rec = (await setStage(db, rec.id, docStage, { today, me: mePersonId(db), addTask: (t) => createTask(db, t), root: vaultRoot })).package;
  }
  if (type !== 'cor') return { id: rec.id, folder: rec.folder };
  // The CO form itself (the PDF made from the Job Control Workbook) sits at the top of the CO folder and
  // triggers the package for the GC; everything else goes in a backup subfolder.
  if (isCoForm) return { id: rec.id, folder: rec.folder, filename: cleanName(`${coLabel(number)} - ${rec.title}`, 150), compile: true };
  const sub = await coSubfolder(vaultRoot, rec.folder, hay);
  // Files in a CO folder carry the CO number; the proposal that goes to the GC also carries the job number.
  const proposal = /proposal|cover letter|submitted|sent to (the )?gc/i.test(hay);
  const tm = /t\s?&\s?m|\btags?\b|ticket/i.test(hay);
  const filename = cleanName(`${coLabel(number)}${proposal && project.code ? ` - ${project.code}` : ''} - ${desc}${tm ? ` - ${today}` : ''}`, 150);
  return { id: rec.id, folder: sub ? `${rec.folder}/${sub}` : rec.folder, filename };
}

// ---------- The job template ----------
// A new job gets a full copy of the template (folders and blank forms). A job that already has a folder only gets the
// template folders it's missing; nothing is ever moved, renamed or overwritten.
export async function setUpJobFolder(vaultRoot, project) {
  if (!template.found) return ensureProjectFolders(vaultRoot, project);
  return copyTemplate(vaultRoot, projectFolder(project), { foldersOnly: Boolean(project.folder) });
}

export async function applyTemplateToJobs(db, vaultRoot) {
  const projects = db.prepare("SELECT * FROM projects WHERE status = 'active'").all().filter((p) => isJobNumber(p.code));
  const results = [];
  for (const p of projects) {
    const added = await setUpJobFolder(vaultRoot, p).catch((err) => { console.warn(`[template] ${p.code}: ${err.message}`); return 0; });
    results.push({ code: p.code, folder: projectFolder(p), added: typeof added === 'number' ? added : 0 });
  }
  return { template: template.found ? templateDir() : null, jobs: results, folders_added: results.reduce((n, r) => n + r.added, 0) };
}

// Re-read the template; when it changed (new folders, renamed stages, new README rules), remember what changed and
// rewrite FILING.md so Claude picks it up too.
export async function checkTemplate(db, vaultRoot) {
  const res = await loadTemplate(vaultRoot);
  if (!template.found) return res;
  const saved = getSetting(db, 'template_signature', null);
  if (saved !== template.signature) {
    const prevPaths = new Set(getSetting(db, 'template_paths', []));
    const nowPaths = template.tree.map((t) => t.path);
    const added = saved ? nowPaths.filter((x) => !prevPaths.has(x)) : [];
    const removed = saved ? [...prevPaths].filter((x) => !nowPaths.includes(x)) : [];
    setSetting(db, 'template_signature', template.signature);
    setSetting(db, 'template_paths', nowPaths);
    if (saved) {
      const log = [{ at: new Date().toISOString(), added, removed }, ...getSetting(db, 'template_changes', [])].slice(0, 20);
      setSetting(db, 'template_changes', log);
      console.log(`[template] job template changed: +${added.length} / -${removed.length}`);
    }
    await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
  }
  return res;
}

function templateStatus(db) {
  return {
    found: template.found, path: templateDir(), checked_at: template.checked_at,
    folders: template.dirs.length, files: template.files.length, top: JOB_TEMPLATE,
    change_orders: template.found ? template.co : null, has_readme: Boolean(template.readme),
    changes: getSetting(db, 'template_changes', []),
  };
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
  const vips = vipSenders(db);
  for (const e of batch.emails) {
    if (e.message_id && seen.get(String(e.message_id))) { result.duplicates++; continue; }
    const tasks = (e.tasks || []).filter((t) => t?.title).map((t) => resolveRefs(t, people, projects));
    applyVip(e, tasks, vips, today);
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

// First start against a real OneDrive: load the team and jobs from Zordon/zordon-roster.json instead of demo data.
export const rosterStatus = { error: null };

// Load the real team and jobs from OneDrive. Runs on an empty database, or replaces the demo data
// once the roster can be found (e.g. ZORDON_VAULT was set after the first start).
export async function seedFromRoster(db, vaultRoot) {
  const isDemo = db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value === 'true';
  if (!isDemo && db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) return false;
  let roster;
  try {
    roster = JSON.parse((await readVaultFile(vaultRoot, `${CONTROL_DIR}/zordon-roster.json`)).toString('utf8'));
    rosterStatus.error = null;
  } catch (err) {
    // OneDrive "online-only" files may still be downloading; the caller retries every minute.
    rosterStatus.error = err.code === 'ENOENT' ? 'not found' : `could not read it yet (${err.code || err.message})`;
    return false;
  }
  return loadRoster(db, roster);
}

// Put a roster's team, jobs and standing reminders in. Replaces demo data; never touches real data.
export function loadRoster(db, roster) {
  const isDemo = db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value === 'true';
  if (!isDemo && db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) return false;
  const people = Array.isArray(roster?.people) ? roster.people.filter((p) => p?.name) : [];
  if (!people.length) return false;
  // A roster written from demo data (older versions did this) is not the real team.
  const demoRoster = (roster.projects || []).some((p) => ['AGM-101', 'CCR-202'].includes(p?.code))
    || people.some((p) => /@example\.com$/i.test(p.email || ''));
  if (demoRoster) { rosterStatus.error = 'demo roster'; return false; }
  if (isDemo) clearDemo(db);
  const colors = RANGER_COLORS;
  const insertPerson = db.prepare('INSERT INTO people (name, role, trade, email, color) VALUES (?, ?, ?, ?, ?)');
  const ids = people.map((p, i) => Number(insertPerson.run(String(p.name), p.role || 'Team', p.trade || null, p.email || null, colors[i % colors.length]).lastInsertRowid));
  const me = roster.me?.email && people.findIndex((p) => String(p.email || '').toLowerCase() === roster.me.email.toLowerCase());
  db.prepare("INSERT INTO settings (key, value) VALUES ('me_person_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(ids[me >= 0 ? me : 0]));
  const vip = people.filter((p) => p.vip && p.email).map((p) => p.email.toLowerCase());
  if (vip.length) db.prepare("INSERT INTO settings (key, value) VALUES ('vip_senders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(vip));
  const insertProject = db.prepare('INSERT INTO projects (name, code, short_name, folder, location, status) VALUES (?, ?, ?, ?, ?, ?)');
  for (const p of Array.isArray(roster.projects) ? roster.projects : []) {
    if (!p?.name) continue;
    insertProject.run(String(p.name), p.code || null, p.short_name || null, p.folder && !String(p.folder).includes('..') ? p.folder : null, p.location || null,
      ['active', 'on_hold', 'closed'].includes(p.status) ? p.status : 'active');
  }
  // Standing reminders for the PM (weekday 0 = Sunday).
  const meId = ids[me >= 0 ? me : 0];
  const routine = db.prepare('INSERT INTO routines (title, description, owner_id, weekday, day_of_month, estimate_hours) VALUES (?, ?, ?, ?, ?, ?)');
  routine.run("Review Liz's WIP report", 'Red: adjust budgets to cost. Blue: update end dates. Green: send billing paperwork to Honor. Yellow: billed 100% — close out?', meId, 4, null, 1);
  routine.run("Update Liz's pending & estimate change orders", "Go through Liz's pending / estimate change order list and update every open COR so they can get done.", meId, 4, null, 1);
  routine.run('Review 3-week look-ahead vs baseline schedule', 'Compare the look-ahead to the baseline, flag slipped activities, confirm crews and inspections, check equipment releases.', meId, 1, null, 1.5);
  routine.run('Review equipment release log', 'Confirm release-by dates against the current schedule and chase open submittals blocking releases.', meId, 3, null, 0.5);
  routine.run('Review change order log — push pending CORs to approval', 'Chase owner/GC approvals, price open PCOs, convert approved COs into billing.', meId, 5, null, 1);
  routine.run('Submit monthly pay applications (billing)', 'Update SOVs and stored materials, collect lien waivers, submit pay apps for every active job.', meId, 1, 20, 3);
  return true;
}

// VIP senders (Damian's leadership and back office): their email always becomes at least a High task.
export const DEFAULT_VIPS = ['honor@gec2.com', 'dawn@gec2.com', 'greg@gec2.com', 'tyson@gec2.com', 'lizeth@gec2.com'];
export function vipSenders(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vip_senders'").get();
  return new Set((row ? JSON.parse(row.value) : DEFAULT_VIPS).map((x) => String(x).toLowerCase().trim()));
}
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const nextWorkday = (iso) => { let d = addDays(iso, 1); while ([0, 6].includes(new Date(`${d}T12:00`).getDay())) d = addDays(d, 1); return d; };

export function applyVip(email, tasks, vips, today = isoDate()) {
  const sender = String(email.sender || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] || '';
  if (!vips.has(sender)) return false;
  for (const t of tasks) if ((RANK[t.priority] ?? 1) < RANK.high) t.priority = 'high';
  if (!tasks.length && email.subject) {
    const who = sender.split('@')[0].replace(/^\w/, (c) => c.toUpperCase());
    tasks.push({ title: `Read & respond to ${who}: ${String(email.subject).replace(/^(re|fw|fwd):\s*/gi, '').slice(0, 150)}`, priority: 'high', due_date: nextWorkday(today), owner_id: null, project_id: null });
  }
  email.vip = true;
  return true;
}

// Who and what Zordon knows, so the hourly email check can assign owners and projects by name.
export async function writeRoster(db, vaultRoot) {
  // Never push the demo team over the real roster in OneDrive.
  if (db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value === 'true') return null;
  const roster = {
    updated_at: new Date().toISOString(),
    me: db.prepare('SELECT name, email FROM people WHERE id = ?').get(mePersonId(db) ?? -1) || null,
    people: db.prepare('SELECT name, role, trade, email FROM people WHERE active = 1').all(),
    projects: db.prepare('SELECT name, code, short_name, folder, location, status FROM projects').all(),
  };
  await saveFile(vaultRoot, `${CONTROL_DIR}/zordon-roster.json`, Buffer.from(JSON.stringify(roster, null, 2)), { overwrite: true });
}

const categoryForPath = (path) => Object.entries(CATEGORY_FOLDERS).find(([, f]) => f && path.includes(`/${f}/`))?.[0] || 'General';

// What the _Inbox check saw last, so the screen can say whether email is flowing.
export const inboxStatus = { checked_at: null, waiting: [], last_import: null, errors: [] };

export async function processInbox(db, vaultRoot, today = isoDate()) {
  const filed = [];
  inboxStatus.checked_at = new Date().toISOString();
  inboxStatus.errors = [];
  let linked = false;
  const link = async () => { if (!linked) { linked = true; await linkJobFolders(db, vaultRoot).catch(() => {}); } };
  const files = await inboxFiles(vaultRoot);
  inboxStatus.waiting = files.map((f) => f.name);
  for (const f of files) {
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
        inboxStatus.last_import = { at: new Date().toISOString(), file: f.name, ...result };
        continue;
      }
      await link();
      filed.push(await fileDocument(db, vaultRoot, { fromRel: f.rel, filename: f.name }, today));
    } catch (err) {
      console.warn(`[vault] could not file ${f.name}: ${err.message}`);
      inboxStatus.errors.push({ file: f.name, error: err.code === 'EPERM' || err.code === 'EACCES' || /cloud|provider/i.test(err.message)
        ? `OneDrive did not download it (${err.code || err.message}). Right-click the OneDrive Zordon folder → Always keep on this device.` : err.message });
    }
  }
  inboxStatus.waiting = (await inboxFiles(vaultRoot)).map((f) => f.name);
  return filed;
}

export function buildRoutes(db, { today = () => isoDate(), vaultRoot = process.env.ZORDON_VAULT || join(ROOT, 'files'), voice = createVoiceSession() } = {}) {
  const projectsCtx = () => ({ projects: db.prepare('SELECT id, name, code, short_name, folder FROM projects').all(), today: today() });
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
    ['GET', '/api/meta', () => ({ statuses: STATUSES, priorities: PRIORITIES, colors: RANGER_COLORS, ai: aiEnabled(), today: today(),
      demo: db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value === 'true', vault_set: Boolean(process.env.ZORDON_VAULT), vault: process.env.ZORDON_VAULT || null, roster_error: rosterStatus.error })],
    ['GET', '/api/dashboard', () => {
      runRoutines(db, today());
      return {
        ...dashboard(db, today()),
        doccontrol: docControlSummary(db, today()),
        focus_person_id: mePersonId(db),
        systems: { ai: aiEnabled(), voice: voice.enabled(), connectors: connectorStatus(), onedrive: Boolean(process.env.ZORDON_VAULT) && vaultRoot === process.env.ZORDON_VAULT },
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
      if (isJobNumber(project.code)) await setUpJobFolder(vaultRoot, project).catch((err) => console.warn(`[vault] ${err.message}`));
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
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
    ['POST', '/api/vault/folders', () => applyTemplateToJobs(db, vaultRoot)],
    // ----- The OneDrive job template ("5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE") -----
    ['GET', '/api/template', () => templateStatus(db)],
    ['POST', '/api/template/apply', () => applyTemplateToJobs(db, vaultRoot)],
    ['POST', '/api/template/check', async () => { await checkTemplate(db, vaultRoot); return templateStatus(db); }],
    // ----- Archive old files (moves only, logged, undoable) -----
    ['POST', '/api/cleanup/scan', async ({ body }) => {
      const areas = (Array.isArray(body.areas) ? body.areas : ['root', 'documents', 'projects']).filter((a) => ['root', 'documents', 'projects'].includes(a));
      const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(body.cutoff || '') ? body.cutoff : '2025-01-01';
      const plan = await scanOld(vaultRoot, { areas, cutoff });
      return { ...plan, items: plan.items.slice(0, 1000) };
    }],
    ['POST', '/api/cleanup/apply', async ({ body }) => {
      try { return await applyPlan(vaultRoot, required(body.plan_id, 'plan_id')); } catch (err) { throw new HttpError(400, err.message); }
    }],
    ['GET', '/api/cleanup/logs', () => listArchiveLogs(vaultRoot)],
    ['POST', '/api/cleanup/undo', async ({ body }) => {
      try { return await undoArchive(vaultRoot, required(body.log, 'log')); } catch (err) { throw new HttpError(400, err.message); }
    }],
    ['GET', '/api/inbox/status', () => ({ ...inboxStatus, inbox: join(vaultRoot, INBOX) })],
    ['POST', '/api/inbox/check', async () => { await processInbox(db, vaultRoot, today()); return { ...inboxStatus, inbox: join(vaultRoot, INBOX) }; }],
    // ----- Job Control Workbook (read-only) -----
    ['GET', '/api/projects/:id/workbook', async ({ params, query }) => {
      const project = mustExist(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(params.id)), 'Project');
      const found = await findWorkbook(vaultRoot, projectFolder(project));
      if (!found) return { found: false, folder: projectFolder(project) };
      try {
        if (query.sheet) return { found: true, ...(await readSheet(vaultRoot, found.path, query.sheet)), path: found.path };
        return { found: true, ...(await readWorkbook(vaultRoot, found.path)) };
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message);
        return { found: true, path: found.path, error: /lock|busy|EBUSY/i.test(err.message) ? 'The workbook is open and locked; close it in Excel and try again.' : `Could not read it (${err.message})` };
      }
    }],

    // ----- OneDrive browser -----
    ['GET', '/api/onedrive', ({ query }) => (query.path === undefined ? oneDriveStatus(vaultRoot)
      : listFolder(vaultRoot, query.path).catch((err) => { throw new HttpError(err.status || 404, err.status ? err.message : 'Folder not found'); }))],
    ['POST', '/api/onedrive/open', async ({ body }) => openOnComputer(vaultRoot, required(body.path, 'path'))],
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

    // Load the team and jobs from a zordon-roster.json the user picks (when OneDrive can't be read directly).
    ['POST', '/api/roster/import', ({ body }) => {
      if (!Array.isArray(body?.people) || !body.people.length) throw new HttpError(400, 'That file is not a Zordon roster (no people in it)');
      if (!loadRoster(db, body)) throw new HttpError(409, 'Zordon already has your real data. Use scripts/reset-zordon.bat to start over.');
      writeRoster(db, vaultRoot).catch(() => {});
      return { people: db.prepare('SELECT COUNT(*) AS n FROM people').get().n, projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n };
    }],

    // ----- Change order & submittal packages -----
    ['GET', '/api/packages', ({ query }) => ({
      packages: listPackages(db, { ...query, open: query.open === '1' }),
      stages: { cor: STAGES.cor, submittal: STAGES.submittal },
    })],
    // Start a package by hand: creates the folder with every stage subfolder and starts tracking it.
    ['POST', '/api/packages', async ({ body }) => {
      const type = required(['cor', 'submittal'].includes(body.type) ? body.type : null, 'type (cor or submittal)');
      const project = mustExist(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(body.project_id)), 'Project');
      // CO numbers are assigned per job, in order, and never reused: blank means "next number".
      let number = String(body.number || '').trim();
      if (type === 'cor' && !number) {
        const last = db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS n FROM packages WHERE project_id = ? AND type = 'cor'").get(project.id).n;
        number = String((last || 0) + 1);
      }
      if (type === 'cor' && !/^\d+$/.test(number)) throw new HttpError(400, 'CO number must be a number');
      if (type === 'submittal' && !specKey(body.spec_section)) throw new HttpError(400, 'Spec section is required (e.g. 26 24 16)');
      const info = { number, spec_section: body.spec_section, title: required(body.title, 'title') };
      const found = await ensurePackage(vaultRoot, projectFolder(project), type, info);
      const pkg = recordPackage(db, { project_id: project.id, type, ...info, folder: found.folder, stage: found.stage, amount: body.amount ? Number(body.amount) : null }, today());
      return body.stage ? (await setStage(db, pkg.id, body.stage, { today: today(), me: mePersonId(db), addTask: (t) => createTask(db, t), root: vaultRoot })).package : pkg;
    }],
    ['PATCH', '/api/packages/:id', ({ params, body }) => {
      if (body.amount !== undefined) db.prepare('UPDATE packages SET amount = ? WHERE id = ?').run(body.amount === '' ? null : Number(body.amount), Number(params.id));
      return setStage(db, Number(params.id), body.stage ?? mustExist(db.prepare('SELECT stage FROM packages WHERE id = ?').get(Number(params.id)), 'Package').stage,
        { force: true, today: today(), me: mePersonId(db), addTask: (t) => createTask(db, t), root: vaultRoot });
    }],
    ['POST', '/api/packages/:id/compile', ({ params }) => compilePackage(db, vaultRoot, params.id, today())],
    ['DELETE', '/api/packages/:id', ({ params }) => {
      db.prepare('DELETE FROM packages WHERE id = ?').run(Number(params.id));
      return { deleted: true, note: 'Stopped tracking. The folder and its files were left in place.' };
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
      vip_senders: [...vipSenders(db)],
      all_groups: WATCH_GROUPS.map(({ key, label }) => ({ key, label })),
    })],
    ['PATCH', '/api/settings', ({ body }) => {
      for (const k of ['me_person_id', 'capacity_hours_per_day', 'watch_groups', 'team_domain', 'vip_senders']) if (k in body) setSetting(db, k, body[k]);
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
      res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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
  const vault = await detectVault();
  if (vault.path && vault.path !== process.env.ZORDON_VAULT) console.log(`Using OneDrive folder: ${vault.path}`);
  if (vault.path) process.env.ZORDON_VAULT = vault.path;
  if (vault.found !== 'roster') {
    console.warn(`Could not find Zordon/zordon-roster.json. Looked in: ${vault.tried.join(' | ') || '(nothing)'}`);
  }
  const vaultRootForSeed = process.env.ZORDON_VAULT || join(ROOT, 'files');
  if (await seedFromRoster(db, vaultRootForSeed)) console.log('Loaded your team and jobs from Zordon/zordon-roster.json.');
  else if (process.env.ZORDON_SEED !== 'off' && seedIfEmpty(db)) console.log('Seeded demo data (set ZORDON_SEED=off to skip).');
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
  // Keep OneDrive's Zordon folder downloaded on this PC ("Always keep on this device"), so email batches and the
  // roster are always readable. Windows only; harmless elsewhere.
  if (process.platform === 'win32' && process.env.ZORDON_VAULT) {
    spawn('attrib', ['+P', '-U', join(vaultRoot, CONTROL_DIR), '/S', '/D'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  }
  await loadBuiltinSkills(db);
  await checkTemplate(db, vaultRoot).catch((err) => console.warn(`[template] ${err.message}`));
  console.log(template.found ? `Job template: ${templateDir()} (${template.dirs.length} folders)` : `No job template at ${templateDir()} yet — using the standard folders.`);
  setInterval(() => checkTemplate(db, vaultRoot).catch(() => {}), 5 * 60_000).unref();
  // Open the doors first; scanning OneDrive can take a while and the window shouldn't wait on it.
  createServer(createApp(db, { voice })).listen(port, () => {
    console.log(`\n  ⚡ Zordon Command Center online → http://localhost:${port}`);
    console.log(`  Email intelligence: ${aiEnabled() ? 'Claude' : 'rule-based (set ANTHROPIC_API_KEY to enable Claude)'}\n`);
  });
  const roster = () => writeRoster(db, vaultRoot).catch((err) => console.warn(`[vault] roster: ${err.message}`));
  (async () => {
    for (const l of await linkJobFolders(db, vaultRoot).catch(() => [])) console.log(`[vault] ${l.code || l.id} → ${l.folder}`);
    await syncControl(db, vaultRoot).catch((err) => console.warn(`[claude] sync: ${err.message}`));
    roster();
    processInbox(db, vaultRoot).catch((err) => console.warn(`[vault] inbox: ${err.message}`));
  })();
  setInterval(roster, 15 * 60_000).unref();
  // Still on demo data? Keep trying the roster (OneDrive may still be downloading it) and switch over by itself.
  setInterval(async () => {
    if (db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value !== 'true') return;
    if (await seedFromRoster(db, vaultRoot)) { console.log('Loaded your team and jobs from Zordon/zordon-roster.json.'); roster(); }
  }, 60_000).unref();
  setInterval(() => processInbox(db, vaultRoot).then((f) => f.length && console.log(`[vault] filed ${f.length} file(s) from _Inbox`)), 60_000).unref();
}
