// Change order and submittal packages: one folder per COR / submittal with numbered stage subfolders,
// tracked from first backup to billed (CORs) or from vendor data to closeout (submittals).
//   5. PROJECTS/G2707/01 COST CONTROL/CHANGE ORDERS/COR 073 - Ice and Water Machine Power/01 BACKUP … 07 BILLED
//   5. PROJECTS/G2707/14 SUBMITTALS/26 24 16 Panelboards/01 VENDOR DATA … 07 CLOSEOUT
import { mkdir, readdir } from 'node:fs/promises';
import { addDays, isoDate } from './db.js';
import { cleanName, titleCase, vaultPath } from './vault.js';

export const COR_DIR = '01 COST CONTROL/CHANGE ORDERS';
export const SUB_DIR = '14 SUBMITTALS';

// [stage folder, what goes in it, words that put a document there]. Words are checked from the last stage back,
// so "approved COR 073 billed on pay app 12" lands in BILLED, not APPROVED.
export const STAGES = {
  cor: [
    ['01 BACKUP', 'RFIs, bulletins, ASIs, directives, emails and photos that justify the change',
      /\bbackup\b|back-up|\brfi\b|bulletin|\basi\b|\bccd\b|directive|photo|field (memo|report)|email/i],
    ['02 T&M', 'signed T&M tags and daily tickets', /t\s?&\s?m|time and material|\btags?\b|ticket|daily/i],
    ['03 QUOTES', 'vendor and sub quotes', /quotes?\b|quotation|vendor pric|supplier/i],
    ['04 WORKUP', 'takeoff, labor/material workup, estimate, endsheet', /work-?up|takeoff|take-off|estimate|endsheet|end sheet|recap|accubid|labor calc/i],
    ['05 SUBMITTED', 'the COR as sent to the GC, with its cover letter', /submitted|cover letter|transmit|\bsent\b|cor letter|proposal/i],
    ['06 APPROVED', 'executed change order / approved CCO from the GC', /approved|executed|signed co\b|\bcco\b|fully signed/i],
    ['07 BILLED', 'the pay app line that billed it', /billed|billing|pay ?app|invoice/i],
  ],
  submittal: [
    ['01 VENDOR DATA', 'cut sheets, product data and shop drawings from the vendor', /cut ?sheet|product data|data ?sheet|vendor|manufacturer|shop drawing|catalog/i],
    ['02 GEC2 REVIEW', 'internal markups and comments before it goes out', /markup|mark-up|redline|internal|gec2 review|check(ed)? against/i],
    ['03 SUBMITTED', 'the package as sent, with the transmittal', /submitted|transmittal|submission|\bsent\b/i],
    ['04 RETURNED', 'returned with comments, revise and resubmit, rejected', /returned|revise and resubmit|r\s?&\s?r|rejected|comments|reviewed/i],
    ['05 APPROVED', 'approved / no exceptions taken / make corrections noted', /approved|no exceptions|exceptions noted|corrections noted|\bnet\b|\bmcn\b/i],
    ['06 RELEASED', 'release letter, PO, order confirmation, lead time', /releas|purchase order|\bpo\b|order (ack|confirmation)|lead time/i],
    ['07 CLOSEOUT', "O&M manuals, warranties, as-builts, attic stock", /o\s?&\s?m|warrant|closeout|close-out|as-?built|attic stock/i],
  ],
};

// What Zordon puts on your list when a package reaches a stage: [title, days until due, priority].
const NEXT_STEP = {
  cor: {
    '04 WORKUP': ['Finish workup and submit', 3, 'high'],
    '05 SUBMITTED': ['Follow up with the GC for approval of', 7, 'high'],
    '06 APPROVED': ['Bill on the next pay app:', 3, 'critical'],
  },
  submittal: {
    '02 GEC2 REVIEW': ['Finish review and submit', 2, 'high'],
    '03 SUBMITTED': ['Chase the review of', 10, 'medium'],
    '04 RETURNED': ['Revise and resubmit', 3, 'high'],
    '05 APPROVED': ['Release equipment for', 2, 'high'],
    '06 RELEASED': ['Confirm ship date for', 7, 'medium'],
  },
};
export const FINAL_STAGE = { cor: '07 BILLED', submittal: '07 CLOSEOUT' };

