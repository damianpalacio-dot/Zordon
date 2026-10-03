// Document Vault: give every file a predictable name and home.
// Naming scheme: <CODE-Project-Name>/<NN-Category>/<YYYY-MM-DD>_<CODE>_<Category>_<Description>.<ext>
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { isoDate } from './db.js';
import { aiEnabled } from './intel.js';

export const CATEGORIES = {
  'RFI': /\brfi\b|request for information/i,
  'Submittal': /submittal|shop drawing|product data|cut sheet/i,
  'Change Order': /change order|\bco\s?#?\d|\bpco\b|\bcor\b|change request|pricing/i,
  'Meeting Minutes': /minutes|meeting notes|\boac\b|agenda|huddle/i,
  'Daily Report': /daily (report|log)|dailies|field report|manpower/i,
  'Schedule': /schedule|look-?ahead|gantt|\bcpm\b|milestone/i,
  'Drawing': /drawing|\bdwg\b|plans?\b|sheet [a-z]-?\d|elevation|section|layout/i,
  'Safety': /safety|jha|jsa|toolbox talk|incident|osha|ppe/i,
  'Contract': /contract|subcontract|agreement|scope of work|\bsow\b|proposal|bid/i,
  'Invoice': /invoice|pay app|payment application|billing|receipt|\bpo\b|purchase order/i,
  'Inspection': /inspection|permit|punch ?list|test report|certificate/i,
  'Photo': /\.(jpe?g|png|heic|webp)$|photo|picture/i,
  'Correspondence': /letter|memo|email|notice|correspondence/i,
};
export const CATEGORY_NAMES = [...Object.keys(CATEGORIES), 'General'];

// Every project gets the same numbered folder tree, so files are always in the same place.
export const CATEGORY_FOLDERS = {
  'Contract': '01-Contracts',
  'Change Order': '02-Change-Orders',
  'Invoice': '03-Billing',
  'RFI': '04-RFIs',
  'Submittal': '05-Submittals',
  'Drawing': '06-Drawings',
  'Schedule': '07-Schedule',
  'Meeting Minutes': '08-Meeting-Minutes',
  'Daily Report': '09-Daily-Reports',
  'Inspection': '10-Inspections-Permits',
  'Safety': '11-Safety',
  'Correspondence': '12-Correspondence',
  'Photo': '13-Photos',
  'General': '99-General',
};
export const INBOX = '_Inbox';
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.eml', '.html', '.htm', '.json', '.xml', '.log']);
const RANDOM_NAME_RE = /^(scan|img|image|dsc|document|doc|untitled|new|file|copy|download|final|draft|asdf|test|temp|screenshot)?[\s_-]*\(?\d*\)?$/i;

export function slug(text, max = 60) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, ' ').trim().split(/[\s_-]+/).filter(Boolean)
    .map((w) => (w.length > 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join('-').slice(0, max).replace(/-+$/, '');
}

export function projectFolder(project) {
  if (!project) return 'Unfiled';
  return slug([project.code, project.name].filter(Boolean).join(' '), 80) || `Project-${project.id}`;
}

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
  const category = Object.entries(CATEGORIES).find(([, re]) => re.test(hay) || re.test(filename))?.[0] || 'General';

  // Prefer: the user's hint, then a meaningful filename, then the first meaningful line of text.
  const firstLine = text.split(/\r?\n/).map((l) => l.replace(/^(subject|re|fw|title)\s*:\s*/i, '').trim())
    .find((l) => l.length > 6 && l.length < 120 && /[a-z]/i.test(l)) || '';
  const meaningful = base && !RANDOM_NAME_RE.test(base.trim()) && /[a-z]{3,}/i.test(base) ? base : '';
  let title = hint || meaningful || firstLine || `${category} document`;
  // Avoid repeating the category or project code in the descriptive part.
  title = title.replace(new RegExp(`\\b${category}\\b`, 'i'), '').replace(project?.code ? new RegExp(project.code, 'i') : /$^/, '');
  title = slug(title) || slug(category);
  return finalize({ title, category, project, ext: extname(filename).toLowerCase(), today });
}

export function finalize({ title, category, project, ext, today }) {
  const code = project?.code ? slug(project.code, 20) : project ? `P${project.id}` : 'GEN';
  const cat = slug(category, 30);
  const filename = `${today}_${code}_${cat}_${slug(title)}${ext || ''}`;
  return {
    title: slug(title).replace(/-/g, ' '),
    category,
    project_id: project?.id ?? null,
    folder: `${projectFolder(project)}/${CATEGORY_FOLDERS[category] || CATEGORY_FOLDERS.General}`,
    filename,
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
    const name = i === 1 ? filename : `${stem}_v${i}${ext}`;
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

export async function ensureProjectFolders(root, project) {
  for (const folder of [...new Set(Object.values(CATEGORY_FOLDERS))]) {
    await mkdir(vaultPath(root, projectFolder(project), folder), { recursive: true });
  }
  await mkdir(vaultPath(root, INBOX), { recursive: true });
}

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

