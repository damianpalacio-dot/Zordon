import { api, esc, fmtDate, fmtTime, relDays, avatar, label, toast, guard, store, personById, projectById, options, WEEKDAYS, downloadDoc } from './core.js';

const today = () => store.meta.today;
const wire = (el, sel, ev, fn) => el.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, (e) => fn(e, n)));
const tile = (n, l, cls = '', attrs = '', extra = '') => `<div class="kpi ${cls}" ${attrs}><span class="gauge" style="--p:${typeof n === 'number' ? Math.min(100, n * 10) : 0}"><span>${n}</span></span><span class="l">${l}${extra}</span></div>`;
const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v === '' ? null : v]));

// ---------------- Projects ----------------
async function projects(el, _p, { render }) {
  const list = store.projects;
  el.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p>Your whole portfolio at a glance.</p></div></div>
    <div class="grid three">
      ${list.map((p) => `
        <section class="panel proj-card a-${p.health}" data-id="${p.id}">
          <div class="row"><span class="dot a-${p.health}"></span><b>${esc(p.name)}</b><span class="spacer"></span><span class="pill">${esc(label(p.status))}</span></div>
          <div class="small muted">${esc(p.code || 'No code')}${p.location ? ` · ${esc(p.location)}` : ''}</div>
          <div class="bar"><span style="width:${p.progress}%"></span></div>
          <div class="row small"><span>${p.progress}% done</span><span class="spacer"></span><span>${p.open} open</span>${p.delayed ? `<span class="pill h-delayed">${p.delayed} late</span>` : ''}</div>
          <div class="row"><a class="btn sm" href="#/board?project_id=${p.id}">Board</a><a class="btn sm" href="#/schedule?project_id=${p.id}">Look-ahead</a>
            <a class="btn sm" href="#/vault?project_id=${p.id}">Files</a><button class="btn sm gold" data-eplan="${p.id}">⚡ Electrical plan</button><span class="spacer"></span><button class="btn sm ghost" data-edit="${p.id}">Edit</button></div>
        </section>`).join('')}
      <section class="panel">
        <h2>New project</h2>
        <form class="grid" id="new-project" style="margin-top:10px">
          <label class="field">Name<input name="name" required placeholder="e.g. Eastside Clinic TI"></label>
          <div class="form-grid"><label class="field">Job number<input name="code" placeholder="G3301"></label>
            <label class="field">Short name for files<input name="short_name" placeholder="32ND ST"></label>
            <label class="field">Location<input name="location"></label></div>
          <button class="btn primary">Create project</button>
        </form>
      </section>
    </div>`;
  el.querySelector('#new-project').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => { await api('/api/projects', { method: 'POST', body: formData(e.target) }); toast('Project created'); render(); });
  });
  wire(el, '[data-eplan]', 'click', (e, n) => {
    e.stopPropagation();
    const date = prompt('Target energization (permanent power) date, YYYY-MM-DD.\nZordon schedules the electrical critical path around it: utility, studies, gear releases, inspections, NETA testing, fire alarm acceptance and closeout.');
    if (!date) return;
    guard(async () => {
      const r = await api(`/api/projects/${n.dataset.eplan}/electrical-plan`, { method: 'POST', body: { energization_date: date.trim() } });
      toast(`Added ${r.created} electrical milestones to the board`);
      location.hash = `#/board?project_id=${n.dataset.eplan}`;
    });
  });
  wire(el, '[data-edit]', 'click', (e, n) => {
    e.stopPropagation();
    const p = projectById(Number(n.dataset.edit));
    const name = prompt('Project name', p.name);
    if (name === null) return;
    const code = prompt('Job number (e.g. G2707)', p.code || '');
    const short_name = prompt('Short name used in file names (e.g. BURB RPT)', p.short_name || '');
    const folder = prompt('OneDrive folder, only if it is NOT "5. PROJECTS/<job #>" (e.g. 5. PROJECTS/LAUSD 32ND ST)', p.folder || '');
    const status = prompt('Status: active, on_hold or closed', p.status);
    guard(async () => { await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name, code, short_name, folder: folder || null, status } }); render(); });
  });
}

