import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';

const { openDb, seedIfEmpty } = await import('../server/db.js');
const { loadBuiltinSkills, listSkills, saveSkill, createJob, syncControl, importJobResult, importProposal, decideProposal, filingRules } = await import('../server/claude.js');
const { processInbox } = await import('../server/index.js');

const TODAY = '2026-10-03';

async function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db, TODAY);
  db.prepare("UPDATE projects SET code = 'G3251', short_name = '32ND ST', folder = '5. PROJECTS/G3251' WHERE id = 1").run();
  await loadBuiltinSkills(db);
  const root = await mkdtemp(join(tmpdir(), 'zordon-claude-'));
  return { db, root };
}

const settle = async (file) => { const old = new Date(Date.now() - 60_000); await utimes(file, old, old); };

test('starter skills load with their output folders', async () => {
  const { db } = await setup();
  const skills = Object.fromEntries(listSkills(db).map((s) => [s.name, s]));
  for (const n of ['zordon-link', 'panel-schedule', 'contract-review', 'drawing-overlay', 'spec-review']) assert.ok(skills[n], n);
  assert.equal(skills['panel-schedule'].output_category, 'Drawing');
  assert.equal(skills['spec-review'].output_category, 'Specification');
  assert.equal(skills['contract-review'].title, 'Contract review (electrical sub)');
});

test('a job round-trips: queued in OneDrive, Claude reports back, task updates', async () => {
  const { db, root } = await setup();
  const task = db.prepare("SELECT id FROM tasks WHERE project_id = 1 AND status != 'done' LIMIT 1").get();
  const job = createJob(db, { skill: 'panel-schedule', task_id: task.id, instructions: 'LP-2A and LP-4 from E-601', inputs: ['5. PROJECTS/G3251/03 CONSTRUCTION SET/E-601.pdf'], complete_task: true });
  assert.equal(job.output_folder, '5. PROJECTS/G3251/03 CONSTRUCTION SET');
  await syncControl(db, root);

  const files = await readdir(join(root, 'Zordon', 'jobs'));
  assert.deepEqual(files, [`${String(job.id).padStart(4, '0')}-panel-schedule.json`]);
  const payload = JSON.parse(await readFile(join(root, 'Zordon', 'jobs', files[0]), 'utf8'));
  assert.equal(payload.skill_file, 'Zordon/skills/panel-schedule/SKILL.md');
  assert.equal(payload.report_to, `Zordon/_Inbox/job-${job.id}.result.zordon.json`);
  assert.match(await readFile(join(root, 'Zordon', 'skills', 'panel-schedule', 'SKILL.md'), 'utf8'), /GEC2_PANEL_SCHEDULE/);
  assert.match(await readFile(join(root, 'Zordon', 'FILING.md'), 'utf8'), /07 RFIS/);

  const out = '5. PROJECTS/G3251/03 CONSTRUCTION SET/G3251_32ND ST - DWG - Panel Schedules LP-2A LP-4 (10.05.2026).xlsx';
  await mkdir(join(root, 'Zordon', '_Inbox'), { recursive: true });
  const report = join(root, 'Zordon', '_Inbox', `job-${job.id}.result.zordon.json`);
  await writeFile(report, JSON.stringify({ type: 'zordon.job_result', job_id: job.id, status: 'done', note: 'LP-4 phase B heavy', outputs: [{ path: out, title: 'Panel schedules' }, { path: '../../etc/passwd' }] }));
  await settle(report);
  await processInbox(db, root, TODAY);

  const done = db.prepare('SELECT * FROM claude_jobs WHERE id = ?').get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(JSON.parse(done.outputs).length, 1, 'paths escaping the OneDrive root are ignored');
  const doc = db.prepare('SELECT * FROM documents WHERE path = ?').get(out);
  assert.equal(doc.category, 'Drawing');
  assert.equal(doc.task_id, task.id);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'done');
  assert.deepEqual(await readdir(join(root, 'Zordon', 'jobs')), [], 'the job file is cleared');
  await assert.rejects(() => importJobResult(db, root, { type: 'zordon.job_result', job_id: 999 }));
});

