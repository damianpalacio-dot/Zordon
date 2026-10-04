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
const { loadTemplate, copyTemplate, template, templateDir } = await import('../server/template.js');
const { applyTemplateToJobs, checkTemplate } = await import('../server/index.js');
const { CATEGORY_FOLDERS, JOB_TEMPLATE } = await import('../server/vault.js');

const TODAY = '2026-10-03';
function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (name, role) VALUES ('Damian', 'Project Manager')").run();
  db.prepare("INSERT INTO projects (name, code, short_name, folder) VALUES ('Burbank Replacement Terminal', 'G2707', 'BURB RPT', '5. PROJECTS/G2707')").run();
  return db;
}

// A OneDrive with the GEC2 job template, shaped like the real "0. JOB TEMPLATE - DO NOT DELETE".
const TPL = '5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE';
const CO = `${TPL}/01 COST CONTROL/04 CHANGE ORDERS`;
async function oneDrive() {
  const root = await mkdtemp(join(tmpdir(), 'zordon-tpl-'));
  const dirs = ['01 COST CONTROL/01 ORIGINAL ESTIMATE', '01 COST CONTROL/02 CONTRACT DOCUMENTS/LOI', '01 COST CONTROL/03 BUDGET',
    '01 COST CONTROL/05 PAYMENT APPLICATIONS (MONTHLY BILLING)', '01 COST CONTROL/06 PURCHASE ORDERS', '02 BIM', '07 RFIS',
    '12 TEMPLATES/GENERAL FORMS', '14 SUBMITTALS', '04 CHANGE ORDERS'.replace(/.*/, '01 COST CONTROL/04 CHANGE ORDERS/2 SUBMITTED (awaiting GC-owner approval)'),
    '01 COST CONTROL/04 CHANGE ORDERS/3 APPROVED', '01 COST CONTROL/04 CHANGE ORDERS/4 REJECTED-VOID'];
  for (const d of dirs) await mkdir(join(root, TPL, d), { recursive: true });
  for (const d of ['01 PRICING - BACKUP', '02 RFP-RFI REFERENCE', '03 T&M TAGS', '04 APPROVED CO DOCUMENTATION']) {
    await mkdir(join(root, CO, '1 PENDING (not yet submitted to GC)', '_CO FOLDER TEMPLATE (DUPLICATE ME)', d), { recursive: true });
  }
  await writeFile(join(root, TPL, '12 TEMPLATES/GENERAL FORMS/Daily Report.pdf'), 'form');
  await writeFile(join(root, TPL, 'README - JOB FOLDER TEMPLATE.txt'), 'Dates in any filename use YYYY-MM-DD.');
  await mkdir(join(root, 'Zordon'), { recursive: true });
  await loadTemplate(root);
  return root;
}

