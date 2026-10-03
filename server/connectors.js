// Pull RFIs and submittals from Procore and Autodesk Construction Cloud (Forma).
// Every setting comes from environment variables; see README "Connect Procore & Autodesk".
// Responses are normalised defensively because field names differ between API versions.

const env = (k, d = undefined) => process.env[k] ?? d;

// "zordonProjectId:externalProjectId,..." → [{ local, external }]
function projectMap(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [local, external] = pair.split(':').map((x) => x.trim());
    return { local: Number(local), external };
  }).filter((p) => p.local && p.external);
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const names = (list) => (Array.isArray(list) ? list : list ? [list] : [])
  .map((x) => (typeof x === 'string' ? x : first(x.login, x.email, x.name, x.oxygenId, x.autodeskId, x.id)))
  .filter(Boolean).map(String);

function mine(people, meIds) {
  const ids = meIds.map((m) => m.toLowerCase());
  return people.some((p) => ids.includes(p.toLowerCase()));
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------------- Procore ----------------
export const procore = {
  name: 'procore',
  configured: () => Boolean((env('PROCORE_ACCESS_TOKEN') || (env('PROCORE_CLIENT_ID') && env('PROCORE_CLIENT_SECRET'))) && env('PROCORE_COMPANY_ID') && env('PROCORE_PROJECTS')),
  async token() {
    if (env('PROCORE_ACCESS_TOKEN')) return env('PROCORE_ACCESS_TOKEN');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env('PROCORE_CLIENT_ID'), client_secret: env('PROCORE_CLIENT_SECRET') });
    const data = await getJson(`${env('PROCORE_LOGIN_URL', 'https://login.procore.com')}/oauth/token`, { method: 'POST', body });
    return data.access_token;
  },
  async fetchItems() {
    const base = env('PROCORE_API_URL', 'https://api.procore.com');
    const token = await this.token();
    const headers = { Authorization: `Bearer ${token}`, 'Procore-Company-Id': env('PROCORE_COMPANY_ID'), Accept: 'application/json' };
    const me = String(env('PROCORE_ME', '')).split(',').filter(Boolean);
    const out = [];
    for (const { local, external } of projectMap(env('PROCORE_PROJECTS'))) {
      for (const type of ['rfis', 'submittals']) {
        for (let page = 1; page <= 20; page++) {
          const rows = await getJson(`${base}/rest/v1.0/projects/${external}/${type}?page=${page}&per_page=100`, { headers });
          if (!Array.isArray(rows) || !rows.length) break;
          for (const r of rows) {
            const bic = names(first(r.ball_in_court, r.ball_in_courts, []));
            const assignees = names(first(r.assignees, r.assignee, []));
            out.push({
              origin: 'procore',
              source: 'procore',
              external_id: r.id,
              project_id: local,
              type: type === 'rfis' ? 'rfi' : 'submittal',
              number: first(r.full_number, r.number, r.formatted_number) != null ? String(first(r.full_number, r.number, r.formatted_number)) : null,
              title: first(r.subject, r.title, r.name, 'Untitled'),
              spec_section: first(r.specification_section?.number, r.spec_section?.number, r.specification_section_number),
              status: first(r.status?.name, r.status, 'Open'),
              due_date: (first(r.due_date, r.required_on_site_date, r.response_due_date) || '').slice(0, 10) || null,
              ball_in_court: bic.join(', ') || null,
              assigned_to_me: me.length ? mine([...bic, ...assignees], me) : false,
              url: `https://app.procore.com/${external}/project/${type}/${type === 'rfis' ? 'show' : 'submittal'}/${r.id}`,
            });
          }
          if (rows.length < 100) break;
        }
      }
    }
    return out;
  },
};