// ---------------- RFIs & submittals ----------------
async function doccontrol(el, params, { render }) {
  const f = Object.fromEntries(params);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [summary, items, settings] = await Promise.all([api('/api/doccontrol'), api(`/api/items?${qs}`), api('/api/settings')]);
  const set = (k, v) => { const n = new URLSearchParams(f); if (v) n.set(k, v); else n.delete(k); location.hash = `#/doccontrol?${n}`; };
  const groupLabel = Object.fromEntries(summary.groups.map((g) => [g.key, g.label.split(' — ')[0]]));
  el.innerHTML = `
    <div class="page-head">
      <div><h1>RFIs & Submittals</h1><p>Watching ${summary.groups.filter((g) => g.watched).map((g) => esc(g.label)).join(', ')}</p></div>
      <div class="row">${summary.connectors.map((c) => `<span class="pill ${c.configured ? 'h-done' : ''}">${esc(label(c.name))}: ${c.configured ? 'connected' : 'not set up'}</span>`).join('')}
        <button class="btn primary" id="sync">⟳ Sync now</button></div>
    </div>
    <div class="grid kpis wide" style="margin-bottom:16px">
      ${summary.groups.map((g) => tile(g.open, esc(g.label), f.group === g.key ? 'a-yellow' : '', `data-group="${g.key}" role="button" tabindex="0" ${g.watched ? '' : 'style="opacity:.45"'}`,
        g.new_this_week ? `<br><span style="color:var(--amber);letter-spacing:0;text-transform:none">+${g.new_this_week} new this week</span>` : '')).join('')}
    </div>
    <div class="grid two" style="margin-bottom:16px">
      <section class="panel"><header><h2>In your court</h2></header><div class="list">${summary.in_my_court.map(row).join('') || '<div class="empty">Nothing waiting on you.</div>'}</div></section>
      <section class="panel"><header><h2>New this week (watched)</h2></header><div class="list">${summary.new_this_week.map(row).join('') || '<div class="empty">No new items.</div>'}</div></section>
    </div>
    <div class="filters">
      <select data-f="type">${options([{ id: 'rfi', name: 'RFIs' }, { id: 'submittal', name: 'Submittals' }], f.type, { empty: 'RFIs & submittals' })}</select>
      <select data-f="project_id">${options(store.projects, f.project_id, { empty: 'All projects' })}</select>
      <select data-f="open">${options([{ id: '1', name: 'Open only' }], f.open, { empty: 'Open & closed' })}</select>
      <select data-f="mine">${options([{ id: '1', name: 'In my court' }], f.mine, { empty: 'Anyone' })}</select>
      <input data-f="q" placeholder="Search number, title, spec…" value="${esc(f.q || '')}">
      ${qs ? '<a class="btn ghost" href="#/doccontrol">Clear</a>' : ''}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>#</th><th>Title</th><th>Spec</th><th>Watch</th><th>Status</th><th>Ball in court</th><th>Due</th><th>Project</th></tr></thead>
      <tbody>${items.map((i) => `<tr>
        <td><span class="pill">${i.type === 'rfi' ? 'RFI' : 'Submittal'}</span></td>
        <td class="mono">${esc(i.number || '—')}</td>
        <td>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}<div class="small dim">via ${esc(i.source)}${i.source !== i.origin ? ` (${esc(i.origin)})` : ''}</div></td>
        <td class="mono">${esc(i.spec_section || '—')}</td>
        <td>${i.groups.map((g) => `<span class="pill small">${esc(groupLabel[g] || g)}</span>`).join(' ')}</td>
        <td><span class="pill ${i.open ? 'h-due_soon' : 'h-done'}">${esc(i.status || '')}</span></td>
        <td>${i.assigned_to_me ? '<b style="color:var(--gold)">You</b>' : esc(i.ball_in_court || '—')}</td>
        <td>${i.due_date ? `<span class="${i.open && i.due_date < today() ? 'pill h-delayed' : ''}">${fmtDate(i.due_date)}</span>` : '—'}</td>
        <td class="small">${esc(i.project_name || '—')}</td></tr>`).join('') || '<tr><td colspan="9" class="dim">No items yet. Connect Procore/Autodesk, forward notification emails to Email Intel, or add one below.</td></tr>'}</tbody>
    </table></div>
    <div class="grid two" style="margin-top:16px">
      <section class="panel"><h2>Add an item manually</h2>
        <form class="grid" id="add-item" style="margin-top:10px">
          <div class="form-grid">
            <label class="field">Type<select name="type"><option value="submittal">Submittal</option><option value="rfi">RFI</option></select></label>
            <label class="field">Number<input name="number" placeholder="23 74 13-1"></label>
            <label class="field">Spec section<input name="spec_section" placeholder="23 74 13"></label>
            <label class="field">Due<input type="date" name="due_date"></label>
            <label class="field">Project<select name="project_id">${options(store.projects, f.project_id, { empty: '—' })}</select></label>
            <label class="field">Status<input name="status" value="Open"></label>
          </div>
          <label class="field">Title<input name="title" required></label>
          <label class="row small"><input type="checkbox" name="assigned_to_me"> Ball in my court (adds a task to my list)</label>
          <button class="btn primary">Add</button>
        </form></section>
      <section class="panel"><h2>Watchlist</h2>
        <p class="small muted">Pick the divisions and trades Zordon should alert you about.</p>
        <div class="chips">${settings.all_groups.map((g) => `<button class="chip ${settings.watch_groups.includes(g.key) ? 'on' : ''}" data-watch="${g.key}">${esc(g.label)}</button>`).join('')}</div>
        <p class="small dim" style="margin-top:14px">Procore & Autodesk sync every 30 minutes once connected (see README → “Connect Procore & Autodesk”). Notification emails pasted or forwarded to Email Intel are picked up automatically.</p>
      </section>
    </div>`;

  wire(el, '[data-f]', 'change', (_e, n) => set(n.dataset.f, n.value));
  wire(el, '[data-group]', 'click', (_e, n) => set('group', f.group === n.dataset.group ? '' : n.dataset.group));
  wire(el, '[data-watch]', 'click', (_e, n) => guard(async () => {
    const next = new Set(settings.watch_groups);
    if (next.has(n.dataset.watch)) next.delete(n.dataset.watch); else next.add(n.dataset.watch);
    await api('/api/settings', { method: 'PATCH', body: { watch_groups: [...next] } });
    render();
  }));
  el.querySelector('#sync').addEventListener('click', () => guard(async () => {
    const results = await api('/api/integrations/sync', { method: 'POST', body: {} });
    toast(results.map((r) => `${r.name}: ${r.error ? `error — ${r.error}` : r.skipped || `${r.fetched} items, ${r.changes.length} changes`}`).join(' · '));
    render();
  }));
  el.querySelector('#add-item').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = formData(e.target);
    body.assigned_to_me = Boolean(body.assigned_to_me);
    body.source = 'manual';
    guard(async () => { await api('/api/items', { method: 'POST', body }); toast('Item added'); render(); });
  });
}

