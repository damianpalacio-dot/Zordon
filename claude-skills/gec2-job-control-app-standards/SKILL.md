---
name: gec2-job-control-app-standards
description: "Use when building, changing, testing or publishing the GEC2 Job Control change-order app (Claude artifact) or its PDFs, folders and sidebar."
metadata:
  title: Job Control app standards
  source: GEC2 Job Control (Claude skills)
---

# GEC2 Job Control app: standing standards from Damian

These apply to every PM, not just Damian. Follow them without asking again. Work in the artifact file, test in a headless browser (run a stress test of dates, views, edits and printing before publishing), then republish to the same artifact URL. The app auto-saves job data to the artifact DB, so always re-read a job doc and write with `if_version`. Before publishing, run the whole test folder (count both `FAIL` lines and `Traceback`/`SyntaxError`, because a crashed test prints no FAIL) and check the script for duplicate function names (a second `function splitHours` once silently replaced the first and broke the labor split). Every new rule below gets a test.

## Black ribbon (sidebar) navigation
- The box at the very top of the ribbon (job number, job name, GC) says **Go Home** underneath. It goes to the Home screen where all the jobs are. It never says "Switch job" or shows how many jobs are in the list.
- Two sets of items. On My Jobs and the company-wide pages the ribbon shows: My Jobs, General Contractors, Subs & Consultants, Vendors, Labor Rates, Quals & Exclusions, Equipment. No change order list there.
- Inside a specific job the ribbon shows only: Change Orders, CO Log & Summary, Billing · SOV, followed by that job's change order list and "+ Next CO". Equipment is NOT in the job ribbon. A small underlined "Job setup" link under the job box is the way into Job Setup. Opening a job lands on Change Orders.
- The black ribbon also holds a Quick actions section under the menu: "Find backup · all jobs" and "Check if sent", each with a count badge. "The black ribbon" always means this sidebar, never the top bar.
- Under Quick actions, inside a job, the ribbon holds a small collapsed note titled **Where files come from**. It is an FYI for the PM, not a setting: the job folder, the Change orders folder and the folders inside a CO folder (01 ESTIMATE - LABOR & MATERIAL, 02 RFP-RFI REFERENCE, 03 T&M TAGS, 04 APPROVED CO DOCUMENTATION, 05 QUOTES with VENDORS, SUBCONTRACTORS, CONSULTANTS, PROFESSIONAL SERVICES), the stage folders (1 PENDING, 2 SUBMITTED, 3 APPROVED), Purchase orders, Payment applications, Original estimate, and where the final PDF is saved. It follows the job and is hidden on My Jobs and the company-wide pages. It does NOT belong in Job Setup.
- Subs & Consultants and Vendors are company-wide lists, directly after General Contractors in the company-wide menu.
- The sidebar change order list is the only CO picker. There is no row of CO buttons above the CO title. Long CO names stay on one line, are cut off with an ellipsis, and show the full name when hovered.

## Change order status: Draft rule
- A change order is a Draft until BOTH conditions are met: (1) the final PDF package has been made (a ROM PDF does not count), and (2) it has been sent to the GC (Submitted). Both must be true.
- Drafts show a small DRAFT tag in the sidebar list, and a Draft badge plus a "Still needed: ..." note in the CO header.

## Change order folders on OneDrive (Damian, Oct 2026)
- Job folder = `<root>` from Job Setup, which includes the description (e.g. `G9999 - TEST CO INTAKE`), never the bare job number. Root: `C:\Users\Palacio\OneDrive - gec2\5. PROJECTS\<job> - <description>`.
- Open change orders live in stage folders inside `<root>\01 COST CONTROL\04 CHANGE ORDERS`: `1 PENDING (not yet submitted to GC)` -> `2 SUBMITTED (awaiting GC-owner approval)` -> `3 APPROVED` (and `4 REJECTED-VOID`). The ready empty next CO folder (e.g. `CO 003`) sits directly in `04 CHANGE ORDERS`.
- The app moves the folder itself with the PM's Microsoft 365 sign-in whenever the status changes the stage; if it cannot, it queues a `move-co` request ({co, from, to}) that Claude runs on "Run now" (`sharepoint_move_item`, keep the folder name, never overwrite). Delete requests must look in every stage folder.
- Emails about approved COs for the PM named in Job Setup show up in Needs attention: Claude writes a doc `data/users/me/mail-<ms>` with `kind:'mailnotice', job, co, from, subject, received, summary, status:'new'`; the app shows it and the PM marks it handled (`status:'handled'`). Claude only reads mail and never replies.

