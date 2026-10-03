# ⚡ Zordon Command Center

A project coordination hub for a construction PM, the APM, the project engineer and foremen, styled as the Power Rangers command center. Zordon floats in his energy tube in the middle of the screen, greets you by name, briefs you on the day and keeps everyone on schedule.

**What it does**

| Area | What you get |
|---|---|
| **Command Center** | 3D Zordon with a live HUD: alert level, clock, system lights, delayed work, change orders & billing, RFIs/submittals in your court, jobsite weather, Rangers (team) status, projects, meetings. Spoken greeting and briefing. |
| **My Focus** | Nudges 3 days, 1 day and the day something is due, plus a **reality check**: hours due vs your real focus hours, projected finish dates at your pace, and your historical on-time rate ("you usually finish 2 days late, so add 2 days when you commit"). |
| **Board** | Monday.com-style board grouped by project: owner, status, priority, due date, timeline, estimate. Inline editing, filters, task drawer with history. |
| **Projects** | Portfolio cards with progress and health. |
| **RFIs & Submittals** | Watchlist for Div 26/27/28, HVAC, plumbing, millwork, special glazing and framing. Pulls from Procore, Autodesk (ACC / Forma) and their notification emails. Anything in your court becomes a task on your list. |
| **Schedule & Equipment** | 3-week look-ahead vs baseline (CSV import from P6 / MS Project), equipment release log (release-by = need date − lead time − buffer), and recurring reminders (weekly look-ahead review, monthly pay app, weekly CO log review). |
| **Meetings** | Huddles, OACs and coordination meetings, with notes and action items that go straight onto the board. |
| **Email Intel** | Paste (or automate) an email. Zordon extracts tasks, owners, due dates, meetings and Procore/Autodesk items. |
| **Reminders** | Drafts a nudge for anyone with late or soon-due work. Open it in your email, copy it to Teams, and keep a sent log. |
| **File Vault** | Every file gets a consistent name and home: `JOB-Project-Name/NN-Type/YYYY-MM-DD_JOB_Type_Description.ext`. Drop files in, or save anything into `_Inbox` and it's filed within a minute. Point it at OneDrive and it syncs everywhere. |

Change orders and billing are treated as cash flow: they're never below *High* priority, become *Critical* inside 3 days, and lead Zordon's briefing.

---

## Quick start

