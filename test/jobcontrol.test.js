// The GEC2 Job Control standard (Oct 2026): "_00 JOB TEMPLATE - DO NOT DELETE", CO folders with 01 ESTIMATE and
// 05 QUOTES/<type>/<company>, the next CO number's empty folder, the workbook reminder file, pay app and PO folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
const { openDb } = await import('../server/db.js');
const { fileDocument } = await import('../server/index.js');
const { coPart, listPackages, setStage, ensureReadyFolder } = await import('../server/packages.js');
const { loadTemplate, template, templateDir } = await import('../server/template.js');

const TODAY = '2026-10-03';
const TPL = '5. PROJECTS/_00 JOB TEMPLATE - DO NOT DELETE';
const JOB = '5. PROJECTS/G2707';
const CO = `${JOB}/01 COST CONTROL/04 CHANGE ORDERS`;
const PENDING = `${CO}/1 PENDING (not yet submitted to GC)`;
const CO_SUBS = ['01 ESTIMATE - LABOR & MATERIAL', '02 RFP-RFI REFERENCE', '03 T&M TAGS', '04 APPROVED CO DOCUMENTATION',
  '05 QUOTES/VENDORS', '05 QUOTES/SUBCONTRACTORS', '05 QUOTES/CONSULTANTS', '05 QUOTES/PROFESSIONAL SERVICES'];

function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (name, role) VALUES ('Damian', 'Project Manager')").run();
  db.prepare("INSERT INTO projects (name, code, short_name, folder) VALUES ('Burbank Replacement Terminal', 'G2707', 'BURB RPT', ?)").run(JOB);
  return db;
}

async function oneDrive() {
  const root = await mkdtemp(join(tmpdir(), 'zordon-jc-'));
  const tco = `${TPL}/01 COST CONTROL/04 CHANGE ORDERS`;
  for (const d of ['01 COST CONTROL/05 PAYMENT APPLICATIONS (MONTHLY BILLING)', '01 COST CONTROL/06 PURCHASE ORDERS', '07 RFIS', '14 SUBMITTALS',
    '01 COST CONTROL/04 CHANGE ORDERS/2 SUBMITTED (awaiting GC-owner approval)', '01 COST CONTROL/04 CHANGE ORDERS/3 APPROVED',
    '01 COST CONTROL/04 CHANGE ORDERS/4 REJECTED-VOID', '01 COST CONTROL/04 CHANGE ORDERS/5. CO LOG']) await mkdir(join(root, TPL, d), { recursive: true });
  for (const d of CO_SUBS) {
    await mkdir(join(root, tco, '1 PENDING (not yet submitted to GC)', '_CO FOLDER TEMPLATE (DUPLICATE ME)', d), { recursive: true });
    await mkdir(join(root, tco, 'CO 001', d), { recursive: true });
  }
  await mkdir(join(root, 'Zordon'), { recursive: true });
  await loadTemplate(root);
  return root;
}
const pdf = async (pages) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage(); return Buffer.from(await d.save()); };
const pathOf = (db, id) => db.prepare('SELECT path FROM documents WHERE id = ?').get(id).path;

test('the renamed _00 JOB TEMPLATE is found and its nested CO subfolders are read', async () => {
  await oneDrive();
  assert.equal(templateDir(), TPL);
  assert.deepEqual(template.co.subfolders, [...CO_SUBS].sort());
});

test('each document has a home inside the CO folder', () => {
  assert.equal(coPart('CO 3 Graybar quote')[0], 'Vendor quote');
  assert.equal(coPart('CO 3 subcontractor quote Direct AV')[0], 'Sub quote');
  assert.equal(coPart('CO 3 McCormick estimate')[0], 'Estimate');
  assert.equal(coPart('CO 3 T&M tag')[0], 'T&M tag');
  assert.equal(coPart('CO 3 RFI 22 response')[0], 'Reference');
  assert.equal(coPart('CO 3 cover letter'), null);
});

