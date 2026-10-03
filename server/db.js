// SQLite storage using Node's built-in driver (no native build step needed).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['not_started', 'working', 'stuck', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const RANGER_COLORS = ['red', 'blue', 'yellow', 'pink', 'black', 'green', 'white', 'gold'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Foreman',
  trade TEXT,
  email TEXT,
  phone TEXT,
  color TEXT NOT NULL DEFAULT 'red',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  location TEXT,
  short_name TEXT,
  lat REAL,
  lon REAL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  priority TEXT NOT NULL DEFAULT 'medium',
  start_date TEXT,
  due_date TEXT,
  completed_at TEXT,
  estimate_hours REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_updates (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  location TEXT,
  attendee_ids TEXT NOT NULL DEFAULT '[]',
  agenda TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  sender TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  analysis TEXT,
  analyzer TEXT,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  task_ids TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  original_name TEXT,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tracked_items (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  type TEXT NOT NULL,
  number TEXT,
  title TEXT NOT NULL,
  spec_section TEXT,
  status TEXT,
  ball_in_court TEXT,
  assigned_to_me INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  url TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  groups TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_activities (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trade TEXT,
  baseline_start TEXT,
  baseline_finish TEXT,
  current_start TEXT,
  current_finish TEXT,
  percent_complete REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, activity_id)
);
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec_section TEXT,
  vendor TEXT,
  submittal_item_id INTEGER REFERENCES tracked_items(id) ON DELETE SET NULL,
  activity_id TEXT,
  need_by_date TEXT,
  lead_time_weeks REAL,
  buffer_days INTEGER NOT NULL DEFAULT 7,
  released_at TEXT,
  delivered_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL DEFAULT 1,
  day_of_month INTEGER,
  every_weeks INTEGER NOT NULL DEFAULT 1,
  estimate_hours REAL,
  last_due TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  output_category TEXT,
  body TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claude_jobs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  skill TEXT NOT NULL,
  instructions TEXT,
  inputs TEXT NOT NULL DEFAULT '[]',
  output_folder TEXT,
  complete_task INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  result_note TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  skill TEXT,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  rule TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(starts_at);
`;

export function openDb(file = process.env.ZORDON_DB || 'data/zordon.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to older databases.
const ADDED_COLUMNS = {
  projects: { lat: 'REAL', lon: 'REAL', short_name: 'TEXT' },
  tasks: { estimate_hours: 'REAL' },
  routines: { day_of_month: 'INTEGER' },
  emails: { message_id: 'TEXT' },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  // The hourly email check may see the same message twice; the message id keeps it to one import.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id) WHERE message_id IS NOT NULL');
}

// Local calendar date as YYYY-MM-DD (job sites run on local time, not UTC).
export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

export function seedIfEmpty(db, today = isoDate()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) return false;

  const person = db.prepare('INSERT INTO people (name, role, trade, email, color) VALUES (?, ?, ?, ?, ?)');
  const pm = person.run('Damian Palacio', 'Project Manager', null, 'Damian@gec2.com', 'white').lastInsertRowid;
  const apm = person.run('Jordan Lee', 'APM', null, 'jordan.lee@example.com', 'red').lastInsertRowid;
  const pe = person.run('Sam Ortiz', 'Project Engineer', null, 'sam.ortiz@example.com', 'blue').lastInsertRowid;
  const f1 = person.run('Marcus Hill', 'Foreman', 'Concrete', 'marcus.hill@example.com', 'black').lastInsertRowid;
  const f2 = person.run('Tina Nguyen', 'Foreman', 'Electrical', 'tina.nguyen@example.com', 'yellow').lastInsertRowid;
  const f3 = person.run('Rick Alvarez', 'Foreman', 'Framing', 'rick.alvarez@example.com', 'green').lastInsertRowid;
  const f4 = person.run('Kim Patel', 'Foreman', 'Mechanical', 'kim.patel@example.com', 'pink').lastInsertRowid;

  const project = db.prepare('INSERT INTO projects (name, code, location) VALUES (?, ?, ?)');
  const p1 = project.run('Angel Grove Medical Office', 'AGM-101', 'Los Angeles, CA').lastInsertRowid;
  const p2 = project.run('Command Center Retrofit', 'CCR-202', 'Phoenix, AZ').lastInsertRowid;

  const task = db.prepare(`INSERT INTO tasks (project_id, title, owner_id, status, priority, start_date, due_date, completed_at, estimate_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const d = (n) => addDays(today, n);
  const rows = [
    [p1, 'Pour level 2 slab', f1, 'working', 'critical', d(-5), d(-1), null, 8],
    [p1, 'Rough-in electrical inspection', f2, 'stuck', 'high', d(-7), d(-2), null, 3],
    [p1, 'Submit RFI #14 — beam penetration', pe, 'working', 'high', d(-3), d(1), null, 2],
    [p1, 'Frame 3rd floor interior walls', f3, 'not_started', 'medium', d(2), d(9), null, 40],
    [p1, 'Update 3-week look-ahead schedule', apm, 'working', 'medium', d(-1), d(2), null, 3],
    [p1, 'HVAC duct submittal review', pe, 'done', 'medium', d(-10), d(-4), d(-4), 2],
    [p1, 'Review pay app #6 from electrical sub', pm, 'not_started', 'high', d(0), d(2), null, 2],
    [p1, 'Sign off on millwork shop drawings', pm, 'not_started', 'medium', d(0), d(3), null, 3],
    [p2, 'Mechanical room equipment set', f4, 'working', 'high', d(-2), d(4), null, 16],
    [p2, 'Owner change order #3 pricing', apm, 'not_started', 'critical', d(0), d(3), null, 6],
    [p2, 'Demo existing control room ceiling', f3, 'done', 'low', d(-12), d(-6), d(-7), 12],
    [p2, 'Coordinate crane pick with GC', f1, 'not_started', 'high', d(5), d(6), null, 2],
    [p2, 'Send monthly owner report', pm, 'done', 'medium', d(-9), d(-5), d(-3), 3],
  ];
  for (const r of rows) task.run(...r);

  // Schedule: baseline vs current for the look-ahead.
  const act = db.prepare(`INSERT INTO schedule_activities (project_id, activity_id, name, trade, baseline_start, baseline_finish, current_start, current_finish, percent_complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const acts = [
    ['A1010', 'L2 slab on deck — pour', 'Concrete', d(-8), d(-2), d(-6), d(1), 80],
    ['A1020', 'L3 interior framing', 'Framing', d(0), d(10), d(3), d(15), 0],
    ['A1030', 'L2 electrical rough-in', 'Electrical', d(-4), d(8), d(-4), d(12), 35],
    ['A1040', 'L2 rough-in inspection', 'Electrical', d(9), d(9), d(13), d(13), 0],
    ['A1050', 'Set RTU-1 and RTU-2', 'Mechanical', d(12), d(13), d(18), d(19), 0],
    ['A1060', 'Storefront glazing — L1', 'Glazing', d(15), d(22), d(15), d(22), 0],
    ['A1070', 'Install casework — exam rooms', 'Millwork', d(40), d(50), d(44), d(54), 0],
    ['A1080', 'Energize main switchgear', 'Electrical', d(30), d(30), d(34), d(34), 0],
  ];
  for (const a of acts) act.run(p1, ...a);

  // Doc control: RFIs and submittals across the watched divisions.
  const item = db.prepare(`INSERT INTO tracked_items (origin, source, external_id, type, number, title, spec_section, status, ball_in_court,
    assigned_to_me, due_date, project_id, groups, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const items = [
    ['procore', 'S-101', 'submittal', '23 74 13-1', 'Packaged rooftop units RTU-1/RTU-2', '23 74 13', 'Open', 'Engineer', 0, d(4), '["hvac"]'],
    ['procore', 'S-102', 'submittal', '26 24 13-1', 'Switchboards — main distribution', '26 24 13', 'Revise and Resubmit', 'me', 1, d(2), '["div26"]'],
    ['procore', 'S-103', 'submittal', '08 41 13-1', 'Aluminum storefront and entrances', '08 41 13', 'Open', 'Architect', 0, d(6), '["glazing"]'],
    ['autodesk', 'R-23', 'rfi', '23', 'Fire alarm device spacing in corridor C', '28 31 00', 'Open', 'me', 1, d(1), '["div28"]'],
    ['autodesk', 'S-201', 'submittal', '06 41 16-1', 'Plastic-laminate casework — exam rooms', '06 41 16', 'Open', 'Architect', 0, d(9), '["millwork"]'],
    ['procore', 'S-104', 'submittal', '22 34 00-1', 'Gas-fired domestic water heaters', '22 34 00', 'Approved', null, 0, d(-3), '["plumbing"]'],
  ];
  const itemIds = items.map((i) => Number(item.run(i[0], i[0], i[1], i[2], i[3], i[4], i[5], i[6], i[7], i[8], i[9], p1, i[10], d(-2), d(-1)).lastInsertRowid));
  for (const [idx, i] of items.entries()) {
    if (!i[8]) continue;
    task.run(p1, `Respond to ${i[2] === 'rfi' ? 'RFI' : 'Submittal'} #${i[3]} — ${i[4]}`, pm, 'not_started', 'high', null, i[9], null, i[2] === 'rfi' ? 1 : 2);
    db.prepare("UPDATE tasks SET source = 'doccontrol', source_ref = ? WHERE id = last_insert_rowid()").run(itemIds[idx]);
  }

  // Equipment release log tied to the schedule and submittals.
  const eq = db.prepare(`INSERT INTO equipment (project_id, name, spec_section, vendor, submittal_item_id, activity_id, need_by_date, lead_time_weeks, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  eq.run(p1, 'RTU-1 / RTU-2 rooftop units', '23 74 13', 'Carrier', itemIds[0], 'A1050', null, 10, null);
  eq.run(p1, 'Main switchboard MSB', '26 24 13', 'Eaton', itemIds[1], 'A1080', null, 4, null);
  eq.run(p1, 'Storefront framing & glass', '08 41 13', 'Kawneer', itemIds[2], 'A1060', null, 6, d(-20));
  eq.run(p1, 'Domestic water heaters WH-1/2', '22 34 00', 'A.O. Smith', itemIds[5], null, d(35), 3, null);

  // Standing routines.
  const routine = db.prepare('INSERT INTO routines (title, description, owner_id, project_id, weekday, estimate_hours) VALUES (?, ?, ?, ?, ?, ?)');
  routine.run('Review 3-week look-ahead vs baseline schedule', 'Compare the look-ahead to the baseline, flag slipped activities, confirm crews and inspections, and check equipment release dates.', pm, p1, 1, 1.5);
  routine.run('Review equipment release log', 'Confirm release-by dates against current schedule and chase open submittals blocking releases.', pm, null, 3, 0.5);
  db.prepare('INSERT INTO routines (title, description, owner_id, project_id, weekday, day_of_month, estimate_hours) VALUES (?, ?, ?, ?, 1, 20, 3)')
    .run('Submit monthly pay application (billing)', 'Collect sub pay apps, update schedule of values and stored materials, get lien waivers, submit the G702/G703 on time.', pm, null);
  routine.run('Review change order log — push pending COs to approval', 'Chase owner approvals, price open PCOs, and convert approved COs into billing.', pm, null, 5, 1);
  db.prepare("INSERT INTO settings (key, value) VALUES ('me_person_id', ?)").run(String(pm));

  const meeting = db.prepare(`INSERT INTO meetings (project_id, title, starts_at, duration_min, location, attendee_ids, agenda)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  meeting.run(p1, 'Daily foreman huddle', `${d(0)}T07:00`, 15, 'Site trailer',
    JSON.stringify([pm, apm, f1, f2, f3]), 'Safety moment\nToday\'s work areas\nBlockers');
  meeting.run(p1, 'Weekly OAC meeting', `${d(2)}T10:00`, 60, 'Owner conference room',
    JSON.stringify([pm, apm, pe]), 'Schedule update\nOpen RFIs\nChange orders');
  meeting.run(p2, 'MEP coordination', `${d(1)}T13:30`, 45, 'Teams',
    JSON.stringify([apm, pe, f2, f4]), 'Clash detection review');
  return true;
}
