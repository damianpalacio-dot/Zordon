import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';

const { openDb, seedIfEmpty, addDays } = await import('../server/db.js');
const { parseDate, parseTime, analyzeHeuristic } = await import('../server/intel.js');
const { taskHealth, moneyPriority, realityCheck, reminderDrafts, dashboard, myNudges } = await import('../server/ops.js');
const { classify, parseNotificationEmail, upsertItems, normalizeSpec } = await import('../server/doccontrol.js');
const { parseCsv, parseScheduleDate, importSchedule, lookahead, equipmentLog, runRoutines } = await import('../server/schedule.js');
const { suggestHeuristic, slug } = await import('../server/vault.js');
const { impacts } = await import('../server/weather.js');
const { createVoiceSession } = await import('../server/voice.js');
const { processInbox } = await import('../server/index.js');

const TODAY = '2026-10-03'; // a Saturday

function freshDb() {
  const db = openDb(':memory:');
  seedIfEmpty(db, TODAY);
  return db;
}

test('relative dates resolve against today', () => {
  assert.equal(parseDate('by tomorrow', TODAY), '2026-10-04');
  assert.equal(parseDate('please send by Friday', TODAY), '2026-10-09');
  assert.equal(parseDate('due 10/15', TODAY), '2026-10-15');
  assert.equal(parseDate('on Oct 20th', TODAY), '2026-10-20');
  assert.equal(parseDate('in January 5', TODAY), '2027-01-05'); // a past month rolls to next year
  assert.equal(parseDate('no date here', TODAY), null);
  assert.equal(parseTime('at 1:30pm'), '13:30');
  assert.equal(parseTime('10am'), '10:00');
});

test('email heuristics pull tasks, owners, projects and meetings', () => {
  const db = freshDb();
  const people = db.prepare('SELECT * FROM people').all();
  const projects = db.prepare('SELECT * FROM projects').all();
  const out = analyzeHeuristic({
    subject: 'AGM-101 pour',
    body: 'Please have Marcus confirm the pump truck by Friday.\nWe need Tina to send the panel schedule ASAP.\nOAC meeting moved to Oct 9 at 10am.',
  }, { people, projects, today: TODAY });
  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[0].owner_id, people.find((p) => p.name.startsWith('Marcus')).id);
  assert.equal(out.tasks[0].due_date, '2026-10-09');
  assert.equal(out.tasks[1].title, 'Tina to send the panel schedule ASAP');
  assert.equal(out.tasks[1].priority, 'critical');
  assert.equal(out.tasks[1].due_date, TODAY);
  assert.equal(out.meetings[0].starts_at, '2026-10-09T10:00');
  assert.equal(out.tasks[0].project_id, projects[0].id);
});

test('task health and money priority', () => {
  assert.equal(taskHealth({ status: 'working', due_date: '2026-10-01' }, TODAY), 'delayed');
  assert.equal(taskHealth({ status: 'working', due_date: '2026-10-05' }, TODAY), 'due_soon');
  assert.equal(taskHealth({ status: 'done', due_date: '2026-10-01' }, TODAY), 'done');
  assert.equal(moneyPriority({ title: 'Price change order #4', priority: 'low', due_date: '2026-10-20' }, TODAY), 'high');
  assert.equal(moneyPriority({ title: 'Submit pay app', priority: 'medium', due_date: '2026-10-05' }, TODAY), 'critical');
  assert.equal(moneyPriority({ title: 'Clean site', priority: 'low' }, TODAY), 'low');
  assert.equal(moneyPriority({ title: "Review Liz's WIP report", priority: 'medium' }, TODAY), 'high');
  assert.equal(moneyPriority({ title: 'Update pending change orders list', priority: 'low', due_date: '2026-10-04' }, TODAY), 'critical');
});

test('dashboard puts cash flow first and counts delays', () => {
  const db = freshDb();
  const d = dashboard(db, TODAY);
  assert.equal(d.counts.delayed, 2);
  assert.ok(d.money.length >= 2);
  assert.ok(d.money.every((t) => ['high', 'critical'].includes(t.priority)));
  assert.match(d.briefing, /Cash flow first/);
});