test('the ready CO folder fills, moves into 1 PENDING, and the next one is made', async () => {
  const root = await oneDrive();
  const db = freshDb();
  await mkdir(join(root, CO), { recursive: true });
  for (const d of CO_SUBS) await mkdir(join(root, CO, 'CO 001', d), { recursive: true });
  await mkdir(join(root, CO, 'CO 001/05 QUOTES/VENDORS/REGENCY SUPPLY'), { recursive: true });

  const q = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'quote.pdf', project_id: 1, hint: 'CO 1 bus tap Regency Supply quote change 5' }, TODAY);
  const folder = listPackages(db)[0].folder;
  assert.ok(folder.startsWith(`${PENDING}/CO 001 - Bus Tap`));
  assert.equal(pathOf(db, q.id), `${folder}/05 QUOTES/VENDORS/REGENCY SUPPLY/CO 001 - Vendor Quote - Bus Tap Regency Supply Quote Change 5.pdf`);
  const title = listPackages(db)[0].title;
  const root04 = await readdir(join(root, CO));
  assert.ok(!root04.includes('CO 001') && root04.includes('CO 002'), 'ready folder renamed into PENDING and CO 002 made');
  assert.deepEqual((await readdir(join(root, CO, 'CO 002', '05 QUOTES'))).sort(), ['CONSULTANTS', 'PROFESSIONAL SERVICES', 'SUBCONTRACTORS', 'VENDORS']);
  assert.equal(await ensureReadyFolder(root, JOB), null, 'never two ready folders');

  const est = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'est.pdf', project_id: 1, hint: 'CO 1 McCormick estimate' }, TODAY);
  assert.match(pathOf(db, est.id), /\/01 ESTIMATE - LABOR & MATERIAL\/CO 001 - Estimate - Labor & Material - /);
  const tm = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'tag.pdf', project_id: 1, hint: 'CO 1 T&M tag' }, TODAY);
  assert.equal(pathOf(db, tm.id), `${folder}/03 T&M TAGS/CO 001 - T&M Tag - 2026-10-03.pdf`);
  assert.equal(listPackages(db)[0].title, title, 'later documents do not rename the CO');
});

