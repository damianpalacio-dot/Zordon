// Document Vault: files every document the GEC2 way, into the same OneDrive folders the team already uses.
//   5. PROJECTS/<Job #>/<NN FOLDER>/<Job #>_<SHORT NAME> - <TYPE> - <Description> (MM.DD.YYYY).<ext>
//   e.g. 5. PROJECTS/G2707/07 RFIS/G2707_BURB RPT - RFI - Beam Penetration At C4 (10.03.2026).pdf
// ZORDON_VAULT points at the OneDrive root; Zordon's own files live in <root>/Zordon.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isoDate } from './db.js';
import { aiEnabled } from './intel.js';

// GEC2 Job Start-Up folder template (OneDrive "_ _ JOB START_UP FOLDER").
export const JOB_TEMPLATE = [
  '01 COST CONTROL', '02 BIM', '03 CONSTRUCTION SET', '04 DESIGN CHANGES', '05 SPECIFICATIONS', '06 SCHEDULE', '07 RFIS',
  '08 JOB SITE PHOTOS', '09 PROCUREMENT LOG', '10 CORRESPONDENCE', '11 CLOSEOUTS', '12 TEMPLATES', '13 SAFETY', '14 SUBMITTALS', '15 PREFAB',
];

// Document types, checked in order: [category, pattern, label used in the file name, template folder].
const TYPES = [
  ['RFI', /\brfis?\b|request for information/i, 'RFI', '07 RFIS'],
  ['COR', /change order|\bcor\b|\bpcos?\b|\bpci\b|\bco\s?#?\d|change request|\brfc\b|t&m|time and material|pricing/i, 'COR', '01 COST CONTROL'],
  ['Pay App', /pay ?app|payment application|billing|invoice|\bsov\b|schedule of values|g70[23]|lien waiver|retention|retainage/i, 'PAY APP', '01 COST CONTROL'],
  ['Submittal', /submittal|shop drawing|product data|cut sheet|\bsub[- ]?\d/i, 'SUBMITTAL', '14 SUBMITTALS'],
  ['Design Change', /bulletin|\basi\b|\bccd\b|\bdcn\b|design change|ifc set change|revision \d|addend/i, 'DESIGN CHANGE', '04 DESIGN CHANGES'],
  ['Procurement', /purchase order|\bpo\s?#|\bmrf\b|material request|\bquote\b|quotation|release letter|delivery ticket|packing slip|\bbom\b/i, 'PROCUREMENT', '09 PROCUREMENT LOG'],
  ['Contract', /subcontract|contract|agreement|exhibit [a-z]\b|scope of work|\bsow\b|insurance cert|\bcoi\b|bond/i, 'CONTRACT', '01 COST CONTROL'],
  ['Proposal', /proposal|estimate|\bbid\b|takeoff|take-off/i, 'PROPOSAL', '01 COST CONTROL'],
  ['Schedule', /schedule|look-?ahead|gantt|\bcpm\b|milestone|\bp6\b/i, 'SCHEDULE', '06 SCHEDULE'],
  ['Specification', /specification|\bspecs?\b|section \d{2}\s?\d{2}/i, 'SPEC', '05 SPECIFICATIONS'],
  ['BIM', /\bbim\b|revit|navisworks|clash|\.(rvt|nwd|nwc|ifc)$/i, 'BIM', '02 BIM'],
  ['Drawing', /drawing|\bdwg\b|\bplans?\b|sheet [a-z]+-?\d|single.?line|\bsld\b|elevation|layout|\.(dwg|dxf)$/i, 'DWG', '03 CONSTRUCTION SET'],
  ['Closeout', /closeout|close-out|o&m|operation and maintenance|as-?built|warranty|attic stock|training/i, 'CLOSEOUT', '11 CLOSEOUTS'],
  ['Safety', /safety|\bjha\b|\bjsa\b|toolbox|incident|osha|\bppe\b|energy control|lockout/i, 'SAFETY', '13 SAFETY'],
  ['Prefab', /prefab|pre-fab|assembly drawing|kitting/i, 'PREFAB', '15 PREFAB'],
  ['Photo', /\.(jpe?g|png|heic|webp)$|photo|picture/i, 'PHOTO', '08 JOB SITE PHOTOS'],
  ['Inspection', /inspection|permit|test report|\bneta\b|punch ?list|certificate/i, 'INSPECTION', '10 CORRESPONDENCE'],
  ['Meeting Minutes', /minutes|meeting notes|\boac\b|agenda/i, 'MINUTES', '10 CORRESPONDENCE'],
  ['Daily Report', /daily (report|log)|dailies|field report|manpower/i, 'DAILY', '10 CORRESPONDENCE'],
  ['Correspondence', /letter|memo|email|notice|correspondence/i, 'LETTER', '10 CORRESPONDENCE'],
];
export const CATEGORIES = Object.fromEntries(TYPES.map(([c, re]) => [c, re]));
export const CATEGORY_NAMES = [...TYPES.map(([c]) => c), 'General'];
export const CATEGORY_FOLDERS = { ...Object.fromEntries(TYPES.map(([c, , , f]) => [c, f])), General: '' };
const TYPE_LABEL = { ...Object.fromEntries(TYPES.map(([c, , l]) => [c, l])), General: 'DOC' };

export const CONTROL_DIR = 'Zordon';
export const INBOX = `${CONTROL_DIR}/_Inbox`;
export const UNFILED = `${CONTROL_DIR}/_Unfiled`;
export const projectsDir = () => process.env.ZORDON_PROJECTS_DIR ?? '5. PROJECTS';

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.eml', '.html', '.htm', '.json', '.xml', '.log']);
const RANDOM_NAME_RE = /^(scan|img|image|dsc|document|doc|untitled|new|file|copy|download|final|draft|asdf|test|temp|screenshot|book)?[\s_-]*\(?\d*\)?$/i;
const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

// Safe on Windows and OneDrive: no \ / : * ? " < > | # %, no trailing dots or spaces.
export function cleanName(text, max = 80) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/[_\s]+/g, ' ').trim().slice(0, max).replace(/[ .]+$/, '');
}

