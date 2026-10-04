// Change order and submittal packages, laid out the way the GEC2 job template says
// (OneDrive "5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE"; see template.js):
//   01 COST CONTROL/04 CHANGE ORDERS/<status stage>/CO 03 - Additional Lighting Circuits/<01 PRICING - BACKUP …>
//     the CO folder lives in its status stage (1 PENDING … 4 REJECTED-VOID) and moves when the status changes.
//   14 SUBMITTALS/26 2416 - PANELBOARDS   one folder per CSI spec section; submittal status is tracked in Zordon.
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { addDays, isoDate } from './db.js';
import { CATEGORY_FOLDERS, cleanName, titleCase, vaultPath } from './vault.js';
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
    SUBMITTED: [['Follow up with the GC for approval of', 7, 'high']],
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
  for (const p of places) {
    const hit = (await dirs(root, p.dir)).find((d) => packageMatches(type, d, info));
    if (hit) return { folder: `${p.dir}/${hit}`, stage: p.stage };
  }
  // New CO: a copy of the template's CO folder, in the first (pending) stage.
  const pending = layout.stages[0];
  const folder = `${base}/${pending.name}/${packageName(type, info)}`;
  if (layout.folderTemplate) await copyTemplate(root, folder, { from: layout.folderTemplate });
  for (const sub of layout.subfolders) await mkdir(vaultPath(root, folder, sub), { recursive: true });
  return { folder, stage: pending.key };
}

// Which of the CO folder's subfolders a document belongs in.
export async function coSubfolder(root, folder, hay) {
  const subs = await dirs(root, folder);
  const pick = (re) => subs.find((s) => re.test(s));
  if (/t\s?&\s?m|time and material|\btags?\b|ticket/i.test(hay)) return pick(/T\s?&\s?M|TAG/i) || null;
  if (/approved|executed|fully signed|signed co\b|\bcco\b/i.test(hay)) return pick(/APPROVED|SIGNED/i) || null;
  if (/\brfi\b|\brfp\b|bulletin|\basi\b|\bccd\b|directive|reference/i.test(hay)) return pick(/RFI|RFP|REFERENCE/i) || null;
  return pick(/PRICING|BACKUP|QUOTE/i) || null;
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
  db.prepare('UPDATE packages SET folder = COALESCE(?, folder), title = COALESCE(?, title), amount = COALESCE(?, amount), updated_at = ? WHERE id = ?')
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