test('reminder drafts go to people with late or soon-due work', () => {
  const db = freshDb();
  const drafts = reminderDrafts(db, TODAY);
  const marcus = drafts.find((x) => x.name.startsWith('Marcus'));
  assert.ok(marcus);
  assert.match(marcus.subject, /past-due/);
  assert.match(marcus.body, /Pour level 2 slab/);
});

test('reality check projects finish dates at real capacity', () => {
  const db = freshDb();
  const pm = db.prepare("SELECT id FROM people WHERE role = 'Project Manager'").get().id;
  const r = realityCheck(db, pm, TODAY, 1); // 1 focus hour a day
  assert.ok(r.at_risk.length > 0, 'with 1h/day something must be at risk');
  assert.ok(r.advice.length > 0);
  const relaxed = realityCheck(db, pm, TODAY, 12);
  assert.ok(relaxed.at_risk.length < r.at_risk.length);
  assert.equal(r.avg_slip_days, 2); // the seeded owner report finished 2 days late
  const nudges = myNudges(db, pm, TODAY);
  assert.ok(nudges.some((n) => n.money && /money/.test(n.nudge)));
});

test('spec sections classify into watch groups; spec beats keywords', () => {
  assert.equal(normalizeSpec('260519'), '26 05 19');
  assert.deepEqual(classify({ spec_section: '26 51 00', title: 'Interior lighting fixtures' }), ['div26']);
  assert.deepEqual(classify({ spec_section: '23 74 13', title: 'RTU' }), ['hvac']);
  assert.deepEqual(classify({ spec_section: '08 44 13', title: 'Curtain wall' }), ['glazing']);
  assert.deepEqual(classify({ spec_section: '06 41 16', title: 'Casework' }), ['millwork']);
  assert.deepEqual(classify({ title: 'Water heater cut sheets' }), ['plumbing']);
});

test('Procore notification emails become tracked items and my tasks', () => {
  const db = freshDb();
  const [item] = parseNotificationEmail({
    sender: 'notifications@procore.com',
    subject: 'Submittal #26 51 00-1: Interior lighting fixtures - Action Required',
    body: 'Project: AGM-101 Angel Grove Medical Office\nYou are the ball in court.\nSpec Section: 26 51 00\nDue Date: 10/08/2026\nStatus: Open',
  }, TODAY);
  assert.equal(item.type, 'submittal');
  assert.equal(item.number, '26 51 00-1');
  assert.equal(item.title, 'Interior lighting fixtures');
  assert.equal(item.due_date, '2026-10-08');
  assert.equal(item.assigned_to_me, true);

  const changes = upsertItems(db, [item], TODAY);
  assert.equal(changes[0].change, 'new');
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'doccontrol' AND title LIKE '%lighting%'").get();
  assert.ok(task, 'a task lands on my list');
  assert.equal(task.due_date, '2026-10-08');

  // Approved later (e.g. from the Procore sync) → the task closes itself.
  upsertItems(db, [{ ...item, source: 'procore', status: 'Approved', assigned_to_me: false }], TODAY);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'done');
});

test('non-notification emails are ignored by the doc parser', () => {
  assert.deepEqual(parseNotificationEmail({ sender: 'bob@gc.com', subject: 'RFI question', body: 'call me' }), []);
});

test('schedule CSV import and 3-week look-ahead variance', () => {
  const db = freshDb();
  assert.deepEqual(parseCsv('a,"b, c",d\n1,2,3\n'), [['a', 'b, c', 'd'], ['1', '2', '3']]);
  assert.equal(parseScheduleDate('15-Oct-26 A'), '2026-10-15');
  assert.equal(parseScheduleDate('10/15/2026'), '2026-10-15');
  assert.equal(parseScheduleDate('Thu Oct 15, 2026'), '2026-10-15');

  const project = db.prepare('INSERT INTO projects (name, code) VALUES (?, ?)').run('Test', 'T-1').lastInsertRowid;
  importSchedule(db, project, 'Activity ID,Activity Name,Start,Finish\nX1,Pour footings,10/05/2026,10/09/2026\nX2,Steel,10/12/2026,10/16/2026\n', 'baseline');
  importSchedule(db, project, 'Activity ID,Activity Name,Start,Finish,% Complete\nX1,Pour footings,10/06/2026,10/12/2026,10\nX2,Steel,10/30/2026,11/05/2026,0\n', 'current');
  const la = lookahead(db, { project_id: project }, TODAY);
  const x1 = la.activities.find((a) => a.activity_id === 'X1');
  assert.equal(x1.finish_variance, 3);
  assert.equal(x1.flag, 'slipped');
  assert.ok(la.pushed_out.some((a) => a.activity_id === 'X2'), 'X2 was promised in the window but moved out');
});