// "beam penetration at c4" → "Beam Penetration at C4"; keeps acronyms and numbers as written.
export function titleCase(text, max = 70) {
  return cleanName(text, max).split(' ').filter(Boolean).map((w, i) => {
    if (/[A-Z].*[A-Z]|\d/.test(w)) return w;
    const lower = w.toLowerCase();
    return i > 0 && SMALL.has(lower) ? lower : lower[0].toUpperCase() + lower.slice(1);
  }).join(' ');
}

// Kept for older callers: hyphenated title-case slug.
export const slug = (text, max = 60) => titleCase(String(text || '').replace(/[^\w\s-]+/g, ' '), max).split(/[\s-]+/).filter(Boolean).join('-');

export function shortName(project) {
  if (!project) return '';
  if (project.short_name) return cleanName(project.short_name, 24).toUpperCase();
  const words = cleanName(project.name, 60).toUpperCase().split(' ').filter((w) => !['THE', 'OF', 'AND', '-', '/'].includes(w));
  return words.slice(0, 3).join(' ');
}

export function projectFolder(project) {
  if (!project) return UNFILED;
  // A job whose folder isn't named after its number (e.g. "5. PROJECTS/LAUSD 32ND ST").
  if (project.folder) return String(project.folder).replace(/^\/+|\/+$/g, '');
  const job = cleanName(project.code || project.name || `Project ${project.id}`, 40);
  return projectsDir() ? `${projectsDir()}/${job}` : job;
}

// ---------- Finding a job's existing folder ----------
const STOP = new Set(['THE', 'OF', 'AND', 'A', 'AT', 'FOR', 'TO', 'IN', 'PROJECT', 'JOB', 'NEW']);
const tokens = (t) => cleanName(t, 200).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

