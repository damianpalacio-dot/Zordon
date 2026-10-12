// Change order and submittal packages, laid out the way the GEC2 job template says
// (OneDrive "5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE"; see template.js):
//   01 COST CONTROL/04 CHANGE ORDERS/<status stage>/CO 003 - Additional Lighting Circuits/
//     01 ESTIMATE - LABOR & MATERIAL  02 RFP-RFI REFERENCE  03 T&M TAGS  04 APPROVED CO DOCUMENTATION
//     05 QUOTES/VENDORS|SUBCONTRACTORS|CONSULTANTS|PROFESSIONAL SERVICES/<company>
//   the CO folder lives in its status stage (1 PENDING … 4 REJECTED-VOID) and moves when the status changes; the next
//   number's empty folder ("CO 004") waits in 04 CHANGE ORDERS itself, outside the stage folders.
//   14 SUBMITTALS/26 2416 - PANELBOARDS   one folder per CSI spec section; submittal status is tracked in Zordon.
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { addDays, isoDate } from './db.js';
import { CATEGORY_FOLDERS, cleanName, projectFolder, projectsDir, titleCase, vaultPath } from './vault.js';
import { coLayout, copyTemplate } from './template.js';

const CO_KEYS = ['PENDING', 'SUBMITTED', 'APPROVED', 'BILLED', 'REJECTED'];
const SUB_KEYS = ['VENDOR DATA', 'GEC2 REVIEW', 'SUBMITTED', 'RETURNED', 'APPROVED', 'RELEASED', 'CLOSEOUT'];
const WHAT = {
  PENDING: 'not yet submitted to the GC', SUBMITTED: 'awaiting GC/owner approval', APPROVED: 'approved by the GC',
  BILLED: 'billed on a pay app (folder stays in APPROVED)', REJECTED: 'rejected or void',
  'VENDOR DATA': 'cut sheets and product data from the vendor', 'GEC2 REVIEW': 'internal review before it goes out',
  RETURNED: 'returned with comments / revise and resubmit', RELEASED: 'released for order (PO, lead time)', CLOSEOUT: 'O&M, warranties, as-builts',
};
const keysFor = (type) => (type === 'cor' ? CO_KEYS : SUB_KEYS);
export const FINAL_STAGES = { cor: ['BILLED', 'REJECTED'], submittal: ['CLOSEOUT'] };

// The stage list for the screen: each stage, what it means, and for CORs the template folder it lives in.
export function stageList(type) {
  return keysFor(type).map((key) => ({
    name: key, what: WHAT[key] || '',
    folder: type === 'cor' ? coLayout().stages.find((s) => s.key === (key === 'BILLED' ? 'APPROVED' : key))?.name || null : null,
  }));
}
export const STAGES = { get cor() { return stageList('cor'); }, get submittal() { return stageList('submittal'); } };

// Words in a document that say where the package stands. Checked latest-first.
const STAGE_WORDS = {
  cor: [
    ['REJECTED', /\brejected\b|\bvoid(ed)?\b|withdrawn/i],
    ['BILLED', /\bbilled\b|on (the )?pay ?app/i],
    ['APPROVED', /approved|executed|fully signed|signed co\b|\bcco\b/i],
    ['SUBMITTED', /submitted|cover letter|transmit|sent to (the )?gc/i],
  ],
  submittal: [
    ['CLOSEOUT', /o\s?&\s?m|warrant|closeout|close-out|as-?built|attic stock/i],
    ['RELEASED', /releas|purchase order|order (ack|confirmation)|lead time/i],
    ['APPROVED', /approved|no exceptions|exceptions noted|corrections noted|\bmcn\b/i],
    ['RETURNED', /returned|revise and resubmit|r\s?&\s?r|rejected|reviewed/i],
    ['SUBMITTED', /submitted|transmittal|submission/i],
    ['GEC2 REVIEW', /markup|mark-up|redline|internal review/i],
    ['VENDOR DATA', /cut ?sheet|product data|data ?sheet|catalog/i],
  ],
};
export function stageFor(type, hay) {
  return STAGE_WORDS[type].find(([, re]) => re.test(hay))?.[0] || null;
}