test('equipment release-by comes from the schedule and lead time', () => {
  const db = freshDb();
  const log = equipmentLog(db, {}, TODAY);
  const msb = log.find((e) => e.name.startsWith('Main switchboard'));
  // A1080 current start is today+34; 4 weeks lead + 7 day buffer → today-1.
  assert.equal(msb.need_by, addDays(TODAY, 34));
  assert.equal(msb.release_by, addDays(TODAY, -1));
  assert.equal(msb.state, 'release_overdue');
});

test('routines create weekly and monthly tasks once', () => {
  const db = freshDb();
  const created = runRoutines(db, TODAY); // Saturday → Monday look-ahead review is 2 days out
  const titles = created.map((id) => db.prepare('SELECT title, due_date FROM tasks WHERE id = ?').get(id));
  assert.ok(titles.some((t) => /look-ahead/.test(t.title) && t.due_date === '2026-10-05'));
  assert.deepEqual(runRoutines(db, TODAY), [], 'no duplicates on a second run');
  const billing = runRoutines(db, '2026-10-16'); // pay app on the 20th enters its runway
  const t = billing.map((id) => db.prepare('SELECT title, priority, due_date FROM tasks WHERE id = ?').get(id)).find((x) => /pay application/.test(x.title));
  assert.equal(t.due_date, '2026-10-20');
  assert.equal(t.priority, 'high');
});

test('file names follow the convention', () => {
  const projects = [
    { id: 1, name: 'Burbank Airport SWA Terminal', code: 'G2707', short_name: 'BURB RPT' },
    { id: 2, name: '32nd St / USC Magnet', code: 'G3251', short_name: '32ND ST' },
  ];
  const name = (x) => suggestHeuristic(x, { projects, today: TODAY });
  const s = name({ filename: 'scan0042.pdf', hint: 'Beam penetration at C4', text: '' });
  assert.equal(s.category, 'General');
  assert.equal(s.folder, 'Zordon/_Unfiled');
  const rfi = name({ filename: 'IMG_1234.pdf', hint: 'RFI 14 response beam penetration at C4 G2707' });
  assert.equal(rfi.project_id, 1);
  assert.equal(rfi.folder, '5. PROJECTS/G2707/07 RFIS');
  assert.equal(rfi.filename, 'G2707_BURB RPT - RFI 14 - Response Beam Penetration at C4 (10.03.2026).pdf');
  assert.equal(name({ filename: 'COR 073 CA#291-5777.pdf', project_id: 1 }).filename, 'G2707_BURB RPT - COR 073 - CA 291-5777 (10.03.2026).pdf');
  const sub = name({ filename: 'G3251 - 32nd St - Spec 26 2416 Sub 01 - Panelboards Siemens.pdf' });
  assert.equal(sub.folder, '5. PROJECTS/G3251/14 SUBMITTALS');
  projects[1].folder = '5. PROJECTS/LAUSD 32ND ST'; // jobs whose folder isn't named by number
  assert.equal(name({ filename: 'x.pdf', hint: 'RFI 9 conduit', project_id: 2 }).folder, '5. PROJECTS/LAUSD 32ND ST/07 RFIS');
  delete projects[1].folder;
  assert.equal(sub.filename, 'G3251_32ND ST - SUBMITTAL - Spec 26 2416 Sub 01 - Panelboards Siemens (10.03.2026).pdf');
  assert.equal(name({ filename: 'x.pdf', hint: 'Pay app 6 backup', project_id: 2 }).folder, '5. PROJECTS/G3251/01 COST CONTROL');
  assert.equal(slug('Pay app #6 — backup (final)'), 'Pay-App-6-Backup-Final');
});

