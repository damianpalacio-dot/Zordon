// Claude Link: Zordon hands work to Damian's Claude (Cowork) through OneDrive.
//   Zordon/FILING.md            the filing rulebook both sides follow
//   Zordon/skills/<name>/       the team's skill library (SKILL.md each), editable from Zordon
//   Zordon/jobs/<id>-<skill>.json   work for Claude to do
//   Zordon/_Inbox/job-<id>.result.zordon.json   Claude's report back
import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isoDate } from './db.js';
import { CONTROL_DIR, INBOX, JOB_TEMPLATE, CATEGORY_FOLDERS, CATEGORY_NAMES, projectFolder, saveFile, vaultPath } from './vault.js';

const BUILTIN_DIR = fileURLToPath(new URL('../claude-skills/', import.meta.url));
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

function frontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

export async function loadBuiltinSkills(db) {
  const names = await readdir(BUILTIN_DIR).catch(() => []);
  const insert = db.prepare(`INSERT INTO skills (name, title, description, output_category, body, builtin) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(name) DO NOTHING`);
  for (const name of names) {
    const body = await readFile(join(BUILTIN_DIR, name, 'SKILL.md'), 'utf8').catch(() => null);
    if (!body) continue;
    const fm = frontMatter(body);
    insert.run(name, fm.title || name, fm.description || '', fm.output_category || null, body);
  }
}

export const listSkills = (db) => db.prepare('SELECT * FROM skills ORDER BY builtin DESC, title').all();

export function saveSkill(db, { name, title, description, output_category, body }) {
  if (!SKILL_NAME_RE.test(name || '')) throw new Error('Skill name must be lowercase letters, numbers and dashes (e.g. panel-schedule)');
  if (output_category && !CATEGORY_NAMES.includes(output_category)) throw new Error('Unknown output type');
  const text = body?.trim() ? body : `---\nname: ${name}\ndescription: ${description || title}\n---\n\n# ${title || name}\n\nDescribe the steps Claude should follow.\n`;
  db.prepare(`INSERT INTO skills (name, title, description, output_category, body, builtin, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET title = excluded.title, description = excluded.description, output_category = excluded.output_category,
      body = excluded.body, updated_at = excluded.updated_at`)
    .run(name, title || name, description || '', output_category || null, text);
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name);
}

export function filingRules(db) {
  const addenda = db ? JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'filing_addenda'").get()?.value || '[]') : [];
  const rows = Object.entries(CATEGORY_FOLDERS).filter(([c]) => c !== 'General')
    .map(([c, f]) => `| ${c} | ${f} |`).join('\n');
  return `# GEC2 filing rules (Zordon)

Every project lives in \`5. PROJECTS/<Job #>/\` (for example \`5. PROJECTS/G2707\`) with the GEC2 job start-up folders:

${JOB_TEMPLATE.map((f) => `- \`${f}\``).join('\n')}

## Where each document goes

| Document type | Folder |
|---|---|
${rows}
| Anything else | the job folder itself |

Unknown job? Save to \`Zordon/_Unfiled\` and say so.

## File names

\`<Job #>_<SHORT NAME> - <TYPE> [number] - <Description> (MM.DD.YYYY).<ext>\`

- \`G2707_BURB RPT - RFI 14 - Response Beam Penetration at C4 (10.03.2026).pdf\`
- \`G2707_BURB RPT - COR 073 - Ice and Water Machine Power (10.03.2026).pdf\`
- \`G3251_32ND ST - SUBMITTAL - Spec 26 24 16 Sub 01 - Panelboards Siemens (10.03.2026).pdf\`

Rules: Title Case description, 3–8 words that someone would recognise months later; keep acronyms and numbers
(kVA, MSB, 26 24 16); no \`\\ / : * ? " < > | # %\`. Never overwrite: if the name exists, add \` v2\`, \` v3\`.
Short names come from Zordon's roster (\`Zordon/zordon-roster.json\`).

## Claude's own work files (00 Cowork Claude)

Keep the Cowork convention: \`Current/\` holds the one live version, \`Archive/\` holds dated prior versions
(\`<name>_YYYY-MM-DD.ext\`), \`Source/\` holds scripts and .bas modules. Nothing is ever deleted; it moves to Archive.
Finished deliverables for a job are also saved into that job's folder above with a proper name.
${addenda.length ? `\n## House rules learned (approved by Damian)\n\n${addenda.map((a) => `- ${a.rule} _(approved ${a.approved_at})_`).join('\n')}\n` : ''}`;
}

