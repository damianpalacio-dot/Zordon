import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
const { openDb } = await import('../server/db.js');
const { syncBoard, shareExistingTasks } = await import('../server/boardsync.js');
const { runRoutines } = await import('../server/schedule.js');

// Two computers with the same team and jobs (from the roster), but different local ids.
function computer(order) {
  const db = openDb(':memory:');
  const people = [['Damian Palacio', 'Damian@gec2.com'], ['Vick Deguzman', 'Vick@gec2.com']];
  for (const [name, email] of order ? people : [...people].reverse()) db.prepare("INSERT INTO people (name, role, email) VALUES (?, 'PM', ?)").run(name, email);
  const jobs = [['Burbank RPT', 'G2707'], ['Fairfax HS', 'G3052']];
  for (const [name, code] of order ? jobs : [...jobs].reverse()) db.prepare('INSERT INTO projects (name, code) VALUES (?, ?)').run(name, code);
  return db;
}
const id = (db, table, col, v) => db.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).get(v).id;

test('two computers share one board through OneDrive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-board-'));
  const home = computer(true);
  const work = computer(false);

  // Tasks already on the home laptop are shared the first time.
  home.prepare('INSERT INTO tasks (project_id, title, owner_id, due_date) VALUES (?, ?, ?, ?)')
    .run(id(home, 'projects', 'code', 'G2707'), 'Get PCI 0045 T&M ticket signed', id(home, 'people', 'name', 'Vick Deguzman'), '2026-10-05');
  shareExistingTasks(home);
  assert.equal((await syncBoard(home, root)).exported, 1);
  assert.equal((await readdir(join(root, 'Zordon/board'))).length, 1);

  // The work computer picks it up, mapped to its own job and person ids.
  assert.equal((await syncBoard(work, root)).imported, 1);
  const w = work.prepare('SELECT * FROM tasks').get();
  assert.equal(w.title, 'Get PCI 0045 T&M ticket signed');
  assert.equal(w.project_id, id(work, 'projects', 'code', 'G2707'));
  assert.equal(w.owner_id, id(work, 'people', 'name', 'Vick Deguzman'));

  // Done at work, with a note: home sees both. Nothing echoes back.
  work.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(w.id);
  work.prepare('INSERT INTO task_updates (task_id, author_id, body) VALUES (?, ?, ?)').run(w.id, id(work, 'people', 'name', 'Damian Palacio'), 'Signed by Swinerton');
  assert.equal((await syncBoard(work, root)).exported, 1);
  assert.equal((await syncBoard(home, root)).imported, 1);
  const h = home.prepare('SELECT * FROM tasks').get();
  assert.equal(h.status, 'done');
  assert.equal(home.prepare('SELECT body FROM task_updates WHERE task_id = ?').get(h.id).body, 'Signed by Swinerton');
  assert.deepEqual(await syncBoard(home, root), { imported: 0, exported: 0 });
  assert.deepEqual(await syncBoard(work, root), { imported: 0, exported: 0 });

  // A task added at home shows up at work; deleting it at work removes it at home.
  home.prepare('INSERT INTO tasks (title) VALUES (?)').run('Review Franklin RFI #128');
  await syncBoard(home, root);
  await syncBoard(work, root);
  const rfi = work.prepare("SELECT id FROM tasks WHERE title LIKE 'Review Franklin%'").get();
  assert.ok(rfi);
  work.prepare('DELETE FROM tasks WHERE id = ?').run(rfi.id);
  await syncBoard(work, root);
  await syncBoard(home, root);
  assert.equal(home.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Review Franklin%'").get().n, 0);
});

test('recurring reminders show up once, even though both computers create them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-board-'));
  const home = computer(true);
  const work = computer(false);
  for (const db of [home, work]) db.prepare("INSERT INTO routines (title, weekday, estimate_hours) VALUES ('Review Liz''s WIP report', 4, 1)").run();
  runRoutines(home, '2026-10-06');
  await syncBoard(home, root);
  await syncBoard(work, root);
  runRoutines(work, '2026-10-06');
  await syncBoard(work, root);
  await syncBoard(home, root);
  for (const db of [home, work]) assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Review Liz''s WIP report'").get().n, 1);
});

test('demo data is never shared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-board-'));
  const { seedIfEmpty } = await import('../server/db.js');
  const demo = openDb(':memory:');
  seedIfEmpty(demo, '2026-10-05');
  shareExistingTasks(demo);
  assert.equal((await syncBoard(demo, root)).skipped, 'demo data');
  assert.deepEqual(await readdir(join(root, 'Zordon')).catch(() => []), []);
});

test('a job only one computer knows about comes along with its task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-board-'));
  const home = computer(true);
  const work = computer(false);
  const pid = Number(home.prepare("INSERT INTO projects (name, code) VALUES ('Lincoln MS Fire Alarm Upgrade', 'G3300')").run().lastInsertRowid);
  home.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(pid, 'Set up G3300 job folder');
  await syncBoard(home, root);
  await syncBoard(work, root);
  const t = work.prepare("SELECT p.code FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = 'Set up G3300 job folder'").get();
  assert.equal(t.code, 'G3300');
});
