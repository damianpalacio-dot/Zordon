// Command-center logic: task health, dashboard, briefings and reminder drafts.
import { addDays, isoDate } from './db.js';

export const DUE_SOON_DAYS = 2;

// Change orders and billing are cash flow: they never sit at low priority.
export const MONEY_RE = /\b(change orders?|c\.?o\.? ?#?\d+|pcos?|cors?|change requests?|cor #|pricing|price|pay ?apps?|pay(ment)? applications?|billing|bill|invoices?|g70[23]|retainage|lien waivers?|t&m|time and material)\b/i;
export const isMoney = (t) => MONEY_RE.test(`${t.title || ''} ${t.description || ''}`);
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function moneyPriority(task, today = isoDate()) {
  if (!isMoney(task)) return task.priority || 'medium';
  const floor = task.due_date && task.due_date <= addDays(today, 3) ? 'critical' : 'high';
  return RANK[task.priority] >= RANK[floor] ? task.priority : floor;
}

export function taskHealth(task, today = isoDate()) {
  if (task.status === 'done') return 'done';
  if (task.due_date && task.due_date < today) return 'delayed';
  if (task.due_date && task.due_date <= addDays(today, DUE_SOON_DAYS)) return 'due_soon';
  if (task.status === 'stuck') return 'stuck';
  return 'on_track';
}

export function daysLate(task, today = isoDate()) {
  if (!task.due_date || task.status === 'done' || task.due_date >= today) return 0;
  return Math.round((Date.parse(today) - Date.parse(task.due_date)) / 86400000);
}

const TASK_SELECT = `SELECT t.*, p.name AS owner_name, p.color AS owner_color, p.email AS owner_email,
  pr.name AS project_name, pr.code AS project_code
  FROM tasks t LEFT JOIN people p ON p.id = t.owner_id LEFT JOIN projects pr ON pr.id = t.project_id`;

export function decorate(task, today) {
  const money = isMoney(task);
  const priority = task.status === 'done' ? task.priority : moneyPriority(task, today);
  return { ...task, priority, money, health: taskHealth(task, today), days_late: daysLate(task, today) };
}

export function listTasks(db, filters = {}, today = isoDate()) {
  const where = [];
  const args = [];
  if (filters.project_id) { where.push('t.project_id = ?'); args.push(Number(filters.project_id)); }
  if (filters.owner_id) { where.push('t.owner_id = ?'); args.push(Number(filters.owner_id)); }
  if (filters.status) { where.push('t.status = ?'); args.push(filters.status); }
  if (filters.q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${filters.q}%`, `%${filters.q}%`); }
  const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (t.status = 'done'), t.due_date IS NULL, t.due_date, t.id`;
  let tasks = db.prepare(sql).all(...args).map((t) => decorate(t, today));
  if (filters.health) tasks = tasks.filter((t) => t.health === filters.health);
  return tasks;
}

export function getTask(db, id, today = isoDate()) {
  const t = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(Number(id));
  return t ? decorate(t, today) : null;
}

export function listMeetings(db, { from, to, project_id } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('m.starts_at >= ?'); args.push(from); }
  if (to) { where.push('m.starts_at < ?'); args.push(to); }
  if (project_id) { where.push('m.project_id = ?'); args.push(Number(project_id)); }
  return db.prepare(`SELECT m.*, pr.name AS project_name FROM meetings m LEFT JOIN projects pr ON pr.id = m.project_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.starts_at`).all(...args)
    .map((m) => ({ ...m, attendee_ids: JSON.parse(m.attendee_ids || '[]') }));
}

export function projectSummaries(db, today = isoDate()) {
  const projects = db.prepare('SELECT * FROM projects ORDER BY status, name').all();
  const tasks = listTasks(db, {}, today);
  return projects.map((p) => {
    const mine = tasks.filter((t) => t.project_id === p.id);
    const done = mine.filter((t) => t.status === 'done').length;
    const delayed = mine.filter((t) => t.health === 'delayed').length;
    return {
      ...p,
      total: mine.length,
      done,
      open: mine.length - done,
      delayed,
      progress: mine.length ? Math.round((done / mine.length) * 100) : 0,
      health: delayed >= 2 ? 'red' : delayed === 1 || mine.some((t) => t.health === 'stuck') ? 'yellow' : 'green',
    };
  });
}

export function dashboard(db, today = isoDate()) {
  const tasks = listTasks(db, {}, today);
  const open = tasks.filter((t) => t.status !== 'done');
  const delayed = open.filter((t) => t.health === 'delayed').sort((a, b) => b.days_late - a.days_late);
  const dueSoon = open.filter((t) => t.health === 'due_soon');
  const weekAgo = addDays(today, -7);
  const doneThisWeek = tasks.filter((t) => t.status === 'done' && (t.completed_at || '').slice(0, 10) >= weekAgo);
  const meetingsToday = listMeetings(db, { from: today, to: addDays(today, 1) });
  const upcomingMeetings = listMeetings(db, { from: today, to: addDays(today, 7) });
  const people = db.prepare('SELECT * FROM people WHERE active = 1 ORDER BY id').all();
  const team = people.map((p) => {
    const theirs = open.filter((t) => t.owner_id === p.id);
    return {
      ...p,
      open: theirs.length,
      delayed: theirs.filter((t) => t.health === 'delayed').length,
      due_soon: theirs.filter((t) => t.health === 'due_soon').length,
      stuck: theirs.filter((t) => t.status === 'stuck').length,
    };
  });
  const money = open.filter((t) => t.money).sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  const alert = delayed.length >= 3 ? 'red' : delayed.length || open.some((t) => t.status === 'stuck') ? 'yellow' : 'green';
  const newEmails = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status = 'new'").get().n;
  return {
    today,
    alert,
    counts: {
      open: open.length,
      delayed: delayed.length,
      due_soon: dueSoon.length,
      stuck: open.filter((t) => t.status === 'stuck').length,
      done_this_week: doneThisWeek.length,
      meetings_today: meetingsToday.length,
      new_emails: newEmails,
      money: money.length,
    },
    money,
    delayed,
    due_soon: dueSoon,
    meetings_today: meetingsToday,
    upcoming_meetings: upcomingMeetings,
    team,
    projects: projectSummaries(db, today),
    briefing: briefing({ delayed, dueSoon, meetingsToday, team, alert, newEmails, money, today }),
  };
}

function briefing({ delayed, dueSoon, meetingsToday, team, alert, newEmails, money = [], today }) {
  const lines = [];
  if (alert === 'green') lines.push('All systems nominal. The team is on schedule.');
  else if (alert === 'yellow') lines.push('Caution. Some operations need your attention.');
  else lines.push('Alert! Multiple operations are behind schedule. Immediate action is required.');
  const urgentMoney = money.filter((t) => t.due_date && t.due_date <= addDays(today, 3));
  if (urgentMoney.length) lines.push(`Cash flow first: ${urgentMoney.map((t) => `"${t.title}"`).slice(0, 2).join(' and ')} ${urgentMoney.length > 1 ? 'are' : 'is'} due within three days.`);
  if (delayed.length) {
    const worst = delayed[0];
    lines.push(`${delayed.length} task${delayed.length > 1 ? 's are' : ' is'} delayed. Most critical: "${worst.title}"${worst.owner_name ? `, assigned to ${worst.owner_name}` : ''}, ${worst.days_late} day${worst.days_late === 1 ? '' : 's'} late.`);
  }
  if (dueSoon.length) lines.push(`${dueSoon.length} task${dueSoon.length > 1 ? 's are' : ' is'} due within ${DUE_SOON_DAYS} days.`);
  const overloaded = team.filter((p) => p.delayed >= 2);
  if (overloaded.length) lines.push(`${overloaded.map((p) => p.name).join(' and ')} ${overloaded.length > 1 ? 'have' : 'has'} multiple delayed tasks. Consider a reminder.`);
  if (meetingsToday.length) lines.push(`You have ${meetingsToday.length} meeting${meetingsToday.length > 1 ? 's' : ''} today, starting with ${meetingsToday[0].title} at ${meetingsToday[0].starts_at.slice(11, 16)}.`);
  if (newEmails) lines.push(`${newEmails} email${newEmails > 1 ? 's' : ''} awaiting triage.`);
  return lines.join(' ');
}

// Draft one reminder per person who has delayed or soon-due work.
export function reminderDrafts(db, today = isoDate(), { fromName } = {}) {
  const tasks = listTasks(db, {}, today).filter((t) => t.owner_id && (t.health === 'delayed' || t.health === 'due_soon'));
  const people = db.prepare('SELECT * FROM people WHERE active = 1').all();
  const lastSent = new Map(db.prepare('SELECT person_id, MAX(created_at) AS at FROM reminders GROUP BY person_id').all()
    .map((r) => [r.person_id, r.at]));
  const sender = fromName || people.find((p) => /project manager/i.test(p.role))?.name || 'Project Manager';

  return people.flatMap((p) => {
    const theirs = tasks.filter((t) => t.owner_id === p.id);
    if (!theirs.length) return [];
    const overdue = theirs.filter((t) => t.health === 'delayed');
    const soon = theirs.filter((t) => t.health === 'due_soon');
    const first = p.name.split(/\s+/)[0];
    const line = (t) => `  • ${t.title}${t.project_name ? ` (${t.project_name})` : ''} — due ${t.due_date}${t.days_late ? `, ${t.days_late} day${t.days_late === 1 ? '' : 's'} late` : ''}`;
    const parts = [`Hi ${first},`, ''];
    if (overdue.length) parts.push('These items are past due:', ...overdue.map(line), '');
    if (soon.length) parts.push('Coming up in the next couple of days:', ...soon.map(line), '');
    parts.push('Can you reply with a status and a new commit date for anything that is slipping? Let me know if something is blocking you.', '', 'Thanks,', sender);
    const subject = overdue.length
      ? `Action needed: ${overdue.length} past-due item${overdue.length > 1 ? 's' : ''}`
      : `Heads up: ${soon.length} item${soon.length > 1 ? 's' : ''} due soon`;
    return [{
      person_id: p.id,
      name: p.name,
      email: p.email,
      color: p.color,
      role: p.role,
      task_ids: theirs.map((t) => t.id),
      overdue: overdue.length,
      due_soon: soon.length,
      last_sent_at: lastSent.get(p.id) || null,
      subject,
      body: parts.join('\n'),
    }];
  });
}

// ---------- Personal nudges and reality check ----------
export const NUDGE_DAYS = [3, 1, 0];
const DEFAULT_ESTIMATE = 2;

function workdaysBetween(from, to) {
  // Inclusive count of Mon–Fri days in [from, to].
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const [y, m, day] = d.split('-').map(Number);
    const dow = new Date(y, m - 1, day).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

function addWorkdays(from, n) {
  let d = from;
  let left = Math.max(0, n);
  while (left > 0) {
    d = addDays(d, 1);
    const [y, m, day] = d.split('-').map(Number);
    const dow = new Date(y, m - 1, day).getDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

export function realityCheck(db, personId, today = isoDate(), capacity = 4) {
  const open = listTasks(db, { owner_id: personId }, today).filter((t) => t.status !== 'done');
  const dated = open.filter((t) => t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  let cum = 0;
  const plan = dated.map((t) => {
    cum += t.estimate_hours ?? DEFAULT_ESTIMATE;
    const available = workdaysBetween(today, t.due_date < today ? today : t.due_date) * capacity;
    // Projected finish if you work the list in due-date order at your real daily capacity.
    const projected = addWorkdays(today, Math.ceil(cum / capacity) - 1);
    return { id: t.id, title: t.title, due_date: t.due_date, hours: t.estimate_hours ?? DEFAULT_ESTIMATE, cumulative: cum, available, projected, at_risk: projected > t.due_date };
  });
  const weekEnd = addDays(today, 7);
  const loadWeek = dated.filter((t) => t.due_date <= weekEnd).reduce((s, t) => s + (t.estimate_hours ?? DEFAULT_ESTIMATE), 0);
  const availWeek = workdaysBetween(today, weekEnd) * capacity;

  const finished = db.prepare("SELECT due_date, completed_at FROM tasks WHERE owner_id = ? AND status = 'done' AND due_date IS NOT NULL AND completed_at IS NOT NULL")
    .all(personId);
  const slips = finished.map((t) => Math.max(0, Math.round((Date.parse(t.completed_at.slice(0, 10)) - Date.parse(t.due_date)) / 86400000)));
  const onTime = slips.length ? Math.round((slips.filter((s) => s === 0).length / slips.length) * 100) : null;
  const avgSlip = slips.length ? Math.round((slips.reduce((a, b) => a + b, 0) / slips.length) * 10) / 10 : null;

  const atRisk = plan.filter((p) => p.at_risk);
  const advice = [];
  if (loadWeek > availWeek) advice.push(`You have ${loadWeek}h of work due in the next 7 days but about ${availWeek}h of focus time. Delegate or re-date ${Math.ceil((loadWeek - availWeek) / DEFAULT_ESTIMATE)} item(s) now, not on the due date.`);
  if (atRisk.length) advice.push(`At your pace, "${atRisk[0].title}" lands ${atRisk[0].projected} — after its ${atRisk[0].due_date} due date.`);
  if (avgSlip > 0.5) advice.push(`Historically you finish about ${avgSlip} day(s) late (${onTime}% on time). When you commit to a date, add ${Math.ceil(avgSlip)} day(s).`);
  if (!advice.length) advice.push('Your commitments fit your capacity. Keep the cadence.');
  return { capacity_hours_per_day: capacity, load_7d: loadWeek, available_7d: availWeek, on_time_rate: onTime, avg_slip_days: avgSlip, plan, at_risk: atRisk, advice };
}

export function myNudges(db, personId, today = isoDate()) {
  return listTasks(db, { owner_id: personId }, today)
    .filter((t) => t.status !== 'done' && t.due_date)
    .map((t) => ({ ...t, due_in: Math.round((Date.parse(t.due_date) - Date.parse(today)) / 86400000) }))
    .filter((t) => t.due_in < 0 || NUDGE_DAYS.includes(t.due_in) || t.due_in <= Math.max(...NUDGE_DAYS))
    .sort((a, b) => a.due_in - b.due_in || Number(b.money) - Number(a.money))
    .map((t) => ({
      ...t,
      nudge: t.money && t.due_in <= 3 ? `💲 ${t.due_in < 0 ? `${-t.due_in} day(s) overdue` : t.due_in === 0 ? 'Due today' : `Due in ${t.due_in} day(s)`} — this is money. Get it out the door.`
        : t.due_in < 0 ? `${-t.due_in} day(s) overdue — do it today or re-date it honestly.`
        : t.due_in === 0 ? 'Due today.'
          : t.due_in === 1 ? 'Due tomorrow — block time for it now.'
            : `Due in ${t.due_in} days — start it this week.`,
    }));
}