test('a status change moves the folder, keeps document paths right and adds the workbook reminder', async () => {
  const root = await oneDrive();
  const db = freshDb();
  const q = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'quote.pdf', project_id: 1, hint: 'CO 3 additional lighting Graybar quote' }, TODAY);
  const [pkg] = listPackages(db);
  const res = await setStage(db, pkg.id, 'SUBMITTED', { today: TODAY, me: 1, root, addTask: (t) => Number(db.prepare(`INSERT INTO tasks (project_id, title, owner_id, priority, due_date, source, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.project_id, t.title, t.owner_id, t.priority, t.due_date, t.source, t.source_ref).lastInsertRowid) });
  assert.match(res.package.folder, /2 SUBMITTED \(awaiting GC-owner approval\)\/CO 003 - /);
  assert.ok(pathOf(db, q.id).startsWith(`${res.package.folder}/05 QUOTES/VENDORS/`), 'document record followed the folder');
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE title LIKE 'Update Job Control Workbook for submitted CO 003%'").get());
  const log = await readFile(join(root, '5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt'), 'utf8');
  assert.match(log, /OPEN \| 2026-10-03 \| G2707 \| CO 003 \| SUBMITTED \| .+\n---- DONE ----\n$/);
});

test('the GC package follows the Job Control order and opens on the CO form', async () => {
  const root = await oneDrive();
  const db = freshDb();
  await fileDocument(db, root, { buffer: await pdf(1), filename: 'tag.pdf', project_id: 1, hint: 'CO 4 bus tap T&M tag' }, TODAY);
  await fileDocument(db, root, { buffer: await pdf(2), filename: 'q.pdf', project_id: 1, hint: 'CO 4 bus tap Graybar quote' }, TODAY);
  await fileDocument(db, root, { buffer: await pdf(1), filename: 'sk1.pdf', project_id: 1, hint: 'CO 4 bus tap reference sketch SK-1' }, TODAY);
  const form = await fileDocument(db, root, { buffer: await pdf(1), filename: 'G2707 - Burbank - CO 004 - Bus Tap.pdf' }, TODAY);
  assert.deepEqual(form.compiled.included.map((i) => i.section), ['Change order', 'RFP / RFI reference', 'Vendor quotes', 'T&M tags']);
  assert.equal(form.compiled.pages, 5);
});

test('pay apps and purchase orders go where the GEC2 template keeps them', async () => {
  const root = await oneDrive();
  const db = freshDb();
  await mkdir(join(root, JOB, '01 COST CONTROL/06 PURCHASE ORDERS/ACME FIRE ALARM'), { recursive: true });
  const pay = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'pa.pdf', project_id: 1, hint: 'Pay app 6 pencil draft' }, TODAY);
  assert.match(pathOf(db, pay.id), /^5\. PROJECTS\/G2707\/01 COST CONTROL\/05 PAYMENT APPLICATIONS \(MONTHLY BILLING\)\/PENCIL DRAFT \(submitted\)\/2026\/10 October\//);
  const loi = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'loi.pdf', project_id: 1, hint: 'LOI Acme Fire Alarm' }, TODAY);
  assert.match(pathOf(db, loi.id), /06 PURCHASE ORDERS\/ACME FIRE ALARM\/LOI-NTP\//);
});

test('Zordon follows CO folders that Claude creates and moves on OneDrive', async () => {
  const { scanCoFolders } = await import('../server/packages.js');
  const { rename } = await import('node:fs/promises');
  const root = await oneDrive();
  const db = freshDb();
  const addTask = (t) => Number(db.prepare(`INSERT INTO tasks (project_id, title, owner_id, priority, due_date, source, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.project_id, t.title, t.owner_id, t.priority, t.due_date, t.source, t.source_ref).lastInsertRowid);
  // What Claude leaves behind: a filled CO in 1 PENDING, an approved one, the next ready folder, the folder template.
  await mkdir(join(root, PENDING, 'CO 013 - Bus Tap (RFI 63)'), { recursive: true });
  await mkdir(join(root, PENDING, '_CO FOLDER TEMPLATE (DUPLICATE ME)'), { recursive: true });
  await mkdir(join(root, CO, '3 APPROVED', 'CO 009 - Added Outlets'), { recursive: true });
  await mkdir(join(root, CO, 'CO 014'), { recursive: true });

  const first = await scanCoFolders(db, root, { today: TODAY, me: 1, addTask });
  assert.deepEqual(first.added.sort(), ['G2707 CO 009', 'G2707 CO 013']);
  assert.equal(first.found, 2, 'the ready folder and the template are not change orders');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'existing COs are recorded quietly');
  const co13 = () => listPackages(db).find((p) => p.number === '013');
  assert.equal(co13().stage, 'PENDING');
  assert.equal(co13().title, 'Bus Tap (RFI 63)');

  // Claude sends CO 013 and moves its folder, and logs the workbook line in its own words.
  await mkdir(join(root, CO, '2 SUBMITTED (awaiting GC-owner approval)'), { recursive: true });
  await rename(join(root, PENDING, 'CO 013 - Bus Tap (RFI 63)'), join(root, CO, '2 SUBMITTED (awaiting GC-owner approval)', 'CO 013 - Bus Tap (RFI 63)'));
  await mkdir(join(root, '5. PROJECTS/Zordon'), { recursive: true });
  await writeFile(join(root, '5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt'), 'OPEN  G2707  CO 013  Submitted to GC  2026-10-03\n');
  const second = await scanCoFolders(db, root, { today: TODAY, me: 1, addTask });
  assert.deepEqual(second.moved, ['G2707 CO 013: PENDING → SUBMITTED']);
  assert.match(co13().folder, /2 SUBMITTED/);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE title LIKE 'Follow up with the GC for approval of CO 013%'").get());
  const log = await readFile(join(root, '5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt'), 'utf8');
  assert.equal(log.match(/CO 013/g).length, 1, 'no second line when Claude already logged it');

  // Billed in Zordon stays billed while its folder sits in 3 APPROVED; a quiet scan changes nothing.
  db.prepare("UPDATE packages SET stage = 'BILLED' WHERE number = '009'").run();
  const third = await scanCoFolders(db, root, { today: TODAY, me: 1, addTask });
  assert.deepEqual([third.added, third.moved], [[], []]);
  assert.equal(listPackages(db).find((p) => p.number === '009').stage, 'BILLED');
});