const row = (i) => `
  <a class="item" href="${i.url ? esc(i.url) : '#/doccontrol'}" ${i.url ? 'target="_blank" rel="noopener"' : ''}>
    <span class="pill">${i.type === 'rfi' ? 'RFI' : 'SUB'}</span>
    <div class="grow"><div class="title">${i.number ? `#${esc(i.number)} ` : ''}${esc(i.title)}</div>
      <div class="sub">${esc(i.spec_section || 'No spec')} · ${esc(i.status || '')} · ${esc(i.project_name || 'Unmatched project')}</div></div>
    ${!i.open ? `<span class="pill h-done">${esc(i.status)}</span>` : i.due_date ? `<span class="pill ${i.due_date < today() ? 'h-delayed' : 'h-due_soon'}">${relDays(i.due_date, today())}</span>` : ''}
  </a>`;

// ---------------- Schedule & equipment ----------------
async function schedule(el, params, { render }) {
  const projectId = params.get('project_id') || store.projects[0]?.id || '';
  const tab = params.get('tab') || 'lookahead';
  const [la, equipment, routines, items] = await Promise.all([
    api(`/api/schedule/lookahead?project_id=${projectId}`),
    api(`/api/equipment?project_id=${projectId}`),
    api('/api/routines'),
    api(`/api/items?type=submittal&project_id=${projectId}`),
  ]);
  const go = (k, v) => { const n = new URLSearchParams(params); n.set(k, v); location.hash = `#/schedule?${n}`; };
  const variance = (v) => (v == null ? '—' : `<span class="variance ${v > 0 ? 'f-slipped' : v < 0 ? 'f-ahead' : 'f-on_track'}">${v > 0 ? '+' : ''}${v}d</span>`);
  const eqState = { release_overdue: 'Release overdue', release_soon: 'Release within 2 wks', blocked_by_submittal: 'Blocked by submittal', released_late_risk: 'Released — arrives late', released: 'Released', delivered: 'Delivered', planned: 'Planned', needs_info: 'Needs lead time / date' };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Schedule & Equipment</h1><p>3-week look-ahead vs baseline · equipment release log</p></div>
      <select id="proj">${options(store.projects, projectId)}</select>
    </div>
    <div class="tabs">${[['lookahead', '3-week look-ahead'], ['equipment', 'Equipment releases'], ['routines', 'Recurring reminders'], ['import', 'Import schedule']]
      .map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  const body = el.querySelector('#tab');

  if (tab === 'lookahead') {
    body.innerHTML = `
      <div class="grid kpis" style="margin-bottom:16px">
        ${tile(la.stats.in_window, 'Activities in window')}
        ${tile(la.stats.slipped, 'Slipped vs baseline', 'f-slipped')}
        ${tile(la.behind.length, 'Behind (late start/finish)', 'f-overdue')}
        ${tile(`${la.stats.worst_slip_days}d`, 'Worst finish slip', la.stats.worst_slip_days > 0 ? 'f-slipped' : '')}
      </div>
      ${la.stats.has_baseline ? '' : '<div class="empty" style="margin-bottom:12px">No baseline loaded yet — import your baseline schedule to see variance.</div>'}
      <div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Activity</th><th>Trade</th><th>Baseline</th><th>Current</th><th>Start var.</th><th>Finish var.</th><th>%</th><th>Flag</th></tr></thead>
        <tbody>${la.activities.map((a) => `<tr>
          <td class="mono">${esc(a.activity_id)}</td><td>${esc(a.name)}</td><td class="small">${esc(a.trade || '')}</td>
          <td class="small">${fmtDate(a.baseline_start)} → ${fmtDate(a.baseline_finish)}</td>
          <td class="small">${fmtDate(a.start)} → ${fmtDate(a.finish)}</td>
          <td>${variance(a.start_variance)}</td><td>${variance(a.finish_variance)}</td><td>${a.percent_complete ?? 0}%</td>
          <td><span class="pill f-${a.flag}">${esc(label(a.flag))}</span></td></tr>`).join('') || '<tr><td colspan="9" class="dim">Nothing scheduled in the next 3 weeks.</td></tr>'}</tbody>
      </table></div>
      ${la.pushed_out.length ? `<section class="panel" style="margin-top:16px"><h2>Baseline promised it, the schedule pushed it out</h2>
        <div class="list" style="margin-top:8px">${la.pushed_out.map((a) => `<div class="item"><span class="mono">${esc(a.activity_id)}</span><div class="grow"><div class="title">${esc(a.name)}</div>
          <div class="sub">Baseline start ${fmtDate(a.baseline_start)} → now ${fmtDate(a.start)}</div></div>${variance(a.start_variance)}</div>`).join('')}</div></section>` : ''}`;
  }

  if (tab === 'equipment') {
    body.innerHTML = `
      <p class="muted small">Release-by = need-on-site date (from the linked schedule activity when set) − lead time − buffer.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Equipment</th><th>Spec</th><th>Submittal</th><th>Need on site</th><th>Lead</th><th>Release by</th><th>State</th><th>Released</th><th>Delivered</th></tr></thead>
        <tbody>${equipment.map((e) => `<tr data-eq="${e.id}">
          <td><b>${esc(e.name)}</b><div class="small dim">${esc(e.vendor || '')}${e.activity_name ? ` · ${esc(e.activity_id)} ${esc(e.activity_name)}` : ''}</div></td>
          <td class="mono">${esc(e.spec_section || '')}</td>
          <td class="small">${e.submittal_number ? `#${esc(e.submittal_number)}<br><span class="pill ${e.submittal_open ? 'h-due_soon' : 'h-done'}">${esc(e.submittal_status)}</span>` : '—'}</td>
          <td>${fmtDate(e.need_by)}</td><td>${e.lead_time_weeks ?? '—'} wk</td>
          <td><b>${fmtDate(e.release_by)}</b><div class="small dim">${e.days_to_release == null ? '' : e.days_to_release < 0 ? `${-e.days_to_release}d ago` : `in ${e.days_to_release}d`}</div></td>
          <td><span class="pill e-${e.state}">${esc(eqState[e.state] || e.state)}</span></td>
          <td><input type="date" data-k="released_at" value="${esc(e.released_at || '')}"></td>
          <td><input type="date" data-k="delivered_at" value="${esc(e.delivered_at || '')}"></td></tr>`).join('') || '<tr><td colspan="9" class="dim">No equipment tracked for this project.</td></tr>'}</tbody>
      </table></div>
      <section class="panel" style="margin-top:16px"><h2>Add equipment</h2>
        <form class="grid" id="add-eq" style="margin-top:10px">
          <div class="form-grid">
            <label class="field">Equipment<input name="name" required placeholder="AHU-1"></label>
            <label class="field">Spec<input name="spec_section" placeholder="23 73 13"></label>
            <label class="field">Vendor<input name="vendor"></label>
            <label class="field">Lead time (weeks)<input type="number" step="0.5" name="lead_time_weeks" placeholder="auto for electrical gear"></label>
            <label class="field">Buffer (days)<input type="number" name="buffer_days" value="7"></label>
            <label class="field">Schedule activity ID<input name="activity_id" placeholder="A1050"></label>
            <label class="field">…or need-on-site date<input type="date" name="need_by_date"></label>
            <label class="field">Submittal<select name="submittal_item_id">${options(items, '', { empty: '—', text: (i) => `#${i.number || i.id} ${i.title}` })}</select></label>
          </div>
          <button class="btn primary">Add equipment</button>
        </form></section>`;
    wire(body, '[data-eq] [data-k]', 'change', (_e, n) => guard(async () => {
      await api(`/api/equipment/${n.closest('[data-eq]').dataset.eq}`, { method: 'PATCH', body: { [n.dataset.k]: n.value || null } });
      render();
    }));
    const nameInput = body.querySelector('#add-eq [name=name]');
    const leadInput = body.querySelector('#add-eq [name=lead_time_weeks]');
    nameInput.addEventListener('change', () => guard(async () => {
      const typical = await api(`/api/electrical/lead-time?name=${encodeURIComponent(nameInput.value)}`);
      if (typical && !leadInput.value) {
        leadInput.value = typical.weeks;
        toast(`${typical.label}: typical lead ${typical.range} weeks — confirm with the vendor`);
      }
    }));
    body.querySelector('#add-eq').addEventListener('submit', (e) => {
      e.preventDefault();
      const b = formData(e.target);
      b.project_id = Number(projectId);
      for (const k of ['lead_time_weeks', 'buffer_days', 'submittal_item_id']) if (b[k] != null) b[k] = Number(b[k]);
      guard(async () => { await api('/api/equipment', { method: 'POST', body: b }); toast('Equipment added'); render(); });
    });
  }

  if (tab === 'routines') {
    body.innerHTML = `
      <p class="muted small">Each routine drops a task on the owner's list a few days before it's due, so the normal nudges and reminders pick it up.</p>
      <div class="list">${routines.map((r) => `<div class="item" style="cursor:default">
        <span class="dot ${r.active ? 'h-on_track' : ''}"></span>
        <div class="grow"><div class="title">${esc(r.title)}</div><div class="sub">${r.day_of_month ? `Monthly on day ${r.day_of_month}` : `Every ${r.every_weeks > 1 ? `${r.every_weeks} weeks on ` : ''}${WEEKDAYS[r.weekday]}`} · ${esc(r.owner_name || 'Unassigned')}${r.project_name ? ` · ${esc(r.project_name)}` : ' · all projects'}${r.last_due ? ` · last ${fmtDate(r.last_due)}` : ''}</div></div>
        <button class="btn sm" data-toggle="${r.id}" data-active="${r.active}">${r.active ? 'Pause' : 'Resume'}</button></div>`).join('')}</div>
      <section class="panel" style="margin-top:16px"><h2>New recurring reminder</h2>
        <form class="grid" id="add-routine" style="margin-top:10px">
          <label class="field">Title<input name="title" required placeholder="Review 3-week look-ahead vs baseline"></label>
          <div class="form-grid">
            <label class="field">Owner<select name="owner_id">${options(store.people, '', { empty: 'Me' })}</select></label>
            <label class="field">Project<select name="project_id">${options(store.projects, '', { empty: 'All projects' })}</select></label>
            <label class="field">Weekly on<select name="weekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
            <label class="field">…or monthly on day<input type="number" min="1" max="31" name="day_of_month" placeholder="e.g. 20"></label>
            <label class="field">Estimate (h)<input type="number" step="0.5" name="estimate_hours" value="1"></label>
          </div>
          <button class="btn primary">Add routine</button>
        </form></section>`;
    wire(body, '[data-toggle]', 'click', (_e, n) => guard(async () => {
      await api(`/api/routines/${n.dataset.toggle}`, { method: 'PATCH', body: { active: n.dataset.active !== '1' } });
      render();
    }));
    body.querySelector('#add-routine').addEventListener('submit', (e) => {
      e.preventDefault();
      const b = formData(e.target);
      for (const k of ['owner_id', 'project_id', 'weekday', 'day_of_month', 'estimate_hours']) if (b[k] != null) b[k] = Number(b[k]);
      guard(async () => { await api('/api/routines', { method: 'POST', body: b }); toast('Routine added'); render(); });
    });
  }

  if (tab === 'import') {
    body.innerHTML = `
      <section class="panel">
        <h2>Import from P6, MS Project or Excel (CSV)</h2>
        <p class="small muted">Export with columns like <span class="mono">Activity ID, Activity Name, Start, Finish</span> — and optionally <span class="mono">BL Start, BL Finish, % Complete, Trade</span>.
          Import the <b>baseline</b> once, then the <b>current</b> update every week. Activities are matched by ID.</p>
        <div class="row" style="margin:12px 0">
          <label class="row"><input type="radio" name="mode" value="current" checked> Current update</label>
          <label class="row"><input type="radio" name="mode" value="baseline"> Baseline</label>
        </div>
        <div class="dropzone" id="csv-drop">Drop a .csv file here or click to choose<input type="file" accept=".csv,.txt,.tsv" hidden></div>
      </section>`;
    const drop = body.querySelector('#csv-drop');
    const input = drop.querySelector('input');
    const upload = (file) => guard(async () => {
      const mode = body.querySelector('[name=mode]:checked').value;
      const res = await api(`/api/schedule/import?project_id=${projectId}&mode=${mode}`, { method: 'POST', raw: await file.text(), headers: { 'content-type': 'text/csv' } });
      toast(`Imported ${res.imported} activities (${mode})`);
      go('tab', 'lookahead');
    });
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => input.files[0] && upload(input.files[0]));
    dropzone(drop, (files) => upload(files[0]));
  }

  wire(el, '[data-tab]', 'click', (_e, n) => go('tab', n.dataset.tab));
  el.querySelector('#proj').addEventListener('change', (e) => go('project_id', e.target.value));
}

function dropzone(node, onFiles) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => { e.preventDefault(); node.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}

// ---------------- Meetings ----------------
async function meetings(el, _p, { render, openTask }) {
  const list = await api(`/api/meetings?from=${today()}`);
  const past = await api(`/api/meetings?to=${today()}`).then((m) => m.slice(-8).reverse());
  const byDay = Map.groupBy ? Map.groupBy(list, (m) => m.starts_at.slice(0, 10)) : list.reduce((acc, m) => acc.set(m.starts_at.slice(0, 10), [...(acc.get(m.starts_at.slice(0, 10)) || []), m]), new Map());
  const card = (m) => `
    <details class="panel" style="padding:12px 14px">
      <summary class="row" style="cursor:pointer"><b>${fmtTime(m.starts_at)}</b><span>${esc(m.title)}</span><span class="spacer"></span>
        <span class="small muted">${esc(m.project_name || '')}${m.location ? ` · ${esc(m.location)}` : ''}</span>
        <span class="row" style="gap:2px">${m.attendee_ids.map((id) => avatar(personById(id))).join('')}</span></summary>
      <div class="grid" style="margin-top:12px">
        ${m.agenda ? `<div><h3>Agenda</h3><pre class="reminder">${esc(m.agenda)}</pre></div>` : ''}
        <label class="field">Notes<textarea rows="4" data-notes="${m.id}">${esc(m.notes || '')}</textarea></label>
        <div class="row"><input placeholder="Action item…" data-action="${m.id}" style="flex:1">
          <select data-action-owner="${m.id}">${options(store.people, '', { empty: 'Owner' })}</select>
          <input type="date" data-action-due="${m.id}">
          <button class="btn sm" data-add-action="${m.id}">+ Add task</button></div>
        <div class="row"><button class="btn sm danger" data-del="${m.id}">Delete meeting</button></div>
      </div>
    </details>`;
  el.innerHTML = `
    <div class="page-head"><div><h1>Meetings</h1><p>Huddles, OACs, coordination — and the action items that come out of them.</p></div></div>
    <div class="grid two">
      <div class="grid" style="align-content:start">
        ${[...byDay.entries()].map(([day, ms]) => `<div><h2 style="margin-bottom:8px">${fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' })}</h2><div class="grid" style="gap:8px">${ms.map(card).join('')}</div></div>`).join('') || '<div class="empty">No upcoming meetings.</div>'}
        ${past.length ? `<h2 style="margin-top:12px">Recent</h2><div class="grid" style="gap:8px">${past.map(card).join('')}</div>` : ''}
      </div>
      <section class="panel" style="align-self:start"><h2>Schedule a meeting</h2>
        <form class="grid" id="new-meeting" style="margin-top:10px">
          <label class="field">Title<input name="title" required></label>
          <div class="form-grid">
            <label class="field">When<input type="datetime-local" name="starts_at" required></label>
            <label class="field">Minutes<input type="number" name="duration_min" value="30"></label>
            <label class="field">Project<select name="project_id">${options(store.projects, '', { empty: '—' })}</select></label>
            <label class="field">Location<input name="location"></label>
          </div>
          <label class="field">Attendees<select name="attendee_ids" multiple size="5">${options(store.people, '')}</select></label>
          <label class="field">Agenda<textarea name="agenda" rows="3"></textarea></label>
          <button class="btn primary">Add meeting</button>
        </form></section>
    </div>`;
  el.querySelector('#new-meeting').addEventListener('submit', (e) => {
    e.preventDefault();
    const b = formData(e.target);
    b.attendee_ids = [...e.target.attendee_ids.selectedOptions].map((o) => Number(o.value));
    b.project_id = b.project_id ? Number(b.project_id) : null;
    b.duration_min = Number(b.duration_min || 30);
    guard(async () => { await api('/api/meetings', { method: 'POST', body: b }); toast('Meeting scheduled'); render(); });
  });
  wire(el, '[data-notes]', 'change', (_e, n) => guard(async () => { await api(`/api/meetings/${n.dataset.notes}`, { method: 'PATCH', body: { notes: n.value } }); toast('Notes saved'); }));
  wire(el, '[data-add-action]', 'click', (_e, n) => {
    const id = n.dataset.addAction;
    const m = [...list, ...past].find((x) => x.id === Number(id));
    const title = el.querySelector(`[data-action="${id}"]`).value.trim();
    if (!title) return;
    guard(async () => {
      await api('/api/tasks', { method: 'POST', body: { title, project_id: m.project_id, owner_id: el.querySelector(`[data-action-owner="${id}"]`).value || null, due_date: el.querySelector(`[data-action-due="${id}"]`).value || null, source: 'meeting', source_ref: m.id } });
      toast('Action item added to the board');
      el.querySelector(`[data-action="${id}"]`).value = '';
    });
  });
  wire(el, '[data-del]', 'click', (_e, n) => confirm('Delete this meeting?') && guard(async () => { await api(`/api/meetings/${n.dataset.del}`, { method: 'DELETE' }); render(); }));
  void openTask;
}

// ---------------- Email intel ----------------
async function inbox(el, params, { render }) {
  const emails = await api('/api/emails');
  const selected = params.get('id') ? await api(`/api/emails/${params.get('id')}`) : null;
  el.innerHTML = `
    <div class="page-head"><div><h1>Email Intel</h1><p>Paste an email — Zordon pulls out the tasks, meetings, RFIs and submittals. ${store.meta.ai ? '<span class="pill h-done">Claude on</span>' : '<span class="pill">Rule-based · add ANTHROPIC_API_KEY for Claude</span>'}</p></div></div>
    <div class="grid two">
      <div class="grid" style="align-content:start">
        <section class="panel"><h2>New email</h2>
          <form class="grid" id="email-form" style="margin-top:10px">
            <div class="form-grid"><label class="field">From<input name="sender" placeholder="gc@company.com"></label><label class="field">Subject<input name="subject"></label></div>
            <label class="field">Body<textarea name="body" rows="9" required placeholder="Paste the email here…"></textarea></label>
            <button class="btn primary">⚡ Analyze</button>
          </form></section>
        <section class="panel"><header><h2>History</h2></header>
          <div class="list">${emails.map((m) => `<a class="item" href="#/inbox?id=${m.id}">
            <span class="pill ${m.status === 'new' ? 'h-due_soon' : m.status === 'processed' ? 'h-done' : ''}">${esc(m.status)}</span>
            <div class="grow"><div class="title">${esc(m.subject || '(no subject)')}</div><div class="sub">${esc(m.sender || '')} · ${esc(m.received_at.slice(0, 10))} · ${esc(m.analyzer)}</div></div></a>`).join('') || '<div class="empty">No emails yet.</div>'}</div></section>
      </div>
      <section class="panel" style="align-self:start" id="review">${selected ? review(selected) : '<div class="empty">Analyze or pick an email to review its suggestions.</div>'}</section>
    </div>`;
  el.querySelector('#email-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    guard(async () => {
      const res = await api('/api/emails', { method: 'POST', body: formData(e.target) });
      if (res.doc_items?.length) toast(`Picked up ${res.doc_items.length} ${res.doc_items[0].type === 'rfi' ? 'RFI' : 'submittal'} from ${res.doc_items[0].origin}`);
      location.hash = `#/inbox?id=${res.id}`;
    }).finally(() => { btn.disabled = false; btn.textContent = '⚡ Analyze'; });
  });
  if (!selected) return;
  const r = el.querySelector('#review');
  wire(r, '[data-accept]', 'click', () => {
    const pickRows = (kind) => [...r.querySelectorAll(`[data-kind=${kind}]`)].filter((n) => n.querySelector('[type=checkbox]').checked).map((n) => {
      const o = Object.fromEntries([...n.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value || null]));
      for (const k of ['owner_id', 'project_id']) if (o[k]) o[k] = Number(o[k]);
      return o;
    });
    guard(async () => {
      const res = await api(`/api/emails/${selected.id}/accept`, { method: 'POST', body: { tasks: pickRows('task'), meetings: pickRows('meeting') } });
      toast(`Added ${res.tasks.length} task(s) and ${res.meetings.length} meeting(s)`);
      render();
    });
  });
  wire(r, '[data-dismiss]', 'click', () => guard(async () => { await api(`/api/emails/${selected.id}/dismiss`, { method: 'POST', body: {} }); render(); }));
}

