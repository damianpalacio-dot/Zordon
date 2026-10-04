import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
const { openDb } = await import('../server/db.js');
const { fileDocument } = await import('../server/index.js');
const { stageFor, packageMatches, packageName, ensurePackage, setStage, listPackages } = await import('../server/packages.js');

const TODAY = '2026-10-03';
function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (name, role) VALUES ('Damian', 'Project Manager')").run();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('Burbank Replacement Terminal', 'G2707', 'BURB RPT')").run();
  return db;
}

test('stages come from the words in the document, latest stage wins', () => {
  assert.equal(stageFor('cor', 'COR 73 T&M tags week 1'), '02 T&M');
  assert.equal(stageFor('cor', 'COR 73 Graybar quote'), '03 QUOTES');
  assert.equal(stageFor('cor', 'COR 73 approved and billed on pay app 12'), '07 BILLED');
  assert.equal(stageFor('submittal', '26 24 16 panelboards returned revise and resubmit'), '04 RETURNED');
  assert.equal(stageFor('submittal', '26 24 16 approved no exceptions taken'), '05 APPROVED');
  assert.equal(stageFor('submittal', 'nothing to see'), null);
});

test('existing folders with the team\'s older names are reused', () => {
  assert.ok(packageMatches('cor', 'Change Request 073', { number: '73' }));
  assert.ok(packageMatches('cor', 'PCO-073 Ice machine', { number: '073' }));
  assert.ok(!packageMatches('cor', 'Change Request 074', { number: '73' }));
  assert.ok(packageMatches('submittal', '262416 PANELBOARDS', { spec_section: '26 24 16' }));
  assert.equal(packageName('cor', { number: '73', title: 'ice and water machine power' }), 'COR 073 - Ice and Water Machine Power');
  assert.equal(packageName('submittal', { spec_section: '26 24 16', title: 'panelboards' }), '26 24 16 Panelboards');
});

test('ensurePackage builds stage folders but keeps existing Quotes / T&M / ENDSHEET folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  const job = '5. PROJECTS/G2707';
  for (const d of ['Quotes', 'T&M', 'ENDSHEET']) await mkdir(join(root, job, '01 COST CONTROL/CHANGE ORDERS/Change Request 073', d), { recursive: true });
  const folder = await ensurePackage(root, job, 'cor', { number: '73', title: 'Ice machine' });
  assert.equal(folder, `${job}/01 COST CONTROL/CHANGE ORDERS/Change Request 073`);
  assert.deepEqual((await readdir(join(root, folder))).sort(),
    ['01 BACKUP', '05 SUBMITTED', '06 APPROVED', '07 BILLED', 'ENDSHEET', 'Quotes', 'T&M'].sort());
});