You need **Node.js 22.13 or newer** (https://nodejs.org, the LTS installer is fine).

```bash
npm install
npm start
```

Open http://localhost:4000. The first run loads demo data so you can click around. To start empty: delete `data/zordon.db` and run with `ZORDON_SEED=off`.

**One-click launch (opens as a full-screen app window):**
- Windows: double-click `scripts/start-zordon.bat`
- Mac: double-click `scripts/start-zordon.command`

When Zordon starts, he says *"Good morning, Damian. Make today a day better than the last."* through your computer's speakers. He says *"May the Power protect you"* when you close the window or shut him down. Set `ZORDON_VOICE=off` to silence him.

### Settings

Copy `.env.example` to `.env` and fill in what you use. Everything is optional.

---

## Make it yours

1. **Rangers**: replace the demo team with your APM, project engineer and foremen. Give each a Ranger color, and choose who "me" is.
2. **Projects**: add your jobs with a job code (e.g. `ECT-301`) and a city. The city is used for weather.
3. **My Focus**: set your real focus hours per day (default 4). Be honest; that's the point.
4. **Schedule**: import the baseline once, then the current update each week (CSV with `Activity ID, Activity Name, Start, Finish`, optionally `BL Start, BL Finish, % Complete, Trade`).

---

## File Vault and OneDrive

Set `ZORDON_VAULT` to a folder inside your OneDrive, for example:

```
ZORDON_VAULT=C:\Users\Damian\OneDrive - Company\Zordon
```

Zordon creates the same folder tree for every project:

```
AGM-101-Angel-Grove-Medical-Office/
  01-Contracts  02-Change-Orders  03-Billing  04-RFIs  05-Submittals  06-Drawings
  07-Schedule  08-Meeting-Minutes  09-Daily-Reports  10-Inspections-Permits
  11-Safety  12-Correspondence  13-Photos  99-General
_Inbox/
```

and names every file `2026-10-03_AGM-101_RFI_Beam-Penetration-At-C4.pdf`. Same convention, every time.

**The `_Inbox` habit:** whenever you save something (from Claude, an email attachment, a scan), save it into `_Inbox`. Zordon reads it, works out the project and document type, renames it and moves it into place. Renaming a project renames its folder and keeps every link working. The **Name helper** on the Vault page gives you the right name for files you keep elsewhere (Procore, SharePoint).

---

## Email

Three ways to get email in, simplest first:

1. **Paste** into Email Intel and review the suggestions.
2. **Ask Claude to sweep your inbox.** The `inbox-sweep` skill in `.claude/skills/` reads Outlook with the Microsoft 365 connector and posts each email to Zordon. It can run as a scheduled Claude routine every morning.
3. **Power Automate / Zapier**: on new email, `POST http://<zordon>/api/emails` with JSON `{ "sender", "subject", "body" }`. Add `"auto_accept": true` to put suggestions straight on the board.

Procore and Autodesk notification emails ("Submittal #26 51 00-1 … ball in court") are recognised automatically and tracked on the RFIs & Submittals page.

With `ANTHROPIC_API_KEY` set, Claude does the email triage and file naming. Without it, a built-in rule-based parser does the job offline.

---

## Connect Procore & Autodesk

**What's an API token?** It's a long secret password that one program uses to prove who it is to another. You create it in Procore or Autodesk's developer settings and paste it into `.env`. Zordon sends it with each request. You can revoke it at any time without changing your password. Keep `.env` private; it's already excluded from git.

### Procore
1. Go to https://developers.procore.com and sign in with your Procore account. Create an app and add a **Developer Managed Service Account**.
2. Have your Procore company admin install the app in your company (Company Admin → App Management) with read access to RFIs and Submittals on your projects.
3. Put the **Client ID** and **Client Secret** in `.env` as `PROCORE_CLIENT_ID` / `PROCORE_CLIENT_SECRET`, plus `PROCORE_COMPANY_ID`. The company id is the number in your Procore URL.
4. Map projects: `PROCORE_PROJECTS=1:562949953421312,2:562949953425000` (Zordon project id : Procore project id from the project URL).
5. `PROCORE_ME=you@company.com` so items assigned to you land on your list.

### Autodesk Construction Cloud / Forma
1. Go to https://aps.autodesk.com and create an app. Copy the **Client ID** and **Client Secret**.
2. Have your ACC account admin add the app under Account Admin → Custom Integrations.
3. Fill `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `APS_USER_ID` (your Autodesk user id), and `ACC_PROJECTS=1:<acc-project-id>`.

Zordon syncs every 30 minutes (`ZORDON_SYNC_MINUTES`); there's also a **Sync now** button. Autodesk's endpoint paths are configurable (`ACC_RFI_SEARCH_PATH`, `ACC_SUBMITTALS_PATH`) in case Autodesk versions them. Verify them against the current APS docs when you first connect.

No API access? Notification emails alone keep the RFI/submittal list current, and the push API (`POST /api/items`) accepts items from any automation.

---

## Reminders and nudges

- **Your nudges** run on a 3-day / 1-day / day-of cadence. Change orders and billing get a 💲 and the loudest wording.
- **Team reminders** are drafted for anyone with late or soon-due work. You review, then send from your own email (one click) or copy to Teams.
- **Recurring reminders** (Schedule → Recurring reminders) drop a task a few days before each occurrence: the weekly look-ahead vs baseline review, the monthly pay application, the weekly change order log.
- **Automatic sending:** ask Claude to set up a routine that reads Zordon's reminder drafts (`GET /api/reminders/drafts`) and sends them from your Outlook on a schedule.

## Weather

Each project's city is looked up on Open-Meteo (free, no account). The Command Center shows current conditions and a 4-day outlook, and flags work impacts: rain for pours and roofing, gusts for crane picks and lifts, heat-illness days, freezing for concrete, and lightning. Zordon mentions them in his spoken briefing.

## Claude skills

`.claude/skills/` holds reusable instructions for Claude Code:
- `lookahead-review`: reviews the 3-week look-ahead against the baseline and the equipment releases, and produces an action list.
- `inbox-sweep`: reads Outlook and pushes it into Zordon.

## Security

Zordon is built to run on your own computer. Before you put it on a server or open it to your team over the network, set `ZORDON_API_TOKEN` to a long random secret. The browser asks for it once, and automations send it as `Authorization: Bearer <token>`.

## Development

```bash
npm run dev    # restart on file changes
npm test       # 23 tests: parsing, scheduling, doc control, naming, API
```

- `server/`: zero-framework Node HTTP server. SQLite via Node's built-in `node:sqlite` (`data/zordon.db`).
- `public/`: the UI, plain ES modules with no build step. Three.js renders Zordon (`public/js/zordon3d.js`).

**Roadmap ideas:** Microsoft Graph sign-in for direct Outlook/OneDrive access, Teams notifications, Procore webhooks instead of polling, daily report capture from foremen's phones, two-way schedule sync.