test('habit proposals need approval before they change anything', async () => {
  const { db, root } = await setup();
  const ruleId = importProposal(db, { type: 'zordon.proposal', kind: 'filing', title: 'Meeting minutes go in 10 CORRESPONDENCE/MEETINGS', rule: 'File meeting minutes in 10 CORRESPONDENCE/MEETINGS.', evidence: ['3 files on 9/28, 10/1, 10/2'] });
  assert.doesNotMatch(filingRules(db), /MEETINGS/);
  decideProposal(db, ruleId, true, TODAY);
  assert.match(filingRules(db), /House rules learned[\s\S]*10 CORRESPONDENCE\/MEETINGS/);

  const body = '---\nname: rfi-draft\ndescription: Draft RFIs the GEC2 way\nmetadata:\n  title: RFI drafting\n  output_category: RFI\n---\n# RFI drafting\n';
  const skillId = importProposal(db, { type: 'zordon.proposal', kind: 'skill', skill: 'rfi-draft', title: 'New RFI skill', body });
  const dismissed = importProposal(db, { type: 'zordon.proposal', kind: 'skill', skill: 'junk', title: 'Nope', body: 'x' });
  decideProposal(db, dismissed, false);
  assert.equal(db.prepare("SELECT 1 FROM skills WHERE name = 'junk'").get(), undefined);
  decideProposal(db, skillId, true);
  const s = db.prepare("SELECT * FROM skills WHERE name = 'rfi-draft'").get();
  assert.equal(s.title, 'RFI drafting');
  assert.equal(s.output_category, 'RFI');
  assert.throws(() => decideProposal(db, skillId, true), /already decided/);
  assert.throws(() => importProposal(db, { type: 'zordon.proposal', kind: 'skill', skill: '../evil', title: 'x', body: 'x' }));

  // Proposal files dropped by Claude are picked up from the inbox.
  await mkdir(join(root, 'Zordon', '_Inbox'), { recursive: true });
  const f = join(root, 'Zordon', '_Inbox', 'proposal-x.proposal.zordon.json');
  await writeFile(f, JSON.stringify({ type: 'zordon.proposal', kind: 'filing', title: 'x', rule: 'y' }));
  await settle(f);
  await processInbox(db, root, TODAY);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM proposals WHERE status = 'open'").get().n, 1);
});

test('skills added straight into OneDrive join the library; bad names are rejected', async () => {
  const { db, root } = await setup();
  await mkdir(join(root, 'Zordon', 'skills', 'takeoff-count'), { recursive: true });
  await writeFile(join(root, 'Zordon', 'skills', 'takeoff-count', 'SKILL.md'), '---\nname: takeoff-count\ndescription: Count devices\n---\n# Takeoff\n');
  await syncControl(db, root);
  assert.ok(db.prepare("SELECT 1 FROM skills WHERE name = 'takeoff-count'").get());
  assert.throws(() => saveSkill(db, { name: 'Bad Name!' }), /lowercase/);
});

test('a newer built-in skill replaces the old copy, but never a skill Damian edited', async () => {
  const { db } = await setup();
  db.prepare("UPDATE skills SET body = 'old shipped version' WHERE name = 'spec-review'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'builtin_skill_hashes'")
    .run(JSON.stringify({ ...JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'builtin_skill_hashes'").get().value),
      'spec-review': (await import('node:crypto')).createHash('sha1').update('old shipped version').digest('hex') }));
  db.prepare("UPDATE skills SET body = 'Damian edited this' WHERE name = 'panel-schedule'").run();
  await loadBuiltinSkills(db);
  assert.match(db.prepare("SELECT body FROM skills WHERE name = 'spec-review'").get().body, /^---/);
  assert.equal(db.prepare("SELECT body FROM skills WHERE name = 'panel-schedule'").get().body, 'Damian edited this');
});
