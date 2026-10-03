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
