import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { scanOld, applyPlan, undoArchive, listArchiveLogs } = await import('../server/cleanup.js');

const OLD = new Date('2023-05-01T12:00:00');
const NEW = new Date('2026-09-01T12:00:00');
async function file(root, rel, when) {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, rel);
  await utimes(full, when, when);
}
const exists = (p) => stat(p).then(() => true, () => false);

test('archives old loose files, old Documents files and fully inactive jobs only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zordon-clean-'));
  await file(root, 'Book2.xlsx', OLD);
  await file(root, 'G3251_32ND ST PRICING.pdf', NEW);
  await file(root, 'Documents/old/spec.pdf', OLD);
  await file(root, 'Documents/current.docx', NEW);
  await file(root, '5. PROJECTS/G2245/old.pdf', OLD); // dead job → whole folder
  await file(root, '5. PROJECTS/G3052/10 CORRESPONDENCE/Historic Design Guidelines.pdf', OLD); // active job keeps its old reference doc
  await file(root, '5. PROJECTS/G3052/07 RFIS/rfi.pdf', NEW);
  await file(root, '00 Cowork Claude/x.xlsm', OLD);
  await file(root, 'Zordon/FILING.md', OLD);
  await file(root, 'Documents/_ _ JOB TEMPLATES/t.xlsx', OLD);

  const plan = await scanOld(root, { cutoff: '2025-01-01' });
  const froms = plan.items.map((i) => i.from).sort();
  assert.deepEqual(froms, ['5. PROJECTS/G2245', 'Book2.xlsx', 'Documents/old/spec.pdf']);
  assert.equal(plan.archive, '_ARCHIVE pre-2025');

  const r = await applyPlan(root, plan.plan_id);
  assert.equal(r.moved, 3);
  assert.ok(await exists(join(root, '_ARCHIVE pre-2025/5. PROJECTS/G2245/old.pdf')));
  assert.ok(await exists(join(root, '_ARCHIVE pre-2025/Documents/old/spec.pdf')));
  assert.ok(await exists(join(root, '5. PROJECTS/G3052/10 CORRESPONDENCE/Historic Design Guidelines.pdf')), 'active job untouched');
  await assert.rejects(() => applyPlan(root, plan.plan_id), /expired/);

  const [log] = await listArchiveLogs(root);
  const u = await undoArchive(root, log);
  assert.equal(u.restored, 3);
  assert.ok(await exists(join(root, 'Book2.xlsx')));
  assert.ok(await exists(join(root, '5. PROJECTS/G2245/old.pdf')));
  await assert.rejects(() => undoArchive(root, '../../etc/passwd'), /Not an archive log/);
});