function review(m) {
  const a = m.analysis || { tasks: [], meetings: [] };
  return `
    <header><h2>Suggestions</h2><span class="pill ${a.urgency === 'high' ? 'h-delayed' : ''}">${esc(label(a.urgency || 'normal'))} urgency</span></header>
    <p class="muted">${esc(a.summary || '')}</p>
    <div class="small dim" style="margin-bottom:10px">${esc(m.sender || '')} — ${esc(m.subject || '')}</div>
    <div class="grid" style="gap:8px">
      ${a.tasks.map((t) => `<div class="check-row" data-kind="task"><input type="checkbox" checked ${m.status !== 'new' ? 'disabled' : ''}>
        <div class="form-grid">
          <input data-k="title" value="${esc(t.title)}">
          <select data-k="owner_id">${options(store.people, t.owner_id, { empty: 'Owner' })}</select>
          <input type="date" data-k="due_date" value="${esc(t.due_date || '')}">
          <select data-k="project_id">${options(store.projects, t.project_id, { empty: 'Project' })}</select>
          <input type="hidden" data-k="priority" value="${esc(t.priority)}">
        </div></div>`).join('')}
      ${a.meetings.map((x) => `<div class="check-row" data-kind="meeting"><input type="checkbox" checked ${m.status !== 'new' ? 'disabled' : ''}>
        <div class="form-grid">
          <input data-k="title" value="${esc(x.title)}">
          <input type="datetime-local" data-k="starts_at" value="${esc(x.starts_at)}">
          <input data-k="location" value="${esc(x.location || '')}" placeholder="Location">
          <select data-k="project_id">${options(store.projects, x.project_id, { empty: 'Project' })}</select>
        </div></div>`).join('')}
      ${!a.tasks.length && !a.meetings.length ? '<div class="empty">Nothing actionable found.</div>' : ''}
    </div>
    ${m.status === 'new' ? `<div class="row" style="margin-top:12px"><button class="btn primary" data-accept>Add selected to board</button><button class="btn ghost" data-dismiss>Dismiss</button></div>`
    : `<p class="small dim" style="margin-top:12px">This email was ${esc(m.status)}.</p>`}
    <details style="margin-top:14px"><summary class="small muted">Original email</summary><pre class="reminder">${esc(m.body)}</pre></details>`;
}