test('the OneDrive job template drives Zordon\'s folders', async () => {
  await oneDrive();
  assert.equal(template.found, true);
  assert.ok(JOB_TEMPLATE.includes('01 COST CONTROL') && !JOB_TEMPLATE.includes('15 PREFAB'));
  assert.equal(CATEGORY_FOLDERS['Pay App'], '01 COST CONTROL/05 PAYMENT APPLICATIONS (MONTHLY BILLING)');
  assert.equal(CATEGORY_FOLDERS['Purchase Order'], '01 COST CONTROL/06 PURCHASE ORDERS');
  assert.equal(CATEGORY_FOLDERS.COR, '01 COST CONTROL/04 CHANGE ORDERS');
  assert.deepEqual(template.co.stages.map((s) => s.key), ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED']);
  assert.match(template.readme, /YYYY-MM-DD/);
});

test('new jobs get a copy of the template; existing jobs only get missing folders', async () => {
  const root = await oneDrive();
  const db = freshDb();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('Lincoln MS Fire Alarm Upgrade', 'G3300', 'LINCOLN MS')").run();
  await mkdir(join(root, '5. PROJECTS/G2707/07 RFIS'), { recursive: true });
  const res = await applyTemplateToJobs(db, root);
  assert.ok(res.folders_added > 0);
  const fresh = join(root, '5. PROJECTS/G3300 - Lincoln MS Fire Alarm Upgrade');
  assert.deepEqual(await readdir(join(fresh, '12 TEMPLATES/GENERAL FORMS')), ['Daily Report.pdf']); // forms come along
  assert.ok(!(await readdir(fresh)).some((n) => /README/i.test(n)));
  assert.ok(!(await readdir(join(fresh, '01 COST CONTROL/04 CHANGE ORDERS/1 PENDING (not yet submitted to GC)'))).length, 'the duplicate-me folder stays in the template');
  assert.deepEqual(await readdir(join(root, '5. PROJECTS/G2707/12 TEMPLATES/GENERAL FORMS')), [], 'existing jobs get folders, not forms');
});

test('template changes are noticed and written into FILING.md', async () => {
  const root = await oneDrive();
  const db = freshDb();
  await checkTemplate(db, root);
  await mkdir(join(root, TPL, '15 COMMISSIONING'), { recursive: true });
  await checkTemplate(db, root);
  const changes = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'template_changes'").get().value);
  assert.deepEqual(changes[0].added, ['15 COMMISSIONING']);
  const { readFile } = await import('node:fs/promises');
  const filing = await readFile(join(root, 'Zordon/FILING.md'), 'utf8');
  assert.match(filing, /15 COMMISSIONING/);
  assert.match(filing, /Template README/);
  assert.match(filing, /4 REJECTED-VOID/);
});

test('stages come from the words in the document', () => {
  assert.equal(stageFor('cor', 'CO 73 T&M tags week 1'), null);
  assert.equal(stageFor('cor', 'CO 73 submitted to GC'), 'SUBMITTED');
  assert.equal(stageFor('cor', 'CO 73 fully signed, approved'), 'APPROVED');
  assert.equal(stageFor('cor', 'CO 73 rejected by owner'), 'REJECTED');
  assert.equal(stageFor('submittal', '26 24 16 panelboards returned revise and resubmit'), 'RETURNED');
  assert.equal(stageFor('submittal', '26 24 16 approved no exceptions taken'), 'APPROVED');
});

test('existing folders with older names are reused', () => {
  assert.ok(packageMatches('cor', 'Change Request 073', { number: '73' }));
  assert.ok(packageMatches('cor', 'CO 003 (GC PCO-012) - Lighting', { number: '3' }));
  assert.ok(packageMatches('cor', 'COR 073 Ice machine', { number: '073' }));
  assert.ok(!packageMatches('cor', 'Change Request 074', { number: '73' }));
  assert.ok(packageMatches('submittal', '262416 PANELBOARDS', { spec_section: '26 24 16' }));
  assert.equal(packageName('cor', { number: '3', title: 'additional lighting circuits' }), 'CO 003 - Additional Lighting Circuits');
  assert.equal(packageName('submittal', { spec_section: '26 24 16', title: 'panelboards' }), '26 2416 - PANELBOARDS');
});

test('a new CO is a copy of the template CO folder in PENDING; an old-style folder is reused where it is', async () => {
  const root = await oneDrive();
  const job = '5. PROJECTS/G2707';
  const fresh = await ensurePackage(root, job, 'cor', { number: '3', title: 'Additional lighting circuits' });
  assert.equal(fresh.folder, `${job}/01 COST CONTROL/04 CHANGE ORDERS/1 PENDING (not yet submitted to GC)/CO 003 - Additional Lighting Circuits`);
  assert.equal(fresh.stage, 'PENDING');
  assert.deepEqual((await readdir(join(root, fresh.folder))).sort(), ['01 PRICING - BACKUP', '02 RFP-RFI REFERENCE', '03 T&M TAGS', '04 APPROVED CO DOCUMENTATION']);
  await mkdir(join(root, job, '01 COST CONTROL/CHANGE ORDERS/Change Request 073'), { recursive: true });
  const old = await ensurePackage(root, job, 'cor', { number: '73', title: 'Ice machine' });
  assert.equal(old.folder, `${job}/01 COST CONTROL/CHANGE ORDERS/Change Request 073`);
});

test('filing CO documents: right subfolder, CO number names, and the folder moves with its status', async () => {
  const db = freshDb();
  const root = await oneDrive();
  const pending = '5. PROJECTS/G2707/01 COST CONTROL/04 CHANGE ORDERS/1 PENDING (not yet submitted to GC)/CO 003 - Additional Lighting Circuits';
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'quote.pdf', project_id: 1, hint: 'CO 3 additional lighting circuits Graybar quote' }, TODAY);
  assert.equal(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path, `${pending}/01 PRICING - BACKUP/CO 003 - Additional Lighting Circuits Graybar Quote.pdf`);
  const t = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'tag.pdf', project_id: 1, hint: 'CO 3 additional lighting circuits T&M tag' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(t.id).path, /\/03 T&M TAGS\/CO 003 - .* - 2026-10-03\.pdf$/);

  // Sent to the GC: the whole CO folder moves to SUBMITTED, the proposal carries the job number, and a follow-up appears.
  const p = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'co.pdf', project_id: 1, hint: 'CO 3 additional lighting circuits proposal submitted to GC' }, TODAY);
  const submitted = pending.replace('1 PENDING (not yet submitted to GC)', '2 SUBMITTED (awaiting GC-owner approval)');
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(p.id).path, new RegExp(`^${submitted.replace(/[()]/g, '\\$&')}/01 PRICING - BACKUP/CO 003 - G2707 - `));
  assert.deepEqual(await readdir(join(root, submitted, '01 PRICING - BACKUP')).then((x) => x.length), 2);
  let [pkg] = listPackages(db);
  assert.equal(pkg.stage, 'SUBMITTED');
  assert.equal(pkg.folder, submitted);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE source = 'package' AND status != 'done' AND title LIKE 'Follow up with the GC for approval of CO 003%'").get());

  // Approved: moves to APPROVED, asks for the workbook update and the billing.
  const addTask = (x) => Number(db.prepare('INSERT INTO tasks (project_id, title, owner_id, priority, due_date, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(x.project_id, x.title, x.owner_id, x.priority, x.due_date, x.source, x.source_ref).lastInsertRowid);
  await setStage(db, pkg.id, 'APPROVED', { today: TODAY, me: 1, addTask, root, force: true });
  [pkg] = listPackages(db);
  assert.match(pkg.folder, /\/3 APPROVED\/CO 003 - /);
  const open = db.prepare("SELECT title, priority FROM tasks WHERE source = 'package' AND status != 'done' ORDER BY id").all();
  assert.deepEqual(open.map((x) => x.title.split(' CO 003')[0]), ['Update Job Control Workbook for approved', 'Bill on the next pay app:']);
});

