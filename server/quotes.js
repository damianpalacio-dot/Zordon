// Zordon sign-offs for emails that go only to the GEC2 team.
// Half fun, half serious — a commander who means it.
export const QUOTES = {
  fun: [
    'Rangers, the inspector approaches. Make your rough-in as clean as your morphers.',
    'Ay-yi-yi is not a status update. Send me dates.',
    'Even Rita Repulsa submits her RFIs on time.',
    'The Power is with you. So is the three-week look-ahead. Read both.',
    'A Ranger never leaves a T&M ticket unsigned.',
    'Go go Power Rangers. And go go get that submittal approved.',
    'Morphin time is 7:00 a.m. sharp. Coffee is not a Zord.',
    'The Viewing Globe shows all. Especially late pay apps.',
    'Alpha 5 has calculated the odds of finishing on time without that answer: unfavorable.',
    'When the switchgear arrives, the Megazord assembles. Until then, chase the release.',
  ],
  serious: [
    'Safety first. Nobody gets hurt on our watch.',
    'Teamwork is our greatest power. Lean on each other.',
    'Make today a day better than the last.',
    'Do it right the first time. Rework steals from all of us.',
    'Communicate early. Bad news does not improve with age.',
    'Own your commitments. If a date will slip, say so today.',
    'Protect the energization date. Everything else follows it.',
    'Respect every trade on site. We win together.',
    'Lock it out, tag it out, try it out. Every time.',
    'May the Power protect you.',
  ],
};

// Stable for a given day and person, alternating fun and serious so it never gets stale.
export function zordonQuote(date, seed = 0) {
  const n = Math.floor(Date.parse(date) / 86400000) + Number(seed);
  const pool = n % 2 === 0 ? QUOTES.serious : QUOTES.fun;
  return pool[Math.abs(n) % pool.length];
}

const domainOf = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';

// True when every recipient is on the team's email domain (e.g. gec2.com).
export function isTeamOnly(recipients, teamDomain) {
  const list = (Array.isArray(recipients) ? recipients : [recipients]).filter(Boolean);
  return Boolean(teamDomain) && list.length > 0 && list.every((r) => domainOf(r) === teamDomain.toLowerCase());
}

export function withSignOff(body, recipients, teamDomain, date, seed) {
  if (!isTeamOnly(recipients, teamDomain)) return body;
  return `${body}\n\n"${zordonQuote(date, seed)}"\n— Zordon`;
}

export { domainOf };