// Score how well a folder name fits a job: number first, then the job's name.
export function folderScore(folderName, project) {
  const code = String(project.code || '').toUpperCase().trim();
  const f = cleanName(folderName, 200).toUpperCase();
  if (code && f === code) return 100;
  if (code && f.startsWith(code) && /^[\s\-_.]/.test(f.slice(code.length) || ' ')) return 90; // "G2379 - LGB ATCT"
  if (code && tokens(f).includes(code)) return 80;
  if (/^G\d{4}\b/.test(f)) return 0; // another job's number
  const ft = tokens(f);
  const pt = new Set([...tokens(project.name), ...tokens(project.short_name)]);
  if (!ft.length || !pt.size) return 0;
  const shared = ft.filter((w) => pt.has(w)).length;
  const ratio = shared / ft.length;
  // "LAUSD 32ND ST" fits "LAUSD 32nd St / USC Magnet": most of the folder's words belong to the job.
  return shared >= 2 && ratio >= 0.6 ? Math.round(50 + ratio * 20) : 0;
}

// Pick the best existing folder for a job: inside the projects folder first, then the OneDrive root.
export async function findJobFolder(root, project) {
  const places = [projectsDir(), ''].filter((p, i, a) => a.indexOf(p) === i);
  let best = null;
  for (const [rank, place] of places.entries()) {
    const entries = await readdir(vaultPath(root, place || '.'), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === CONTROL_DIR) continue;
      const score = folderScore(e.name, project) - rank; // prefer the projects folder on ties
      if (score > 0 && (!best || score > best.score)) best = { score, path: place ? `${place}/${e.name}` : e.name };
    }
  }
  return best?.path || null;
}

// ---------- Picking the folder that best describes a document ----------
// Words too common to decide a folder on their own.
const GENERIC = new Set(['GEC2', 'ELECTRICAL', 'ELEC', 'SUB', 'SUBMITTAL', 'SUBMITTALS', 'RFI', 'RFIS', 'DRAWING', 'DRAWINGS', 'DWG',
  'PDF', 'REV', 'REVISION', 'COPY', 'FINAL', 'DRAFT', 'NEW', 'OLD', 'FILES', 'DOCS', 'DOCUMENTS', 'MISC', 'GENERAL', 'LEVEL', 'SET']);
const specKeys = (t) => [...String(t).matchAll(/\b(\d{2})\s?(\d{2})\s?(\d{2})\b/g)].map((m) => m.slice(1).join(''));

export function subfolderScore(folderName, hay) {
  const ht = new Set(tokens(hay));
  const strong = tokens(folderName).filter((w) => !GENERIC.has(w) && (w.length >= 4 || /^[A-Z]{3}$/.test(w)) && ht.has(w));
  const specs = specKeys(folderName).filter((k) => specKeys(hay).includes(k));
  return strong.length + specs.length * 3;
}