test('a submittal with a spec section goes in its spec folder', async () => {
  const db = freshDb();
  const root = await oneDrive();
  await mkdir(join(root, '5. PROJECTS/G2707/14 SUBMITTALS/26 24 16 PANELBOARDS'), { recursive: true });
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'sub.pdf', project_id: 1, hint: 'Submittal 26 24 16 panelboards approved no exceptions taken' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path, /^5\. PROJECTS\/G2707\/14 SUBMITTALS\/26 24 16 PANELBOARDS\/G2707_BURB RPT - SUBMITTAL/);
  const [pkg] = listPackages(db);
  assert.equal(pkg.stage, 'APPROVED');
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE source = 'package' AND title LIKE 'Release equipment for Submittal 26 24 16%'").get());
  const b = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'sub2.pdf', project_id: 1, hint: 'Submittal 28 31 00 fire alarm product data' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(b.id).path, /\/14 SUBMITTALS\/28 3100 - FIRE ALARM/);
});

test('a document with no CO number still files normally', async () => {
  const db = freshDb();
  const root = await oneDrive();
  const a = await fileDocument(db, root, { buffer: Buffer.from('x'), filename: 'co log.xlsx', project_id: 1, hint: 'change order log' }, TODAY);
  assert.match(db.prepare('SELECT path FROM documents WHERE id = ?').get(a.id).path, /^5\. PROJECTS\/G2707\/01 COST CONTROL\/04 CHANGE ORDERS\/G2707_BURB RPT - CO - /);
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

test('Procore/Autodesk items can be mapped by job number', async () => {
  const { upsertItems } = await import('../server/doccontrol.js');
  const db = freshDb();
  upsertItems(db, [{ origin: 'procore', external_id: '77', type: 'rfi', number: '12', title: 'Conduit routing', project_id: 'G2707' }], TODAY);
  assert.equal(db.prepare("SELECT project_id FROM tracked_items WHERE external_id = '77'").get().project_id, 1);
});

test('a CO form PDF from the workbook creates "CO 001 - description" and compiles the package for the GC', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = async (pages) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([612, 792]); return Buffer.from(await d.save()); };
  const db = freshDb();
  const root = await oneDrive();
  const { compilePackage } = await import('../server/index.js');

  // Backup already sitting in the CO folder (filed earlier by Damian or Claude).
  const q = await fileDocument(db, root, { buffer: await pdf(2), filename: 'graybar quote.pdf', project_id: 1, hint: 'CO 1 additional lighting circuits Graybar quote' }, TODAY);
  const tm = await fileDocument(db, root, { buffer: await pdf(1), filename: 'tag.pdf', project_id: 1, hint: 'CO 1 additional lighting circuits T&M tag' }, TODAY);
  assert.equal(q.compiled, null);

  // The workbook's PDF arrives in the _Inbox: job number and job name drop out of the folder name.
  const form = await fileDocument(db, root, { buffer: await pdf(1), filename: 'G2707 - Burbank Replacement Terminal - CO 001 - Additional Lighting Circuits.pdf' }, TODAY);
  const folder = '5. PROJECTS/G2707/01 COST CONTROL/04 CHANGE ORDERS/1 PENDING (not yet submitted to GC)/CO 001 - Additional Lighting Circuits';
  assert.equal(db.prepare('SELECT path FROM documents WHERE id = ?').get(form.id).path, `${folder}/CO 001 - Additional Lighting Circuits.pdf`);
  assert.ok(db.prepare('SELECT path FROM documents WHERE id = ?').get(q.id).path.startsWith(`${folder}/01 PRICING - BACKUP/`));
  assert.ok(db.prepare('SELECT path FROM documents WHERE id = ?').get(tm.id).path.startsWith(`${folder}/03 T&M TAGS/`));

  // Contents page + form (1) + quote (2) + T&M tag (1); a spreadsheet is listed as skipped, not lost.
  assert.equal(form.compiled.path, `${folder}/CO 001 - G2707 - Additional Lighting Circuits.pdf`);
  assert.equal(form.compiled.pages, 5);
  assert.deepEqual(form.compiled.included.map((i) => i.section), ['Change order', 'Pricing & backup', 'T&M tags']);
  const built = await PDFDocument.load(await (await import('node:fs/promises')).readFile(join(root, form.compiled.path)));
  assert.equal(built.getPageCount(), 5);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE title LIKE 'Review and send CO 001 package to the GC%'").get());

  await writeFile(join(root, folder, '01 PRICING - BACKUP', 'labor.xlsx'), 'x');
  const again = await compilePackage(db, root, listPackages(db)[0].id, TODAY);
  assert.equal(again.pages, 5);
  assert.match(again.skipped[0].file, /labor\.xlsx$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Review and send CO 001%'").get().n, 1, 'one review task, not one per rebuild');
});
