// Browse the GEC2 OneDrive from Zordon: list job folders and open files on this computer.
// Read-only: nothing here renames, moves or deletes anything.
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { CONTROL_DIR, projectsDir } from './vault.js';

const HIDDEN = /^(\.|~\$|desktop\.ini$|thumbs\.db$)/i;

// Resolve a vault-relative path, refusing anything that climbs out of the vault.
export function safePath(root, rel = '') {
  const base = resolve(root);
  const full = resolve(base, String(rel).replace(/^[\\/]+/, ''));
  if (full !== base && !full.startsWith(base + sep)) throw Object.assign(new Error('Path is outside your OneDrive'), { status: 400 });
  return full;
}

export async function oneDriveStatus(root) {
  const has = (...p) => stat(join(root, ...p)).then(() => true, () => false);
  const connected = Boolean(root) && await has('.');
  const jobs = connected ? (await readdir(join(root, projectsDir() || '.'), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !HIDDEN.test(e.name)).length : 0;
  return {
    connected,
    root,
    projects_dir: projectsDir(),
    has_projects: connected && await has(projectsDir() || '.'),
    has_roster: connected && await has(CONTROL_DIR, 'zordon-roster.json'),
    job_folders: jobs,
  };
}

export async function listFolder(root, rel = '') {
  const full = safePath(root, rel);
  const entries = await readdir(full, { withFileTypes: true });
  const items = await Promise.all(entries.filter((e) => !HIDDEN.test(e.name)).map(async (e) => {
    // stat on OneDrive placeholders is cheap; it never downloads the file.
    const s = await stat(join(full, e.name)).catch(() => null);
    return { name: e.name, dir: e.isDirectory(), size: s?.size ?? null, modified: s ? s.mtime.toISOString().slice(0, 10) : null,
      path: [String(rel).replace(/^[\\/]+|[\\/]+$/g, ''), e.name].filter(Boolean).join('/') };
  }));
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: String(rel).replace(/^[\\/]+|[\\/]+$/g, ''), items };
}

// Open a file with its usual app, or a folder in File Explorer / Finder.
export function openOnComputer(root, rel) {
  const full = safePath(root, rel);
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [full]]
    : process.platform === 'darwin' ? ['open', [full]] : ['xdg-open', [full]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return { opened: full };
}
