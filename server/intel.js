// Email intelligence: turn an email into suggested tasks and meetings.
// Uses Claude when credentials are configured, otherwise a rule-based parser
// so the command center keeps working offline.
import { addDays, isoDate } from './db.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ACTION_RE = /\b(please|pls|need(?:s|ed)? to|needs?|must|make sure|can you|could you|follow up|send|submit|review|approve|confirm|schedule|order|install|inspect|fix|update|price|provide|complete|finish|coordinate|call)\b/i;
const MEETING_RE = /\b(meeting|call|walk-?through|walk|huddle|site visit|inspection|review session|OAC|kickoff|kick-off)\b/i;
const URGENT_RE = /\b(asap|urgent|immediately|critical|today|eod|end of day|right away)\b/i;

export function aiEnabled() {
  if (process.env.ZORDON_AI === 'off') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ZORDON_AI === 'on');
}

// Resolve a relative date phrase ("tomorrow", "Friday", "10/15", "Oct 15") to YYYY-MM-DD.
export function parseDate(text, today = isoDate()) {
  const t = text.toLowerCase();
  if (/\b(today|eod|end of day|tonight)\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\bnext week\b/.test(t)) return addDays(today, 7);
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(y, m - 1, d);

  const wd = t.match(/\b(?:by |on |this |next )?(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?\b/);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd[1].slice(0, 3)));
    let delta = (idx - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (/next\s+\w+day/.test(wd[0])) delta += delta < 7 ? 7 : 0;
    return addDays(today, delta);
  }
  const num = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) return resolveMonthDay(base, Number(num[1]), Number(num[2]), num[3]);
  const named = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (named) return resolveMonthDay(base, MONTHS.indexOf(named[1]) + 1, Number(named[2]));
  return null;
}

function resolveMonthDay(base, month, day, yearStr) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = yearStr ? Number(yearStr.length === 2 ? `20${yearStr}` : yearStr) : base.getFullYear();
  let date = new Date(year, month - 1, day);
  // A bare date that already passed by a couple of months most likely means next year.
  if (!yearStr && date < new Date(base.getFullYear(), base.getMonth() - 2, base.getDate())) {
    date = new Date(year + 1, month - 1, day);
  }
  return isoDate(date);
}

export function parseTime(text) {
  const m = text.toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function matchPerson(text, people) {
  const t = text.toLowerCase();
  return people.find((p) => {
    const [first, ...rest] = p.name.toLowerCase().split(/\s+/);
    return t.includes(p.name.toLowerCase()) || new RegExp(`\\b${first}\\b`).test(t) || (rest.length && t.includes(rest.at(-1)) && t.includes(first));
  }) || null;
}

function matchProject(text, projects) {
  const t = text.toLowerCase();
  return projects.find((p) => (p.code && t.includes(p.code.toLowerCase())) || t.includes(p.name.toLowerCase())) || null;
}

function cleanTitle(sentence) {
  let s = sentence.replace(/^[-*•\d.)\s]+/, '').replace(/^(hi|hey|hello)\b[^,]*,\s*/i, '');
  s = s.replace(/^(please|pls|can you|could you|we need to|need to|make sure( to)?|also)\s+/i, '');
  s = s.replace(/^we need (\w+) to\s+/i, '$1 to ');
  s = s.replace(/[.?!]+$/, '').trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

export function analyzeHeuristic(email, ctx) {
  const { people = [], projects = [], today = isoDate() } = ctx;
  const text = `${email.subject || ''}\n${email.body || ''}`;
  const project = matchProject(text, projects);
  const sentences = (email.body || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && !/^(thanks|thank you|regards|best|sent from|from:|to:|cc:|subject:)/i.test(s));

  const tasks = [];
  const meetings = [];
  for (const s of sentences) {
    if (MEETING_RE.test(s) && (parseTime(s) || parseDate(s, today))) {
      const date = parseDate(s, today) || today;
      meetings.push({
        title: cleanTitle(s).slice(0, 80),
        starts_at: `${date}T${parseTime(s) || '09:00'}`,
        location: (s.match(/\b(?:at|in|@)\s+(the\s+)?([A-Z][\w\s]{2,30}?)(?=[,.]|$)/) || [])[2] || null,
        project_id: project?.id ?? null,
      });
      continue;
    }
    if (ACTION_RE.test(s)) {
      const owner = matchPerson(s, people);
      tasks.push({
        title: cleanTitle(s),
        owner_id: owner?.id ?? null,
        due_date: parseDate(s, today) || (URGENT_RE.test(s) ? today : null),
        priority: URGENT_RE.test(s) ? 'critical' : /\b(important|priority|high)\b/i.test(s) ? 'high' : 'medium',
        project_id: project?.id ?? null,
      });
    }
  }
  const urgency = URGENT_RE.test(text) ? 'high' : tasks.length ? 'normal' : 'low';
  const summary = tasks.length || meetings.length
    ? `${tasks.length} action item(s) and ${meetings.length} meeting(s) found${project ? ` for ${project.name}` : ''}.`
    : 'No clear action items found — file for reference.';
  return { summary, urgency, tasks: tasks.slice(0, 12), meetings: meetings.slice(0, 5) };
}

let clientPromise;
async function getClient() {
  clientPromise ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic());
  return clientPromise;
}

