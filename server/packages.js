// Change order and submittal packages, filed the GEC2 Job Control way.
//   Change orders: one folder per CO inside the stage folder for where it stands, with the same five subfolders every time.
//     5. PROJECTS/G2707/01 COST CONTROL/04 CHANGE ORDERS/
//       CO 074/                                   the next number, ready and empty (not in a stage folder)
//       1 PENDING (not yet submitted to GC)/CO 073 - Ice and Water Machine Power/
//         01 ESTIMATE - LABOR & MATERIAL  02 RFP-RFI REFERENCE  03 T&M TAGS  04 APPROVED CO DOCUMENTATION
//         05 QUOTES/VENDORS|SUBCONTRACTORS|CONSULTANTS|PROFESSIONAL SERVICES/<company>
//       2 SUBMITTED (awaiting GC-owner approval)/  3 APPROVED/  4 REJECTED-VOID/  5. CO LOG/
//   Submittals: 5. PROJECTS/G2707/14 SUBMITTALS/26 24 16 Panelboards/01 VENDOR DATA … 07 CLOSEOUT
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { addDays, isoDate } from './db.js';
import { cleanName, projectsDir, titleCase, vaultPath } from './vault.js';

export const COR_DIR = '01 COST CONTROL/04 CHANGE ORDERS';
export const LEGACY_COR_DIR = '01 COST CONTROL/CHANGE ORDERS'; // Zordon's older layout, still reused in place
export const SUB_DIR = '14 SUBMITTALS';
export const CO_LOG_DIR = '5. CO LOG';

