// Electrical know-how: long-lead gear, the electrical critical path, and what never slips quietly.
import { addDays, isoDate } from './db.js';

// Typical lead times in weeks (planning ranges, verify with the vendor every time).
// Ordered so the most specific pattern wins.
export const LEAD_TIMES = [
  { re: /medium.?voltage|mv switch|\bmvs\b|switchgear/i, weeks: 52, range: '40–80', label: 'Switchgear' },
  { re: /pad.?mount|liquid.?filled|substation|utility transformer/i, weeks: 60, range: '40–100+', label: 'Pad-mount / liquid-filled transformer' },
  { re: /generator|genset|\bgen\b/i, weeks: 52, range: '40–70', label: 'Generator' },
  { re: /\bups\b|uninterruptible/i, weeks: 24, range: '16–30', label: 'UPS' },
  { re: /switchboard|\bmsb\b|main distribution|\bmdp\b/i, weeks: 30, range: '20–45', label: 'Switchboard' },
  { re: /\bats\b|transfer switch/i, weeks: 26, range: '18–35', label: 'Automatic transfer switch' },
  { re: /dry.?type|transformer|\bxfmr\b/i, weeks: 24, range: '14–40', label: 'Dry-type transformer' },
  { re: /bus ?duct|busway/i, weeks: 20, range: '14–26', label: 'Busway' },
  { re: /panelboard|panel ?board|\bpanels?\b|\blp-?\d|\bhp-?\d/i, weeks: 14, range: '8–20', label: 'Panelboards' },
  { re: /\bmcc\b|motor control/i, weeks: 22, range: '16–30', label: 'Motor control center' },
  { re: /\bvfd|variable frequency/i, weeks: 14, range: '8–20', label: 'VFDs' },
  { re: /ev charg|evse/i, weeks: 14, range: '8–20', label: 'EV chargers' },
  { re: /lighting control|nlight|wattstopper|\blcp\b/i, weeks: 10, range: '6–14', label: 'Lighting controls' },
  { re: /fixture|luminaire|light(ing)? package/i, weeks: 10, range: '6–16', label: 'Light fixtures' },
  { re: /fire alarm|\bfacp\b|notifier|simplex|edwards/i, weeks: 8, range: '6–12', label: 'Fire alarm equipment' },
  { re: /meter|\bct cabinet|metering/i, weeks: 12, range: '6–20', label: 'Metering equipment' },
  { re: /wire|cable|feeder|conductor/i, weeks: 6, range: '2–12', label: 'Wire & cable' },
];

export function leadTime(name = '') {
  const hit = LEAD_TIMES.find((l) => l.re.test(name));
  return hit ? { weeks: hit.weeks, range: hit.range, label: hit.label } : null;
}

// Electrical critical path, timed backwards from energization (permanent power) and
// forwards to turnover. [days relative to energization, title, owner role, hours, details]
export const ELECTRICAL_PLAN = [
  [-300, 'Submit utility service application & load letter', 'Project Engineer', 3, 'Service size, load calc, site plan, single-line. Ask for the will-serve letter and design fee.'],
  [-280, 'Confirm load calculation and single-line with EOR', 'Project Engineer', 2, 'Lock service size before gear submittals.'],
  [-270, 'Order short-circuit / coordination / arc-flash study', 'APM', 1, 'Needed for gear AIC ratings and labels; study vendor needs final gear data.'],
  [-260, 'Switchgear / switchboard submittal to EOR', 'Project Engineer', 4, 'Long lead. Push for approval in one cycle — every resubmit adds weeks.'],
  [-245, 'Release switchgear / switchboard for fabrication', 'APM', 1, 'Release letter to vendor once approved. Confirm ship date in writing.'],
  [-240, 'Transformer & generator / ATS submittals and release', 'APM', 2, 'Check utility-owned vs. contractor-furnished transformer.'],
  [-220, 'Utility design: transformer pad, conduit & vault layout approved', 'Project Engineer', 2, 'Utility drawings drive underground rough-in.'],
  [-200, 'Panelboards, lighting & lighting-control submittals', 'Project Engineer', 3, ''],
  [-180, 'Temp power set and inspected', 'Foreman', 4, ''],
  [-160, 'Underground / under-slab electrical rough-in inspection', 'Foreman', 2, 'Before the pour — coordinate with the concrete schedule.'],
  [-150, 'Fire alarm drawings submitted to AHJ / fire marshal', 'Project Engineer', 2, 'Deferred submittal; approval can take weeks.'],
  [-120, 'Rough-in inspections by area / floor', 'Foreman', 2, 'Schedule ahead of drywall; no cover until signed off.'],
  [-90, 'Gear delivery: confirm rigging, pad ready and room dry', 'Foreman', 2, 'Room must be dried-in and clean for gear.'],
  [-75, 'Utility service inspection & meter release request', 'APM', 1, 'AHJ sign-off to utility; utility schedules energization.'],
  [-60, 'Cover / above-ceiling inspections', 'Foreman', 2, ''],
  [-30, 'Arc-flash labels installed; study results reviewed', 'Project Engineer', 1, ''],
  [-14, 'Pre-energization walk & NETA acceptance testing of gear', 'Foreman', 4, 'Torque, insulation resistance, breaker settings per coordination study.'],
  [0, 'Energization — permanent power', 'Project Manager', 2, 'Utility on site; lockout/tagout plan; notify all trades.'],
  [14, 'Lighting controls programming & commissioning', 'Foreman', 4, ''],
  [21, 'Fire alarm pre-test and AHJ acceptance test', 'Foreman', 4, ''],
  [30, 'Electrical punch list complete', 'Foreman', 6, ''],
  [45, 'O&M manuals, as-builts, warranties and training to owner', 'Project Engineer', 6, ''],
];

// Electrical work that is on the critical path never sits below High.
export const ELECTRICAL_CRITICAL_RE = /\b(energi[sz]ation|permanent power|utility (service|coordination|application|design)|will.?serve|meter release|switchgear|switchboard|transformer|generator|\bats\b|arc.?flash|coordination study|short.?circuit|rough.?in inspection|cover inspection|fire alarm (acceptance|submittal)|neta)\b/i;

export function createElectricalPlan(db, projectId, energization, today = isoDate()) {
  const people = db.prepare('SELECT id, role FROM people WHERE active = 1').all();
  const byRole = (role) => people.find((p) => p.role.toLowerCase() === role.toLowerCase())?.id
    ?? people.find((p) => p.role.toLowerCase().includes(role.toLowerCase().split(' ')[0]))?.id ?? null;
  const insert = db.prepare(`INSERT INTO tasks (project_id, title, description, owner_id, priority, start_date, due_date, source, estimate_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'electrical_plan', ?)`);
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const [offset, title, role, hours, details] of ELECTRICAL_PLAN) {
      const due = addDays(energization, offset);
      const priority = ELECTRICAL_CRITICAL_RE.test(title) ? 'high' : 'medium';
      // Milestones already in the past are still created so the gap is visible, flagged as late.
      ids.push(Number(insert.run(projectId, title, `${details}${details ? '\n' : ''}Electrical plan · ${offset === 0 ? 'energization day' : `${Math.abs(offset)} days ${offset < 0 ? 'before' : 'after'} energization`}`,
        byRole(role), priority, due < today ? today : addDays(due, -Math.max(3, Math.ceil(hours))), due, hours).lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ids;
}
