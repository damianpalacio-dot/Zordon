import { api, esc, fmtDate, fmtTime, relDays, avatar, label, toast, guard, store, refreshRefs, personById, options } from './core.js';
import { views as moreViews } from './views.js';

const view = document.getElementById('view');
const drawer = document.getElementById('drawer');
let cleanup = null;
let zordon = null; // the 3D scene survives navigation so it doesn't rebuild every visit

// ---------------- Command Center ----------------
async function commandView(el) {
  const [d, focus] = await Promise.all([api('/api/dashboard'), api('/api/focus')]);
  const c = d.counts;
  const alertText = { green: 'All systems nominal', yellow: 'Caution — attention needed', red: 'Ay-yi-yi! Red alert' }[d.alert];
  const panel = (title, link, body) => `<section class="panel"><header><h2>${title}</h2>${link || ''}</header><div class="list">${body}</div></section>`;
  const sys = d.systems;
  const light = (name, on) => `<span class="sys ${on ? 'on' : ''}"><i></i>${esc(name)}</span>`;
  el.innerHTML = `
    <div class="hud-strip a-${d.alert}">
      <span class="hud-title">⚡ COMMAND CENTER <b>// ONLINE</b></span>
      <span class="hud-clock" id="clock"></span>
      <span class="hud-date">${fmtDate(d.today, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</span>
      <span class="hud-weather" id="hud-weather"></span>
      <span class="spacer"></span>
      ${light('ONEDRIVE', sys.onedrive)}${light('VOICE', sys.voice)}${light('CLAUDE', sys.ai)}${sys.connectors.map((x) => light(x.name.toUpperCase(), x.configured)).join('')}
      <span class="hud-alert"><span class="lamp"></span>${esc(alertText.toUpperCase())}</span>
    </div>
    <div class="page-head">
      <div><h1>Command Center</h1></div>
      <div class="row">
        <button class="btn" id="speak">🔊 Hear briefing</button>
        <a class="btn primary" href="#/inbox">✉ Triage email</a>
      </div>
    </div>
    <div class="command-grid">
      <div class="col col-left">
        <div class="grid kpis mini">
          ${kpi('Delayed', c.delayed, 'h-delayed', '#/board?health=delayed')}
          ${kpi('Due ≤ 2 days', c.due_soon, 'h-due_soon', '#/board?health=due_soon')}
          ${kpi('💲 CO & billing', c.money, 'money', '#/focus')}
          ${kpi('In my court', d.doccontrol.in_my_court.length, 'a-yellow', '#/doccontrol')}
        </div>
        ${panel('⚑ Your nudges', '<a href="#/focus" class="small">Reality check →</a>',
          focus.nudges.length ? focus.nudges.slice(0, 6).map(nudgeRow).join('') : '<div class="empty">Nothing due in the next 3 days. Nice.</div>')}
        ${panel('📐 In your court', '<a href="#/doccontrol" class="small">RFIs & subs →</a>',
          d.doccontrol.in_my_court.length ? d.doccontrol.in_my_court.map(itemRow(d.today)).join('') : '<div class="empty">Nothing waiting on you.</div>')}
      </div>

      <div class="col col-center">
        <div class="stage" id="stage">
          <div class="hud-frame" aria-hidden="true">
            <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
            <div class="ruler left"></div><div class="ruler right"></div>
            <div class="readout r1">PWR <b>${100 - c.delayed * 4}%</b></div>
            <div class="readout r2">SIGNAL <b>LOCK</b></div>
            <div class="readout r3">OPS <b>${c.open}</b></div>
            <div class="readout r4">ALERT <b class="a-${d.alert}" style="color:var(--c)">${d.alert.toUpperCase()}</b></div>
          </div>
          <div class="label"><span class="dot a-${d.alert}"></span><b>ZORDON</b><span class="spacer"></span><span class="small muted" id="stage-hint">Move your mouse — he follows</span></div>
        </div>
        <section class="briefing alert-${d.alert}">
          <div class="alpha alpha-${d.alert} a-${d.alert}"><span class="lamp"></span>${esc(alertText)}</div>
          <div class="text" id="briefing-text"></div>
        </section>
        <section class="panel"><header><h2>⛅ Jobsite weather</h2><span class="small dim">Open-Meteo</span></header>
          <div id="weather" class="grid" style="gap:10px"><div class="small dim">Scanning the skies…</div></div></section>
      </div>

      <div class="col col-right">
        <div class="grid kpis mini">
          ${kpi('Meetings today', c.meetings_today, '', '#/meetings')}
          ${kpi('Stuck', c.stuck, 'h-stuck', '#/board?status=stuck')}
          ${kpi('Open tasks', c.open, '', '#/board')}
          ${kpi('Done this week', c.done_this_week, 'h-done', '#/board?status=done')}
        </div>
        ${panel('🌐 Viewing globe — delayed', '<a href="#/reminders" class="small">Remind →</a>',
          d.delayed.length ? d.delayed.map(taskRow(d.today)).join('') : '<div class="empty">No delayed tasks.</div>')}
        ${panel('💲 Change orders & billing', '',
          d.money.length ? d.money.map(taskRow(d.today)).join('') : '<div class="empty">No open CO or billing items.</div>')}
      </div>
    </div>

    <section style="margin-top:18px">
      <div class="page-head" style="margin-bottom:10px"><h2>⚡ Rangers</h2><a href="#/team" class="small">Manage team →</a></div>
      <div class="grid rangers">${d.team.map(rangerCard).join('')}</div>
    </section>

    <div class="grid two" style="margin-top:16px">
      ${panel('◈ Projects', '<a href="#/projects" class="small">Portfolio →</a>', d.projects.filter((p) => p.status !== 'closed').map((p) => `
          <a class="item" href="#/board?project_id=${p.id}">
            <span class="dot a-${p.health}"></span>
            <div class="grow"><div class="title">${esc(p.name)}</div>
              <div class="bar" style="margin-top:6px"><span style="width:${p.progress}%"></span></div></div>
            <span class="small muted">${p.open} open${p.delayed ? ` · <b style="color:var(--red)">${p.delayed} late</b>` : ''}</span>
          </a>`).join('') || '<div class="empty">No projects yet.</div>')}
      ${panel('◷ Coming up', '<a href="#/meetings" class="small">All meetings →</a>', d.upcoming_meetings.slice(0, 6).map((m) => `
          <a class="item" href="#/meetings">
            <div class="grow"><div class="title">${esc(m.title)}</div><div class="sub">${esc(m.project_name || '')}${m.location ? ` · ${esc(m.location)}` : ''}</div></div>
            <span class="small muted">${fmtDate(m.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(m.starts_at)}</span>
          </a>`).join('') || '<div class="empty">No meetings this week.</div>')}
    </div>`;

  el.querySelectorAll('[data-task]').forEach((n) => n.addEventListener('click', () => openTask(Number(n.dataset.task))));
  el.querySelectorAll('[data-person]').forEach((n) => n.addEventListener('click', () => { location.hash = `#/board?owner_id=${n.dataset.person}`; }));

  const clock = el.querySelector('#clock');
  const tickClock = () => { clock.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tickClock();
  const clockTimer = setInterval(tickClock, 1000);

  // Typewriter briefing.
  const textEl = el.querySelector('#briefing-text');
  let i = 0;
  const timer = setInterval(() => {
    textEl.textContent = d.briefing.slice(0, ++i);
    if (i >= d.briefing.length) { clearInterval(timer); textEl.classList.add('done'); }
  }, 14);

  // 3D Zordon.
  const stage = el.querySelector('#stage');
  try {
    if (!zordon) {
      const { createZordon } = await import('./zordon3d.js');
      zordon = { host: document.createElement('div'), api: null };
      zordon.host.style.cssText = 'position:absolute;inset:0';
      stage.prepend(zordon.host); // attach before creating so the canvas gets its real size
      zordon.api = createZordon(zordon.host);
    }
    stage.prepend(zordon.host);
    zordon.api.setAlert(d.alert);
  } catch (err) {
    console.warn('3D unavailable', err);
    stage.classList.add('zordon-fallback');
  }
  // Weather loads on its own so a slow forecast never holds up the command center.
  let weatherNote = '';
  api('/api/weather').then((sites) => {
    const box = el.querySelector('#weather');
    if (!box) return;
    box.innerHTML = weatherPanel(sites);
    const first = sites.find((w) => w.current);
    if (first) el.querySelector('#hud-weather').textContent = `${first.current.icon} ${first.current.temp_f}°F ${first.location.split(',')[0].toUpperCase()}`;
    const warnings = sites.flatMap((w) => (w.days || []).slice(0, 2).flatMap((day, i) => day.impacts.map((x) => `${i ? 'Tomorrow' : 'Today'} at ${w.project_name}: ${x.text.split(' — ')[0]}.`)));
    weatherNote = warnings.length ? ` Weather: ${warnings.slice(0, 2).join(' ')}` : '';
  }).catch(() => { const box = el.querySelector('#weather'); if (box) box.innerHTML = '<div class="small dim">Weather unavailable right now.</div>'; });

  el.querySelector('#speak').addEventListener('click', () => (zordon?.api ? zordon.api.speak(d.briefing + weatherNote) : toast('Speech not available')));

  // Greeting once per session — spoken by the server through the computer's voice, no click needed.
  const first = (focus.person?.name || '').split(/\s+/)[0];
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const greeting = `Good ${part}${first ? `, ${first}` : ''}. Make today a day better than the last.`;
  textEl.insertAdjacentHTML('beforebegin', `<div class="greeting">${esc(greeting)}</div>`);
  let greeted = false;
  try { greeted = sessionStorage.getItem('zordon.greeted') === '1'; } catch { /* storage blocked */ }
  if (!greeted) {
    try { sessionStorage.setItem('zordon.greeted', '1'); } catch { /* storage blocked */ }
    const res = await api('/api/voice/hello', { method: 'POST', body: { text: greeting } }).catch(() => null);
    if (res?.spoken) zordon?.api?.animate(greeting);
    else if (res?.reason !== 'reload' && res?.reason !== 'recently greeted') {
      // No computer voice available: speak in the browser if allowed, else on the first click.
      const speakNow = () => zordon?.api?.speak(greeting);
      if (navigator.userActivation?.hasBeenActive) speakNow();
      else document.addEventListener('pointerdown', speakNow, { once: true });
    }
  }
  return () => { clearInterval(timer); clearInterval(clockTimer); zordon?.api?.stop(); zordon?.host.remove(); };
}

// Each stat gets a glowing gauge ring; the ring fills toward a sensible "full" value.
const kpi = (l, n, cls, href, full = 10) => {
  const pct = typeof n === 'number' ? Math.min(100, Math.round((n / full) * 100)) : 0;
  return `<a class="kpi ${cls}" href="${href}">
    <span class="gauge" style="--p:${pct}"><span>${n}</span></span>
    <span class="l">${esc(l)}</span></a>`;
};

export const taskRow = (today) => (t) => `
  <div class="item" data-task="${t.id}">
    ${avatar({ name: t.owner_name, color: t.owner_color })}
    <div class="grow"><div class="title">${t.money ? '💲 ' : ''}${t.electrical ? '⚡ ' : ''}${esc(t.title)}</div><div class="sub">${esc(t.project_name || 'No project')}${t.owner_name ? ` · ${esc(t.owner_name)}` : ''}</div></div>
    <span class="pill h-${t.health}">${t.due_date ? relDays(t.due_date, today) : label(t.health)}</span>
  </div>`;

const nudgeRow = (t) => `
  <div class="item" data-task="${t.id}">
    <span class="dot ${t.due_in < 0 ? 'h-delayed' : t.due_in <= 1 ? 'h-due_soon' : 'h-on_track'}"></span>
    <div class="grow"><div class="title">${esc(t.title)}</div><div class="sub">${esc(t.nudge)}</div></div>
    <span class="pill pr-${t.priority} ${t.money ? 'money' : ''}">${esc(label(t.priority))}</span>
  </div>`;

export const itemRow = (today) => (i) => `
  <a class="item" href="${i.url ? esc(i.url) : '#/doccontrol'}" ${i.url ? 'target="_blank" rel="noopener"' : ''}>
    <span class="pill">${i.type === 'rfi' ? 'RFI' : 'SUB'}</span>
    <div class="grow"><div class="title">${i.number ? `#${esc(i.number)} ` : ''}${esc(i.title)}</div>
      <div class="sub">${esc(i.spec_section || 'No spec')} · ${esc(i.status || '')} · ${esc(i.project_name || 'Unmatched project')}</div></div>
    ${i.due_date ? `<span class="pill ${i.due_date < today ? 'h-delayed' : 'h-due_soon'}">${relDays(i.due_date, today)}</span>` : ''}
  </a>`;

// One compact line per city (jobs in the same city share the forecast), a 4-day strip, and the work warnings
// gathered underneath instead of repeated on every job.
function weatherPanel(sites) {
  const ok = sites.filter((w) => w.current);
  if (!ok.length) return '<div class="small dim">Add a city to a project (Projects → Edit) to see its weather.</div>';
  const groups = new Map();
  for (const w of ok) {
    const key = String(w.location || '').split(',')[0].trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { w, jobs: [] });
    groups.get(key).jobs.push(w.project_code || w.project_name);
  }
  const flags = [];
  const rows = [...groups.values()].map(({ w, jobs }) => {
    const city = String(w.location).split(',')[0];
    w.days.slice(0, 2).forEach((day, i) => day.impacts.forEach((x) => flags.push({ ...x, city, when: i ? 'Tomorrow' : 'Today' })));
    return `<div class="wx-row" title="${esc(`${w.location} · ${w.current.text} · feels ${w.current.feels_f}° · wind ${w.current.wind_mph} mph`)}">
      <div class="wx-loc"><b>${esc(city)}</b><span class="small dim">${esc(jobs.slice(0, 4).join(' · '))}${jobs.length > 4 ? ` +${jobs.length - 4}` : ''}</span></div>
      <div class="wx-now">${w.current.icon} ${w.current.temp_f}°</div>
      <div class="wx-strip">${w.days.slice(0, 4).map((day, i) => `<span class="${day.impacts.length ? 'flag' : ''}${day.precip_prob >= 40 ? ' wet' : ''}" title="${esc([day.text, `Rain ${day.precip_prob}%`, ...day.impacts.map((x) => x.text)].join('\n'))}">
        <i>${i ? fmtDate(day.date, { weekday: 'short' }) : 'Today'}${day.precip_prob >= 40 ? ` 💧${day.precip_prob}%` : ''}</i><b>${day.icon} ${day.temp_max_f}°<em>/${day.temp_min_f}°</em></b></span>`).join('')}</div>
    </div>`;
  }).join('');
  const seen = new Set();
  const warn = flags.filter((x) => { const k = `${x.when}|${x.city}|${x.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const missing = sites.length - ok.length;
  return `<div class="wx-list">${rows}</div>
    ${warn.length ? `<div class="wx-warn">${warn.slice(0, 4).map((x) => `<div class="small wx-flag ${x.level}">⚠ ${x.when} · ${esc(x.city)}: ${esc(x.text.split(' — ')[0])}</div>`).join('')}</div>` : '<div class="small dim" style="margin-top:6px">No weather impacts on the work today or tomorrow.</div>'}
    ${missing ? `<div class="small dim" style="margin-top:4px">${missing} job(s) without a city — add one under Projects → Edit.</div>` : ''}`;
}

const rangerCard = (p) => `
  <div class="ranger c-${esc(p.color)}" data-person="${p.id}">
    <div class="row">${avatar(p, 'lg')}<div><div class="name">${esc(p.name)}</div><div class="small muted">${esc(p.role)}${p.trade ? ` · ${esc(p.trade)}` : ''}</div></div></div>
    <div class="stats">
      <span class="pill">${p.open} open</span>
      ${p.delayed ? `<span class="pill h-delayed">${p.delayed} late</span>` : ''}
      ${p.due_soon ? `<span class="pill h-due_soon">${p.due_soon} due soon</span>` : ''}
      ${p.stuck ? `<span class="pill h-stuck">${p.stuck} stuck</span>` : ''}
    </div>
  </div>`;

// ---------------- My focus ----------------
async function focusView(el) {
  const [f, settings] = await Promise.all([api('/api/focus'), api('/api/settings')]);
  const r = f.reality;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>My Focus</h1><p>${f.person ? `Nudges and an honest reality check for ${esc(f.person.name)}` : 'Pick who "me" is on the Rangers page.'}</p></div>
      <label class="field">Focus hours per workday
        <input type="number" min="1" max="12" step="0.5" id="cap" value="${esc(settings.capacity_hours_per_day)}" style="width:110px"></label>
    </div>
    ${r ? `
    <div class="grid kpis" style="margin-bottom:16px">
      ${kpi('Hours due next 7 days', r.load_7d, r.load_7d > r.available_7d ? 'h-delayed' : 'h-on_track', '#/focus')}
      ${kpi('Focus hours available', r.available_7d, '', '#/focus')}
      ${kpi('On-time rate', r.on_time_rate == null ? '—' : `${r.on_time_rate}%`, r.on_time_rate >= 80 ? 'h-done' : 'h-due_soon', '#/focus')}
      ${kpi('Avg days late', r.avg_slip_days ?? '—', r.avg_slip_days > 1 ? 'h-delayed' : '', '#/focus')}
    </div>
    <section class="briefing ${r.at_risk.length || r.load_7d > r.available_7d ? 'alert-yellow' : ''}" style="margin-bottom:16px">
      <div class="alpha"><span class="lamp" style="--c:var(--cyan)"></span>Reality check</div>
      <div class="text done">${r.advice.map(esc).join('<br>')}</div>
    </section>
    <div class="grid two">
      <section class="panel"><header><h2>⚑ Nudges</h2><span class="small dim">3 days, 1 day and day-of</span></header>
        <div class="list">${f.nudges.length ? f.nudges.map(nudgeRow).join('') : '<div class="empty">Nothing due in the next 3 days.</div>'}</div></section>
      <section class="panel"><header><h2>Plan at your real pace</h2><span class="small dim">in due-date order</span></header>
        <div class="table-wrap"><table style="min-width:520px"><thead><tr><th>Task</th><th>Est</th><th>Due</th><th>Lands</th></tr></thead><tbody>
        ${r.plan.map((p) => `<tr data-task="${p.id}" style="cursor:pointer"><td>${esc(p.title)}</td><td>${p.hours}h</td><td>${fmtDate(p.due_date)}</td>
          <td><span class="pill ${p.at_risk ? 'h-delayed' : 'h-on_track'}">${fmtDate(p.projected)}</span></td></tr>`).join('') || '<tr><td colspan="4" class="dim">No dated tasks.</td></tr>'}
        </tbody></table></div>
        <p class="small dim">Set an estimate on each task (open it) to make this sharper. Unestimated tasks count as 2h.</p>
      </section>
    </div>` : ''}`;
  el.querySelectorAll('[data-task]').forEach((n) => n.addEventListener('click', () => openTask(Number(n.dataset.task))));
  el.querySelector('#cap').addEventListener('change', (e) => guard(async () => {
    await api('/api/settings', { method: 'PATCH', body: { capacity_hours_per_day: Number(e.target.value) } });
    render();
  }));
}

// ---------------- Board (Monday-style) ----------------
async function boardView(el, params) {
  const filters = Object.fromEntries(params);
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const tasks = await api(`/api/tasks${qs ? `?${qs}` : ''}`);
  const { today, statuses, priorities } = store.meta;
  const groups = new Map();
  for (const p of store.projects.filter((p) => !filters.project_id || p.id === Number(filters.project_id))) groups.set(p.id, { project: p, tasks: [] });
  for (const t of tasks) {
    if (!groups.has(t.project_id)) groups.set(t.project_id, { project: { id: t.project_id, name: t.project_name || 'No project' }, tasks: [] });
    groups.get(t.project_id).tasks.push(t);
  }
  const set = (k, v) => {
    const next = new URLSearchParams(filters);
    if (v) next.set(k, v); else next.delete(k);
    location.hash = `#/board?${next}`;
  };

  el.innerHTML = `
    <div class="page-head"><div><h1>Board</h1><p>${tasks.length} task${tasks.length === 1 ? '' : 's'}</p></div>
      <button class="btn primary" id="new-task">+ New task</button></div>
    <div class="filters">
      <select data-f="project_id">${options(store.projects, filters.project_id, { empty: 'All projects' })}</select>
      <select data-f="owner_id">${options(store.people, filters.owner_id, { empty: 'Everyone' })}</select>
      <select data-f="status">${options(statuses, filters.status, { empty: 'Any status', value: (s) => s, text: label })}</select>
      <select data-f="health">${options(['delayed', 'due_soon', 'stuck', 'on_track', 'done'], filters.health, { empty: 'Any health', value: (s) => s, text: label })}</select>
      <input data-f="q" placeholder="Search…" value="${esc(filters.q || '')}">
      ${qs ? '<a class="btn ghost" href="#/board">Clear</a>' : ''}
    </div>
    ${[...groups.values()].map(({ project, tasks: list }) => `
      <section class="group">
        <header><span class="dot a-${project.health || 'green'}"></span><h3>${esc(project.name)}</h3>
          <span class="small dim">${esc(project.code || '')} · ${list.length} task${list.length === 1 ? '' : 's'}</span></header>
        <div class="table-wrap"><table>
          <thead><tr><th>Task</th><th>Owner</th><th>Status</th><th>Priority</th><th>Due</th><th>Timeline</th><th>Est.</th></tr></thead>
          <tbody>
            ${list.map((t) => `
              <tr data-id="${t.id}">
                <td class="task h-${t.health}"><div class="t" data-open>${t.money ? '💲 ' : ''}${t.electrical ? '⚡ ' : ''}${esc(t.title)}</div>
                  <div class="small dim">${t.source !== 'manual' ? `from ${esc(t.source)} · ` : ''}${t.health === 'delayed' ? `<b style="color:var(--red)">${t.days_late}d late</b>` : label(t.health)}</div></td>
                <td><div class="row" style="gap:6px;flex-wrap:nowrap">${avatar(personById(t.owner_id))}
                  <select data-k="owner_id" style="max-width:140px">${options(store.people, t.owner_id, { empty: 'Unassigned' })}</select></div></td>
                <td><select class="cell st-${t.status}" data-k="status">${options(statuses, t.status, { value: (s) => s, text: label })}</select></td>
                <td><select class="cell pr-${t.priority}" data-k="priority">${options(priorities, t.priority, { value: (s) => s, text: label })}</select></td>
                <td><input type="date" data-k="due_date" value="${esc(t.due_date || '')}" class="${t.health === 'delayed' ? 'late' : ''}"></td>
                <td>${timeline(t, today)}</td>
                <td class="small muted">${t.estimate_hours ? `${t.estimate_hours}h` : '—'}</td>
              </tr>`).join('')}
            <tr class="add-row"><td colspan="7"><input placeholder="+ Add task to ${esc(project.name)} — press Enter" data-add="${project.id ?? ''}"></td></tr>
          </tbody></table></div>
      </section>`).join('') || '<div class="empty">No projects yet. Create one on the Projects page.</div>'}`;

  el.querySelectorAll('[data-f]').forEach((n) => n.addEventListener(n.tagName === 'INPUT' ? 'change' : 'input', () => set(n.dataset.f, n.value)));
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-open]').addEventListener('click', () => openTask(id));
    tr.querySelectorAll('[data-k]').forEach((input) => input.addEventListener('change', () => guard(async () => {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: { [input.dataset.k]: input.value || null } });
      if (input.dataset.k === 'status' && input.value === 'done') toast('Task complete. Well done, Ranger.');
      render();
    })));
  });
  el.querySelectorAll('[data-add]').forEach((input) => input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    guard(async () => {
      await api('/api/tasks', { method: 'POST', body: { title: input.value.trim(), project_id: input.dataset.add || null, owner_id: filters.owner_id || null } });
      render();
    });
  }));
  el.querySelector('#new-task').addEventListener('click', () => openTask(null, { project_id: filters.project_id }));
}

