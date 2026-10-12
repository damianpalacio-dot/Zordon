import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
const { openDb } = await import('../server/db.js');
const { fileDocument } = await import('../server/index.js');
const { stageFor, coPart, packageMatches, packageName, ensurePackage, ensureChangeOrders, applyStage, listPackages } = await import('../server/packages.js');

const TODAY = '2026-10-03';
function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (name, role) VALUES ('Damian', 'Project Manager')").run();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('Burbank Replacement Terminal', 'G2707', 'BURB RPT')").run();
  return db;
}

test('stages come from the words in the document, latest stage wins', () => {
  assert.equal(stageFor('cor', 'COR 73 T&M tags week 1'), null);
  assert.equal(stageFor('cor', 'COR 73 submitted to GC'), 'SUBMITTED');
  assert.equal(stageFor('cor', 'COR 73 approved and billed on pay app 12'), 'BILLED');
  assert.equal(stageFor('cor', 'CO 12 voided by owner'), 'REJECTED-VOID');
  assert.equal(stageFor('submittal', '26 24 16 panelboards returned revise and resubmit'), '04 RETURNED');
  assert.equal(stageFor('submittal', '26 24 16 approved no exceptions taken'), '05 APPROVED');
  assert.equal(stageFor('submittal', 'nothing to see'), null);
});

test('each document has a home inside the CO folder', () => {
  assert.equal(coPart('COR 73 Graybar quote')[0], '05 QUOTES/VENDORS');
  assert.equal(coPart('COR 73 subcontractor quote Direct AV')[0], '05 QUOTES/SUBCONTRACTORS');
  assert.equal(coPart('COR 73 McCormick estimate')[0], '01 ESTIMATE - LABOR & MATERIAL');
  assert.equal(coPart('COR 73 T&M tag 10/02')[0], '03 T&M TAGS');
  assert.equal(coPart('COR 73 RFI 22 response')[0], '02 RFP-RFI REFERENCE');
  assert.equal(coPart('COR 73 executed CO')[0], '04 APPROVED CO DOCUMENTATION');
  assert.equal(coPart('COR 73 submitted to GC'), null);
});

test('existing folders with older names are reused', () => {
  assert.ok(packageMatches('cor', 'Change Request 073', { number: '73' }));
  assert.ok(packageMatches('cor', 'PCO-073 Ice machine', { number: '073' }));
  assert.ok(packageMatches('cor', 'CO 073', { number: 73 }));
  assert.ok(!packageMatches('cor', 'Change Request 074', { number: '73' }));
  assert.ok(packageMatches('submittal', '262416 PANELBOARDS', { spec_section: '26 24 16' }));
  assert.equal(packageName('cor', { number: '73', title: 'ice and water machine power' }), 'CO 073 - Ice and Water Machine Power');
  assert.equal(packageName('submittal', { spec_section: '26 24 16', title: 'panelboards' }), '26 24 16 Panelboards');
});

const CO = '5. PROJECTS/G2707/01 COST CONTROL/04 CHANGE ORDERS';

test('a new job gets the stage folders, the CO LOG folder and an empty CO 001', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  assert.equal(await ensureChangeOrders(root, '5. PROJECTS/G2707'), `${CO}/CO 001`);
  assert.deepEqual((await readdir(join(root, CO))).sort(), ['1 PENDING (not yet submitted to GC)', '2 SUBMITTED (awaiting GC-owner approval)',
    '3 APPROVED', '4 REJECTED-VOID', '5. CO LOG', 'CO 001'].sort());
  assert.deepEqual((await readdir(join(root, CO, 'CO 001'))).sort(), ['01 ESTIMATE - LABOR & MATERIAL', '02 RFP-RFI REFERENCE', '03 T&M TAGS',
    '04 APPROVED CO DOCUMENTATION', '05 QUOTES']);
  assert.deepEqual((await readdir(join(root, CO, 'CO 001/05 QUOTES'))).sort(), ['CONSULTANTS', 'PROFESSIONAL SERVICES', 'SUBCONTRACTORS', 'VENDORS']);
});

test('the ready CO folder is renamed into 1 PENDING when filled, and the next one is made', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await ensureChangeOrders(root, '5. PROJECTS/G2707');
  await writeFile(join(root, CO, 'CO 001/03 T&M TAGS/tag.pdf'), 'x');
  const folder = await ensurePackage(root, '5. PROJECTS/G2707', 'cor', { number: '1', title: 'Bus tap' });
  assert.equal(folder, `${CO}/1 PENDING (not yet submitted to GC)/CO 001 - Bus Tap`);
  assert.deepEqual(await readdir(join(root, folder, '03 T&M TAGS')), ['tag.pdf']);
  assert.ok((await readdir(join(root, CO))).includes('CO 002'));
  assert.ok(!(await readdir(join(root, CO))).includes('CO 001'));
});