// Within a job folder, prefer one of the team's own subfolders (ERCCS, IFC SET CHANGES, EXISTING PANELS…)
// when the document clearly belongs there; then look one level down inside the chosen folder
// (e.g. 14 SUBMITTALS/26 24 16 PANELBOARDS). Ties or weak matches keep the standard folder.
export async function refineFolder(root, folder, jobBase, hay) {
  const best = async (base, skip = new Set()) => {
    const dirs = (await readdir(vaultPath(root, base), { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !skip.has(d.name.toUpperCase()));
    const scored = dirs.map((d) => ({ name: d.name, score: subfolderScore(d.name, hay) })).filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.length && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].name : null;
  };
  let out = folder;
  if (jobBase && folder.startsWith(jobBase)) {
    const custom = await best(jobBase, new Set(JOB_TEMPLATE.map((f) => f.toUpperCase())));
    if (custom) out = `${jobBase}/${custom}`;
  }
  const inner = await best(out);
  return inner ? `${out}/${inner}` : out;
}

export const usDate = (iso) => { const [y, m, d] = iso.split('-'); return `${m}.${d}.${y}`; };

export function textSnippet(buffer, filename) {
  if (!buffer || !TEXT_EXT.has(extname(filename || '').toLowerCase())) return '';
  return buffer.subarray(0, 4000).toString('utf8');
}

export function suggestHeuristic({ filename = '', text = '', project_id, hint = '' }, { projects = [], today = isoDate() }) {
  const base = filename.replace(/\.[^.]+$/, '');
  const hay = `${hint}\n${base}\n${text}`;
  const project = projects.find((p) => p.id === Number(project_id))
    || projects.find((p) => (p.code && hay.toLowerCase().includes(p.code.toLowerCase())) || hay.toLowerCase().includes(p.name.toLowerCase()))
    || null;
  const category = TYPES.find(([, re]) => re.test(hay) || re.test(filename))?.[0] || 'General';

  // Prefer: the user's hint, then a meaningful filename, then the first meaningful line of text.
  const firstLine = text.split(/\r?\n/).map((l) => l.replace(/^(subject|re|fw|title)\s*:\s*/i, '').trim())
    .find((l) => l.length > 6 && l.length < 120 && /[a-z]/i.test(l)) || '';
  const meaningful = base && !RANDOM_NAME_RE.test(base.trim()) && /[a-z]{3,}/i.test(base) ? base : '';
  let title = hint || meaningful || firstLine || `${category} document`;
  return finalize({ title: title || category, category, project, ext: extname(filename).toLowerCase(), today });
}

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split "RFI 14 response beam at C4" into the document number and the description,
// dropping words already in the file name (job number, project name, short name, type).
export function describe(title, category, project) {
  let t = ` ${cleanName(title, 160)} `;
  for (const w of [project?.code, project?.name, project?.short_name, project && shortName(project)].filter(Boolean)) {
    t = t.replace(new RegExp(escapeRe(cleanName(w)), 'ig'), ' ');
  }
  t = t.replace(/^[\s\-–—_:]+/, '');
  const typeWords = [TYPE_LABEL[category], category, ...(category === 'COR' ? ['PCO', 'PCI', 'CO', 'Change Order'] : []), ...(category === 'Submittal' ? ['Sub'] : [])];
  t = t.replace(new RegExp(`^(${typeWords.map(escapeRe).join('|')})\\b[\\s:#-]*`, 'i'), '');
  let number = '';
  const m = t.match(/^#?\s*(\d[\w.]*(?:-\d[\w.]*)?)\b[\s:-]*/);
  if (m) { number = m[1]; t = t.slice(m[0].length); }
  t = t.replace(/\s+[-–—]\s+[-–—]\s+/g, ' - ').replace(/^[\s\-–—_:]+|[\s\-–—_:]+$/g, '');
  return { number, desc: titleCase(t) };
}

export function finalize({ title, category, project, ext, today }) {
  const { number, desc: d } = describe(title, category, project);
  const label = `${TYPE_LABEL[category] || 'DOC'}${number ? ` ${number}` : ''}`;
  const desc = d || titleCase(category);
  const date = usDate(today);
  const prefix = project ? `${cleanName(project.code || project.name, 40)}${shortName(project) ? `_${shortName(project)}` : ''} - ` : '';
  const sub = CATEGORY_FOLDERS[category] || '';
  const folder = project ? [projectFolder(project), sub].filter(Boolean).join('/') : UNFILED;
  return {
    title: `${label} - ${desc}`, // e.g. "RFI 14 - Beam at C4"; re-filing keeps the number
    category,
    project_id: project?.id ?? null,
    folder,
    filename: `${prefix}${label} - ${desc} (${date})${ext || ''}`,
  };
}

export async function suggestWithClaude(input, ctx) {
  const { z } = await import('zod');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { projects = [], today = isoDate() } = ctx;
  const Suggestion = z.object({
    title: z.string(),
    category: z.enum(CATEGORY_NAMES),
    project_id: z.number().int().nullable(),
  });
  const response = await new Anthropic().messages.parse({
    model: process.env.ZORDON_MODEL || 'claude-opus-5-5',
    max_tokens: 1000,
    output_config: { effort: 'low', format: zodOutputFormat(Suggestion) },
    system: 'You file documents for an electrical-focused construction project manager (panel schedules, single-lines, utility letters, arc-flash studies, gear submittals, fire alarm drawings, change orders, pay apps). Give a short, specific, descriptive title (3-8 words, no dates, no project code, no category word) that someone could recognise months later, pick the best category, and pick the project id from the list or null.',
    messages: [{
      role: 'user',
      content: `Projects:\n${projects.map((p) => `${p.id}: ${p.name}${p.code ? ` [${p.code}]` : ''}`).join('\n') || '(none)'}\n\nOriginal filename: ${input.filename || '(none)'}\nUser note: ${input.hint || '(none)'}\nPreferred project id: ${input.project_id ?? '(none)'}\n\nContent excerpt:\n${input.text ? input.text.slice(0, 4000) : '(binary or empty)'}`,
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`no suggestion (${response.stop_reason})`);
  const s = response.parsed_output;
  const project = projects.find((p) => p.id === Number(input.project_id)) || projects.find((p) => p.id === s.project_id) || null;
  return finalize({ title: s.title, category: s.category, project, ext: extname(input.filename || '').toLowerCase(), today });
}

export async function suggestName(input, ctx) {
  if (aiEnabled()) {
    try {
      return { analyzer: 'claude', ...(await suggestWithClaude(input, ctx)) };
    } catch (err) {
      console.warn(`[vault] Claude naming failed, using rules: ${err.message}`);
    }
  }
  return { analyzer: 'rules', ...suggestHeuristic(input, ctx) };
}

// Resolve a path inside the vault root, refusing anything that escapes it.
export function vaultPath(root, ...parts) {
  const full = resolve(root, ...parts);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new Error('Path escapes vault');
  return full;
}

export async function uniquePath(root, folder, filename, exists) {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? filename : `${stem} v${i}${ext}`;
    const rel = `${folder}/${name}`;
    if (!(await exists(vaultPath(root, rel)))) return rel;
  }
}

export async function saveFile(root, rel, buffer, { overwrite = false } = {}) {
  const full = vaultPath(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buffer, { flag: overwrite ? 'w' : 'wx' });
}

export async function moveFile(root, fromRel, toRel) {
  const to = vaultPath(root, toRel);
  await mkdir(dirname(to), { recursive: true });
  await rename(vaultPath(root, fromRel), to);
}

// Creates the GEC2 job start-up folders for a real job (only when asked; never for demo projects).
export async function ensureProjectFolders(root, project) {
  for (const folder of JOB_TEMPLATE) await mkdir(vaultPath(root, projectFolder(project), folder), { recursive: true });
  await mkdir(vaultPath(root, INBOX), { recursive: true });
}

export const isJobNumber = (code) => /^G\d{4}$/i.test(String(code || '').trim());

// Files dropped in _Inbox (by Claude, a scanner, "Save as…") that are done being written.
export async function inboxFiles(root, settleMs = 10_000) {
  const dir = vaultPath(root, INBOX);
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('~$') || /\.(tmp|part|crdownload)$/i.test(name)) continue;
    const info = await stat(vaultPath(root, INBOX, name)).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > settleMs) out.push({ name, rel: `${INBOX}/${name}`, size: info.size });
  }
  return out;
}

export const readVaultFile = (root, rel) => readFile(vaultPath(root, rel));

export async function deleteFile(root, rel) {
  await rm(vaultPath(root, rel), { force: true });
}


// Find the GEC2 OneDrive without the user typing a path. Tries ZORDON_VAULT (also with a stray "quotes" or trailing
// slash), Windows' own OneDrive variables, then every "OneDrive…" folder in the user's home folder.
// Prefers the one that holds Zordon/zordon-roster.json, then one with the projects folder.
export async function detectVault(env = process.env, home = homedir()) {
  const clean = (p) => String(p || '').trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
  const candidates = [clean(env.ZORDON_VAULT), clean(env.OneDriveCommercial), clean(env.OneDrive)];
  for (const e of await readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && /^onedrive/i.test(e.name)) candidates.push(join(home, e.name));
  }
  const unique = [...new Set(candidates.filter(Boolean))];
  const has = (dir, ...rel) => stat(join(dir, ...rel)).then(() => true, () => false);
  for (const dir of unique) if (await has(dir, CONTROL_DIR, 'zordon-roster.json')) return { path: dir, found: 'roster', tried: unique };
  for (const dir of unique) if (await has(dir, projectsDir() || '.')) return { path: dir, found: 'projects', tried: unique };
  return { path: clean(env.ZORDON_VAULT) || null, found: null, tried: unique };
}