## CO LOG page, folder and log PDFs
- Only ONE log PDF exists: the detailed log. There is no "PDF summary" and no "PDF summary + log" button, and no "No status" filter button. The on-screen filters are All, Open, Approved.
- When the PM clicks PDF detailed log the app ASKS which change orders to show: All, Only open (open amount above zero), Lapsed over 30 days (open and more than 30 working days since submitted), or Approved. Choices with no matching change orders are disabled. The request carries `logShow` (all|open|lapsed|approved) and `logShowLabel`. To build it run `buildlog.py detlog <out.pdf> <logShow>`, which prints only those rows and their TOTALS bar; the CONTRACT TOTAL and REVISED TOTAL bars always show the whole job. The page title says which filter was used.
- File name: `<job #> <job name> CO LOG - Detailed <date>.pdf` for All, `... CO LOG - Detailed - Open <date>.pdf`, `- Lapsed 30+ days`, `- Approved` for the others. A second file with the same name gets a version suffix (v2, v3) and never overwrites.
- Folder: `5. CO LOG` directly under `04 CHANGE ORDERS` (created the first time if missing).
- The app builds the GC email text (subject, body, counts for the shown rows) into the request; Claude leaves it as an Outlook draft only. The draft cannot carry the attachment, so the PM attaches the filed PDF. It is never sent without the PM's OK.
- Page layout: a drafted email waiting for review shows as a yellow banner at the TOP of the CO Log page (above the filters and table) with Open draft in Outlook and I have reviewed it; once reviewed it drops into the log PDF panel. The log PDF panel (latest request in full, "Earlier log PDFs (n)" drop-down) sits at the BOTTOM of the page. The Pay app PDFs panel sits at the bottom of Billing · SOV the same way.
- The detailed log PDF ends with a slate TOTALS → bar (quoted, approved, open) and two bars under it: CONTRACT TOTAL → and REVISED TOTAL WITH APPROVED CHANGE ORDERS →.

