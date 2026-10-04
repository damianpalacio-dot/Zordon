// Read each job's GEC2_Job_Control_Workbook.xlsm (read-only: never saved, macros never run) so Zordon can show its
// Dashboard: contract, change orders and billing, as the workbook itself sums them up.
import { readdir, stat } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { vaultPath } from './vault.js';

const NAME_RE = /job[_ ]?control[_ ]?workbook.*\.xls[xm]$/i;
const SKIP_DIR = /^(archive|_archive|old|superseded)/i;
const cache = new Map(); // full path -> { mtimeMs, data }

// Newest workbook inside the job folder (a few levels down, skipping archive folders).
export async function findWorkbook(root, folder, depth = 0) {
  let best = null;
  for (const e of await readdir(vaultPath(root, folder), { withFileTypes: true }).catch(() => [])) {
    const rel = `${folder}/${e.name}`;
    if (e.isDirectory() && depth < 3 && !SKIP_DIR.test(e.name) && !e.name.startsWith('.')) {
      const hit = await findWorkbook(root, rel, depth + 1);
      if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
    } else if (e.isFile() && NAME_RE.test(e.name) && !e.name.startsWith('~$')) {
      const s = await stat(vaultPath(root, rel)).catch(() => null);
      if (s && (!best || s.mtimeMs > best.mtimeMs)) best = { path: rel, mtimeMs: s.mtimeMs, modified: s.mtime.toISOString() };
    }
  }
  return best;
}

const show = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return show(v.result); // formula: use the value Excel last calculated
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return null;
    return null;
  }
  return v;
};

// Label/value pairs from a sheet: each row's first text cell is the label, the next filled cell its value.
function pairs(sheet, max = 60) {
  const out = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (out.length >= max) return;
    const cells = [];
    row.eachCell({ includeEmpty: false }, (c) => { const v = show(c.value); if (v !== null && v !== '') cells.push({ v, fmt: c.numFmt || '' }); });
    if (!cells.length) return;
    const [first, ...rest] = cells;
    if (typeof first.v !== 'string') return;
    const value = rest.find((c) => c.v !== first.v);
    out.push({ label: first.v.trim(), value: value ? value.v : null, money: Boolean(value && typeof value.v === 'number' && /\$|#,##0\.00|accounting/i.test(value.fmt)) });
  });
  return out;
}

export async function readWorkbook(root, rel) {
  const full = vaultPath(root, rel);
  const s = await stat(full);
  const hit = cache.get(full);
  if (hit && hit.mtimeMs === s.mtimeMs) return hit.data;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(full);
  const sheets = wb.worksheets.map((w) => ({ name: w.name, rows: w.actualRowCount }));
  const dash = wb.worksheets.find((w) => /dashboard/i.test(w.name)) || wb.worksheets[0];
  const data = { path: rel, modified: s.mtime.toISOString(), sheets, dashboard: dash ? { name: dash.name, items: pairs(dash) } : null };
  cache.set(full, { mtimeMs: s.mtimeMs, data });
  return data;
}

// Any sheet as rows of values (for a closer look from the screen).
export async function readSheet(root, rel, name, maxRows = 200) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(vaultPath(root, rel));
  const sheet = wb.getWorksheet(name);
  if (!sheet) throw Object.assign(new Error(`No sheet named ${name}`), { status: 404 });
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= maxRows) return;
    const vals = [];
    row.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = show(c.value); });
    if (vals.some((v) => v !== null && v !== undefined && v !== '')) rows.push(vals.map((v) => (v === undefined ? null : v)));
  });
  return { name, rows };
}