// What Zordon puts on your list when a package reaches a stage: [[title, days until due, priority], …].
const NEXT_STEP = {
  cor: {
    SUBMITTED: [['Follow up with the GC for approval of', 7, 'high'], ['Update Job Control Workbook for submitted', 0, 'medium']],
    APPROVED: [['Update Job Control Workbook for approved', 0, 'high'], ['Bill on the next pay app:', 3, 'critical']],
    REJECTED: [['Update Job Control Workbook for rejected/void', 0, 'high']],
  },
  submittal: {
    'GEC2 REVIEW': [['Finish review and submit', 2, 'high']],
    SUBMITTED: [['Chase the review of', 10, 'medium']],
    RETURNED: [['Revise and resubmit', 3, 'high']],
    APPROVED: [['Release equipment for', 2, 'high']],
    RELEASED: [['Confirm ship date for', 7, 'medium']],
  },
};

export const packageType = (category) => (category === 'COR' ? 'cor' : category === 'Submittal' ? 'submittal' : null);

// "CO 001": numbered per job, three digits, never renumbered.
export const corNumber = (n) => (/^\d+$/.test(String(n)) ? String(Number(n)).padStart(3, '0') : cleanName(n, 20).toUpperCase());
export const coLabel = (n) => `CO ${corNumber(n)}`;
// Spec sections are compared by their six digits ("26 24 16" = "262416" = "26 2416").
export const specKey = (t) => String(t || '').match(/\b(\d{2})\s?(\d{2})\s?(\d{2})\b/)?.slice(1).join(' ') || null;
const specFolder = (key) => key && `${key.slice(0, 2)} ${key.slice(3).replace(' ', '')}`; // "26 2416"

