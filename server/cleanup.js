// Archive old files: move anything last saved before the cutoff into "_ARCHIVE pre-<year>/<same path>".
// Nothing is deleted. Every run writes a log so it can be undone with one click.
//   root      loose files directly in the OneDrive root
//   documents every old file under Documents/
//   projects  whole job folders in "5. PROJECTS" with no file saved since the cutoff (active jobs are never split up)
import { mkdir, readdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTROL_DIR, projectsDir, vaultPath } from './vault.js';

const NEVER = [/^zordon$/i, /^00 cowork claude$/i, /^_ _ job/i, /template/i, /^_archive/i, /^\./];
const SKIP_FILES = /^(desktop\.ini|thumbs\.db|\.ds_store|~\$.*)$/i;
const plans = new Map(); // plan id → plan (kept in memory until applied)

export const archiveDirName = (cutoff) => `_ARCHIVE pre-${cutoff.slice(0, 4)}`;
const protectedName = (name) => NEVER.some((re) => re.test(name));
const toRel = (root, full) => relative(root, full).split(sep).join('/');

async function walkFiles(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || SKIP_FILES.test(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, out);
    else if (e.isFile()) {
      const s = await stat(full).catch(() => null);
      if (s) out.push({ full, mtime: s.mtime, size: s.size });
    }
  }
  return out;
}

export async function scanOld(root, { areas = ['root', 'documents', 'projects'], cutoff = '2025-01-01' } = {}) {
  const limit = new Date(`${cutoff}T00:00:00`);
  const archive = archiveDirName(cutoff);
  const items = [];
  const add = (full, kind, size, mtime, area) => {
    const rel = toRel(root, full);
    items.push({ kind, area, from: rel, to: `${archive}/${rel}`, size, modified: mtime.toISOString().slice(0, 10) });
  };

  if (areas.includes('root')) {
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() || SKIP_FILES.test(e.name) || e.name.startsWith('.')) continue;
      const s = await stat(join(root, e.name)).catch(() => null);
      if (s && s.mtime < limit) add(join(root, e.name), 'file', s.size, s.mtime, 'root');
    }
  }
  if (areas.includes('documents')) {
    for (const f of await walkFiles(vaultPath(root, 'Documents'))) {
      const parts = toRel(root, f.full).split('/');
      if (parts.some(protectedName)) continue;
      if (f.mtime < limit) add(f.full, 'file', f.size, f.mtime, 'documents');
    }
  }
  if (areas.includes('projects')) {
    const pdir = vaultPath(root, projectsDir() || '.');
    for (const e of await readdir(pdir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || protectedName(e.name)) continue;
      const files = await walkFiles(join(pdir, e.name));
      const newest = files.reduce((m, f) => (f.mtime > m ? f.mtime : m), new Date(0));
      if (files.length && newest < limit) {
        add(join(pdir, e.name), 'folder', files.reduce((s, f) => s + f.size, 0), newest, 'projects');
      }
    }
  }
  const id = randomUUID();
  const summary = ['root', 'documents', 'projects'].map((area) => {
    const list = items.filter((i) => i.area === area);
    return { area, count: list.length, bytes: list.reduce((s, i) => s + i.size, 0) };
  });
  plans.set(id, { id, cutoff, archive, items, created: Date.now() });
  return { plan_id: id, cutoff, archive, summary, total: items.length, items };
}

async function freePath(root, rel) {
  let candidate = rel;
  for (let i = 2; await stat(vaultPath(root, candidate)).then(() => true, () => false); i++) {
    candidate = rel.replace(/(\.[^./]+)?$/, (ext) => ` (${i})${ext || ''}`);
  }
  return candidate;
}

export async function applyPlan(root, planId) {
  const plan = plans.get(planId);
  if (!plan) throw new Error('Plan expired — scan again');
  const moved = [];
  const failed = [];
  for (const item of plan.items) {
    try {
      const to = await freePath(root, item.to);
      await mkdir(dirname(vaultPath(root, to)), { recursive: true });
      await rename(vaultPath(root, item.from), vaultPath(root, to));
      moved.push({ from: item.from, to });
    } catch (err) {
      failed.push({ from: item.from, error: err.message });
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const log = `${CONTROL_DIR}/archive-logs/archive-${stamp}.json`;
  await mkdir(dirname(vaultPath(root, log)), { recursive: true });
  await writeFile(vaultPath(root, log), JSON.stringify({ cutoff: plan.cutoff, moved, failed }, null, 2));
  plans.delete(planId);
  return { moved: moved.length, failed, log };
}

export async function listArchiveLogs(root) {
  const dir = vaultPath(root, CONTROL_DIR, 'archive-logs');
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort().reverse();
  return names.map((n) => `${CONTROL_DIR}/archive-logs/${n}`);
}

// Put everything from one archive run back where it was.
export async function undoArchive(root, logRel) {
  if (!/^Zordon\/archive-logs\/archive-[\w-]+\.json$/.test(logRel)) throw new Error('Not an archive log');
  const log = JSON.parse(await readFile(vaultPath(root, logRel), 'utf8'));
  let restored = 0;
  const failed = [];
  for (const m of log.moved.slice().reverse()) {
    try {
      const back = await freePath(root, m.from);
      await mkdir(dirname(vaultPath(root, back)), { recursive: true });
      await rename(vaultPath(root, m.to), vaultPath(root, back));
      restored++;
    } catch (err) {
      failed.push({ from: m.to, error: err.message });
    }
  }
  await rename(vaultPath(root, logRel), vaultPath(root, logRel.replace(/\.json$/, '.undone.json')));
  return { restored, failed };
}
