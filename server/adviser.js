// The financial adviser: Claude (Opus 5.5) with tools over Zordon's money data. It answers change order, billing and
// cost questions the way Claude would, but grounded in the jobs' real numbers: tracked change orders, billing and CO
// tasks, each job's Job Control Workbook (read-only), the pending workbook updates, and the GEC2 Job Control skills.
// It can also search the web and add a follow-up task to the board. It never sends email or edits the workbook.
import { readFile } from 'node:fs/promises';
import { isoDate } from './db.js';
import { listTasks } from './ops.js';
import { listPackages, WORKBOOK_FILE } from './packages.js';
import { findWorkbook, readWorkbook, readSheet } from './workbook.js';
import { projectFolder, vaultPath } from './vault.js';

export const ADVISER_MODEL = process.env.ZORDON_ADVISER_MODEL || process.env.ZORDON_MODEL || 'claude-opus-5-5';
const MAX_STEPS = 12;

const SYSTEM = `You are Zordon, the financial adviser to Damian Palacio, a project manager at GEC2 (GECTWO Inc.), an
electrical contractor in Southern California (IBEW Local 11). You think and work like Claude: careful, candid,
quantitative, and practical. Your job is to protect and grow the money on his jobs: change orders (COs), billing and pay
apps, labor rates, subcontractor and vendor costs, and the GEC2 Job Control Workbook for each job.

How to work:
- Ground every number in a tool result. Look things up before answering; never invent a dollar amount, date, CO
  number or status. If the data isn't there, say exactly what is missing and where it would live.
- Be direct. Lead with the answer or the recommendation, then the numbers that support it. Short tables are fine.
- Think like a CFO for the job: unbilled approved COs, COs submitted long ago with no answer (30+ working days is
  "lapsed"), pending work being done without a signed CO, retention, cash flow timing, and anything due this week.
- When you recommend an action, offer to put it on his board with add_task (due date and priority included).
  Billing and change order items are never below High priority.
- Follow the GEC2 Job Control rules (read the matching skill with read_skill when a question touches them): CO
  numbering and folders, what goes in a CO package and in what order, labor rate rules (double time is the same on
  every shift), sub quote / LOI / PO filing, and the pending workbook updates list.
- The Job Control Workbook (.xlsm) is the source of truth for CO values and billing. You can read it; you never edit it.
- Never send an email to a GC or anyone else; at most, draft the text for Damian to send.
- Use web search for things outside his data (an IBEW rate bulletin, a lien law deadline, a material price trend) and
  say where the information came from.
- Contract and legal points are a review aid, not legal advice; say so when it matters.`;

const TOOLS = [
  { name: 'list_jobs', description: 'All jobs (projects) with id, job number (code), name, short name, status and OneDrive folder.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_change_orders', description: 'Tracked change orders: number, title, job, stage (PENDING, SUBMITTED, APPROVED, BILLED, REJECTED), amount if known, folder and stage history with dates. Optionally for one job or open ones only.',
    input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, open_only: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'list_money_tasks', description: 'Open billing and change order tasks on the board (pay apps, CO follow-ups, workbook updates) with owner, due date, priority and health (delayed, due soon, on track).',
    input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, include_done: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'read_job_workbook', description: "Read a job's GEC2 Job Control Workbook (.xlsm, read-only, values as last saved in Excel). Without a sheet: the list of sheets and the Dashboard's label/value pairs (contract, change orders, billing). With a sheet name: that sheet's rows.",
    input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, sheet: { type: 'string' } }, required: ['project_id'], additionalProperties: false } },
  { name: 'pending_workbook_updates', description: 'The _PENDING WORKBOOK UPDATES.txt list: CO status changes not yet entered in the Job Control Workbooks (OPEN lines) and the resolved ones.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_skill', description: 'Read one of the GEC2 skills in full (rules Damian set for change orders, job setup, labor rates, PO filing, and more). The list of skills is in the instructions.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  { name: 'add_task', description: "Put a follow-up on Damian's board. Use when he agrees to an action or asks you to track something.",
    input_schema: { type: 'object', properties: {
      title: { type: 'string' }, project_id: { type: 'integer' }, due_date: { type: 'string', description: 'YYYY-MM-DD' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, description: { type: 'string' },
    }, required: ['title'], additionalProperties: false } },
];
const SERVER_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
];

const json = (v) => JSON.stringify(v, null, 1).slice(0, 60_000);