test('filing a COR quote lands in its package and stage; submitting it puts a follow-up on my list', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await mkdir(join(root, 'Zordon'), { recursive: true });
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'quote.pdf', project_id: 1, hint: 'COR 73 Graybar quote ice and water machine' }, TODAY);
  const doc = db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id);
  assert.match(doc.path, /^5\. PROJECTS\/G2707\/01 COST CONTROL\/CHANGE ORDERS\/COR 073 - .+\/03 QUOTES\/G2707_BURB RPT - COR 73 - /);
  let [pkg] = listPackages(db);
  assert.equal(pkg.stage, '03 QUOTES');

  await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'cor.pdf', project_id: 1, hint: 'COR 73 submitted to GC with cover letter' }, TODAY);
  [pkg] = listPackages(db);
  assert.equal(pkg.stage, '05 SUBMITTED');
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'package' AND status != 'done'").get();
  assert.match(task.title, /^Follow up with the GC for approval of COR 073/);
  assert.equal(task.due_date, '2026-10-10');

  // An older backup filed later doesn't move the package backwards.
  await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'rfi.pdf', project_id: 1, hint: 'COR 73 backup RFI 22 response' }, TODAY);
  assert.equal(listPackages(db)[0].stage, '05 SUBMITTED');

  // Approval closes the follow-up and asks for billing.
  setStage(db, pkg.id, '06 APPROVED', { today: TODAY, me: 1, addTask: (t) => Number(db.prepare(`INSERT INTO tasks (project_id, title, owner_id, priority, due_date, source, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.project_id, t.title, t.owner_id, t.priority, t.due_date, t.source, t.source_ref).lastInsertRowid) });
  const open = db.prepare("SELECT title, priority FROM tasks WHERE source = 'package' AND status != 'done'").all();
  assert.equal(open.length, 1);
  assert.match(open[0].title, /^Bill on the next pay app: COR 073/);
  assert.equal(open[0].priority, 'critical');
});

test('a submittal with a spec section gets its own package', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await mkdir(join(root, '5. PROJECTS/G2707/14 SUBMITTALS/26 24 16 PANELBOARDS'), { recursive: true });
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'sub.pdf', project_id: 1, hint: 'Submittal 26 24 16 panelboards approved no exceptions taken' }, TODAY);
  const doc = db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id);
  assert.match(doc.path, /^5\. PROJECTS\/G2707\/14 SUBMITTALS\/26 24 16 PANELBOARDS\/05 APPROVED\//);
  const [pkg] = listPackages(db);
  assert.equal(pkg.spec_section, '26 24 16');
  assert.equal(pkg.stage, '05 APPROVED');
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE source = 'package' AND title LIKE 'Release equipment for Submittal 26 24 16%'").get());
});

test('a note dropped as a plain file still files normally when there is no number', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await writeFile(join(root, 'x'), '');
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'co log.xlsx', project_id: 1, hint: 'change order log' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path, /^5\. PROJECTS\/G2707\/01 COST CONTROL\/G2707_BURB RPT - COR - /);
  assert.equal(listPackages(db).length, 0);
});

test('demo data is replaced by the OneDrive roster once it can be found', async () => {
  const { seedIfEmpty } = await import('../server/db.js');
  const { seedFromRoster, writeRoster } = await import('../server/index.js');
  const db = openDb(':memory:');
  seedIfEmpty(db, TODAY);
  const root = await mkdtemp(join(tmpdir(), 'zordon-roster-'));
  assert.equal(await writeRoster(db, root), null); // demo never overwrites the real roster
  await mkdir(join(root, 'Zordon'), { recursive: true });
  await writeFile(join(root, 'Zordon/zordon-roster.json'), JSON.stringify({
    me: { email: 'damian@gec2.com' },
    people: [{ name: 'Damian Palacio', email: 'damian@gec2.com', role: 'Project Manager' }, { name: 'Vick Deguzman', role: 'Project Engineer' }],
    projects: [{ name: 'Burbank Replacement Terminal', code: 'G2707', short_name: 'BURB RPT' }],
  }));
  assert.equal(await seedFromRoster(db, root), true);
  assert.deepEqual(db.prepare('SELECT name FROM people ORDER BY id').all().map((p) => p.name), ['Damian Palacio', 'Vick Deguzman']);
  assert.deepEqual(db.prepare('SELECT code FROM projects').all().map((p) => p.code), ['G2707']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(await seedFromRoster(db, root), false); // real data is never replaced
});

test('finds the GEC2 OneDrive without a path in .env', async () => {
  const { detectVault } = await import('../server/vault.js');
  const home = await mkdtemp(join(tmpdir(), 'zordon-home-'));
  await mkdir(join(home, 'OneDrive'), { recursive: true }); // personal OneDrive: no roster
  await mkdir(join(home, 'OneDrive - GECTWO', 'Zordon'), { recursive: true });
  await writeFile(join(home, 'OneDrive - GECTWO', 'Zordon', 'zordon-roster.json'), '{}');
  assert.equal((await detectVault({}, home)).path, join(home, 'OneDrive - GECTWO'));
  // A wrong or quoted path in .env still falls through to the real one.
  assert.equal((await detectVault({ ZORDON_VAULT: '"C:\\nope"' }, home)).path, join(home, 'OneDrive - GECTWO'));
  assert.equal((await detectVault({ ZORDON_VAULT: `"${join(home, 'OneDrive - GECTWO')}\\"` }, home)).found, 'roster');
});

test('unflagged demo data from older versions is recognised', async () => {
  const { seedIfEmpty } = await import('../server/db.js');
  const dir = await mkdtemp(join(tmpdir(), 'zordon-legacy-'));
  const file = join(dir, 'z.db');
  let db = openDb(file);
  seedIfEmpty(db, TODAY);
  db.exec("DELETE FROM settings WHERE key = 'demo_data'"); // what older versions left behind
  db.close();
  db = openDb(file);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'demo_data'").get()?.value, 'true');
  db.close();
});

test('OneDrive browser lists job folders and never leaves the vault', async () => {
  const { oneDriveStatus, listFolder, safePath } = await import('../server/onedrive.js');
  const root = await mkdtemp(join(tmpdir(), 'zordon-od-'));
  await mkdir(join(root, '5. PROJECTS/G2707/14 SUBMITTALS'), { recursive: true });
  await mkdir(join(root, '5. PROJECTS/LAUSD 32ND ST'), { recursive: true });
  await writeFile(join(root, '5. PROJECTS/G2707/notes.pdf'), 'x');
  await writeFile(join(root, '5. PROJECTS/G2707/desktop.ini'), 'x');
  const st = await oneDriveStatus(root);
  assert.equal(st.connected, true);
  assert.equal(st.job_folders, 2);
  const list = await listFolder(root, '5. PROJECTS/G2707');
  assert.deepEqual(list.items.map((i) => [i.name, i.dir]), [['14 SUBMITTALS', true], ['notes.pdf', false]]);
  assert.equal(list.items[1].path, '5. PROJECTS/G2707/notes.pdf');
  assert.throws(() => safePath(root, '../../etc'), /outside your OneDrive/);
});

test('a vault pointed at "5. PROJECTS" or a demo roster is not mistaken for the real one', async () => {
  const { detectVault } = await import('../server/vault.js');
  const { loadRoster } = await import('../server/index.js');
  const home = await mkdtemp(join(tmpdir(), 'zordon-home2-'));
  const od = join(home, 'OneDrive - GEC2');
  await mkdir(join(od, '5. PROJECTS', 'Zordon'), { recursive: true });
  await writeFile(join(od, '5. PROJECTS', 'Zordon', 'zordon-roster.json'), '{}'); // the stray copy
  await mkdir(join(od, 'Zordon'), { recursive: true });
  await writeFile(join(od, 'Zordon', 'zordon-roster.json'), '{}');
  assert.equal((await detectVault({ ZORDON_VAULT: join(od, '5. PROJECTS') }, home)).path, od);

  const db = freshDb();
  db.exec('DELETE FROM people; DELETE FROM projects');
  assert.equal(loadRoster(db, { people: [{ name: 'Jordan Lee', email: 'jordan.lee@example.com' }], projects: [{ name: 'Angel Grove', code: 'AGM-101' }] }), false);
});
