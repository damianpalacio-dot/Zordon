// One board for every computer that runs Zordon: each task is a small JSON file in OneDrive
// (Zordon/board/<uid>.json). A computer writes the tasks it changed and reads the ones the others changed.
// The newest change wins, per task. Deleted tasks leave a short "deleted" note so the delete spreads too.
import { readdir, readFile, stat } from 'node:fs/promises';
import { saveFile, vaultPath } from './vault.js';

export const BOARD_DIR = 'Zordon/board'; // CONTROL_DIR + /board (spelled out: db.js loads this before vault.js finishes)
const UID_RE = /^[a-z0-9][a-z0-9-]{5,80}$/;
const FIELDS = ['title', 'description', 'status', 'priority', 'category', 'start_date', 'due_date', 'completed_at', 'estimate_hours', 'source'];
const seenBy = new WeakMap(); // per database: file name -> mtimeMs already read
const seenFor = (db) => { if (!seenBy.has(db)) seenBy.set(db, new Map()); return seenBy.get(db); };
export const syncStatus = { last_export: null, last_import: null, exported: 0, imported: 0, error: null };

// Triggers note every task change (and every new comment) so it can be written out. While Zordon applies a change
// that came from another computer, sync_state.applying = 1 keeps that change from being echoed back.
export function installBoardSync(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO sync_state (id, applying) VALUES (1, 0);
    UPDATE sync_state SET applying = 0;
    CREATE TABLE IF NOT EXISTS sync_dirty (uid TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_uid ON tasks(uid);
    UPDATE tasks SET uid = lower(hex(randomblob(12))) WHERE uid IS NULL;
    CREATE TRIGGER IF NOT EXISTS tasks_uid AFTER INSERT ON tasks WHEN NEW.uid IS NULL
      BEGIN UPDATE tasks SET uid = lower(hex(randomblob(12))) WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS tasks_dirty_ins AFTER INSERT ON tasks WHEN (SELECT applying FROM sync_state) = 0
      BEGIN INSERT OR REPLACE INTO sync_dirty (uid, deleted) VALUES (COALESCE(NEW.uid, (SELECT uid FROM tasks WHERE id = NEW.id)), 0); END;
    CREATE TRIGGER IF NOT EXISTS tasks_dirty_upd AFTER UPDATE ON tasks WHEN (SELECT applying FROM sync_state) = 0 AND NEW.uid IS NOT NULL
      BEGIN INSERT OR REPLACE INTO sync_dirty (uid, deleted) VALUES (NEW.uid, 0); END;
    CREATE TRIGGER IF NOT EXISTS tasks_dirty_del AFTER DELETE ON tasks WHEN (SELECT applying FROM sync_state) = 0 AND OLD.uid IS NOT NULL
      BEGIN INSERT OR REPLACE INTO sync_dirty (uid, deleted) VALUES (OLD.uid, 1); END;
    CREATE TRIGGER IF NOT EXISTS task_updates_dirty AFTER INSERT ON task_updates WHEN (SELECT applying FROM sync_state) = 0
      BEGIN INSERT OR REPLACE INTO sync_dirty (uid, deleted) SELECT uid, 0 FROM tasks WHERE id = NEW.task_id AND uid IS NOT NULL; END;
  `);
}

const nowRev = () => new Date().toISOString();

function record(db, uid, deleted) {
  if (deleted) return { type: 'zordon.task', uid, rev: nowRev(), deleted: true };
  const t = db.prepare(`SELECT t.*, p.code AS project_code, p.name AS project_name, o.email AS owner_email, o.name AS owner_name
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people o ON o.id = t.owner_id WHERE t.uid = ?`).get(uid);
  if (!t) return null;
  const updates = db.prepare(`SELECT u.body, u.created_at, a.email AS author_email, a.name AS author_name FROM task_updates u
    LEFT JOIN people a ON a.id = u.author_id WHERE u.task_id = ? ORDER BY u.id`).all(t.id);
  const rev = nowRev();
  db.prepare('UPDATE sync_state SET applying = 1').run();
  try { db.prepare('UPDATE tasks SET rev = ? WHERE id = ?').run(rev, t.id); } finally { db.prepare('UPDATE sync_state SET applying = 0').run(); }
  return {
    type: 'zordon.task', uid, rev, ...Object.fromEntries(FIELDS.map((k) => [k, t[k] ?? null])),
    project: t.project_code || t.project_name ? { code: t.project_code, name: t.project_name } : null,
    owner: t.owner_email || t.owner_name ? { email: t.owner_email, name: t.owner_name } : null,
    updates: updates.map((u) => ({ body: u.body, at: u.created_at, author: u.author_email || u.author_name ? { email: u.author_email, name: u.author_name } : null })),
  };
}

// Write every task changed on this computer since the last run.
export async function exportBoard(db, root) {
  const dirty = db.prepare('SELECT uid, deleted FROM sync_dirty').all();
  let n = 0;
  for (const d of dirty) {
    if (!UID_RE.test(d.uid)) { db.prepare('DELETE FROM sync_dirty WHERE uid = ?').run(d.uid); continue; }
    const rec = record(db, d.uid, d.deleted);
    if (rec) {
      const name = `${d.uid}.json`;
      await saveFile(root, `${BOARD_DIR}/${name}`, Buffer.from(JSON.stringify(rec, null, 1)), { overwrite: true });
      const s = await stat(vaultPath(root, BOARD_DIR, name)).catch(() => null);
      if (s) seenFor(db).set(name, s.mtimeMs); // our own write: nothing to read back
      n++;
    }
    db.prepare('DELETE FROM sync_dirty WHERE uid = ?').run(d.uid);
  }
  if (n) { syncStatus.last_export = nowRev(); syncStatus.exported += n; }
  return n;
}

const findBy = (db, table, ref) => {
  if (!ref) return null;
  if (table === 'projects') {
    return (ref.code && db.prepare('SELECT id FROM projects WHERE lower(code) = lower(?)').get(ref.code)?.id)
      || (ref.name && db.prepare('SELECT id FROM projects WHERE lower(name) = lower(?)').get(ref.name)?.id) || null;
  }
  return (ref.email && db.prepare('SELECT id FROM people WHERE lower(email) = lower(?)').get(ref.email)?.id)
    || (ref.name && db.prepare('SELECT id FROM people WHERE lower(name) = lower(?)').get(ref.name)?.id) || null;
};

// Apply one task file from another computer. Returns true when something changed here.
export function applyRecord(db, rec) {
  if (rec?.type !== 'zordon.task' || !UID_RE.test(String(rec.uid || '')) || !rec.rev) return false;
  const local = db.prepare('SELECT id, rev FROM tasks WHERE uid = ?').get(rec.uid);
  if (local && local.rev && local.rev >= rec.rev) return false; // ours is as new or newer
  if (db.prepare('SELECT 1 FROM sync_dirty WHERE uid = ?').get(rec.uid) && local && !local.rev) return false; // unsent local edit wins
  db.prepare('UPDATE sync_state SET applying = 1').run();
  try {
    if (rec.deleted) {
      if (!local) return false;
      db.prepare('DELETE FROM tasks WHERE id = ?').run(local.id);
      return true;
    }
    // A job the other computer learned about (e.g. from a new email) is added here too.
    let projectId = findBy(db, 'projects', rec.project);
    if (!projectId && rec.project?.name) {
      projectId = Number(db.prepare('INSERT INTO projects (name, code) VALUES (?, ?)').run(String(rec.project.name), rec.project.code || null).lastInsertRowid);
    }
    const values = { ...Object.fromEntries(FIELDS.map((k) => [k, rec[k] ?? null])), project_id: projectId, owner_id: findBy(db, 'people', rec.owner), rev: rec.rev };
    if (!values.title) return false;
    values.status ||= 'not_started';
    values.priority ||= 'medium';
    values.source ||= 'manual';
    let id = local?.id;
    if (local) {
      db.prepare(`UPDATE tasks SET ${Object.keys(values).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(values), id);
    } else {
      const keys = ['uid', ...Object.keys(values)];
      id = Number(db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(rec.uid, ...Object.values(values)).lastInsertRowid);
    }
    db.prepare('DELETE FROM task_updates WHERE task_id = ?').run(id);
    const add = db.prepare('INSERT INTO task_updates (task_id, author_id, body, created_at) VALUES (?, ?, ?, ?)');
    for (const u of Array.isArray(rec.updates) ? rec.updates : []) if (u?.body) add.run(id, findBy(db, 'people', u.author), String(u.body), u.at || nowRev());
    return true;
  } finally {
    db.prepare('UPDATE sync_state SET applying = 0').run();
  }
}