test('_Inbox files are renamed and filed', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-vault-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'Zordon', '_Inbox'), { recursive: true });
  const file = join(root, 'Zordon', '_Inbox', 'Document (3).txt');
  await writeFile(file, 'Subject: Change order 7 pricing for AGM-101 added outlets\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  const filed = await processInbox(db, root, TODAY);
  assert.equal(filed.length, 1);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(filed[0].id);
  assert.equal(doc.category, 'COR');
  assert.match(doc.path, /^5\. PROJECTS\/AGM-101\/01 COST CONTROL\/AGM-101_ANGEL GROVE MEDICAL - COR 7 - Pricing for Added Outlets \(10\.03\.2026\)\.txt$/);
  assert.deepEqual(await readdir(join(root, 'Zordon', '_Inbox')), []);
});

test('weather impacts flag crane, rain, heat and freeze days', () => {
  const flags = impacts({ code: 95, temp_max_f: 98, temp_min_f: 70, precip_prob: 60, precip_in: 0.3, wind_max_mph: 18, wind_gust_mph: 35 }).map((x) => x.text);
  assert.ok(flags.some((t) => /Rain/.test(t)));
  assert.ok(flags.some((t) => /crane/.test(t)));
  assert.ok(flags.some((t) => /Heat/.test(t)));
  assert.ok(flags.some((t) => /Lightning/.test(t)));
  assert.deepEqual(impacts({ code: 0, temp_max_f: 75, temp_min_f: 55, precip_prob: 0, precip_in: 0, wind_max_mph: 5, wind_gust_mph: 8 }), []);
});

test('voice: a quick reload cancels the farewell and skips the greeting', () => {
  const v = createVoiceSession({ farewellDelayMs: 10_000 });
  assert.equal(v.hello('hi').spoken, false); // voice is off in tests, but the greeting is attempted
  v.goodbye();
  assert.equal(v.hello('hi').reason, 'reload');
});

test('electrical: lead times, critical-path priority and the energization plan', async () => {
  const { leadTime, createElectricalPlan, ELECTRICAL_PLAN } = await import('../server/electrical.js');
  assert.equal(leadTime('Main switchboard MSB').label, 'Switchboard');
  assert.equal(leadTime('MV switchgear lineup').label, 'Switchgear');
  assert.equal(leadTime('LP-2A panelboard').label, 'Panelboards');
  assert.equal(leadTime('Office chairs'), null);
  assert.equal(moneyPriority({ title: 'Schedule utility energization', priority: 'low' }, TODAY), 'high');

  const db = freshDb();
  const ids = createElectricalPlan(db, 1, '2027-03-01', TODAY);
  assert.equal(ids.length, ELECTRICAL_PLAN.length);
  const energize = db.prepare("SELECT * FROM tasks WHERE source = 'electrical_plan' AND title LIKE 'Energization%'").get();
  assert.equal(energize.due_date, '2027-03-01');
  assert.equal(energize.owner_id, db.prepare("SELECT id FROM people WHERE role = 'Project Manager'").get().id);
  const utility = db.prepare("SELECT * FROM tasks WHERE title LIKE 'Submit utility service%'").get();
  assert.equal(utility.due_date, '2026-05-05'); // 300 days earlier: already behind, and it shows
});

