import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZORDON_AI = 'off';
process.env.ZORDON_VOICE = 'off';
delete process.env.ZORDON_API_TOKEN;

const { openDb, seedIfEmpty } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');

const TODAY = '2026-10-03';
let server;
let base;
let vaultRoot;

before(async () => {
  const db = openDb(':memory:');
  seedIfEmpty(db, TODAY);
  vaultRoot = await mkdtemp(join(tmpdir(), 'zordon-api-'));
  server = createServer(createApp(db, { today: () => TODAY, vaultRoot }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); delete process.env.ZORDON_API_TOKEN; });

const call = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Buffer) ? JSON.stringify(opts.body) : opts.body,
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('dashboard, focus and lookahead respond', async () => {
  const d = await call('/api/dashboard');
  assert.equal(d.status, 200);
  assert.ok(d.body.briefing.length > 20);
  assert.ok(d.body.systems.connectors.length === 2);
  assert.equal((await call('/api/focus')).body.person.name, 'Damian Palacio');
  assert.ok((await call('/api/schedule/lookahead?project_id=1')).body.activities.length > 0);
});

test('task lifecycle with validation and history', async () => {
  const bad = await call('/api/tasks', { method: 'POST', body: { title: 'x', status: 'nope' } });
  assert.equal(bad.status, 400);
  const created = await call('/api/tasks', { method: 'POST', body: { title: 'Submit change order 9', project_id: 1, due_date: '2026-10-04' } });
  assert.equal(created.body.priority, 'critical', 'money due tomorrow escalates');
  const id = created.body.id;
  const done = await call(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(done.body.status, 'done');
  assert.match(done.body.completed_at, /^\d{4}-\d{2}-\d{2}$/);
  const detail = await call(`/api/tasks/${id}`);
  assert.match(detail.body.updates[0].body, /done/);
  assert.equal((await call(`/api/tasks/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/tasks/${id}`)).status, 404);
});

test('email ingest suggests and accept creates tasks', async () => {
  const e = await call('/api/emails', { method: 'POST', body: { sender: 'gc@x.com', subject: 'Slab', body: 'Please have Marcus confirm the pump by Friday.' } });
  assert.equal(e.body.analyzer, 'rules');
  assert.equal(e.body.analysis.tasks.length, 1);
  const acc = await call(`/api/emails/${e.body.id}/accept`, { method: 'POST', body: { tasks: e.body.analysis.tasks, meetings: [] } });
  assert.equal(acc.body.tasks.length, 1);
  assert.equal((await call(`/api/emails/${e.body.id}`)).body.status, 'processed');
});

test('upload names and files a document; rename moves it', async () => {
  const up = await fetch(`${base}/api/documents?filename=scan001.txt&hint=${encodeURIComponent('RFI 14 beam at C4')}&project_id=1`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'RFI response text',
  }).then((r) => r.json());
  assert.equal(up.path, '5. PROJECTS/AGM-101/07 RFIS/AGM-101_ANGEL GROVE MEDICAL - RFI 14 - Beam at C4 (10.03.2026).txt');
  assert.equal(await readFile(join(vaultRoot, up.path), 'utf8'), 'RFI response text');
  const moved = await call(`/api/documents/${up.id}`, { method: 'PATCH', body: { category: 'Correspondence' } });
  assert.match(moved.body.path, /^5\. PROJECTS\/AGM-101\/10 CORRESPONDENCE\/AGM-101_ANGEL GROVE MEDICAL - LETTER - RFI 14 - Beam at C4 /);
  // The job folder follows the job number; renaming the job number moves the folder and keeps links working.
  const proj = await call('/api/projects/1', { method: 'PATCH', body: { code: 'G9999' } });
  assert.equal(proj.status, 200);
  const doc = (await call('/api/documents')).body.find((d) => d.id === up.id);
  assert.match(doc.path, /^5\. PROJECTS\/G9999\/10 CORRESPONDENCE\//);
  assert.equal(await readFile(join(vaultRoot, doc.path), 'utf8'), 'RFI response text');
  const file = await fetch(`${base}/api/documents/${up.id}/file`).then((r) => r.text());
  assert.equal(file, 'RFI response text');
});

test('path traversal in uploads is contained', async () => {
  const res = await fetch(`${base}/api/documents?filename=${encodeURIComponent('../../etc/passwd')}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x',
  }).then((r) => r.json());
  assert.ok(!res.path.includes('..'));
});

test('items push API and doc control summary', async () => {
  const r = await call('/api/items', { method: 'POST', body: { items: [{ type: 'rfi', number: '99', title: 'Glazing anchor detail', spec_section: '084413', assigned_to_me: true, project_id: 1, due_date: '2026-10-06' }] } });
  assert.equal(r.body.changes[0].change, 'new');
  const s = await call('/api/doccontrol');
  assert.ok(s.body.in_my_court.some((i) => i.number === '99'));
});

test('API token is enforced when configured', async () => {
  process.env.ZORDON_API_TOKEN = 'secret-token';
  try {
    assert.equal((await call('/api/dashboard')).status, 401);
    assert.equal((await call('/api/health')).status, 200);
    assert.equal((await call('/api/dashboard', { headers: { Authorization: 'Bearer secret-token' } })).status, 200);
    assert.equal((await call('/api/dashboard', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally {
    delete process.env.ZORDON_API_TOKEN;
  }
});