// ---------------- Reminders ----------------
async function reminders(el, _p, { render }) {
  const [drafts, history] = await Promise.all([api('/api/reminders/drafts'), api('/api/reminders')]);
  el.innerHTML = `
    <div class="page-head"><div><h1>Reminders</h1><p>Drafted nudges for anyone with past-due or soon-due work. Review, then send.</p></div></div>
    <div class="grid two">
      <div class="grid" style="align-content:start">
        ${drafts.map((d, i) => `<section class="panel c-${esc(d.color)}" style="border-left:3px solid var(--c)">
          <header><div class="row">${avatar(d)}<div><b>${esc(d.name)}</b><div class="small muted">${esc(d.role)} · ${esc(d.email || 'no email on file')}</div></div></div>
            <div class="row">${d.overdue ? `<span class="pill h-delayed">${d.overdue} past due</span>` : ''}${d.due_soon ? `<span class="pill h-due_soon">${d.due_soon} due soon</span>` : ''}</div></header>
          ${d.last_sent_at ? `<div class="small dim">Last reminded ${esc(d.last_sent_at)}</div>` : ''}
          <input data-subject="${i}" value="${esc(d.subject)}" style="width:100%;margin-top:8px">
          <textarea data-body="${i}" rows="9" style="margin-top:8px">${esc(d.body)}</textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn primary" data-mail="${i}" ${d.email ? '' : 'disabled title="Add an email on the Rangers page"'}>✉ Open in email & log</button>
            <button class="btn" data-copy="${i}">Copy</button>
            <button class="btn ghost" data-log="${i}">Mark sent</button></div>
        </section>`).join('') || '<div class="empty">Everyone is on schedule. No reminders needed.</div>'}
      </div>
      <section class="panel" style="align-self:start"><header><h2>Sent log</h2></header>
        <div class="list">${history.map((h) => `<div class="item" style="cursor:default"><div class="grow"><div class="title">${esc(h.subject)}</div><div class="sub">${esc(h.person_name || '')} · ${esc(h.created_at)} · ${esc(h.channel)}</div></div></div>`).join('') || '<div class="empty">No reminders sent yet.</div>'}</div>
        <p class="small dim" style="margin-top:12px">Want these sent automatically from your Outlook? See README → “Automatic reminders with Claude”.</p></section>
    </div>`;
  const current = (i) => ({ ...drafts[i], subject: el.querySelector(`[data-subject="${i}"]`).value, body: el.querySelector(`[data-body="${i}"]`).value });
  const log = (d, channel) => api('/api/reminders', { method: 'POST', body: { person_id: d.person_id, task_ids: d.task_ids, subject: d.subject, body: d.body, channel } });
  wire(el, '[data-mail]', 'click', (_e, n) => guard(async () => {
    const d = current(n.dataset.mail);
    window.location.href = `mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
    await log(d, 'email');
    setTimeout(render, 500);
  }));
  wire(el, '[data-copy]', 'click', (_e, n) => guard(async () => { const d = current(n.dataset.copy); await navigator.clipboard.writeText(`${d.subject}\n\n${d.body}`); toast('Copied — paste into Teams or a text'); }));
  wire(el, '[data-log]', 'click', (_e, n) => guard(async () => { await log(current(n.dataset.log), 'manual'); toast('Logged'); render(); }));
}

// ---------------- File vault ----------------
async function vault(el, params, { render }) {
  const f = Object.fromEntries(params);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [docs, categories, tasks, info] = await Promise.all([api(`/api/documents?${qs}`), api('/api/documents/categories'), api('/api/tasks?status='), api('/api/vault')]);
  const set = (k, v) => { const n = new URLSearchParams(f); if (v) n.set(k, v); else n.delete(k); location.hash = `#/vault?${n}`; };
  el.innerHTML = `
    <div class="page-head"><div><h1>File Vault</h1><p>Drop anything in. Zordon names it properly and files it by project and type, so you can find it months later.</p></div>
      <div class="row"><button class="btn" id="mk-folders">📁 Create project folders</button><button class="btn primary" id="file-inbox">⚡ File _Inbox now</button></div></div>
    <section class="panel" style="margin-bottom:16px">
      <div class="row"><span class="small muted">Vault folder</span><span class="mono">${esc(info.root)}</span></div>
      <div class="row small muted" style="margin-top:6px">Save anything into <span class="mono">${esc(info.inbox)}</span> — it's renamed and filed within a minute.
        Naming: <span class="mono">YYYY-MM-DD_JOB_Type_Description.ext</span> in <span class="mono">JOB-Project-Name/NN-Type/</span></div>
      <div class="chips" style="margin-top:8px">${info.folders.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    </section>
    <div class="grid two">
      <section class="panel">
        <h2>Save files</h2>
        <div class="form-grid" style="margin:10px 0">
          <label class="field">Project (optional — auto-detected)<select id="up-project">${options(store.projects, f.project_id, { empty: 'Detect automatically' })}</select></label>
          <label class="field">Link to task<select id="up-task">${options(tasks.filter((t) => t.status !== 'done'), '', { empty: '—', text: (t) => t.title })}</select></label>
        </div>
        <label class="field">What is it? (optional — helps the title)<input id="up-hint" placeholder="e.g. RFI response from architect about beam at C4"></label>
        <div class="dropzone" id="drop" style="margin-top:10px">Drop files here or click to choose<input type="file" multiple hidden></div>
        <div id="results" class="grid" style="gap:8px;margin-top:10px"></div>
      </section>
      <section class="panel">
        <h2>Name helper</h2>
        <p class="small muted">Saving somewhere else (OneDrive, SharePoint, Procore)? Get the standard name and folder without uploading.</p>
        <form class="grid" id="helper">
          <div class="form-grid"><label class="field">Current filename<input name="filename" placeholder="scan_0042.pdf"></label>
            <label class="field">Project<select name="project_id">${options(store.projects, '', { empty: 'Detect' })}</select></label></div>
          <label class="field">What is it?<input name="hint" required placeholder="Pay app #6 backup from electrical sub"></label>
          <button class="btn">Suggest name</button>
        </form>
        <div id="helper-out" style="margin-top:10px"></div>
      </section>
    </div>
    <div class="filters" style="margin-top:18px">
      <select data-f="project_id">${options(store.projects, f.project_id, { empty: 'All projects' })}</select>
      <select data-f="category">${options(categories, f.category, { empty: 'All types', value: (c) => c, text: (c) => c })}</select>
      <input data-f="q" placeholder="Search titles, names, notes…" value="${esc(f.q || '')}">
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Title</th><th>Type</th><th>Project</th><th>Saved as</th><th>Original name</th><th></th></tr></thead>
      <tbody>${docs.map((d) => `<tr data-doc="${d.id}">
        <td><input data-k="title" value="${esc(d.title)}" style="width:100%"></td>
        <td><select data-k="category">${options(categories, d.category, { value: (c) => c, text: (c) => c })}</select></td>
        <td><select data-k="project_id">${options(store.projects, d.project_id, { empty: 'Unfiled' })}</select></td>
        <td class="mono" style="max-width:340px;word-break:break-all">${esc(d.path)}</td>
        <td class="small dim">${esc(d.original_name || '')}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-dl>Open</button><button class="btn sm danger" data-rm>✕</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="dim">No files yet.</td></tr>'}</tbody>
    </table></div>`;

  el.querySelector('#mk-folders').addEventListener('click', () => guard(async () => {
    const r = await api('/api/vault/folders', { method: 'POST', body: {} });
    toast(`Folder structure ready for ${r.projects.length} project(s)`);
  }));
  el.querySelector('#file-inbox').addEventListener('click', () => guard(async () => {
    const filed = await api('/api/vault/inbox', { method: 'POST', body: {} });
    toast(filed.length ? `Filed ${filed.length} file(s) from _Inbox` : '_Inbox is empty (files settle for 10 seconds first)');
    if (filed.length) render();
  }));
  const drop = el.querySelector('#drop');
  const input = drop.querySelector('input');
  const results = el.querySelector('#results');
  const upload = async (files) => {
    for (const file of files) {
      const q = new URLSearchParams({ filename: file.name, mime: file.type || '' });
      const pid = el.querySelector('#up-project').value;
      const tid = el.querySelector('#up-task').value;
      const hint = el.querySelector('#up-hint').value.trim();
      if (pid) q.set('project_id', pid);
      if (tid) q.set('task_id', tid);
      if (hint) q.set('hint', hint);
      const doc = await guard(() => api(`/api/documents?${q}`, { method: 'POST', raw: file }));
      if (doc) results.insertAdjacentHTML('beforeend', `<div class="suggest"><div class="row"><span class="pill h-done">Saved</span><b>${esc(doc.title)}</b><span class="pill">${esc(doc.category)}</span></div><div class="mono path">${esc(doc.path)}</div><div class="small dim">was “${esc(file.name)}” · named by ${esc(doc.analyzer)}</div></div>`);
    }
    setTimeout(render, 1500);
  };
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => upload([...input.files]));
  dropzone(drop, upload);

  el.querySelector('#helper').addEventListener('submit', (e) => {
    e.preventDefault();
    const b = formData(e.target);
    if (b.project_id) b.project_id = Number(b.project_id);
    guard(async () => {
      const s = await api('/api/documents/suggest', { method: 'POST', body: b });
      el.querySelector('#helper-out').innerHTML = `<div class="suggest"><div class="small muted">Folder</div><div class="mono path">${esc(s.folder)}/</div>
        <div class="small muted">File name</div><div class="mono path"><b>${esc(s.filename)}</b></div><button class="btn sm" id="copy-name">Copy name</button></div>`;
      el.querySelector('#copy-name').addEventListener('click', () => navigator.clipboard.writeText(s.filename).then(() => toast('Copied')));
    });
  });
  wire(el, '[data-f]', 'change', (_e, n) => set(n.dataset.f, n.value));
  wire(el, '[data-doc] [data-k]', 'change', (_e, n) => guard(async () => {
    const id = n.closest('[data-doc]').dataset.doc;
    const v = n.dataset.k === 'project_id' ? (n.value ? Number(n.value) : null) : n.value;
    const d = await api(`/api/documents/${id}`, { method: 'PATCH', body: { [n.dataset.k]: v } });
    toast(`Moved to ${d.path}`);
    render();
  }));
  wire(el, '[data-dl]', 'click', (_e, n) => guard(() => downloadDoc(docs.find((d) => d.id === Number(n.closest('[data-doc]').dataset.doc)))));
  wire(el, '[data-rm]', 'click', (_e, n) => confirm('Delete this file from the vault?') && guard(async () => {
    await api(`/api/documents/${n.closest('[data-doc]').dataset.doc}`, { method: 'DELETE' });
    render();
  }));
}

// ---------------- Rangers (team) ----------------
async function team(el, _p, { render }) {
  const settings = await api('/api/settings');
  const colors = store.meta.colors;
  el.innerHTML = `
    <div class="page-head"><div><h1>Rangers</h1><p>Your PM team and foremen. Every Ranger gets a color.</p></div>
      <label class="field">Who is “me”?<select id="me">${options(store.people, settings.me_person_id)}</select></label></div>
    <div class="grid rangers">
      ${store.people.map((p) => `<form class="ranger c-${esc(p.color)}" data-id="${p.id}" style="cursor:default">
        <div class="row">${avatar(p, 'lg')}<div class="grow"><input name="name" value="${esc(p.name)}" style="width:100%;font-weight:700"></div></div>
        <div class="grid" style="gap:6px;margin-top:10px">
          <input name="role" value="${esc(p.role)}" placeholder="Role (APM, Foreman…)">
          <input name="trade" value="${esc(p.trade || '')}" placeholder="Trade">
          <input name="email" value="${esc(p.email || '')}" placeholder="Email" type="email">
          <input name="phone" value="${esc(p.phone || '')}" placeholder="Phone">
          <select name="color">${options(colors, p.color, { value: (c) => c, text: label })}</select>
          <div class="row"><button class="btn sm">Save</button><span class="spacer"></span>
            <label class="row small"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active</label></div>
        </div></form>`).join('')}
      <form class="ranger" id="new-person" style="cursor:default;--c:var(--gold)">
        <b>Recruit a Ranger</b>
        <div class="grid" style="gap:6px;margin-top:10px">
          <input name="name" required placeholder="Name">
          <input name="role" placeholder="Role" value="Foreman">
          <input name="trade" placeholder="Trade">
          <input name="email" type="email" placeholder="Email">
          <select name="color">${options(colors, colors[store.people.length % colors.length], { value: (c) => c, text: label })}</select>
          <button class="btn gold">⚡ Add</button>
        </div></form>
    </div>`;
  wire(el, 'form[data-id]', 'submit', (e, form) => {
    e.preventDefault();
    const b = formData(form);
    b.active = form.active.checked;
    guard(async () => { await api(`/api/people/${form.dataset.id}`, { method: 'PATCH', body: b }); toast('Saved'); render(); });
  });
  el.querySelector('#new-person').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => { await api('/api/people', { method: 'POST', body: formData(e.target) }); toast('Welcome to the team'); render(); });
  });
  el.querySelector('#me').addEventListener('change', (e) => guard(async () => {
    await api('/api/settings', { method: 'PATCH', body: { me_person_id: Number(e.target.value) } });
    toast('Updated');
  }));
}

// ---------------- Claude Link ----------------
async function claude(el, params, { render }) {
  const tab = params.get('tab') || 'skills';
  const [skills, jobs, proposals] = await Promise.all([api('/api/claude/skills'), api('/api/claude/jobs'), api('/api/claude/proposals')]);
  const categories = await api('/api/documents/categories');
  const open = proposals.filter((p) => p.status === 'open');
  const go = (t) => { location.hash = `#/claude?tab=${t}`; };
  const statusCls = { queued: 'h-due_soon', needs_input: 'h-stuck', done: 'h-done', failed: 'h-delayed', cancelled: '' };
  el.innerHTML = `
    <div class="page-head"><div><h1>Claude Link</h1>
      <p>Zordon hands work to your Claude (Cowork) through OneDrive. Claude uses these skills, saves files into the right job folders, and reports back here.</p></div>
      <div class="row"><button class="btn" id="copy-run">📋 Copy "run my jobs" for Cowork</button></div></div>
    <div class="tabs">${[['skills', `Skills (${skills.length})`], ['jobs', `Jobs (${jobs.filter((j) => ['queued', 'needs_input'].includes(j.status)).length} open)`], ['learn', `Learning${open.length ? ` (${open.length})` : ''}`], ['filing', 'Filing rules']]
      .map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  const body = el.querySelector('#tab');

  if (tab === 'skills') {
    body.innerHTML = `
      <div class="grid three">
        ${skills.map((s) => `<section class="panel" style="display:grid;gap:8px">
          <div class="row"><b>${esc(s.title)}</b><span class="spacer"></span>${s.builtin ? '<span class="pill">starter</span>' : '<span class="pill h-done">yours</span>'}</div>
          <div class="small muted">${esc(s.description || '')}</div>
          <div class="small dim">Saves to: ${esc(s.output_category || 'the job folder')} · <span class="mono">${esc(s.name)}</span></div>
          <div class="row"><button class="btn sm" data-edit="${esc(s.name)}">Edit</button>${s.builtin ? '' : `<button class="btn sm danger" data-del="${esc(s.name)}">Delete</button>`}</div>
        </section>`).join('')}
        <section class="panel" style="display:grid;gap:8px;align-content:start">
          <b>+ Teach Zordon a new skill</b>
          <p class="small muted">Write it the way you'd explain it to a new project engineer. Claude follows it every time. You can also ask Claude in Cowork to "save this as a Zordon skill".</p>
          <button class="btn gold" data-edit="">⚡ New skill</button>
        </section>
      </div>
      <section class="panel" id="editor" style="margin-top:16px" hidden></section>`;
    const editor = body.querySelector('#editor');
    wire(body, '[data-edit]', 'click', (_e, n) => {
      const s = skills.find((x) => x.name === n.dataset.edit) || { name: '', title: '', description: '', output_category: '', body: '' };
      editor.hidden = false;
      editor.innerHTML = `<h2>${s.name ? `Edit: ${esc(s.title)}` : 'New skill'}</h2>
        <form class="grid" id="skill-form" style="margin-top:10px">
          <div class="form-grid">
            <label class="field">Short name (lowercase-with-dashes)<input name="name" required pattern="[a-z0-9][a-z0-9-]{1,48}" value="${esc(s.name)}" ${s.name ? 'readonly' : ''} placeholder="takeoff-count"></label>
            <label class="field">Title<input name="title" required value="${esc(s.title)}" placeholder="Device takeoff count"></label>
            <label class="field">Saves to<select name="output_category">${options(categories, s.output_category, { empty: 'Job folder', value: (c) => c, text: (c) => c })}</select></label>
          </div>
          <label class="field">When should Claude use it?<input name="description" value="${esc(s.description || '')}" placeholder="Count devices per sheet from lighting and power plans"></label>
          <label class="field">Instructions (SKILL.md)<textarea name="body" rows="18" class="mono">${esc(s.body || '')}</textarea></label>
          <div class="row"><button class="btn primary">Save skill</button><button type="button" class="btn ghost" id="cancel-edit">Cancel</button></div>
        </form>`;
      editor.scrollIntoView({ behavior: 'smooth' });
      editor.querySelector('#cancel-edit').addEventListener('click', () => { editor.hidden = true; });
      editor.querySelector('#skill-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const b = formData(e.target);
        guard(async () => { await api(`/api/claude/skills/${b.name}`, { method: 'PUT', body: b }); toast('Skill saved — Claude will use it from now on'); render(); });
      });
    });
    wire(body, '[data-del]', 'click', (_e, n) => confirm('Delete this skill?') && guard(async () => { await api(`/api/claude/skills/${n.dataset.del}`, { method: 'DELETE' }); render(); }));
  }

  if (tab === 'jobs') {
    body.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Skill</th><th>Task / project</th><th>Status</th><th>Result</th><th></th></tr></thead>
        <tbody>${jobs.map((j) => `<tr>
          <td class="mono">${j.id}</td><td><b>${esc(j.skill_title || j.skill)}</b><div class="small dim">${esc(j.created_at)}</div></td>
          <td>${esc(j.task_title || '—')}<div class="small dim">${esc(j.project_name || '')} · saves to <span class="mono">${esc(j.output_folder || '')}</span></div></td>
          <td><span class="pill ${statusCls[j.status] || ''}">${esc(label(j.status))}</span></td>
          <td class="small">${esc(j.result_note || '')}${j.outputs.map((o) => `<div class="mono dim">${esc(o.path)}</div>`).join('')}</td>
          <td>${['queued', 'needs_input'].includes(j.status) ? `<button class="btn sm ghost" data-cancel="${j.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">No jobs yet. Open any task and press 🤖 Send to Claude.</td></tr>'}</tbody>
      </table></div>`;
    wire(body, '[data-cancel]', 'click', (_e, n) => guard(async () => { await api(`/api/claude/jobs/${n.dataset.cancel}/cancel`, { method: 'POST', body: {} }); render(); }));
  }

  if (tab === 'learn') {
    body.innerHTML = `
      <p class="muted small">Claude watches how you actually work. When it sees the same new habit 3+ times it proposes an update here. Nothing changes until you approve.</p>
      <div class="grid" style="gap:10px">${proposals.map((p) => `<section class="panel">
        <div class="row"><span class="pill ${p.status === 'open' ? 'h-due_soon' : p.status === 'approved' ? 'h-done' : ''}">${esc(p.status)}</span>
          <span class="pill">${p.kind === 'skill' ? `skill: ${esc(p.skill)}` : 'filing rule'}</span><b>${esc(p.title)}</b></div>
        ${p.rule ? `<p>${esc(p.rule)}</p>` : ''}
        ${p.evidence.length ? `<div class="small dim">Seen: ${p.evidence.map(esc).join(' · ')}</div>` : ''}
        ${p.body ? `<details><summary class="small muted">Proposed skill text</summary><pre class="reminder">${esc(p.body)}</pre></details>` : ''}
        ${p.status === 'open' ? `<div class="row" style="margin-top:8px"><button class="btn primary sm" data-decide="${p.id}/approve">Approve</button><button class="btn ghost sm" data-decide="${p.id}/dismiss">Dismiss</button></div>` : ''}
      </section>`).join('') || '<div class="empty">No proposals yet. The weekly habit check and Cowork add them here.</div>'}</div>`;
    wire(body, '[data-decide]', 'click', (_e, n) => guard(async () => { await api(`/api/claude/proposals/${n.dataset.decide}`, { method: 'POST', body: {} }); toast('Done'); render(); }));
  }

  if (tab === 'filing') {
    const { markdown } = await api('/api/claude/filing');
    body.innerHTML = `<section class="panel"><p class="small muted">This is <span class="mono">Zordon/FILING.md</span> in your OneDrive — the rulebook Zordon and Claude both follow.</p><pre class="reminder">${esc(markdown)}</pre></section>`;
  }

  wire(el, '[data-tab]', 'click', (_e, n) => go(n.dataset.tab));
  el.querySelector('#copy-run').addEventListener('click', () => navigator.clipboard.writeText('Run my Zordon jobs.').then(() => toast('Copied — paste it into Claude Cowork')));
}

export const views = { claude, projects, doccontrol, schedule, meetings, inbox, reminders, vault, team };