function timeline(t, today) {
  if (!t.due_date) return '<span class="dim small">—</span>';
  // Show the task's span on a 6-week window centred near today.
  const start = Date.parse(today) - 14 * 86400000;
  const span = 42 * 86400000;
  const s = Math.max(0, (Date.parse(t.start_date || t.due_date) - start) / span);
  const e = Math.min(1, (Date.parse(t.due_date) - start + 86400000) / span);
  const nowX = (14 / 42) * 100;
  return `<div class="timeline h-${t.health}" title="${fmtDate(t.start_date)} → ${fmtDate(t.due_date)}">
    <span style="left:${(s * 100).toFixed(1)}%;width:${Math.max(3, (e - s) * 100).toFixed(1)}%"></span>
    <i style="position:absolute;left:${nowX}%;top:-3px;bottom:-3px;width:2px;background:var(--gold)"></i></div>`;
}

// ---------------- Task drawer ----------------
export async function openTask(id, defaults = {}) {
  const t = id ? await api(`/api/tasks/${id}`) : { title: '', status: 'not_started', priority: 'medium', updates: [], ...defaults };
  const docs = id ? await api(`/api/documents?q=`).then((all) => all.filter((d) => d.task_id === id)) : [];
  const [skills, jobs] = id ? await Promise.all([api('/api/claude/skills'), api('/api/claude/jobs').then((all) => all.filter((j) => j.task_id === id))]) : [[], []];
  const { statuses, priorities } = store.meta;
  drawer.innerHTML = `
    <button class="btn ghost close" data-close>✕</button>
    <h1 style="margin-right:40px">${id ? 'Task' : 'New task'}</h1>
    ${id && t.source !== 'manual' ? `<p class="small muted">Created from ${esc(t.source)}${t.money ? ' · 💲 money item — kept at high priority' : ''}</p>` : ''}
    <form class="grid" id="task-form" style="margin-top:14px">
      <label class="field">Title<input name="title" required value="${esc(t.title)}"></label>
      <div class="form-grid">
        <label class="field">Project<select name="project_id">${options(store.projects, t.project_id, { empty: 'No project' })}</select></label>
        <label class="field">Owner<select name="owner_id">${options(store.people, t.owner_id, { empty: 'Unassigned' })}</select></label>
        <label class="field">Status<select name="status">${options(statuses, t.status, { value: (s) => s, text: label })}</select></label>
        <label class="field">Priority<select name="priority">${options(priorities, t.priority, { value: (s) => s, text: label })}</select></label>
        <label class="field">Start<input type="date" name="start_date" value="${esc(t.start_date || '')}"></label>
        <label class="field">Due<input type="date" name="due_date" value="${esc(t.due_date || '')}"></label>
        <label class="field">Estimate (hours)<input type="number" step="0.5" min="0" name="estimate_hours" value="${esc(t.estimate_hours ?? '')}"></label>
      </div>
      <label class="field">Details<textarea name="description" rows="4">${esc(t.description || '')}</textarea></label>
      <div class="row"><button class="btn primary">${id ? 'Save' : 'Create task'}</button>
        ${id ? '<span class="spacer"></span><button type="button" class="btn danger" data-delete>Delete</button>' : ''}</div>
    </form>
    ${id ? `
      <h2 style="margin-top:24px">🤖 Send to Claude</h2>
      <form class="grid" id="claude-form" style="margin-top:8px">
        <div class="form-grid">
          <label class="field">Skill<select name="skill" required>${skills.filter((s) => s.name !== 'zordon-link').map((s) => `<option value="${esc(s.name)}">${esc(s.title)}</option>`).join('')}</select></label>
          <label class="row small" style="align-self:end"><input type="checkbox" name="complete_task"> Mark this task done when Claude finishes</label>
        </div>
        <label class="field">Files to use (one per line: OneDrive path or link)<textarea name="inputs" rows="2" placeholder="5. PROJECTS/G3251/03 CONSTRUCTION SET/E-601.pdf"></textarea></label>
        <label class="field">Notes for Claude<textarea name="instructions" rows="2" placeholder="Only panels LP-2A and LP-4; flag anything over 80% of bus"></textarea></label>
        <div class="row"><button class="btn gold">⚡ Send to Claude</button><span class="small dim">Then tell Cowork: "Run my Zordon jobs"</span></div>
      </form>
      ${jobs.length ? `<div class="list" style="margin-top:8px">${jobs.map((j) => `<div class="item" style="cursor:default"><span class="pill">${esc(j.status)}</span><div class="grow"><div class="title">${esc(j.skill_title || j.skill)}</div><div class="sub">${esc(j.result_note || j.output_folder || '')}</div></div></div>`).join('')}</div>` : ''}
      <h2 style="margin-top:24px">Files</h2>
      <div class="list" style="margin-top:8px">${docs.map((d) => `<div class="item"><span class="pill">${esc(d.category)}</span><div class="grow"><div class="title">${esc(d.title)}</div><div class="sub mono">${esc(d.path)}</div></div></div>`).join('') || '<div class="small dim">No files linked. Upload in the Vault and pick this task.</div>'}</div>
      <h2 style="margin-top:24px">Updates</h2>
      <form class="row" id="update-form" style="margin-top:8px"><input name="body" placeholder="Post an update…" style="flex:1"><button class="btn">Post</button></form>
      <div class="updates">${t.updates.map((u) => `<div class="update"><div class="meta">${esc(u.author_name || 'System')} · ${esc(u.created_at)}</div>${esc(u.body)}</div>`).join('') || '<div class="small dim">No updates yet.</div>'}</div>` : ''}`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.querySelector('[name=title]').focus();
  drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
  drawer.querySelector('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    for (const k of ['project_id', 'owner_id', 'start_date', 'due_date', 'estimate_hours']) if (body[k] === '') body[k] = null;
    if (body.estimate_hours != null) body.estimate_hours = Number(body.estimate_hours);
    guard(async () => {
      await api(id ? `/api/tasks/${id}` : '/api/tasks', { method: id ? 'PATCH' : 'POST', body });
      toast(id ? 'Saved' : 'Task created');
      closeDrawer();
      render();
    });
  });
  drawer.querySelector('[data-delete]')?.addEventListener('click', () => {
    if (!confirm('Delete this task?')) return;
    guard(async () => { await api(`/api/tasks/${id}`, { method: 'DELETE' }); closeDrawer(); render(); });
  });
  drawer.querySelector('#claude-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    guard(async () => {
      const job = await api('/api/claude/jobs', { method: 'POST', body: {
        skill: f.skill.value, task_id: id, instructions: f.instructions.value.trim(),
        inputs: f.inputs.value.split('\n').map((x) => x.trim()).filter(Boolean), complete_task: f.complete_task.checked,
      } });
      toast(`Job #${job.id} queued — it saves to ${job.output_folder}`);
      openTask(id);
    });
  });
  drawer.querySelector('#update-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    guard(async () => { await api(`/api/tasks/${id}/updates`, { method: 'POST', body: { body } }); openTask(id); });
  });
}

