// The financial adviser's tool loop, with a stand-in for Claude so no network or API key is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
const { openDb } = await import('../server/db.js');
const { askAdviser, runTool, ADVISER_MODEL } = await import('../server/adviser.js');
const { recordPackage } = await import('../server/packages.js');

const TODAY = '2026-10-12';
function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (name, role) VALUES ('Damian', 'Project Manager')").run();
  db.prepare("INSERT INTO projects (name, code, short_name) VALUES ('Burbank Replacement Terminal', 'G2707', 'BURB RPT')").run();
  recordPackage(db, { project_id: 1, type: 'cor', number: '12', title: 'Ice machine power', folder: 'x', stage: 'SUBMITTED', amount: 18450 }, '2026-08-20');
  db.prepare("INSERT INTO skills (name, title, description, body, builtin) VALUES ('co-update', 'Change orders', 'CO rules', '# CO rules\\nNever renumber.', 1)").run();
  return db;
}

// Scripted Claude: each call returns the next response and records the request.
function fakeClient(responses) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return responses.shift(); } } } };
}

test('the adviser looks up the change orders, then answers from them', async () => {
  const db = freshDb();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_change_orders', input: { open_only: true } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'CO 012 ($18,450) has waited on the GC since Aug 20. Chase it.' }] },
  ]);
  const res = await askAdviser([{ role: 'user', content: 'What CO should I chase?' }], { db, client, today: TODAY });
  assert.equal(res.reply, 'CO 012 ($18,450) has waited on the GC since Aug 20. Chase it.');
  assert.deepEqual(res.tools_used, ['list_change_orders']);

  const [first, second] = client.calls;
  assert.equal(first.model, ADVISER_MODEL);
  assert.deepEqual(first.thinking, { type: 'adaptive' });
  assert.equal(first.fallbacks, 'default');
  assert.ok(first.tools.some((t) => t.name === 'web_search'));
  assert.match(first.system[0].text, /co-update: Change orders/, 'skills are listed for the model');
  assert.ok(first.system[0].cache_control, 'the stable system prompt is cached');
  assert.match(first.messages.at(-1).content, /Today is 2026-10-12/);
  // The tool result carries the real data back to Claude.
  const result = second.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(result.content, /"stage": "SUBMITTED"/);
  assert.match(result.content, /18450/);
});

test('the adviser can put a follow-up on the board, and reports refusals plainly', async () => {
  const db = freshDb();
  const added = [];
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'add_task', input: { title: 'Call GC about CO 012', project_id: 1, due_date: '2026-10-13' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Added.' }] },
  ]);
  const res = await askAdviser([{ role: 'user', content: 'Track it' }], { db, client, today: TODAY, createTask: (t) => { added.push(t); return 99; } });
  assert.equal(res.tasks_added, 1);
  assert.equal(added[0].priority, 'high');
  assert.equal(added[0].source, 'adviser');

  const refused = await askAdviser([{ role: 'user', content: 'x' }], { db, client: fakeClient([{ stop_reason: 'refusal', content: [] }]), today: TODAY });
  assert.equal(refused.stop_reason, 'refusal');
  assert.match(refused.reply, /can't help/);
  await assert.rejects(askAdviser([{ role: 'assistant', content: 'hi' }], { db, client: fakeClient([]) }), /Ask a question/);
});

test('tools read skills and handle a missing OneDrive', async () => {
  const db = freshDb();
  assert.match(await runTool('read_skill', { name: 'co-update' }, { db }), /Never renumber/);
  assert.match(await runTool('read_job_workbook', { project_id: 1 }, { db, vaultRoot: null }), /not connected/);
  assert.match(await runTool('list_jobs', {}, { db }), /G2707/);
});