// Read task files that changed since the last look.
export async function importBoard(db, root) {
  let n = 0;
  const seen = seenFor(db);
  for (const name of await readdir(vaultPath(root, BOARD_DIR)).catch(() => [])) {
    if (!name.endsWith('.json')) continue; // OneDrive conflict copies ("<uid>-PC.json") carry the uid inside, so they're read too
    const s = await stat(vaultPath(root, BOARD_DIR, name)).catch(() => null);
    if (!s || seen.get(name) === s.mtimeMs) continue;
    try {
      if (applyRecord(db, JSON.parse(await readFile(vaultPath(root, BOARD_DIR, name), 'utf8')))) n++;
      seen.set(name, s.mtimeMs);
    } catch (err) {
      syncStatus.error = `${name}: ${err.message}`; // half-synced file: try again next round
    }
  }
  if (n) { syncStatus.last_import = nowRev(); syncStatus.imported += n; }
  return n;
}

// First run on a computer: write out every task it already has, so the other computer gets them.
export function shareExistingTasks(db) {
  db.exec("INSERT OR IGNORE INTO sync_dirty (uid, deleted) SELECT uid, 0 FROM tasks WHERE uid IS NOT NULL AND rev IS NULL");
}

const isDemo = (db) => db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value === 'true';

export async function syncBoard(db, root) {
  // Demo data never leaves this computer, and the real board waits until the real roster is loaded.
  if (isDemo(db)) return { imported: 0, exported: 0, skipped: 'demo data' };
  try {
    const imported = await importBoard(db, root);
    const exported = await exportBoard(db, root);
    syncStatus.error = null;
    return { imported, exported };
  } catch (err) {
    syncStatus.error = err.message;
    return { imported: 0, exported: 0, error: err.message };
  }
}