test('hourly email batches import once, assign by name and land on the board', async () => {
  const { importEmailBatch } = await import('../server/index.js');
  const db = freshDb();
  const batch = {
    type: 'zordon.emails',
    auto_accept: true,
    emails: [{
      message_id: 'AAMk-1',
      sender: 'gc@builder.com',
      subject: 'L2 pour and CO #5',
      received_at: '2026-10-03T15:02:00Z',
      body: 'Marcus please confirm the pump. Jordan, price CO #5 by Tuesday.',
      tasks: [
        { title: 'Confirm pump truck for L2 pour', owner: 'Marcus Hill', project: 'AGM-101', due_date: '2026-10-05', priority: 'high' },
        { title: 'Price change order #5', owner: 'jordan.lee@example.com', project: 'Command Center Retrofit', due_date: '2026-10-06', priority: 'low' },
        { title: 'Reply to GC about delivery', owner: 'Nobody Known', due_date: 'next week' },
      ],
      meetings: [{ title: 'Pour walk', starts_at: '2026-10-05T07:00', project: 'AGM-101' }],
    }],
  };
  const r = importEmailBatch(db, batch, TODAY);
  assert.deepEqual([r.emails, r.tasks, r.meetings, r.duplicates], [1, 3, 1, 0]);
  const pump = db.prepare("SELECT * FROM tasks WHERE title LIKE 'Confirm pump%'").get();
  assert.equal(pump.owner_id, db.prepare("SELECT id FROM people WHERE name = 'Marcus Hill'").get().id);
  assert.equal(pump.project_id, 1);
  assert.equal(pump.source, 'email');
  const co = db.prepare("SELECT * FROM tasks WHERE title LIKE 'Price change order%'").get();
  assert.equal(co.owner_id, db.prepare("SELECT id FROM people WHERE name = 'Jordan Lee'").get().id);
  assert.ok(['high', 'critical'].includes(co.priority), 'change orders never sit low');
  const reply = db.prepare("SELECT * FROM tasks WHERE title LIKE 'Reply to GC%'").get();
  assert.equal(reply.owner_id, null);
  assert.equal(reply.due_date, null, 'unparseable dates are dropped, not guessed');
  assert.equal(importEmailBatch(db, batch, TODAY).duplicates, 1, 'the next hourly check does not duplicate it');
  assert.throws(() => importEmailBatch(db, { emails: [] }, TODAY));

  const r2 = importEmailBatch(db, {
    type: 'zordon.emails',
    projects: [{ name: 'Fairfax HS Modernization', code: 'FAIRFAX' }, { name: 'Angel Grove Medical Office', code: 'AGM-101' }],
    emails: [{ message_id: 'AAMk-2', subject: 'DP-3 gear', tasks: [{ title: 'Track Eaton DP-3 responses', project: 'FAIRFAX' }] }],
  }, TODAY);
  assert.equal(r2.new_projects, 1, 'only the unknown job is created');
  const eaton = db.prepare("SELECT t.*, p.code FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title LIKE 'Track Eaton%'").get();
  assert.equal(eaton.code, 'FAIRFAX');
});

test('email batch files dropped in _Inbox are imported, not filed as documents', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-batch-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'Zordon', '_Inbox'), { recursive: true });
  const file = join(root, 'Zordon', '_Inbox', 'emails-2026-10-03T1500.zordon.json');
  await writeFile(file, JSON.stringify({ type: 'zordon.emails', emails: [{ message_id: 'x1', subject: 'Hi', tasks: [{ title: 'Send panel schedule' }] }] }));
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  assert.deepEqual(await processInbox(db, root, TODAY), []);
  assert.ok(db.prepare("SELECT id FROM tasks WHERE title = 'Send panel schedule'").get());
  assert.deepEqual(await readdir(join(root, 'Zordon', '_Inbox')), ['.imported']);
});

test('team-only emails end with a Zordon quote; outside emails stay plain', async () => {
  const { isTeamOnly, withSignOff, zordonQuote, QUOTES } = await import('../server/quotes.js');
  assert.ok(isTeamOnly(['Vick@gec2.com', 'chase@GEC2.com'], 'gec2.com'));
  assert.ok(!isTeamOnly(['Vick@gec2.com', 'dmartinez@pankow.com'], 'gec2.com'));
  assert.ok(!isTeamOnly([], 'gec2.com'));
  assert.match(withSignOff('Hi', ['vick@gec2.com'], 'gec2.com', TODAY, 1), /\n\n".+"\n— Zordon$/);
  assert.equal(withSignOff('Hi', ['gc@pankow.com'], 'gec2.com', TODAY, 1), 'Hi');
  const all = [...QUOTES.fun, ...QUOTES.serious];
  const seen = new Set(Array.from({ length: 10 }, (_, i) => zordonQuote(addDays(TODAY, i))));
  assert.ok([...seen].every((q) => all.includes(q)) && seen.size > 3, 'rotates through fun and serious lines');

  const db = freshDb(); // PM is Damian@gec2.com; demo foremen are @example.com
  db.prepare("UPDATE people SET email = 'marcus@gec2.com' WHERE name = 'Marcus Hill'").run();
  const drafts = reminderDrafts(db, TODAY);
  assert.match(drafts.find((d) => d.name === 'Marcus Hill').body, /— Zordon$/);
  assert.doesNotMatch(drafts.find((d) => d.name === 'Tina Nguyen').body, /Zordon/);
});