const stageNames = (type) => STAGES[type].map(([name]) => name);
const bare = (name) => cleanName(name, 80).toUpperCase().replace(/^\d+\s*[-.]?\s*/, '').replace(/[^A-Z0-9&]+/g, ' ').trim();
const ALIASES = { ENDSHEET: 'WORKUP', 'END SHEET': 'WORKUP', QUOTE: 'QUOTES', 'T M': 'T&M', TM: 'T&M', 'PRODUCT DATA': 'VENDOR DATA' };
const canonical = (name) => ALIASES[bare(name)] || bare(name);

export const packageType = (category) => (category === 'COR' ? 'cor' : category === 'Submittal' ? 'submittal' : null);

export function stageFor(type, hay) {
  const hit = [...STAGES[type]].reverse().find(([, , re]) => re.test(hay));
  return hit ? hit[0] : null;
}

export const corNumber = (n) => (/^\d+$/.test(String(n)) ? String(Number(n)).padStart(3, '0') : cleanName(n, 20).toUpperCase());
export const specKey = (t) => String(t || '').match(/\b(\d{2})\s?(\d{2})\s?(\d{2})\b/)?.slice(1).join(' ') || null;

export function packageName(type, { number, spec_section, title }) {
  const desc = titleCase(String(title || '').replace(/^(cor|pco|pci|co|change (order|request)|submittal|sub)\b[\s#:-]*\d*[\s:-]*/i, ''), 50);
  if (type === 'cor') return cleanName(`COR ${corNumber(number)}${desc ? ` - ${desc}` : ''}`, 80);
  return cleanName(`${specKey(spec_section) || specKey(title)}${desc ? ` ${desc.replace(/^\d{2} \d{2} \d{2}\s*/, '')}` : ''}`, 80);
}

// Does an existing folder belong to this COR number / spec section? Handles the team's older names too
// ("Change Request 073", "CR 73", "PCO-073", "26 24 16 PANELBOARDS", "262416 Panelboards").
export function packageMatches(type, folderName, { number, spec_section }) {
  const f = cleanName(folderName, 120).toUpperCase();
  if (type === 'cor') {
    if (!number) return false;
    const m = f.match(/\b(?:COR|PCO|PCI|CR|CO|CHANGE (?:ORDER|REQUEST))\s*[#-]?\s*0*(\d+)\b/);
    return Boolean(m && /^\d+$/.test(String(number)) && Number(m[1]) === Number(number));
  }
  const key = specKey(spec_section);
  return Boolean(key && specKey(f) === key);
}

const dirs = async (root, rel) => (await readdir(vaultPath(root, rel), { withFileTypes: true }).catch(() => []))
  .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);

// Find or create the package folder and its stage subfolders. Returns the package folder (relative to the vault).
export async function ensurePackage(root, jobBase, type, info) {
  const base = `${jobBase}/${type === 'cor' ? COR_DIR : SUB_DIR}`;
  const existing = (await dirs(root, base)).find((d) => packageMatches(type, d, info));
  const folder = `${base}/${existing || packageName(type, info)}`;
  const have = await dirs(root, folder);
  for (const stage of stageNames(type)) {
    // Keep the team's existing "Quotes" / "T&M" / "ENDSHEET" folders instead of adding a numbered twin.
    if (!have.some((d) => canonical(d) === canonical(stage))) await mkdir(vaultPath(root, folder, stage), { recursive: true });
  }
  return folder;
}

export async function stageFolder(root, folder, stage) {
  if (!stage) return folder;
  const match = (await dirs(root, folder)).find((d) => canonical(d) === canonical(stage));
  return `${folder}/${match || stage}`;
}

// ---------- Tracking ----------
const row = (db, id) => db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
  LEFT JOIN projects p ON p.id = k.project_id WHERE k.id = ?`).get(id);

export function listPackages(db, { type, project_id, open } = {}) {
  let rows = db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
    LEFT JOIN projects p ON p.id = k.project_id ORDER BY k.updated_at DESC, k.id DESC`).all();
  if (type) rows = rows.filter((r) => r.type === type);
  if (project_id) rows = rows.filter((r) => r.project_id === Number(project_id));
  if (open) rows = rows.filter((r) => r.stage !== FINAL_STAGE[r.type]);
  return rows.map((r) => ({ ...r, history: JSON.parse(r.history || '[]'), stages: stageNames(r.type) }));
}

export function findPackage(db, project_id, type, { number, spec_section }) {
  return type === 'cor'
    ? db.prepare("SELECT * FROM packages WHERE project_id = ? AND type = 'cor' AND number = ?").get(project_id, corNumber(number))
    : db.prepare("SELECT * FROM packages WHERE project_id = ? AND type = 'submittal' AND spec_section = ?").get(project_id, specKey(spec_section));
}

export function recordPackage(db, { project_id, type, number, spec_section, title, folder, stage, amount }, today = isoDate()) {
  const info = { number: type === 'cor' && number ? corNumber(number) : number || null, spec_section: specKey(spec_section) };
  const prev = findPackage(db, project_id, type, info);
  if (!prev) {
    const id = Number(db.prepare(`INSERT INTO packages (project_id, type, number, spec_section, title, folder, stage, amount, history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(project_id, type, info.number, info.spec_section, titleCase(title, 120) || packageName(type, { ...info, title }),
      folder, stage || stageNames(type)[0], amount ?? null, JSON.stringify([{ stage: stage || stageNames(type)[0], date: today }]), today, today).lastInsertRowid);
    return row(db, id);
  }
  db.prepare('UPDATE packages SET folder = COALESCE(?, folder), title = COALESCE(?, title), amount = COALESCE(?, amount), updated_at = ? WHERE id = ?')
    .run(folder || null, title ? titleCase(title, 120) : null, amount ?? null, today, prev.id);
  return row(db, prev.id);
}

// Move a package to a stage (never backwards when it comes from filing; the user can set any stage by hand)
// and put the next step on the PM's list. `addTask` is the server's createTask so money rules apply.
export function setStage(db, id, stage, { force = false, today = isoDate(), me = null, addTask = null } = {}) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(id);
  if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
  const names = stageNames(pkg.type);
  if (!names.includes(stage)) throw Object.assign(new Error(`Stage must be one of: ${names.join(', ')}`), { status: 400 });
  if (stage === pkg.stage || (!force && names.indexOf(stage) < names.indexOf(pkg.stage))) return { package: row(db, id), task_id: null };
  const history = [...JSON.parse(pkg.history || '[]'), { stage, date: today }];
  db.prepare('UPDATE packages SET stage = ?, history = ?, updated_at = ? WHERE id = ?').run(stage, JSON.stringify(history), today, id);
  // The previous next-step is finished by reaching a new stage.
  db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE source = 'package' AND source_ref = ? AND status != 'done'").run(today, id);
  const step = NEXT_STEP[pkg.type][stage];
  let task_id = null;
  if (step && addTask) {
    const label = pkg.type === 'cor' ? `COR ${pkg.number}` : `Submittal ${pkg.spec_section || ''}`.trim();
    task_id = addTask({
      project_id: pkg.project_id, owner_id: me, title: `${step[0]} ${label} - ${pkg.title}`.slice(0, 200),
      description: `Package folder: ${pkg.folder}\nStage: ${stage}`, priority: step[2], due_date: addDays(today, step[1]),
      status: 'not_started', source: 'package', source_ref: id, estimate_hours: 1,
    });
  }
  return { package: row(db, id), task_id };
}
