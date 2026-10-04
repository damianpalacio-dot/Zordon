// The GEC2 job template lives in OneDrive at "5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE". It is the source of truth
// for job folders: Zordon reads its tree and README, checks it for changes every few minutes, files documents by it,
// copies it for new jobs, and puts it in FILING.md so Claude (Cowork) follows the same structure.
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CATEGORY_FOLDERS, JOB_TEMPLATE, projectsDir, vaultPath } from './vault.js';

export const TEMPLATE_NAME = '0. JOB TEMPLATE - DO NOT DELETE';
export const templateDir = () => [projectsDir(), TEMPLATE_NAME].filter(Boolean).join('/');
const README_RE = /^readme/i;
const SKIP_RE = /^(\.|~\$|desktop\.ini$|thumbs\.db$)/i;

// Where each kind of document goes, found by folder name so renumbering or renaming in the template carries over.
// Checked against folder names (not paths); the shallowest match wins.
const ROLES = {
  COR: /CHANGE ORDERS?$/i,
  'Pay App': /PAYMENT APPLICATIONS|PAY APPS?\b|BILLING/i,
  Contract: /CONTRACT DOCUMENTS|^\d*\s*CONTRACTS?$/i,
  Proposal: /ORIGINAL ESTIMATE|ESTIMATES?$/i,
  'Purchase Order': /PURCHASE ORDERS?$|SUBCONTRACTS?$/i,
  RFI: /^\d*\s*RFIS?\b/i,
  Submittal: /SUBMITTALS?$/i,
  'Design Change': /DESIGN CHANGES?|BULLETINS?$/i,
  Procurement: /PROCUREMENT/i,
  Schedule: /^\d*\s*SCHEDULES?$/i,
  Specification: /SPECIFICATIONS?$|^\d*\s*SPECS$/i,
  BIM: /^\d+\s+BIM$/i,
  Drawing: /CONSTRUCTION SET|DRAWINGS$/i,
  Closeout: /CLOSE-?OUTS?$/i,
  Safety: /^\d+\s+SAFETY$/i,
  Photo: /PHOTOS?$/i,
  Inspection: /CORRESPONDENCE$/i,
  'Meeting Minutes': /CORRESPONDENCE$/i,
  'Daily Report': /CORRESPONDENCE$/i,
  Correspondence: /CORRESPONDENCE$/i,
};

// Current template, kept in memory. `tree` holds relative paths ("01 COST CONTROL/04 CHANGE ORDERS").
export const template = {
  found: false, path: null, tree: [], dirs: [], files: [], readme: '', signature: null, checked_at: null,
  co: null, // { base, stages: [{ name, key }], folderTemplate, subfolders }
};

