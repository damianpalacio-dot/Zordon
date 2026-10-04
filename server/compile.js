// Change order submittal package: the CO form (PDF from the Job Control Workbook) plus everything in the CO folder's
// backup folders, merged into one PDF to send to the GC, with a contents page in front.
//   CO 001 - Additional Lighting Circuits/
//     CO 001 - Additional Lighting Circuits.pdf            <- the CO form
//     01 PRICING - BACKUP/ 02 RFP-RFI REFERENCE/ 03 T&M TAGS/ (and any ESTIMATE folder)
//     CO 001 - G3249 - Additional Lighting Circuits.pdf    <- the compiled package (written here)
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { vaultPath } from './vault.js';

// Which subfolders go in, in this order. Approved CO documentation is what comes back from the GC, so it stays out.
const SECTIONS = [
  ['Pricing & backup', /PRICING|BACKUP|QUOTE/i],
  ['Estimate', /ESTIMAT|WORK-?UP|TAKE-?OFF|ENDSHEET/i],
  ['RFP / RFI reference', /RFP|RFI|REFERENCE/i],
  ['T&M tags', /T\s?&\s?M|TAGS?\b/i],
];
const IMAGES = new Set(['.jpg', '.jpeg', '.png']);

const sortNames = (a, b) => a.localeCompare(b, undefined, { numeric: true });
async function filesIn(root, rel, depth = 0) {
  const out = [];
  for (const e of (await readdir(vaultPath(root, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => sortNames(a.name, b.name))) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (e.isDirectory() && depth < 3) out.push(...await filesIn(root, `${rel}/${e.name}`, depth + 1));
    else if (e.isFile()) out.push(`${rel}/${e.name}`);
  }
  return out;
}

export const packageFileName = (label, jobCode, desc) => `${label}${jobCode ? ` - ${jobCode}` : ''} - ${desc}.pdf`;

// Build the package. Returns { path, included: [{section, file, pages}], skipped: [{file, reason}] }.
export async function compileCo(root, folder, { label, jobCode, jobName, desc, today }) {
  const outName = packageFileName(label, jobCode, desc);
  const top = (await readdir(vaultPath(root, folder), { withFileTypes: true }).catch(() => []));
  const isOutput = (name) => name === outName || (jobCode && name.startsWith(`${label} - ${jobCode} - `));
  // The CO form: PDFs sitting directly in the CO folder (not the compiled package itself).
  const form = top.filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.pdf' && !isOutput(e.name)).map((e) => `${folder}/${e.name}`).sort(sortNames);
  const parts = [['Change order', form]];
  const subs = top.filter((e) => e.isDirectory()).map((e) => e.name);
  const used = new Set();
  for (const [section, re] of SECTIONS) {
    const files = [];
    for (const d of subs.filter((n) => re.test(n) && !/APPROVED/i.test(n) && !used.has(n))) { used.add(d); files.push(...await filesIn(root, `${folder}/${d}`)); }
    parts.push([section, files]);
  }

  const out = await PDFDocument.create();
  const included = [];
  const skipped = [];
  for (const [section, files] of parts) {
    for (const rel of files) {
      const name = rel.split('/').pop();
      const ext = extname(name).toLowerCase();
      try {
        if (ext === '.pdf') {
          const src = await PDFDocument.load(await readFile(vaultPath(root, rel)), { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
          included.push({ section, file: rel, pages: pages.length });
        } else if (IMAGES.has(ext)) {
          const bytes = await readFile(vaultPath(root, rel));
          const img = ext === '.png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
          // Letter page, picture scaled to fit inside half-inch margins.
          const page = out.addPage([612, 792]);
          const scale = Math.min(540 / img.width, 720 / img.height, 1);
          page.drawImage(img, { x: (612 - img.width * scale) / 2, y: (792 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
          included.push({ section, file: rel, pages: 1 });
        } else skipped.push({ file: rel, reason: 'not a PDF or picture (save it as PDF to include it)' });
      } catch (err) {
        skipped.push({ file: rel, reason: `could not be read (${err.message.split('\n')[0].slice(0, 80)})` });
      }
    }
  }
  if (!included.length) throw Object.assign(new Error('Nothing to compile yet: no PDFs in the CO folder'), { status: 400 });

  // Contents page in front.
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const cover = out.insertPage(0, [612, 792]);
  let y = 740;
  const line = (text, { size = 11, f = font, color = rgb(0.1, 0.1, 0.12), indent = 0 } = {}) => {
    if (y < 60) return;
    cover.drawText(String(text).replace(/[^\x20-\x7E]/g, '-').slice(0, 95), { x: 54 + indent, y, size, font: f, color });
    y -= size + 7;
  };
  line(`${label} - ${desc}`, { size: 18, f: bold });
  line([jobCode, jobName].filter(Boolean).join(' - '), { size: 12 });
  line(`Change order package - ${today}`, { size: 10, color: rgb(0.4, 0.4, 0.45) });
  y -= 10;
  line('CONTENTS', { size: 11, f: bold });
  let page = 2;
  for (const [section] of parts) {
    const items = included.filter((i) => i.section === section);
    if (!items.length) continue;
    line(section, { size: 11, f: bold, indent: 6 });
    for (const i of items) {
      line(`${i.file.split('/').pop()}  .....  page ${page}`, { size: 10, indent: 18 });
      page += i.pages;
    }
  }
  const path = `${folder}/${outName}`;
  await writeFile(vaultPath(root, path), await out.save());
  return { path, included, skipped, pages: out.getPageCount() };
}

// True when anything in the CO folder changed after the package was built (used to rebuild it).
export async function packageStale(root, folder, path) {
  const built = await stat(vaultPath(root, path)).catch(() => null);
  if (!built) return true;
  for (const f of await filesIn(root, folder)) {
    if (f === path) continue;
    const s = await stat(vaultPath(root, f)).catch(() => null);
    if (s && s.mtimeMs > built.mtimeMs) return true;
  }
  return false;
}