test('jobs find their existing OneDrive folder by number, "number - title", or name', async () => {
  const { folderScore, findJobFolder } = await import('../server/vault.js');
  const { linkJobFolders } = await import('../server/index.js');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'zordon-jobs-'));
  // Mirrors Damian's OneDrive.
  for (const d of ['5. PROJECTS/G2707', '5. PROJECTS/BUR Siemens Pathways', '5. PROJECTS/(E) BURB SWA TEMP POWER', '5. PROJECTS/LAUSD 32ND ST',
    '5. PROJECTS/FAIRFAX SLD', '5. PROJECTS/G3052', '5. PROJECTS/G2853', 'G2379 - LGB ATCT', 'G2853 - CHES HVAC UPGRADES']) {
    await mkdir(join(root, d), { recursive: true });
  }
  const bur = { code: 'G2707', name: 'Burbank Airport Replacement Passenger Terminal (SWA)', short_name: 'BURB RPT' };
  assert.equal(await findJobFolder(root, bur), '5. PROJECTS/G2707');
  assert.equal(await findJobFolder(root, { code: 'G3251', name: 'LAUSD 32nd St / USC Magnet', short_name: '32ND ST' }), '5. PROJECTS/LAUSD 32ND ST');
  assert.equal(await findJobFolder(root, { code: 'G3052', name: 'Fairfax High School Modernization' }), '5. PROJECTS/G3052', 'job number beats a similar name');
  assert.equal(await findJobFolder(root, { code: 'G2379', name: 'Long Beach ATCT' }), 'G2379 - LGB ATCT');
  assert.equal(await findJobFolder(root, { code: 'G2853', name: 'CHES HVAC Upgrades' }), '5. PROJECTS/G2853', 'the projects folder wins over the root');
  assert.equal(await findJobFolder(root, { code: 'G9999', name: 'Brand New Job' }), null);
  assert.equal(folderScore('G2489 - CHES IN _ CR', { code: 'G2707', name: 'CHES IN CR' }), 0, "never take another job's numbered folder");
  assert.equal(folderScore('ST', { code: 'X', name: 'LAUSD 32nd St' }), 0, 'one shared word is not enough');

  const db = freshDb();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('LAUSD 32nd St / USC Magnet', 'G3251', '32ND ST'), ('Long Beach ATCT', 'G2379', 'LGB ATCT')").run();
  db.prepare("INSERT INTO projects (name, code, folder) VALUES ('Hand set', 'G2707', 'Somewhere/Else')").run();
  const linked = await linkJobFolders(db, root);
  assert.deepEqual(linked.map((l) => l.folder).sort(), ['5. PROJECTS/LAUSD 32ND ST', 'G2379 - LGB ATCT']);
  assert.equal(db.prepare("SELECT folder FROM projects WHERE name = 'Hand set'").get().folder, 'Somewhere/Else', 'a folder set by hand is kept');
});