export function closeDrawer() {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------------- Router ----------------
const routes = { command: commandView, focus: focusView, board: boardView, ...moreViews };

export async function render() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const name = routes[path] ? path : 'command';
  document.querySelectorAll('.sidebar a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  cleanup?.();
  cleanup = null;
  try {
    await refreshRefs();
    cleanup = (await routes[name](view, new URLSearchParams(query), { openTask, render })) || null;
  } catch (err) {
    view.innerHTML = `<div class="empty">Communication with the command center failed: ${esc(err.message)}</div>`;
  }
  refreshBadges();
}

// While showing demo data, check every 30 s whether the real roster has loaded and switch over.
setInterval(async () => {
  if (!store.meta.demo) return;
  const meta = await api('/api/meta').catch(() => null);
  if (meta && !meta.demo) render();
  else if (meta) refreshRefs();
}, 30_000);

async function refreshBadges() {
  const d = await api('/api/dashboard').catch(() => null);
  if (!d) return;
  const set = (id, n) => { const b = document.getElementById(id); b.hidden = !n; b.textContent = n; };
  set('badge-inbox', d.counts.new_emails);
  set('badge-reminders', d.team.reduce((s, p) => s + (p.delayed ? 1 : 0), 0));
  set('badge-doccontrol', d.doccontrol.in_my_court.length);
  const props = await api('/api/claude/proposals').catch(() => []);
  set('badge-claude', props.filter((p) => p.status === 'open').length);
}

window.addEventListener('hashchange', () => { closeDrawer(); render(); });
// Closing the center: Zordon says farewell (the server ignores it if the page reloads right away).
window.addEventListener('pagehide', () => {
  let auth = '';
  try { auth = localStorage.getItem('zordon.token') || ''; } catch { /* storage blocked */ }
  fetch('/api/voice/goodbye', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: '{}' }).catch(() => {});
});
render();