## Change order details and backup (Documents step)
- The short description (it names the CO file) is suggested by Claude from the change, with Use this / Try another / Write my own, exactly like the description-of-work prompt. 2 to 5 words, Title Case, 34 characters or fewer, no CO/RFI numbers, prices or file-illegal characters.
- Find backup lists every file with three actions: Read & fill in, Add to documents, Dismiss. Dismiss hides a file the PM does not want on that change order, and Dismiss all (next to Search again) hides every listed file not yet on the documents list; it is saved on the CO (`dismissed`), listed under a collapsed "Dismissed (n)" with Restore and Restore all, and is skipped by Read all and by the all-jobs Find backup count.
- Stop on Find backup really stops: the search is cancelled at every folder listing and Claude's sorting, the screen goes straight back (a previous list is kept), and a stopped run never overwrites anything later. The same for Stop on the all-jobs Find backup.
- The View button on a backup file shows the text OneDrive reads, with Open in OneDrive (OneDrive's own link from search, folder-path link as fallback), Copy link, and Attach a copy to view here (stores a copy in the app so the real PDF shows inline from then on).
- McCormick estimates that exist as both a PDF and an Excel file in the same CO folder are read together, compared, and counted ONCE (hours and material are never duplicated). A banner says "Same estimate as ..." or warns when the two do not match.

## Quotes, tickets and vouchers: which section they belong in (Damian, Oct 2026)
There must never be doubt about which Change Orders step a document belongs on. The rules, in order:
- **Job Setup has a "Subcontractors & vendors on this job" section.** The PM lists the subcontractors and the vendors for that job (pick from the master list or type a new name). A new subcontractor joins the company Subs & Consultants list; a new vendor joins the company Vendors list (Vendors page in the ribbon, with name, contact, phone, email, notes, shared by every PM).
- **Claude checks every document against those lists first** (this job's list, then the whole Subs & Consultants list, then the vendors), by company name (also in the file name and folder), phone number, license number and email domain, and only then trusts its own reading. GECTWO itself never matches. A match overrides Claude's guess: a known subcontractor is a Subcontractor document, a known vendor is a vendor quote. The note on the card says which list matched and how.
- **Claude reads the WHOLE document**: letterhead and logo text, header and footer, stamps, signature block, license number, phone, address, email. The company that ISSUED the document decides what it is. A logo-only company name is found by its phone, license or address.
- **A subcontractor that bills time and material is still a subcontractor.** A T&M ticket, daily voucher or invoice issued by another contractor goes on the Subcontractors step, never into GECTWO's labor hours. T&M is only for GECTWO's own crews. A quote with installation labor (for example Direct AV) is a subcontractor quote, not a material quote.
- **For a subcontractor, only the GRAND TOTAL counts.** No labor hours, no material lines, no tax or freight lines: the grand total printed on their quote or voucher is the amount on the Subcontractors step. Everything else on their paper is ignored (the card says so).
- **Resolve button** on every document in the Check before adding window: if it landed in the wrong place the PM clicks Resolve and moves it to Labor hours, Material, Subcontractors or Equipment rental (the amount follows: a sub gets the grand total, material becomes one lump line, equipment becomes a rental line the PM sets unit and quantity for), or Dismisses it (it joins the CO's Dismissed list). A "Remember" box, ticked by default, adds the company to the job's subcontractor or vendor list so the same file lands correctly next time.
- The Find backup list applies the same lists to every file (file name, folder, company) before showing its kind.

## Scanned PDFs and photos in the app
- OneDrive gives the app text only. A scanned PDF or a photo reads as "no text". The app then opens a window that says so and offers **Choose this file…**: the PM picks the same file from the computer, the app turns it into page pictures (a JPG/PNG goes as is; a PDF is drawn page by page with pdf.js, up to 6 to 8 pages) and Claude looks at the pictures, logos and handwriting included. The result goes through the normal Check before adding window (with Resolve). A HEIC iPhone photo must be sent as JPG.
- This needs the `sample` capability declared with `images: true`. Keep it in the full capability set on every publish. pdf.js is loaded from cdnjs when needed; if it cannot load, the message says to photograph the page or ask Claude to read it in the chat (see the scan rules skill). The in-app picture reading was tested only with a mocked Claude; confirm it once on a real scan.

## Pay app PDFs and folders
- Path: `<root>\01 COST CONTROL\05 PAYMENT APPLICATIONS (MONTHLY BILLING)\PENCIL DRAFT (submitted)\<year>\<MM Month>` for pencil drafts, and `...\APPROVED\<year>\<MM Month>` for final pay apps, using the period-end month. Only the job number and description change between jobs. The path always starts `C:\Users\Palacio\OneDrive - gec2` (never D:).
- Pay App number: the first SOV a job brings in always starts at Pay App #1, whatever number the spreadsheet carries (the spreadsheet number is ignored). The import preview has a Pay App # box the PM can change, and the Billing page has a Change # button next to the title for any later override. The number moves up by one only when the PM closes a billing period in the app; a re-import after pay apps were closed in the app keeps the current number.
- The pay app panel shows the latest request in full and folds earlier pay app PDFs into an "Earlier pay app PDFs (n)" drop-down.

## Change order PDF package
- Package order: (1) end sheet (everything the app prints), (2) RFI/CCD/PCI/drawings/narrative (non-estimating reference), (3) material sheets (e.g. McCormick estimates), (4) quotes (material and rentals), (5) subcontractors, (6) other backup (currently T&M tags). No contents page, no cover page. The package opens straight on the CO form.
- File names: `<job> <site or job name> CO ### <title>.pdf`. A rebuilt package gets a version suffix (v2, v3) and never overwrites a sent file.
- The end sheet follows his real COR workbook (G3249 CO 018): letterhead, CHANGE ORDER REQUEST form page, then the detailed breakdown with every class/shift row (zeros shown, muted gray), every support line, material (deliveries, consumables, tax, freight), subs with mark-up, direct job expense, O&P close-out and grand total.
- Support lines show a red percentage note beside the row, for example "(5% of total labor hours)" for Project Engineer and "(10% of total labor hours)" for Project Manager (also Quality Control 2.5%, scaffolding/non-productive/foreman 3%, 5% and 10% per the table in the app). A separate "Basis for the percentage-driven labor allocations" block is NOT printed. If the PM entered the hours by hand, the note reads "hours entered by PM".
- Last page: qualifications and exclusions at the top. The closing paragraph and the AUTHORIZATION block (SUBMITTED BY GECTWO INC. with signature line, name, date; ACCEPTED BY CUSTOMER with signature line, date) are pinned to the very bottom of the page. No "backup attached behind the endsheet" list.
- Colors: mostly white and black, some red, yellow only in a few places (the letterhead rule and the underline/left marker on grand-total lines). No slate-gray or gold scheme. The round G2.0 Electrical Contracting logo goes top-left in the letterhead.
- Double time is the same rate on every shift (1st DT = 2nd DT = 3rd DT).

## Job Setup page
- Row 1: Job number, Contract date, Contract amount, Bill cycle (billing due day of month). Fields are bottom-aligned; explanatory text goes under the row, not inside a cell. No "numbers only" hint on Contract amount.
- Then Job name, then Job address, City/state and Zip code on one row, then one field, **Job folder on OneDrive**, with a one-line note pointing to the ribbon note. The long "Where Claude looks for backup" panel is gone from Job Setup; the folder list lives in the ribbon under Where files come from.
- Then the **Subcontractors & vendors on this job** section (see Quotes, tickets and vouchers above).
- The General contractor section uses Company address (not "Street address"), City/state and Zip on one row.
- **APM prepares change orders** (in the Project team section) is a switch: Off or "On · the PM reviews before it goes out". The PM can ALWAYS prepare, review and send change orders; the switch only adds the APM. When On, the APM puts a change order together, "Send to PM" on the Review step emails the PM to review what the APM put together and reviewed, nothing goes to the GC until the PM approves, and the final PDF package stays locked until then. APM fields are APM name and APM email only (no PM box).

## My Jobs page and billing calendar
- The billing calendar lives at the bottom of the My Jobs page, below the jobs table and always above "Add a job". It is compact, not big.
- A solid semi-transparent black vertical line separates the calendar from the job list.
- Jobs show as small circles stacked vertically, each with its job number, name and billing status. Starting 5 days before billing is due the circle and its text blink red, and they turn solid red on the due date. Overdue stays solid red for up to 5 days. A billed job is dimmed.
- The My Jobs menu item shows a red number badge when any job is within 5 days. A pop-up notice appears once when the app opens.
- The sidebar (black ribbon) stays at its normal width and does not hold the calendar.

## Labor Rates page
- No "Loaded from" line, no "5% to 15% mark up" line, no "at 5% - effective" in the table title, no "Rates:" line in the sidebar, no Source file column in Rate history. The history column is Status (Current, or Archived with through-date).
- Classification names (Foreman, Journeyman, etc.) sit close to their numbers (fixed narrow first column).

## Lists and names
- Quals & Exclusions library: the add box works like the equipment picker (click to browse a scrollable list, type a word to search, pick a line to add it, or type your own and press Enter), with the same styling as the equipment popup.
- Subs & Consultants Type list: Subcontractor, Consultant, Professional services. A subcontractor quote read for a company missing from this list adds the company to it (type from the quote's folder), so it appears in every Company drop-down for every PM.
- Vendors (company-wide, `company/catalog/vendors`): name, contact, phone, email, notes; edited in place, saved for everyone.
- Anywhere the app shows who made a change (Last change, change history, activity feed), show the person's actual name, never "You".

## Other standing rules
- Never send the GC email without the PM's OK in chat. Leave it as a draft in Outlook for the PM to review. The internal PM review email is queued by the app and sent only when Damian says "Run now" in chat.
- Test-job paperwork mismatches (job G9999) are fine; the job is a test.
- When a mark-up image is sent, make exactly what is marked. Red scribbles are removals; green X'd blocks are removed; added notes go beside the marked cells.
- Publishing: pass the FULL capability set explicitly when adding one (a plain republish carries the stored set forward). The set today: `mcp` (Microsoft 365: sharepoint_search, sharepoint_folder_search, sharepoint_move_item, read_resource, outlook_email_search; Claude Code Remote: fire_trigger), `sample` with `images: true`, `assets`, `db` (rules for `data/users` and `data/users/{self}`), `user` (profile). Adding a connector tool asks the PM for permission on first use; adding `images` asks each viewer again at their next use of Claude.
- When Damian lists several requests in a row, keep a numbered list of every one, check each off before publishing, and say so in chat. Nothing he sends is dropped.