test('older CO folders are reused in place, keeping their Quotes / T&M folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  const job = '5. PROJECTS/G2707';
  for (const d of ['Quotes', 'T&M']) await mkdir(join(root, job, '01 COST CONTROL/CHANGE ORDERS/Change Request 073', d), { recursive: true });
  const folder = await ensurePackage(root, job, 'cor', { number: '73', title: 'Ice machine' });
  assert.equal(folder, `${job}/01 COST CONTROL/CHANGE ORDERS/Change Request 073`);
  const have = await readdir(join(root, folder));
  assert.ok(have.includes('Quotes') && !have.includes('05 QUOTES'));
  assert.ok(have.includes('01 ESTIMATE - LABOR & MATERIAL'));
  assert.ok((await readdir(join(root, CO))).includes('CO 074'), 'next ready folder follows the highest number');
});

test('filing a CO quote lands in its company folder; submitting moves the folder and asks for the workbook update', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await mkdir(join(root, 'Zordon'), { recursive: true });
  await mkdir(join(root, CO, '1 PENDING (not yet submitted to GC)/CO 073 - Ice and Water Machine/05 QUOTES/VENDORS/GRAYBAR ELECTRIC'), { recursive: true });
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'quote.pdf', project_id: 1, hint: 'COR 73 Graybar quote ice and water machine' }, TODAY);
  const doc = db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id);
  assert.equal(doc.path, `${CO}/1 PENDING (not yet submitted to GC)/CO 073 - Ice and Water Machine/05 QUOTES/VENDORS/GRAYBAR ELECTRIC/CO 073 - Vendor Quote - Graybar Quote Ice and Water Machine.pdf`);
  let [pkg] = listPackages(db);
  assert.equal(pkg.stage, 'PENDING');
  assert.match(db.prepare("SELECT title FROM tasks WHERE source = 'package'").get().title, /^Build the package and draft the GC email for CO 073/);

  await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'cor.pdf', project_id: 1, hint: 'COR 73 submitted to GC with cover letter' }, TODAY);
  [pkg] = listPackages(db);
  assert.equal(pkg.stage, 'SUBMITTED');
  assert.equal(pkg.folder, `${CO}/2 SUBMITTED (awaiting GC-owner approval)/CO 073 - Ice and Water Machine`);
  assert.deepEqual((await readdir(join(root, pkg.folder, '05 QUOTES/VENDORS/GRAYBAR ELECTRIC'))).length, 1, 'the quote moved with its folder');
  assert.ok(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path.startsWith(pkg.folder), 'and its document record followed');
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'package' AND status != 'done'").get();
  assert.match(task.title, /^Follow up with the GC for approval of CO 073/);
  assert.equal(task.due_date, '2026-10-10');
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE source = 'workbook' AND title LIKE 'Update the Job Control Workbook: CO 073 submitted%'").get());
  const log = await readFile(join(root, '5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt'), 'utf8');
  assert.match(log, /OPEN \| 2026-10-03 \| G2707 \| CO 073 \| SUBMITTED \| Ice and Water Machine\n---- DONE ----/);

  // An older backup filed later doesn't move the package backwards.
  await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'sk1.pdf', project_id: 1, hint: 'COR 73 backup sketch SK-1 from GC' }, TODAY);
  assert.equal(listPackages(db)[0].stage, 'SUBMITTED');
  assert.ok((await readdir(join(root, pkg.folder, '02 RFP-RFI REFERENCE'))).length === 1);

  // Approval closes the follow-up and asks for billing.
  await applyStage(db, root, pkg.id, 'APPROVED', { today: TODAY, me: 1, addTask: (t) => Number(db.prepare(`INSERT INTO tasks (project_id, title, owner_id, priority, due_date, source, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.project_id, t.title, t.owner_id, t.priority, t.due_date, t.source, t.source_ref).lastInsertRowid) });
  const open = db.prepare("SELECT title, priority FROM tasks WHERE source = 'package' AND status != 'done'").all();
  assert.equal(open.length, 1);
  assert.match(open[0].title, /^Bill on the next pay app: CO 073/);
  assert.equal(open[0].priority, 'critical');
  assert.equal(listPackages(db)[0].folder, `${CO}/3 APPROVED/CO 073 - Ice and Water Machine`);
});

test('pay apps and purchase orders go where the GEC2 template keeps them', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-pkg-'));
  await mkdir(join(root, '5. PROJECTS/G2707/01 COST CONTROL/06 PURCHASE ORDERS/ACME FIRE ALARM'), { recursive: true });
  const pay = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'pa.pdf', project_id: 1, hint: 'Pay app 6 pencil draft' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(pay.id).path,
    /^5\. PROJECTS\/G2707\/01 COST CONTROL\/05 PAYMENT APPLICATIONS \(MONTHLY BILLING\)\/PENCIL DRAFT \(submitted\)\/2026\/10 October\//);
  const loi = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'loi.pdf', project_id: 1, hint: 'LOI Acme Fire Alarm' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(loi.id).path, /06 PURCHASE ORDERS\/ACME FIRE ALARM\/LOI-NTP\//);
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
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path, /^5\. PROJECTS\/G2707\/01 COST CONTROL\/04 CHANGE ORDERS\/G2707_BURB RPT - COR - /);
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