// Change order stages: [stage, what it means, words that put a CO there, its stage folder].
// Words are checked from the last stage back, so "approved and billed on pay app 12" is BILLED.
export const STAGES = {
  cor: [
    ['PENDING', 'being put together, not yet sent to the GC', /^$/, '1 PENDING (not yet submitted to GC)'],
    ['SUBMITTED', 'sent to the GC, awaiting GC / owner approval', /submitted|cover letter|transmit|\bsent\b/i, '2 SUBMITTED (awaiting GC-owner approval)'],
    ['APPROVED', 'executed / approved by the GC', /approved|executed|signed co\b|\bcco\b|fully signed/i, '3 APPROVED'],
    ['BILLED', 'approved and billed on a pay app', /billed|on pay ?app|invoiced/i, '3 APPROVED'],
    ['REJECTED-VOID', 'rejected or voided', /rejected|\bvoid(ed)?\b/i, '4 REJECTED-VOID'],
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
export const STAGE_FOLDERS = STAGES.cor.map(([, , , f]) => f).filter((f, i, a) => a.indexOf(f) === i);

// Inside a CO folder: [subfolder, file label, words]. Checked in order; no match = the CO folder itself
// (where the final package PDF lives). Vendor quotes never go in 01.
export const CO_PARTS = [
  ['03 T&M TAGS', 'T&M Tag', /t\s?&\s?m|time and material|\btags?\b|ticket|voucher|daily/i],
  ['05 QUOTES/PROFESSIONAL SERVICES', 'Professional Services Quote', /professional services|engineering (fee|proposal|quote)|survey/i],
  ['05 QUOTES/CONSULTANTS', 'Consultant Quote', /consultant/i],
  ['05 QUOTES/SUBCONTRACTORS', 'Sub Quote', /\bsub(contractor)?['’]?s?\s+(quote|proposal|pricing)|subcontractor/i],
  ['05 QUOTES/VENDORS', 'Vendor Quote', /quotes?\b|quotation|rental|vendor pric|supplier/i],
  ['01 ESTIMATE - LABOR & MATERIAL', 'Estimate - Labor & Material', /mccormick|estimate|takeoff|take-off|work-?up|end ?sheet|recap|labor calc/i],
  ['04 APPROVED CO DOCUMENTATION', 'Signed CO', /approved|executed|signed|\bcco\b/i],
  ['02 RFP-RFI REFERENCE', 'Reference', /\brf[ip]\b|\bccd\b|\bpci\b|\basi\b|\bdc[dn]\b|bulletin|directive|drawing|sketch|reference|backup|back-up|photo/i],
];
const CO_SUBFOLDERS = ['01 ESTIMATE - LABOR & MATERIAL', '02 RFP-RFI REFERENCE', '03 T&M TAGS', '04 APPROVED CO DOCUMENTATION',
  '05 QUOTES/VENDORS', '05 QUOTES/SUBCONTRACTORS', '05 QUOTES/CONSULTANTS', '05 QUOTES/PROFESSIONAL SERVICES'];

// What Zordon puts on your list when a package reaches a stage: [title, days until due, priority].
const NEXT_STEP = {
  cor: {
    PENDING: ['Build the package and draft the GC email for', 3, 'high'],
    SUBMITTED: ['Follow up with the GC for approval of', 7, 'high'],
    APPROVED: ['Bill on the next pay app:', 3, 'critical'],
  },
  submittal: {
    '02 GEC2 REVIEW': ['Finish review and submit', 2, 'high'],
    '03 SUBMITTED': ['Chase the review of', 10, 'medium'],
    '04 RETURNED': ['Revise and resubmit', 3, 'high'],
    '05 APPROVED': ['Release equipment for', 2, 'high'],
    '06 RELEASED': ['Confirm ship date for', 7, 'medium'],
  },
};
export const CLOSED_STAGES = { cor: ['BILLED', 'REJECTED-VOID'], submittal: ['07 CLOSEOUT'] };

const stageNames = (type) => STAGES[type].map(([name]) => name);
export const stageFolderName = (stage) => STAGES.cor.find(([n]) => n === stage)?.[3] || STAGE_FOLDERS[0];
const bare = (name) => cleanName(name, 80).toUpperCase().replace(/^\d+\s*[-.]?\s*/, '').replace(/[^A-Z0-9&]+/g, ' ').trim();
const ALIASES = { QUOTE: 'QUOTES', 'T M': 'T&M', TM: 'T&M', 'PRODUCT DATA': 'VENDOR DATA', 'T&M TAG': 'T&M TAGS', 'T M TAGS': 'T&M TAGS' };
const canonical = (name) => ALIASES[bare(name)] || bare(name);

export const packageType = (category) => (category === 'COR' ? 'cor' : category === 'Submittal' ? 'submittal' : null);

export function stageFor(type, hay) {
  const hit = [...STAGES[type]].reverse().find(([, , re]) => re.test(hay));
  return hit ? hit[0] : null;
}

export const coPart = (hay) => CO_PARTS.find(([, , re]) => re.test(hay)) || null;

export const corNumber = (n) => (/^\d+$/.test(String(n)) ? String(Number(n)).padStart(3, '0') : cleanName(n, 20).toUpperCase());
export const specKey = (t) => String(t || '').match(/\b(\d{2})\s?(\d{2})\s?(\d{2})\b/)?.slice(1).join(' ') || null;

export function packageName(type, { number, spec_section, title }) {
  const desc = titleCase(String(title || '').replace(/^(cor|pco|pci|co|change (order|request)|submittal|sub)\b[\s#:-]*\d*[\s:-]*/i, ''), 50);
  if (type === 'cor') return cleanName(`CO ${corNumber(number)}${desc ? ` - ${desc}` : ''}`, 80);
  return cleanName(`${specKey(spec_section) || specKey(title)}${desc ? ` ${desc.replace(/^\d{2} \d{2} \d{2}\s*/, '')}` : ''}`, 80);
}

// Does an existing folder belong to this CO number / spec section? Handles older names too
// ("COR 073", "Change Request 073", "CR 73", "PCO-073", "26 24 16 PANELBOARDS", "262416 Panelboards").
const coNumberOf = (name) => cleanName(name, 120).toUpperCase().match(/\b(?:COR|PCO|PCI|CR|CO|CHANGE (?:ORDER|REQUEST))\s*[#-]?\s*0*(\d+)\b/)?.[1] || null;
export function packageMatches(type, folderName, { number, spec_section }) {
  if (type === 'cor') {
    const n = coNumberOf(folderName);
    return Boolean(n && /^\d+$/.test(String(number || '')) && Number(n) === Number(number));
  }
  const key = specKey(spec_section);
  return Boolean(key && specKey(cleanName(folderName, 120)) === key);
}

const dirs = async (root, rel) => (await readdir(vaultPath(root, rel), { withFileTypes: true }).catch(() => []))
  .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
const exists = (root, rel) => stat(vaultPath(root, rel)).then(() => true, () => false);
const isReady = (name) => /^CO\s*\d+$/i.test(cleanName(name, 40)); // the empty "CO 074" waiting for the next change order

async function ensureSubfolders(root, folder, wanted) {
  for (const sub of wanted) {
    const [top, inner] = sub.split('/');
    const have = await dirs(root, folder);
    const topName = have.find((d) => canonical(d) === canonical(top)) || top;
    if (!have.includes(topName)) await mkdir(vaultPath(root, folder, topName), { recursive: true });
    if (inner && !(await dirs(root, `${folder}/${topName}`)).some((d) => canonical(d) === canonical(inner))) {
      await mkdir(vaultPath(root, folder, topName, inner), { recursive: true });
    }
  }
}

// Every CO folder for any number, wherever it sits: [{ path, name, where: 'root' | stage folder | 'legacy' }].
async function coFolders(root, base, legacy) {
  const out = (await dirs(root, base)).filter((d) => !STAGE_FOLDERS.includes(d) && d !== CO_LOG_DIR && !d.startsWith('_'))
    .map((name) => ({ name, path: `${base}/${name}`, where: 'root' }));
  for (const sf of STAGE_FOLDERS) {
    for (const name of await dirs(root, `${base}/${sf}`)) if (!name.startsWith('_')) out.push({ name, path: `${base}/${sf}/${name}`, where: sf });
  }
  for (const name of await dirs(root, legacy)) out.push({ name, path: `${legacy}/${name}`, where: 'legacy' });
  return out;
}

// Keep the next CO number's empty folder ready in 04 CHANGE ORDERS (outside the stage folders).
export async function ensureReadyFolder(root, jobBase) {
  const base = `${jobBase}/${COR_DIR}`;
  const all = await coFolders(root, base, `${jobBase}/${LEGACY_COR_DIR}`);
  const numbers = all.map((f) => coNumberOf(f.name)).filter(Boolean).map(Number);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const name = `CO ${String(next).padStart(3, '0')}`;
  if (!all.some((f) => packageMatches('cor', f.name, { number: next }))) {
    await mkdir(vaultPath(root, base, name), { recursive: true });
    await ensureSubfolders(root, `${base}/${name}`, CO_SUBFOLDERS);
  }
  return `${base}/${name}`;
}

// The change orders folder of a job: stage folders, the CO LOG folder and the next ready CO folder.
export async function ensureChangeOrders(root, jobBase) {
  for (const sf of [...STAGE_FOLDERS, CO_LOG_DIR]) await mkdir(vaultPath(root, jobBase, COR_DIR, sf), { recursive: true });
  return ensureReadyFolder(root, jobBase);
}

// Find or create the package folder. Returns the package folder (relative to the vault).
// A CO goes in the stage folder for `stage`; the ready "CO 073" folder is renamed and moved there once it gets its
// first document, and the next number's ready folder is created.
export async function ensurePackage(root, jobBase, type, info, stage = null) {
  if (type === 'submittal') {
    const base = `${jobBase}/${SUB_DIR}`;
    const existing = (await dirs(root, base)).find((d) => packageMatches(type, d, info));
    const folder = `${base}/${existing || packageName(type, info)}`;
    const have = await dirs(root, folder);
    for (const s of stageNames(type)) {
      if (!have.some((d) => canonical(d) === canonical(s))) await mkdir(vaultPath(root, folder, s), { recursive: true });
    }
    return folder;
  }
  const base = `${jobBase}/${COR_DIR}`;
  for (const sf of [...STAGE_FOLDERS, CO_LOG_DIR]) await mkdir(vaultPath(root, base, sf), { recursive: true });
  const found = (await coFolders(root, base, `${jobBase}/${LEGACY_COR_DIR}`)).filter((f) => packageMatches('cor', f.name, info));
  // Prefer a filed CO folder over the empty ready one.
  const pick = found.find((f) => f.where !== 'root') || found.find((f) => !isReady(f.name)) || found[0];
  let folder;
  if (pick && pick.where !== 'root') {
    folder = pick.path;
  } else {
    const name = pick && !isReady(pick.name) ? pick.name : packageName('cor', info);
    folder = `${base}/${stageFolderName(stage || 'PENDING')}/${name}`;
    if (pick && !(await exists(root, folder))) await rename(vaultPath(root, pick.path), vaultPath(root, folder));
    else await mkdir(vaultPath(root, folder), { recursive: true });
  }
  await ensureSubfolders(root, folder, CO_SUBFOLDERS);
  await ensureReadyFolder(root, jobBase);
  return folder;
}

// Where a document goes inside its package: a CO part subfolder (and the quote's company folder when one already
// exists), or a submittal stage folder.
export async function partFolder(root, folder, type, { stage, hay = '' } = {}) {
  if (type === 'submittal') return stageFolder(root, folder, stage);
  const part = coPart(hay);
  if (!part) return { folder, label: null };
  const [top, inner] = part[0].split('/');
  let out = `${folder}/${(await dirs(root, folder)).find((d) => canonical(d) === canonical(top)) || top}`;
  if (inner) {
    out += `/${(await dirs(root, out)).find((d) => canonical(d) === canonical(inner)) || inner}`;
    const words = new Set(cleanName(hay, 300).toUpperCase().split(/[^A-Z0-9&]+/).filter((w) => w.length >= 3));
    const company = (await dirs(root, out)).find((d) => cleanName(d, 80).toUpperCase().split(/[^A-Z0-9&]+/).filter((w) => w.length >= 3).some((w) => words.has(w)));
    if (company) out += `/${company}`;
  }
  return { folder: out, label: part[1] };
}

export async function stageFolder(root, folder, stage) {
  if (!stage) return { folder, label: null };
  const match = (await dirs(root, folder)).find((d) => canonical(d) === canonical(stage));
  return { folder: `${folder}/${match || stage}`, label: null };
}

// Move a CO folder to the stage folder for its stage. Never overwrites; legacy folders stay where they are.
export async function moveCoFolder(root, folder, stage) {
  const m = String(folder || '').match(/^(.*\/04 CHANGE ORDERS)\/([^/]+)\/([^/]+)$/);
  const target = stageFolderName(stage);
  if (!m || m[2] === target || !STAGE_FOLDERS.includes(m[2])) return { folder, moved: false };
  const to = `${m[1]}/${target}/${m[3]}`;
  if (await exists(root, to)) return { folder, moved: false, conflict: to };
  await mkdir(vaultPath(root, m[1], target), { recursive: true });
  await rename(vaultPath(root, folder), vaultPath(root, to));
  return { folder: to, moved: true };
}

// The reminder file that keeps nagging until the real Job Control Workbook (.xlsm) is updated by hand.
export const WORKBOOK_FILE = () => `${projectsDir() ? `${projectsDir()}/` : ''}Zordon/_PENDING WORKBOOK UPDATES.txt`;
const WORKBOOK_HEADER = `GEC2 PENDING WORKBOOK UPDATES
Each line is a change order status change that still needs to be entered in the job's GEC2 Job Control Workbook (.xlsm).
Format: OPEN | date | job | CO ### | new status | description
When the workbook is updated, change OPEN to DONE, add "resolved YYYY-MM-DD" and move the line under ---- DONE ----.

---- OPEN ----
`;
export async function noteWorkbookUpdate(root, { job, number, stage, title }, today = isoDate()) {
  const rel = WORKBOOK_FILE();
  const line = `OPEN | ${today} | ${job} | CO ${number} | ${stage} | ${title}\n`;
  const current = await readFile(vaultPath(root, rel), 'utf8').catch(() => null);
  if (current?.includes(`| ${job} | CO ${number} | ${stage} |`)) return rel;
  await mkdir(vaultPath(root, rel, '..'), { recursive: true });
  if (current === null) await appendFile(vaultPath(root, rel), `${WORKBOOK_HEADER}${line}---- DONE ----\n`);
  else if (current.includes('---- DONE ----')) {
    await writeFile(vaultPath(root, rel), current.replace('---- DONE ----', `${line}---- DONE ----`));
  } else await appendFile(vaultPath(root, rel), line);
  return rel;
}

// ---------- Tracking ----------
const row = (db, id) => db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
  LEFT JOIN projects p ON p.id = k.project_id WHERE k.id = ?`).get(id);

export function listPackages(db, { type, project_id, open } = {}) {
  let rows = db.prepare(`SELECT k.*, p.name AS project_name, p.code AS project_code FROM packages k
    LEFT JOIN projects p ON p.id = k.project_id ORDER BY k.updated_at DESC, k.id DESC`).all();
  if (type) rows = rows.filter((r) => r.type === type);
  if (project_id) rows = rows.filter((r) => r.project_id === Number(project_id));
  if (open) rows = rows.filter((r) => !CLOSED_STAGES[r.type].includes(r.stage));
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
  // The first document names the package; later documents (quotes, letters) don't rename it.
  db.prepare("UPDATE packages SET folder = COALESCE(?, folder), title = CASE WHEN title = '' THEN COALESCE(?, title) ELSE title END, amount = COALESCE(?, amount), updated_at = ? WHERE id = ?")
    .run(folder || null, title ? titleCase(title, 120) : null, amount ?? null, today, prev.id);
  return row(db, prev.id);
}

// Move a package to a stage (never backwards when it comes from filing; the user can set any stage by hand)
// and put the next step on the PM's list. `addTask` is the server's createTask so money rules apply.
// `initial` puts the first stage's next step on the list for a package that was just created.
export function setStage(db, id, stage, { force = false, initial = false, today = isoDate(), me = null, addTask = null } = {}) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(id);
  if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
  const names = stageNames(pkg.type);
  if (!names.includes(stage)) throw Object.assign(new Error(`Stage must be one of: ${names.join(', ')}`), { status: 400 });
  const same = stage === pkg.stage;
  if ((same && !initial) || (!force && names.indexOf(stage) < names.indexOf(pkg.stage))) return { package: row(db, id), task_id: null, changed: false };
  if (same && db.prepare("SELECT 1 FROM tasks WHERE source = 'package' AND source_ref = ?").get(id)) return { package: row(db, id), task_id: null, changed: false };
  if (!same) {
    const history = [...JSON.parse(pkg.history || '[]'), { stage, date: today }];
    db.prepare('UPDATE packages SET stage = ?, history = ?, updated_at = ? WHERE id = ?').run(stage, JSON.stringify(history), today, id);
    // The previous next-step is finished by reaching a new stage.
    db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE source = 'package' AND source_ref = ? AND status != 'done'").run(today, id);
  }
  const step = NEXT_STEP[pkg.type][stage];
  let task_id = null;
  if (step && addTask) {
    const label = pkg.type === 'cor' ? `CO ${pkg.number}` : `Submittal ${pkg.spec_section || ''}`.trim();
    task_id = addTask({
      project_id: pkg.project_id, owner_id: me, title: `${step[0]} ${label} - ${pkg.title}`.slice(0, 200),
      description: `Package folder: ${pkg.folder}\nStage: ${stage}`, priority: step[2], due_date: addDays(today, step[1]),
      status: 'not_started', source: 'package', source_ref: id, estimate_hours: 1,
    });
  }
  return { package: row(db, id), task_id, changed: !same };
}

// Stage change plus what it means on OneDrive for a change order: the CO folder moves to its stage folder, and a
// status the GC decided (submitted, approved, rejected/void) goes on the workbook reminder list and on your board.
export async function applyStage(db, root, id, stage, opts = {}) {
  const res = setStage(db, id, stage, opts);
  const pkg = res.package;
  if (!res.changed || pkg.type !== 'cor' || !root) return res;
  const today = opts.today || isoDate();
  if (pkg.folder) {
    const moved = await moveCoFolder(root, pkg.folder, stage).catch((err) => ({ folder: pkg.folder, error: err.message }));
    if (moved.folder !== pkg.folder) {
      db.prepare('UPDATE packages SET folder = ? WHERE id = ?').run(moved.folder, id);
      db.prepare('UPDATE documents SET path = ? || substr(path, ?) WHERE path LIKE ?').run(moved.folder, pkg.folder.length + 1, `${pkg.folder}/%`);
    }
    res.move = moved;
  }
  if (['SUBMITTED', 'APPROVED', 'REJECTED-VOID'].includes(stage)) {
    const job = pkg.project_code || pkg.project_name || '';
    res.workbook = await noteWorkbookUpdate(root, { job, number: pkg.number, stage, title: pkg.title }, today).catch(() => null);
    if (opts.addTask) {
      opts.addTask({
        project_id: pkg.project_id, owner_id: opts.me ?? null, priority: 'medium', due_date: addDays(today, 2), status: 'not_started',
        title: `Update the Job Control Workbook: CO ${pkg.number} ${stage.toLowerCase()} - ${pkg.title}`.slice(0, 200),
        description: `Enter the new status in ${job}'s GEC2 Job Control Workbook (.xlsm), then mark the line DONE in ${WORKBOOK_FILE()}.`,
        source: 'workbook', source_ref: id, estimate_hours: 0.25,
      });
    }
  }
  return { ...res, package: row(db, id) };
}