function jobFile(job) {
  return `${CONTROL_DIR}/jobs/${String(job.id).padStart(4, '0')}-${job.skill}.json`;
}

function jobPayload(db, job) {
  const task = job.task_id ? db.prepare('SELECT id, title, description, due_date, priority FROM tasks WHERE id = ?').get(job.task_id) : null;
  const project = job.project_id ? db.prepare('SELECT name, code, short_name, folder, location FROM projects WHERE id = ?').get(job.project_id) : null;
  return {
    type: 'zordon.job',
    id: job.id,
    skill: job.skill,
    skill_file: `${CONTROL_DIR}/skills/${job.skill}/SKILL.md`,
    created_at: job.created_at,
    project,
    project_folder: project ? projectFolder(project) : null,
    output_folder: job.output_folder,
    task,
    instructions: job.instructions || '',
    inputs: JSON.parse(job.inputs || '[]'),
    complete_task: Boolean(job.complete_task),
    report_to: `${INBOX}/job-${job.id}.result.zordon.json`,
    report_format: { type: 'zordon.job_result', job_id: job.id, status: 'done | needs_input | failed', note: 'one short paragraph', outputs: [{ path: '<path from the OneDrive root>', title: '<what it is>' }] },
  };
}

export function createJob(db, { skill, task_id, project_id, instructions, inputs = [], complete_task = false }) {
  const s = db.prepare('SELECT * FROM skills WHERE name = ?').get(skill);
  if (!s) throw new Error(`Unknown skill: ${skill}`);
  const task = task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(task_id)) : null;
  const pid = project_id ? Number(project_id) : task?.project_id ?? null;
  const project = pid ? db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) : null;
  const sub = s.output_category ? CATEGORY_FOLDERS[s.output_category] : '';
  const output = project ? [projectFolder(project), sub].filter(Boolean).join('/') : `${CONTROL_DIR}/_Unfiled`;
  const id = Number(db.prepare(`INSERT INTO claude_jobs (task_id, project_id, skill, instructions, inputs, output_folder, complete_task)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(task?.id ?? null, pid, skill, instructions || '', JSON.stringify(inputs.filter(Boolean)), output, complete_task ? 1 : 0).lastInsertRowid);
  if (task) db.prepare('INSERT INTO task_updates (task_id, body) VALUES (?, ?)').run(task.id, `🤖 Sent to Claude: ${s.title} (job #${id})`);
  return db.prepare('SELECT * FROM claude_jobs WHERE id = ?').get(id);
}

export const listJobs = (db) => db.prepare(`SELECT j.*, s.title AS skill_title, t.title AS task_title, p.name AS project_name
  FROM claude_jobs j LEFT JOIN skills s ON s.name = j.skill LEFT JOIN tasks t ON t.id = j.task_id LEFT JOIN projects p ON p.id = j.project_id
  ORDER BY j.id DESC LIMIT 200`).all().map((j) => ({ ...j, inputs: JSON.parse(j.inputs || '[]'), outputs: JSON.parse(j.outputs || '[]') }));

// Write the rulebook, the skill library and open jobs into OneDrive for Claude to read.
export async function syncControl(db, root) {
  const put = (rel, text) => saveFile(root, rel, Buffer.from(text), { overwrite: true });
  await put(`${CONTROL_DIR}/FILING.md`, filingRules(db));
  // Skill folders someone added straight into OneDrive join the library.
  const dir = vaultPath(root, CONTROL_DIR, 'skills');
  for (const name of await readdir(dir).catch(() => [])) {
    if (!SKILL_NAME_RE.test(name) || db.prepare('SELECT 1 FROM skills WHERE name = ?').get(name)) continue;
    const body = await readFile(join(dir, name, 'SKILL.md'), 'utf8').catch(() => null);
    if (body) { const fm = frontMatter(body); saveSkill(db, { name, title: fm.title || name, description: fm.description, output_category: CATEGORY_NAMES.includes(fm.output_category) ? fm.output_category : null, body }); }
  }
  await put(`${CONTROL_DIR}/zordon-filing.json`, JSON.stringify({ projects_dir: projectFolder({ code: '' }).replace(/\/$/, ''), job_template: JOB_TEMPLATE, folders: CATEGORY_FOLDERS }, null, 2));
  for (const s of listSkills(db)) await put(`${CONTROL_DIR}/skills/${s.name}/SKILL.md`, s.body);
  for (const j of db.prepare("SELECT * FROM claude_jobs WHERE status IN ('queued', 'needs_input')").all()) {
    await put(jobFile(j), JSON.stringify(jobPayload(db, j), null, 2));
  }
}

// Claude's report: { type: 'zordon.job_result', job_id, status, note, outputs: [{ path, title }] }
export async function importJobResult(db, root, result, { categoryFor } = {}) {
  if (result?.type !== 'zordon.job_result') throw new Error('Not a zordon.job_result');
  const job = db.prepare('SELECT * FROM claude_jobs WHERE id = ?').get(Number(result.job_id));
  if (!job) throw new Error(`Unknown job ${result.job_id}`);
  const status = ['done', 'needs_input', 'failed'].includes(result.status) ? result.status : 'done';
  const outputs = (Array.isArray(result.outputs) ? result.outputs : []).filter((o) => o?.path && !String(o.path).includes('..'));
  for (const o of outputs) {
    const exists = db.prepare('SELECT id FROM documents WHERE path = ?').get(o.path);
    if (exists) continue;
    const name = String(o.path).split('/').pop();
    db.prepare(`INSERT INTO documents (project_id, task_id, title, category, original_name, path, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(job.project_id, job.task_id, o.title || name, categoryFor?.(o.path) || 'General', name, o.path, `Made by Claude (${job.skill}, job #${job.id})`);
  }
  db.prepare(`UPDATE claude_jobs SET status = ?, result_note = ?, outputs = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(status, result.note || null, JSON.stringify(outputs), job.id);
  if (job.task_id) {
    db.prepare('INSERT INTO task_updates (task_id, body) VALUES (?, ?)')
      .run(job.task_id, `🤖 Claude ${status === 'done' ? 'finished' : status === 'needs_input' ? 'needs your input on' : 'could not finish'} job #${job.id}${result.note ? `: ${result.note}` : ''}`);
    if (status === 'done' && job.complete_task) db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(isoDate(), job.task_id);
  }
  if (status !== 'needs_input') await rm(vaultPath(root, jobFile(job)), { force: true });
  return { job_id: job.id, status, outputs: outputs.length };
}

// Claude noticed a consistent new habit and proposes a rule or skill change; Damian approves in Zordon.
export function importProposal(db, p) {
  if (p?.type !== 'zordon.proposal' || !['skill', 'filing'].includes(p.kind) || !p.title) throw new Error('Not a zordon.proposal');
  if (p.kind === 'skill' && (!SKILL_NAME_RE.test(p.skill || '') || !p.body)) throw new Error('Skill proposal needs a valid skill name and body');
  if (p.kind === 'filing' && !p.rule) throw new Error('Filing proposal needs a rule');
  return Number(db.prepare('INSERT INTO proposals (kind, skill, title, evidence, rule, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.kind, p.skill || null, String(p.title).slice(0, 200), JSON.stringify((p.evidence || []).slice(0, 20)), p.rule || null, p.body || null).lastInsertRowid);
}

export function decideProposal(db, id, approve, today = isoDate()) {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ? AND status = 'open'").get(Number(id));
  if (!p) throw new Error('Proposal not found or already decided');
  if (approve && p.kind === 'skill') {
    const fm = frontMatter(p.body);
    const existing = db.prepare('SELECT * FROM skills WHERE name = ?').get(p.skill);
    saveSkill(db, { name: p.skill, title: fm.title || existing?.title || p.skill, description: fm.description || existing?.description,
      output_category: CATEGORY_NAMES.includes(fm.output_category) ? fm.output_category : existing?.output_category, body: p.body });
  }
  if (approve && p.kind === 'filing') {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'filing_addenda'").get();
    const list = JSON.parse(row?.value || '[]');
    list.push({ rule: p.rule, approved_at: today });
    db.prepare("INSERT INTO settings (key, value) VALUES ('filing_addenda', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(list));
  }
  db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(approve ? 'approved' : 'dismissed', p.id);
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
}

export const listProposals = (db) => db.prepare("SELECT * FROM proposals ORDER BY status = 'open' DESC, id DESC LIMIT 100").all()
  .map((p) => ({ ...p, evidence: JSON.parse(p.evidence || '[]') }));
