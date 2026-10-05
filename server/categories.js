// Every task falls in one of Damian's work buckets. Zordon picks one from the task's words when it's created
// (email, meetings, Claude, change orders…); it can always be changed by hand.
export const TASK_CATEGORIES = [
  { key: 'rfi', label: 'RFIs', icon: '❓' },
  { key: 'coordination', label: 'Coordination', icon: '🤝' },
  { key: 'billing', label: 'Billing', icon: '💵' },
  { key: 'change_order', label: 'Change orders', icon: '💲' },
  { key: 'submittal', label: 'Submittals', icon: '📦' },
  { key: 'closeout', label: 'Closeout', icon: '🏁' },
  { key: 'equipment', label: 'Equipment release', icon: '⚡' },
  { key: 'tracking', label: 'Tracking', icon: '📋' },
];
export const CATEGORY_KEYS = TASK_CATEGORIES.map((c) => c.key);

// Checked in order; the first match wins. Money first (billing, then change orders), then the specific document
// types, then releases, closeout and coordination. Anything else is tracking (follow-ups, logs, reviews).
const RULES = [
  ['billing', /\bpay ?apps?\b|payment application|\bbilling\b|\bbill\b|\bbilled\b|invoice|\bwip\b|lien waiver|retention|retainage|\bsov\b|schedule of values|funding|job cost/i],
  ['change_order', /change orders?|\bcor?s?\s*#?\s*\d|\bcors?\b|\bpcos?\b|\bpcis?\b|\bccds?\b|t\s?&\s?m|time and material|\brfps?\b|price (the |this )?change|pricing request/i],
  ['equipment', /\brelease\b|released|lead[- ]?time|ship(ping)? date|deliver(y|ies)|purchase order|\bpo\s?#?\d|\bmrf\b|material request|order (the |gear|equipment)|procure/i],
  ['rfi', /\brfis?\b|request for information/i],
  ['submittal', /submittals?|shop drawings?|product data|cut ?sheets?|\btransmittal\b|resubmit/i],
  ['closeout', /close-?out|o\s?&\s?m|warrant(y|ies)|as-?builts?|attic stock|punch ?list|training|commissioning|final inspection/i],
  ['coordination', /meeting|\boac\b|huddle|coordinat|look-?ahead|schedule|walk(-| )?(through|down)|site walk|inspection|utility|energiz|clash|\bbim\b|call\b|confirm|scope|sequence|crew|manpower/i],
  ['equipment', /switchgear|switchboard|transformer|generator|\bats\b|panelboard|\bgear\b|equipment/i],
];

export function categorize(title = '', description = '') {
  const text = `${title} ${description || ''}`;
  return RULES.find(([, re]) => re.test(text))?.[0] || 'tracking';
}