async function walk(root, rel = '', depth = 0, out = []) {
  if (depth > 7) return out;
  for (const e of await readdir(vaultPath(root, templateDir(), rel || '.'), { withFileTypes: true }).catch(() => [])) {
    if (SKIP_RE.test(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { out.push({ path: p, dir: true }); await walk(root, p, depth + 1, out); } else out.push({ path: p, dir: false });
  }
  return out;
}

// "1 PENDING (not yet submitted to GC)": the words in parentheses describe the stage, they don't name it.
const STAGE_KEY = (folder) => {
  const name = folder.replace(/\(.*?\)/g, '');
  return /REJECT|VOID/i.test(name) ? 'REJECTED' : /APPROV/i.test(name) ? 'APPROVED' : /SUBMIT/i.test(name) ? 'SUBMITTED' : /PENDING/i.test(name) ? 'PENDING' : null;
};
export const DEFAULT_CO = {
  base: '01 COST CONTROL/04 CHANGE ORDERS',
  stages: ['1 PENDING (not yet submitted to GC)', '2 SUBMITTED (awaiting GC-owner approval)', '3 APPROVED', '4 REJECTED-VOID'].map((name) => ({ name, key: STAGE_KEY(name) })),
  folderTemplate: null,
  subfolders: ['01 PRICING - BACKUP', '02 RFP-RFI REFERENCE', '03 T&M TAGS', '04 APPROVED CO DOCUMENTATION'],
};

// Read the template and update Zordon's folder map. Returns { changed, added, removed }.
export async function loadTemplate(root) {
  template.checked_at = new Date().toISOString();
  const info = await stat(vaultPath(root, templateDir())).catch(() => null);
  if (!info?.isDirectory()) { template.found = false; return { changed: false, added: [], removed: [] }; }
  const tree = await walk(root);
  const signature = createHash('sha1').update(tree.map((t) => `${t.dir ? 'd' : 'f'}:${t.path}`).sort().join('\n')).digest('hex');
  const before = new Set(template.tree.map((t) => t.path));
  const after = new Set(tree.map((t) => t.path));
  const changed = template.signature !== null && template.signature !== signature;
  Object.assign(template, {
    found: true, path: templateDir(), tree, signature,
    dirs: tree.filter((t) => t.dir).map((t) => t.path), files: tree.filter((t) => !t.dir).map((t) => t.path),
  });
  const readme = tree.find((t) => !t.dir && !t.path.includes('/') && README_RE.test(t.path));
  template.readme = readme ? (await readFile(vaultPath(root, templateDir(), readme.path), 'utf8').catch(() => '')).slice(0, 40_000) : '';
  applyTemplate();
  return { changed, added: [...after].filter((p) => !before.has(p)), removed: [...before].filter((p) => !after.has(p)) };
}

// Point Zordon's folder map at the template's folders.
function applyTemplate() {
  const top = template.dirs.filter((d) => !d.includes('/'));
  if (top.length) JOB_TEMPLATE.splice(0, JOB_TEMPLATE.length, ...top.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  const byDepth = [...template.dirs].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const [category, re] of Object.entries(ROLES)) {
    const hit = byDepth.find((d) => re.test(d.split('/').pop()) && !/_.*TEMPLATE|DUPLICATE ME/i.test(d));
    if (hit) CATEGORY_FOLDERS[category] = hit;
  }
  // Change orders: stage folders ("1 PENDING …") and the CO folder template to duplicate.
  const base = CATEGORY_FOLDERS.COR;
  const stages = template.dirs.filter((d) => d.startsWith(`${base}/`) && d.split('/').length === base.split('/').length + 1)
    .map((d) => d.split('/').pop()).filter((n) => STAGE_KEY(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const folderTemplate = template.dirs.find((d) => d.startsWith(`${base}/`) && /DUPLICATE ME|_CO FOLDER TEMPLATE/i.test(d.split('/').pop())) || null;
  const subfolders = folderTemplate ? template.dirs.filter((d) => d.startsWith(`${folderTemplate}/`) && d.split('/').length === folderTemplate.split('/').length + 1).map((d) => d.split('/').pop()) : [];
  template.co = {
    base,
    stages: stages.length ? stages.map((name) => ({ name, key: STAGE_KEY(name) })) : DEFAULT_CO.stages,
    folderTemplate,
    subfolders: subfolders.length ? subfolders.sort() : DEFAULT_CO.subfolders,
  };
}

export const coLayout = () => template.co || DEFAULT_CO;

// Copy the template (or one folder of it) into a job without ever overwriting. `foldersOnly` adds missing folders
// to existing jobs without dropping the template's blank forms into them. Returns how many items were created.
export async function copyTemplate(root, destRel, { from = '', foldersOnly = false } = {}) {
  if (!template.found) return 0;
  let created = 0;
  const prefix = from ? `${from}/` : '';
  for (const t of template.tree) {
    if (from && t.path !== from && !t.path.startsWith(prefix)) continue;
    const rel = from ? t.path.slice(from.length).replace(/^\//, '') : t.path;
    if (!rel || (!t.dir && (foldersOnly || (!rel.includes('/') && README_RE.test(rel))))) continue;
    // A new job's CO folders start empty; the "duplicate me" folder stays in the template only.
    if (!from && /DUPLICATE ME/i.test(t.path)) continue;
    const target = vaultPath(root, destRel, rel);
    if (await stat(target).then(() => true, () => false)) continue;
    if (t.dir) await mkdir(target, { recursive: true });
    else { await mkdir(join(target, '..'), { recursive: true }); await copyFile(vaultPath(root, templateDir(), t.path), target); }
    created++;
  }
  return created;
}

// A readable tree for FILING.md (folders only, two spaces per level).
export function templateOutline(maxDepth = 5) {
  return template.dirs.filter((d) => d.split('/').length <= maxDepth)
    .map((d) => `${'  '.repeat(d.split('/').length - 1)}- ${d.split('/').pop()}`).join('\n');
}