// ---------------- Autodesk Construction Cloud / Forma (APS) ----------------
export const autodesk = {
  name: 'autodesk',
  configured: () => Boolean((env('APS_ACCESS_TOKEN') || (env('APS_CLIENT_ID') && env('APS_CLIENT_SECRET'))) && env('ACC_PROJECTS')),
  async token() {
    if (env('APS_ACCESS_TOKEN')) return env('APS_ACCESS_TOKEN');
    const basic = Buffer.from(`${env('APS_CLIENT_ID')}:${env('APS_CLIENT_SECRET')}`).toString('base64');
    const data = await getJson('https://developer.api.autodesk.com/authentication/v2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read account:read' }),
    });
    return data.access_token;
  },
  async fetchItems() {
    const base = env('APS_API_URL', 'https://developer.api.autodesk.com');
    const headers = { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' };
    if (env('APS_USER_ID')) headers['x-user-id'] = env('APS_USER_ID'); // act on behalf of a user with a 2-legged token
    const me = String(env('ACC_ME', env('APS_USER_ID', ''))).split(',').filter(Boolean);
    // Paths are overridable in case Autodesk versions them again.
    const rfiPath = env('ACC_RFI_SEARCH_PATH', '/construction/rfis/v3/projects/{project}/search:rfis');
    const subPath = env('ACC_SUBMITTALS_PATH', '/construction/submittals/v2/projects/{project}/items');
    const out = [];
    for (const { local, external } of projectMap(env('ACC_PROJECTS'))) {
      const project = external.replace(/^b\./, '');
      for (let offset = 0; offset < 2000; offset += 100) {
        const data = await getJson(`${base}${rfiPath.replace('{project}', project)}`, {
          method: 'POST', headers, body: JSON.stringify({ limit: 100, offset }),
        });
        const rows = first(data.results, data.data, []);
        for (const r of rows) {
          const assigned = names(first(r.assignedTo, r.assignees, []));
          out.push({
            origin: 'autodesk', source: 'autodesk', external_id: r.id, project_id: local, type: 'rfi',
            number: first(r.customIdentifier, r.displayId, r.number) != null ? String(first(r.customIdentifier, r.displayId, r.number)) : null,
            title: first(r.title, r.question, 'Untitled RFI'),
            spec_section: first(r.specSection, r.location?.specSection),
            status: first(r.status, 'open'),
            due_date: (r.dueDate || '').slice(0, 10) || null,
            ball_in_court: assigned.join(', ') || null,
            assigned_to_me: me.length ? mine(assigned, me) : false,
            url: `https://acc.autodesk.com/build/rfis/projects/${project}?preview=${r.id}`,
          });
        }
        if (rows.length < 100) break;
      }
      for (let offset = 0; offset < 2000; offset += 50) {
        const data = await getJson(`${base}${subPath.replace('{project}', project)}?limit=50&offset=${offset}`, { headers });
        const rows = first(data.results, data.data, []);
        for (const r of rows) {
          const bic = names(first(r.ballInCourtUsers, r.ballInCourt, r.assignedTo, []));
          out.push({
            origin: 'autodesk', source: 'autodesk', external_id: r.id, project_id: local, type: 'submittal',
            number: first(r.customIdentifier, r.identifier, r.number) != null ? String(first(r.customIdentifier, r.identifier, r.number)) : null,
            title: first(r.title, 'Untitled submittal'),
            spec_section: first(r.specIdentifier, r.spec?.identifier, r.specSection),
            status: first(r.statusValue, r.status, r.stateId, 'open'),
            due_date: (first(r.dueDate, r.requiredDate, r.requiredOnJobDate) || '').slice(0, 10) || null,
            ball_in_court: bic.join(', ') || null,
            assigned_to_me: me.length ? mine(bic, me) : false,
            url: `https://acc.autodesk.com/build/submittals/projects/${project}/items/${r.id}`,
          });
        }
        if (rows.length < 50) break;
      }
    }
    return out;
  },
};

export const CONNECTORS = [procore, autodesk];

export function connectorStatus() {
  return CONNECTORS.map((c) => ({ name: c.name, configured: c.configured() }));
}

export async function syncAll(upsert) {
  const results = [];
  for (const c of CONNECTORS) {
    if (!c.configured()) { results.push({ name: c.name, skipped: 'not configured' }); continue; }
    try {
      const items = await c.fetchItems();
      results.push({ name: c.name, fetched: items.length, changes: upsert(items) });
    } catch (err) {
      results.push({ name: c.name, error: err.message });
    }
  }
  return results;
}
