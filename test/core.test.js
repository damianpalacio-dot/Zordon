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
  const projects = [{ id: 1, name: 'Angel Grove Medical Office', code: 'AGM-101' }];
  const s = suggestHeuristic({ filename: 'scan0042.pdf', hint: 'Beam penetration at C4', text: '' }, { projects, today: TODAY });
  assert.equal(s.category, 'General');
  const rfi = suggestHeuristic({ filename: 'IMG_1234.pdf', hint: 'RFI 14 response beam at C4 AGM-101', text: '' }, { projects, today: TODAY });
  assert.equal(rfi.category, 'RFI');
  assert.equal(rfi.project_id, 1);
  assert.equal(rfi.folder, 'AGM-101-Angel-Grove-Medical-Office/04-RFIs');
  assert.match(rfi.filename, /^2026-10-03_AGM-101_RFI_.+\.pdf$/);
  assert.equal(slug('Pay app #6 — backup (final)'), 'Pay-App-6-Backup-Final');
});

test('_Inbox files are renamed and filed', async () => {
  const db = freshDb();
  const root = await mkdtemp(join(tmpdir(), 'zordon-vault-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, '_Inbox'));
  const file = join(root, '_Inbox', 'Document (3).txt');
  await writeFile(file, 'Subject: Change order 7 pricing for AGM-101 added outlets\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  const filed = await processInbox(db, root, TODAY);
  assert.equal(filed.length, 1);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(filed[0].id);
  assert.equal(doc.category, 'Change Order');
  assert.match(doc.path, /^AGM-101-Angel-Grove-Medical-Office\/02-Change-Orders\/2026-10-03_AGM-101_Change-Order_/);
  assert.deepEqual(await readdir(join(root, '_Inbox')), []);
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