// Run one tool against Zordon's data. Returns text for the tool_result.
export async function runTool(name, input, { db, vaultRoot, today = isoDate(), createTask, me = null }) {
  const project = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  switch (name) {
    case 'list_jobs':
      return json(db.prepare('SELECT id, code, name, short_name, status, folder FROM projects ORDER BY code, name').all());
    case 'list_change_orders':
      return json(listPackages(db, { type: 'cor', project_id: input.project_id, open: Boolean(input.open_only) })
        .map(({ id, number, title, project_code, project_name, stage, amount, folder, history, package_path }) => ({ id, number, title, job: project_code || project_name, stage, amount, folder, history, package_path })));
    case 'list_money_tasks': {
      const tasks = listTasks(db, { project_id: input.project_id }, today)
        .filter((t) => ['billing', 'change_order'].includes(t.category) && (input.include_done || t.status !== 'done'));
      return json(tasks.map(({ id, title, project_name, owner_name, status, priority, due_date, health, category }) => ({ id, title, job: project_name, owner: owner_name, status, priority, due_date, health, category })));
    }
    case 'read_job_workbook': {
      const p = project(input.project_id);
      if (!p) return `No job with id ${input.project_id}.`;
      if (!vaultRoot) return 'OneDrive is not connected, so the workbook cannot be read.';
      const found = await findWorkbook(vaultRoot, projectFolder(p));
      if (!found) return `No Job Control Workbook found in ${projectFolder(p)}.`;
      try {
        return json(input.sheet ? await readSheet(vaultRoot, found.path, input.sheet) : await readWorkbook(vaultRoot, found.path));
      } catch (err) {
        return /lock|busy|EBUSY/i.test(err.message) ? 'The workbook is open and locked in Excel; ask Damian to close it.' : `Could not read the workbook: ${err.message}`;
      }
    }
    case 'pending_workbook_updates':
      if (!vaultRoot) return 'OneDrive is not connected.';
      return (await readFile(vaultPath(vaultRoot, WORKBOOK_FILE()), 'utf8').catch(() => null)) || 'No pending workbook updates file yet (nothing logged).';
    case 'read_skill': {
      const s = db.prepare('SELECT body FROM skills WHERE name = ?').get(String(input.name || ''));
      return s ? s.body.slice(0, 40_000) : `No skill named ${input.name}.`;
    }
    case 'add_task': {
      if (!createTask) return 'Adding tasks is not available here.';
      const id = createTask({ title: String(input.title).slice(0, 200), project_id: input.project_id ?? null, due_date: input.due_date || null,
        priority: input.priority || 'high', description: input.description || 'Added by the financial adviser', owner_id: me,
        status: 'not_started', source: 'adviser' });
      return `Added task #${id}.`;
    }
    default:
      return `Unknown tool ${name}.`;
  }
}

// The stable part of the prompt (rules + skill index) is cached; it only changes when skills change.
function systemBlocks(db) {
  const skills = db.prepare('SELECT name, title, description FROM skills ORDER BY name').all()
    .map((s) => `- ${s.name}: ${s.title}. ${String(s.description || '').slice(0, 300)}`).join('\n');
  return [{ type: 'text', text: `${SYSTEM}\n\nSkills you can read with read_skill:\n${skills}`, cache_control: { type: 'ephemeral' } }];
}

// Answer one turn. `history` is [{ role: 'user'|'assistant', content: string }], newest last.
// Returns { reply, tools_used: [names], tasks_added, stop_reason }.
export async function askAdviser(history, ctx) {
  const { db, client: given, today = isoDate() } = ctx;
  const turns = (Array.isArray(history) ? history : []).filter((m) => ['user', 'assistant'].includes(m?.role) && String(m.content || '').trim())
    .slice(-30).map((m) => ({ role: m.role, content: String(m.content).slice(0, 20_000) }));
  if (turns.at(-1)?.role !== 'user') throw Object.assign(new Error('Ask a question first'), { status: 400 });
  while (turns[0]?.role !== 'user') turns.shift();
  const client = given || new (await import('@anthropic-ai/sdk')).default();
  const messages = [...turns];
  // Today's date goes with the question, not in the cached system prompt.
  messages[messages.length - 1] = { role: 'user', content: `${turns.at(-1).content}\n\n(Today is ${today}.)` };
  const tools_used = [];
  let tasks_added = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: ADVISER_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: systemBlocks(db),
      tools: [...TOOLS, ...SERVER_TOOLS],
      messages,
    });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (response.stop_reason === 'refusal') {
      return { reply: text || "I can't help with that one. Try asking it another way.", tools_used, tasks_added, stop_reason: 'refusal' };
    }
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') {
      return { reply: text || '(No answer.)', tools_used, tasks_added, stop_reason: response.stop_reason };
    }
    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      tools_used.push(block.name);
      let content;
      try {
        content = await runTool(block.name, block.input || {}, ctx);
        if (block.name === 'add_task' && /^Added task/.test(content)) tasks_added++;
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        continue;
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'That took more steps than I allow for one answer. Ask a narrower question (one job, or one change order).', tools_used, tasks_added, stop_reason: 'max_steps' };
}