export async function analyzeWithClaude(email, ctx) {
  const { z } = await import('zod');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { people = [], projects = [], today = isoDate() } = ctx;

  const Analysis = z.object({
    summary: z.string(),
    urgency: z.enum(['low', 'normal', 'high']),
    tasks: z.array(z.object({
      title: z.string(),
      owner_id: z.number().int().nullable(),
      due_date: z.string().nullable(),
      priority: z.enum(['low', 'medium', 'high', 'critical']),
      project_id: z.number().int().nullable(),
    })),
    meetings: z.array(z.object({
      title: z.string(),
      starts_at: z.string(),
      location: z.string().nullable(),
      project_id: z.number().int().nullable(),
    })),
  });

  const roster = people.map((p) => `${p.id}: ${p.name} (${p.role}${p.trade ? `, ${p.trade}` : ''})`).join('\n');
  const jobs = projects.map((p) => `${p.id}: ${p.name}${p.code ? ` [${p.code}]` : ''}`).join('\n');
  const client = await getClient();
  const response = await client.messages.parse({
    model: process.env.ZORDON_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Analysis) },
    system: `You are the executive assistant to a construction project manager with an electrical focus, who coordinates an APM, a project engineer and several foremen. You know electrical work: utility service and energization, gear submittals and releases (switchgear, switchboards, transformers, generators, ATS, panelboards), short-circuit/coordination/arc-flash studies, inspections (underground, rough-in, cover), fire alarm (AHJ submittals, acceptance tests), low voltage, lighting controls, NETA testing, change orders and pay applications. Extract only concrete action items and meetings; mark utility, energization, long-lead gear, inspections, change orders and billing as high or critical. Write task titles as short imperatives. Assign owner_id and project_id only from the lists given, otherwise null. Dates are YYYY-MM-DD; meeting starts_at is YYYY-MM-DDTHH:MM. Today is ${today}.`,
    messages: [{
      role: 'user',
      content: `Team:\n${roster || '(none)'}\n\nProjects:\n${jobs || '(none)'}\n\nEmail from: ${email.sender || 'unknown'}\nSubject: ${email.subject || ''}\n\n${email.body}`,
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new Error(`Claude returned no analysis (stop_reason: ${response.stop_reason})`);
  }
  const ids = { people: new Set(people.map((p) => p.id)), projects: new Set(projects.map((p) => p.id)) };
  const out = response.parsed_output;
  for (const t of out.tasks) {
    if (!ids.people.has(t.owner_id)) t.owner_id = null;
    if (!ids.projects.has(t.project_id)) t.project_id = null;
  }
  for (const m of out.meetings) if (!ids.projects.has(m.project_id)) m.project_id = null;
  return out;
}

export async function analyzeEmail(email, ctx) {
  if (aiEnabled()) {
    try {
      return { analyzer: 'claude', ...(await analyzeWithClaude(email, ctx)) };
    } catch (err) {
      console.warn(`[intel] Claude analysis failed, using rules: ${err.message}`);
    }
  }
  return { analyzer: 'rules', ...analyzeHeuristic(email, ctx) };
}