const cleanTitle = (title) => titleCase(String(title || '')
  .replace(/^(cor|pco|pci|co|change (order|request)|submittal|sub|spec(ification)?|section)\b[\s#:-]*[\d.]*[\s:-]*/i, '')
  .replace(/\b\d{2}\s?\d{2}\s?\d{2}\b[\s:-]*/, ''), 50);

export function packageName(type, { number, spec_section, title }) {
  const desc = cleanTitle(title);
  if (type === 'cor') return cleanName(`${coLabel(number)}${desc ? ` - ${desc}` : ''}`, 80);
  return cleanName(`${specFolder(specKey(spec_section) || specKey(title))}${desc ? ` - ${desc.toUpperCase()}` : ''}`, 80);
}

// Does an existing folder belong to this CO number / spec section? Handles older names too
// ("Change Request 073", "COR 073", "CO 03 (GC PCO-012)", "26 24 16 PANELBOARDS", "262416 Panelboards").
export function packageMatches(type, folderName, { number, spec_section }) {
  const f = cleanName(folderName, 120).toUpperCase();
  if (type === 'cor') {
    if (!number || !/^\d+$/.test(String(number))) return false;
    const m = f.match(/^(?:COR|PCO|PCI|CR|CO|CHANGE (?:ORDER|REQUEST))\s*[#-]?\s*0*(\d+)\b/);
    return Boolean(m && Number(m[1]) === Number(number));
  }
  const key = specKey(spec_section);
  return Boolean(key && specKey(f) === key);
}

const dirs = async (root, rel) => (await readdir(vaultPath(root, rel), { withFileTypes: true }).catch(() => []))
  .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
const exists = (root, rel) => stat(vaultPath(root, rel)).then(() => true, () => false);

// Find or create the package folder. Returns { folder, stage } where stage is the CO status its folder sits in.
export async function ensurePackage(root, jobBase, type, info) {
  if (type === 'submittal') {
    const base = `${jobBase}/${CATEGORY_FOLDERS.Submittal}`;
    const existing = (await dirs(root, base)).find((d) => packageMatches(type, d, info));
    const folder = `${base}/${existing || packageName(type, info)}`;
    await mkdir(vaultPath(root, folder), { recursive: true });
    return { folder, stage: null };
  }
  const layout = coLayout();
  const base = `${jobBase}/${layout.base}`;
  // Look in every stage folder, then in older layouts (01 COST CONTROL/CHANGE ORDERS, or loose in cost control).
  const places = [...layout.stages.map((s) => ({ dir: `${base}/${s.name}`, stage: s.key })), { dir: base, stage: null },
    { dir: `${jobBase}/01 COST CONTROL/CHANGE ORDERS`, stage: null }, { dir: `${jobBase}/01 COST CONTROL`, stage: null }];
  const pending = layout.stages[0];
  for (const p of places) {
    const hit = (await dirs(root, p.dir)).find((d) => packageMatches(type, d, info));
    if (!hit) continue;
    // The empty "CO 003" waiting in 04 CHANGE ORDERS: renamed and moved into the pending stage once it gets a document.
    if (p.dir === base && isReady(hit)) {
      const folder = `${base}/${pending.name}/${packageName(type, info)}`;
      if (await exists(root, folder)) return { folder, stage: pending.key };
      await mkdir(vaultPath(root, base, pending.name), { recursive: true });
      await rename(vaultPath(root, base, hit), vaultPath(root, folder));
      await ensureReadyFolder(root, jobBase);
      return { folder, stage: pending.key };
    }
    return { folder: `${p.dir}/${hit}`, stage: p.stage };
  }
  // New CO: a copy of the template's CO folder, in the first (pending) stage.
  const folder = `${base}/${pending.name}/${packageName(type, info)}`;
  await newCoFolder(root, folder);
  await ensureReadyFolder(root, jobBase);
  return { folder, stage: pending.key };
}

const isReady = (name) => /^CO\s*\d+$/i.test(cleanName(name, 40));
async function newCoFolder(root, folder) {
  const layout = coLayout();
  if (layout.folderTemplate) await copyTemplate(root, folder, { from: layout.folderTemplate });
  for (const sub of layout.subfolders) await mkdir(vaultPath(root, folder, sub), { recursive: true });
}

// Keep the next CO number's empty folder ready directly in 04 CHANGE ORDERS (not in a stage folder), like the
// co-update skill does. Only for jobs that use the stage-folder layout. Returns its path, or null.
export async function ensureReadyFolder(root, jobBase) {
  const layout = coLayout();
  const base = `${jobBase}/${layout.base}`;
  const stageDirs = await Promise.all(layout.stages.map((s) => dirs(root, `${base}/${s.name}`)));
  // One ready folder at a time; and only for jobs already on the stage-folder layout.
  if ((await dirs(root, base)).some(isReady) || !stageDirs.some((d) => d.some((n) => !n.startsWith('_')))) return null;
  const all = [...await dirs(root, base), ...stageDirs.flat(), ...await dirs(root, `${jobBase}/01 COST CONTROL/CHANGE ORDERS`)];
  const numbers = all.map((d) => cleanName(d, 120).toUpperCase().match(/^(?:COR|PCO|PCI|CR|CO|CHANGE (?:ORDER|REQUEST))\s*[#-]?\s*0*(\d+)\b/)?.[1])
    .filter(Boolean).map(Number);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  if (all.some((d) => packageMatches('cor', d, { number: next }))) return null;
  const folder = `${base}/${coLabel(next)}`;
  await newCoFolder(root, folder);
  return folder;
}

// Inside a CO folder: [what it is, file label, words, folder name patterns (first that exists wins)].
// Vendor quotes never go in the estimate folder; the McCormick estimate does.
export const CO_PARTS = [
  ['T&M tag', 'T&M Tag', /t\s?&\s?m|time and material|\btags?\b|ticket|voucher|daily/i, [/T\s?&\s?M|TAG/i]],
  ['Professional services quote', 'Professional Services Quote', /professional services|engineering (fee|proposal|quote)|survey/i, [/QUOTE/i, /PROFESSIONAL/i]],
  ['Consultant quote', 'Consultant Quote', /consultant/i, [/QUOTE/i, /CONSULTANT/i]],
  ['Sub quote', 'Sub Quote', /\bsub(contractor)?['’]?s?\s+(quote|proposal|pricing)|subcontractor/i, [/QUOTE/i, /SUBCONTRACT/i]],
  ['Vendor quote', 'Vendor Quote', /quotes?\b|quotation|rental|vendor pric|supplier/i, [/QUOTE/i, /VENDOR/i]],
  ['Estimate', 'Estimate - Labor & Material', /mccormick|estimate|takeoff|take-off|work-?up|end ?sheet|recap|labor calc/i, [/ESTIMAT/i]],
  ['Signed CO', 'Signed CO', /approved|executed|fully signed|signed co\b|\bcco\b/i, [/APPROVED|SIGNED/i]],
  ['Reference', 'Reference', /\brf[ip]\b|\bccd\b|\bpci\b|\basi\b|\bdc[dn]\b|bulletin|directive|drawing|sketch|reference/i, [/RFI|RFP|REFERENCE/i]],
];
export const coPart = (hay) => CO_PARTS.find(([, , re]) => re.test(hay)) || null;

// Which of the CO folder's subfolders a document belongs in, e.g. "05 QUOTES/VENDORS/GRAYBAR ELECTRIC" (the company
// folder only when it already exists). Older CO folders without a match fall back to their PRICING / BACKUP folder.
// Returns { sub, label } (sub null = the CO folder itself).
export async function coSubfolder(root, folder, hay) {
  const part = coPart(hay);
  const subs = await dirs(root, folder);
  const fallback = () => ({ sub: subs.find((d) => /PRICING|BACKUP/i.test(d)) || null, label: part?.[1] || null });
  if (!part) return fallback();
  const [top, inner] = part[3];
  const first = subs.find((d) => top.test(d));
  if (!first) return part[0].endsWith('quote') || part[0] === 'Estimate' ? fallback() : { sub: null, label: part[1] };
  let sub = first;
  if (inner) {
    const second = (await dirs(root, `${folder}/${first}`)).find((d) => inner.test(d));
    if (second) {
      sub += `/${second}`;
      const words = new Set(cleanName(hay, 300).toUpperCase().split(/[^A-Z0-9&]+/).filter((w) => w.length >= 3));
      const company = (await dirs(root, `${folder}/${sub}`))
        .find((d) => cleanName(d, 80).toUpperCase().split(/[^A-Z0-9&]+/).filter((w) => w.length >= 3).some((w) => words.has(w)));
      if (company) sub += `/${company}`;
    }
  }
  return { sub, label: part[1] };
}

// Move a CO folder into the stage folder for `key`. Only folders already in the template layout move.
async function moveCoFolder(root, pkg, key) {
  const layout = coLayout();
  const target = layout.stages.find((s) => s.key === (key === 'BILLED' ? 'APPROVED' : key));
  if (!target || !pkg.folder) return pkg.folder;
  const parts = pkg.folder.split('/');
  const name = parts.pop();
  const stageDir = parts.pop();
  if (!layout.stages.some((s) => s.name === stageDir) || stageDir === target.name) return pkg.folder;
  const dest = [...parts, target.name, name].join('/');
  if (await exists(root, dest) || !await exists(root, pkg.folder)) return pkg.folder;
  await mkdir(vaultPath(root, [...parts, target.name].join('/')), { recursive: true });
  await rename(vaultPath(root, pkg.folder), vaultPath(root, dest));
  return dest;
}

// ---------- Tracking ----------
const row = (db, id) => db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
  LEFT JOIN projects p ON p.id = k.project_id WHERE k.id = ?`).get(id);

export function listPackages(db, { type, project_id, open } = {}) {
  let rows = db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
    LEFT JOIN projects p ON p.id = k.project_id ORDER BY k.updated_at DESC, k.id DESC`).all();
  if (type) rows = rows.filter((r) => r.type === type);
  if (project_id) rows = rows.filter((r) => r.project_id === Number(project_id));
  if (open) rows = rows.filter((r) => !FINAL_STAGES[r.type].includes(r.stage));
  return rows.map((r) => ({
    ...r, history: JSON.parse(r.history || '[]'), stages: keysFor(r.type),
    package_path: r.type === 'cor' && r.compiled_at ? `${r.folder}/${coLabel(r.number)}${r.project_code ? ` - ${r.project_code}` : ''} - ${r.title}.pdf` : null,
  }));
}

export function findPackage(db, project_id, type, { number, spec_section }) {
  return type === 'cor'
    ? db.prepare("SELECT * FROM packages WHERE project_id = ? AND type = 'cor' AND number = ?").get(project_id, corNumber(number))
    : db.prepare("SELECT * FROM packages WHERE project_id = ? AND type = 'submittal' AND spec_section = ?").get(project_id, specKey(spec_section));
}

export function recordPackage(db, { project_id, type, number, spec_section, title, folder, stage, amount }, today = isoDate()) {
  const info = { number: type === 'cor' && number ? corNumber(number) : number || null, spec_section: specKey(spec_section) };
  const prev = findPackage(db, project_id, type, info);
  const first = stage || keysFor(type)[0];
  if (!prev) {
    const id = Number(db.prepare(`INSERT INTO packages (project_id, type, number, spec_section, title, folder, stage, amount, history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(project_id, type, info.number, info.spec_section, cleanTitle(title) || packageName(type, { ...info, title }),
      folder, first, amount ?? null, JSON.stringify([{ stage: first, date: today }]), today, today).lastInsertRowid);
    return row(db, id);
  }
  // The first document names the package; later quotes and letters don't rename it.
  db.prepare("UPDATE packages SET folder = COALESCE(?, folder), title = CASE WHEN title = '' THEN COALESCE(?, title) ELSE title END, amount = COALESCE(?, amount), updated_at = ? WHERE id = ?")
    .run(folder || null, cleanTitle(title) || null, amount ?? null, today, prev.id);
  return row(db, prev.id);
}

// Move a package to a stage and put the next steps on the PM's list. From filing it never goes backwards; the user
// can set any stage by hand. CO folders move to the matching stage folder. `addTask` is the server's createTask.
export async function setStage(db, id, stage, { force = false, today = isoDate(), me = null, addTask = null, root = null } = {}) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(id);
  if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
  const keys = keysFor(pkg.type);
  if (!keys.includes(stage)) throw Object.assign(new Error(`Stage must be one of: ${keys.join(', ')}`), { status: 400 });
  if (stage === pkg.stage || (!force && keys.indexOf(stage) < keys.indexOf(pkg.stage))) return { package: row(db, id), task_ids: [] };
  const folder = pkg.type === 'cor' && root ? await moveCoFolder(root, pkg, stage).catch(() => pkg.folder) : pkg.folder;
  const history = [...JSON.parse(pkg.history || '[]'), { stage, date: today }];
  db.prepare('UPDATE packages SET stage = ?, folder = ?, history = ?, updated_at = ? WHERE id = ?').run(stage, folder, JSON.stringify(history), today, id);
  // Documents filed in a CO folder that moved keep pointing at the right place.
  if (folder !== pkg.folder) {
    db.prepare('UPDATE documents SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?').run(folder, pkg.folder.length + 1, pkg.folder.length + 1, `${pkg.folder}/`);
  }
  // Status changes the GC decided go on the reminder list until the Job Control Workbook (.xlsm) is updated by hand.
  if (pkg.type === 'cor' && root && ['SUBMITTED', 'APPROVED', 'REJECTED'].includes(stage)) {
    const job = db.prepare('SELECT code, name FROM projects WHERE id = ?').get(pkg.project_id);
    await noteWorkbookUpdate(root, { job: job?.code || job?.name || '', number: pkg.number, stage, title: pkg.title }, today).catch(() => null);
  }
  // Reaching a new stage finishes the previous next steps.
  db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE source = 'package' AND source_ref = ? AND status != 'done'").run(today, id);
  const label = pkg.type === 'cor' ? coLabel(pkg.number) : `Submittal ${pkg.spec_section || ''}`.trim();
  const task_ids = addTask ? (NEXT_STEP[pkg.type][stage] || []).map(([title, days, priority]) => addTask({
    project_id: pkg.project_id, owner_id: me, title: `${title} ${label} - ${pkg.title}`.slice(0, 200),
    description: `Folder: ${folder}\nStage: ${stage}`, priority, due_date: addDays(today, days),
    status: 'not_started', source: 'package', source_ref: id,
  })) : [];
  return { package: row(db, id), task_ids, task_id: task_ids[0] ?? null };
}

// The reminder file that keeps nagging until the real Job Control Workbook (.xlsm) is updated by hand
// (co-update skill). Lines: OPEN | date | job | CO ### | status | description.
export const WORKBOOK_FILE = () => `${projectsDir() ? `${projectsDir()}/` : ''}Zordon/_PENDING WORKBOOK UPDATES.txt`;
const WORKBOOK_HEADER = `GEC2 PENDING WORKBOOK UPDATES
Each line is a change order status change that still needs to be entered in the job's GEC2 Job Control Workbook (.xlsm).
Format: OPEN | date | job | CO ### | new status | description
When the workbook is updated, change OPEN to DONE, add "resolved YYYY-MM-DD" and move the line under ---- DONE ----.

---- OPEN ----
`;
export async function noteWorkbookUpdate(root, { job, number, stage, title }, today = isoDate()) {
  const rel = WORKBOOK_FILE();
  const line = `OPEN | ${today} | ${job} | ${coLabel(number)} | ${stage} | ${title}\n`;
  const current = await readFile(vaultPath(root, rel), 'utf8').catch(() => null);
  // Claude (co-update skill) may already have logged the same change in its own wording: one line per change.
  const n = Number(number);
  const word = { REJECTED: /reject|void/i, SUBMITTED: /submit/i, APPROVED: /approv/i }[stage] || new RegExp(stage, 'i');
  const same = (l) => /^\s*OPEN\b/i.test(l) && (!job || l.toUpperCase().includes(String(job).toUpperCase()))
    && new RegExp(`\\bCO\\s*#?\\s*0*${n}\\b`, 'i').test(l) && word.test(l);
  if (current?.split('\n').some(same)) return rel;
  await mkdir(vaultPath(root, rel, '..'), { recursive: true });
  const next = current === null ? `${WORKBOOK_HEADER}${line}---- DONE ----\n`
    : current.includes('---- DONE ----') ? current.replace('---- DONE ----', `${line}---- DONE ----`) : `${current}${line}`;
  await writeFile(vaultPath(root, rel), next);
  return rel;
}

// ---------- Following the CO folders on OneDrive ----------
// Claude (Job Control app, co-update skill) creates CO folders and moves them between stage folders without telling
// Zordon. Every few minutes Zordon looks at each job's 04 CHANGE ORDERS and follows along:
//   - a CO folder it hasn't seen is recorded quietly at the stage its folder is in (no tasks, no package build:
//     Claude already built the package);
//   - a CO folder that moved to another stage folder updates the stage and adds the next steps and the workbook
//     reminder, the same as changing the stage in Zordon. Nothing is moved, renamed or written into the CO folder.
export async function scanCoFolders(db, root, { today = isoDate(), me = null, addTask = null } = {}) {
  const result = { jobs: 0, found: 0, added: [], moved: [], checked_at: new Date().toISOString() };
  if (!root) return result;
  const layout = coLayout();
  const jobs = db.prepare("SELECT * FROM projects WHERE status != 'closed' AND code IS NOT NULL AND code != ''").all();
  for (const job of jobs) {
    const base = `${projectFolder(job)}/${layout.base}`;
    if (!(await exists(root, base))) continue;
    result.jobs++;
    for (const st of layout.stages) {
      for (const name of await dirs(root, `${base}/${st.name}`)) {
        if (name.startsWith('_')) continue; // _CO FOLDER TEMPLATE (DUPLICATE ME)
        const m = cleanName(name, 120).match(/^(?:CO|COR|PCO|CR|CHANGE ORDER)\s*#?\s*0*(\d{1,4})\b\s*(?:\([^)]*\))?\s*[-–:]*\s*(.*)$/i);
        if (!m) continue;
        result.found++;
        const number = corNumber(m[1]);
        const folder = `${base}/${st.name}/${name}`;
        const prev = findPackage(db, job.id, 'cor', { number });
        if (!prev) {
          recordPackage(db, { project_id: job.id, type: 'cor', number, title: m[2] || `Change Order ${number}`, folder, stage: st.key }, today);
          result.added.push(`${job.code} ${coLabel(number)}`);
          continue;
        }
        if (prev.folder !== folder) {
          db.prepare('UPDATE packages SET folder = ? WHERE id = ?').run(folder, prev.id);
          if (prev.folder) db.prepare('UPDATE documents SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?').run(folder, prev.folder.length + 1, prev.folder.length + 1, `${prev.folder}/`);
        }
        // BILLED lives in the APPROVED folder; anything else follows the folder.
        const stageNow = prev.stage === 'BILLED' && st.key === 'APPROVED' ? 'BILLED' : st.key;
        if (stageNow !== prev.stage) {
          await setStage(db, prev.id, stageNow, { force: true, today, me, addTask, root });
          result.moved.push(`${job.code} ${coLabel(number)}: ${prev.stage} → ${stageNow}`);
        }
      }
    }
  }
  return result;
}