test('documents land in the folder that best describes them, including the team\'s own subfolders', async () => {
  const { refineFolder, subfolderScore } = await import('../server/vault.js');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'zordon-best-'));
  for (const d of ['5. PROJECTS/G2707/07 RFIS', '5. PROJECTS/G2707/ERCCS', '5. PROJECTS/G2707/IFC SET CHANGES', '5. PROJECTS/G2707/14 SUBMITTALS/26 24 16 PANELBOARDS',
    '5. PROJECTS/G2707/14 SUBMITTALS/28 31 00 FIRE ALARM', '5. PROJECTS/G3052/EXISTING PANELS', '5. PROJECTS/G3052/14 SUBMITTALS']) {
    await mkdir(join(root, d), { recursive: true });
  }
  const job = '5. PROJECTS/G2707';
  assert.equal(await refineFolder(root, `${job}/14 SUBMITTALS`, job, 'Submittal ERCCS radio coverage test plan'), `${job}/ERCCS`);
  assert.equal(await refineFolder(root, `${job}/04 DESIGN CHANGES`, job, 'IFC set changes level 2 south'), `${job}/IFC SET CHANGES`);
  assert.equal(await refineFolder(root, `${job}/14 SUBMITTALS`, job, 'Spec 26 24 16 panelboards Siemens rev 1'), `${job}/14 SUBMITTALS/26 24 16 PANELBOARDS`);
  assert.equal(await refineFolder(root, `${job}/14 SUBMITTALS`, job, 'Lighting fixtures cut sheets'), `${job}/14 SUBMITTALS`, 'no good match keeps the standard folder');
  assert.equal(await refineFolder(root, `${job}/07 RFIS`, job, 'RFI 14 response'), `${job}/07 RFIS`, 'generic words never decide');
  assert.equal(await refineFolder(root, '5. PROJECTS/G3052/03 CONSTRUCTION SET', '5. PROJECTS/G3052', 'Existing panels survey HM1 photos'), '5. PROJECTS/G3052/EXISTING PANELS');
  assert.equal(subfolderScore('SUB', 'submittal sub 01'), 0);

  // End to end through the _Inbox.
  const db = freshDb();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('Burbank Airport Replacement Passenger Terminal', 'G2707', 'BURB RPT')").run();
  await mkdir(join(root, 'Zordon', '_Inbox'), { recursive: true });
  const f = join(root, 'Zordon', '_Inbox', 'G2707 ERCCS submittal radio coverage.txt');
  await writeFile(f, 'ERCCS submittal');
  await utimes(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const [filed] = await processInbox(db, root, TODAY);
  const doc = db.prepare('SELECT path FROM documents WHERE id = ?').get(filed.id);
  assert.match(doc.path, /^5\. PROJECTS\/G2707\/ERCCS\/G2707_BURB RPT - SUBMITTAL - /);
});

test('first start loads the real team and jobs from the OneDrive roster', async () => {
  const { seedFromRoster } = await import('../server/index.js');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'zordon-roster-'));
  await mkdir(join(root, 'Zordon'), { recursive: true });
  await writeFile(join(root, 'Zordon', 'zordon-roster.json'), JSON.stringify({
    me: { email: 'Damian@gec2.com' },
    people: [{ name: 'Vick Deguzman', role: 'Project Engineer', email: 'Vick@gec2.com' }, { name: 'Damian Palacio', role: 'Project Manager', email: 'damian@gec2.com' }],
    projects: [{ name: 'LAUSD 32nd St', code: 'G3251', short_name: '32ND ST', folder: '5. PROJECTS/LAUSD 32ND ST' }, { name: 'Old job', code: 'G2245', status: 'closed' }, { name: 'Bad', folder: '../x' }],
  }));
  const db = openDb(':memory:');
  assert.equal(await seedFromRoster(db, root), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 2);
  const me = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'me_person_id'").get().value);
  assert.equal(db.prepare('SELECT name FROM people WHERE id = ?').get(Number(me)).name, 'Damian Palacio');
  assert.equal(db.prepare("SELECT folder FROM projects WHERE code = 'G3251'").get().folder, '5. PROJECTS/LAUSD 32ND ST');
  assert.equal(db.prepare("SELECT status FROM projects WHERE code = 'G2245'").get().status, 'closed');
  assert.equal(db.prepare("SELECT folder FROM projects WHERE name = 'Bad'").get().folder, null);
  assert.ok(db.prepare("SELECT 1 FROM routines WHERE title LIKE '%WIP%' AND weekday = 4").get(), "Liz's WIP review is a standing Thursday reminder");
  assert.equal(await seedFromRoster(db, root), false, 'never runs twice');
  assert.equal(await seedFromRoster(openDb(':memory:'), await mkdtemp(join(tmpdir(), 'zordon-none-'))), false, 'no roster, no seed');
});
