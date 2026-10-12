---
name: co-update
description: "Use when Damian tells you a Change Order's status changed (submitted/approved/rejected), when a new CO PDF appears loose in a job's CHANGE ORDERS folder, when he asks to build/assemble a CO's submission package, or when the hourly inbox check finds a CO status update - handles CO numbering/naming, assembling a CO's backup into a complete submission package, drafting the GC email, moving the CO folder between status stages, and tracking the Job Control Workbook reminder."
metadata:
  title: Change orders: numbering, package & GC email
  source: GEC2 Job Control (Claude skills)
  output_category: COR
---

# GEC2 Change Order Status & Naming

## The CO folder layout (Damian's standard, Oct 2026 - do not drift from it)

Every CO has its own folder, `CO 0XX - [short description]`, inside a stage folder of `01 COST CONTROL/04 CHANGE ORDERS`: `1 PENDING (not yet submitted to GC)`, `2 SUBMITTED (awaiting GC-owner approval)`, `3 APPROVED`, `4 REJECTED-VOID`. Inside the CO folder:

```
CO 0XX - [short description]/
    [the final package PDF]
    01 ESTIMATE - LABOR & MATERIAL/     the McCormick estimate ONLY
    02 RFP-RFI REFERENCE/               RFIs, CCDs, PCIs, ASIs, drawings
    03 T&M TAGS/
    04 APPROVED CO DOCUMENTATION/       signed CO once executed
    05 QUOTES/
        VENDORS/[Company]/              material and rental quotes, one folder per vendor
        SUBCONTRACTORS/[Company]/
        CONSULTANTS/[Company]/
        PROFESSIONAL SERVICES/[Company]/
```

Vendor quotes never go in 01. The company folder is named for who the quote came from, read from the quote's own letterhead or header (never guessed from the products on it: a quote for Eaton fuses can come from Regency Supply, and the folder is Regency Supply).

## Always keep the next CO number ready - in the CHANGE ORDERS folder, not in a stage folder

The CO folder for the next number always already exists, empty, sitting directly in `01 COST CONTROL/04 CHANGE ORDERS` (next to the four stage folders, NOT inside `1 PENDING`), named just `CO 0XX`. It is a copy of `_CO FOLDER TEMPLATE (DUPLICATE ME)` (the template lives in `1 PENDING`; the ready folder does not). A brand new job starts with `CO 001` already there, because the master job template (`_00 JOB TEMPLATE - DO NOT DELETE`) carries it in its 04 CHANGE ORDERS folder.

When a CO's folder is filled (its PDF built and its backup filed):
1. Take the ready folder `CO 0XX`, rename it `CO 0XX - [short description]`, and move it into `1 PENDING (not yet submitted to GC)`. (If no ready folder exists, copy the template into `1 PENDING` under that name.)
2. If the CO's backup was sitting loose in another plain `CO 0XX` folder (or loose files) at the root of `04 CHANGE ORDERS`, copy every file into the right subfolder of the CO folder first, check that every file is there with the same size, and only then delete that loose folder (the connector's delete goes to the recycle bin, recoverable 93 days). Two folders for one CO number make the app refuse to move it.
3. Create the next number's ready folder: copy `_CO FOLDER TEMPLATE (DUPLICATE ME)` into `04 CHANGE ORDERS` (the root, not a stage folder) named `CO 0XX+1`. Do this for every job, whenever you finish a CO folder, without being asked.

## How a CO gets started

The normal flow starts when Damian prints/exports a Change Order PDF from Job Control (already titled with its COR-XX number and a short description) or asks Claude to make the final PDF from the app (a queued build-pdf request, which wakes this session). He can also drop a PDF loose into that job's `01 COST CONTROL/04 CHANGE ORDERS` folder - not yet filed into any stage subfolder - or ask directly ("build the package for CO 013"). Damian does not need to tell you the job number or job name separately; that is implicit in which job's folder it landed in.

1. Read the loose PDF to get its COR-XX number and short description - both are printed on the form itself. Use that COR number directly as the CO number - do NOT count existing folders or invent your own sequence. Zero-pad to 3 digits (CO 002). This number is permanent for that CO - never reused or renumbered later. If the GC later assigns their own CO/PCO number, add it in parentheses instead of renumbering.
2. Use the ready folder (see above) or duplicate `_CO FOLDER TEMPLATE (DUPLICATE ME)`, name it `CO 0XX - [short description]` and put it in `1 PENDING`.
3. Move (don't copy) the loose CO PDF into the new CO folder - it is the one file in this workflow that gets moved, since it has no other home.
4. Go straight into "Building the complete submission package" - don't wait for Damian to ask separately.

## Naming files inside a CO folder

Every file gets the CO number prefix, since it may end up emailed on its own:

- `01 ESTIMATE - LABOR & MATERIAL/`  CO 0XX - Estimate - Labor & Material (McCormick [short description]).pdf
- `02 RFP-RFI REFERENCE/`            CO 0XX - RFI ## Reference.pdf (or CCD / PCI / ASI / drawing)
- `03 T&M TAGS/`                     CO 0XX - T&M Tag - YYYY-MM-DD.pdf
- `04 APPROVED CO DOCUMENTATION/`    CO 0XX - Signed CO.pdf
- `05 QUOTES/VENDORS/[Company]/`     CO 0XX - Vendor Quote - [Company] [quote or change #].pdf
- `05 QUOTES/SUBCONTRACTORS|CONSULTANTS|PROFESSIONAL SERVICES/[Company]/`   CO 0XX - Sub Quote - [Company].pdf (use Consultant Quote / Professional Services Quote for those folders)

The combined submission PDF carries the job so it identifies itself out of context. When the Job Control app queued the build, use the file name in the request (the app's own name, for example `G9999 Test CO Intake CO 002 Bus Tap (RFI #63).pdf`). When building from a loose PDF with no request, use `CO 0XX - [Job#] - [short description].pdf`.

## Building the complete submission package

1. Identify the job and CO number - from the loose PDF, the queued request, or what Damian says. If it's ambiguous, ask.
2. Find or create that CO's folder in `1 PENDING (not yet submitted to GC)` (see the ready-folder rule above).
3. Search the job folder for backup tied to this CO: estimate, RFI/RFP/bulletin reference docs, T&M tags, vendor and sub quotes (the job's `06 PURCHASE ORDERS` folder holds job-wide sub quotes and POs), photos - matched by CO number, RFI/PCI/bulletin reference, date, or keywords. If more than one file could be the match for a slot, list the candidates and ask - never guess silently.
4. Copy (don't move) each file into the right subfolder above, renamed per the naming list. Photos stay in 08 JOB SITE PHOTOS and are only copied into the combined PDF.
5. Build one combined PDF in the CO folder root, in this order: the CO form with its cost breakdown (end sheet, no cover page) -> Reference (RFI/CCD/PCI/drawings) -> Material sheets (the McCormick estimate) -> Vendor quotes -> Subcontractor, consultant and professional services quotes -> Other backup (T&M tags, photos). A drawing that is already an attachment inside the RFI PDF is not added a second time.
6. Show Damian a summary: what backup was found and where it was filed, and plainly call out any category where nothing was found. Also flag any line on the CO form that looks stale (for example a Description of Work that still says no reference document was provided).
7. Then go into "Drafting the GC email" - that draft is how Damian reviews the package.

## Drafting the GC email

Create an Outlook DRAFT (never send it yourself) addressed to the GC with the combined PDF attached:

1. Subject: `CO 0XX - [Job#] - [short description]`.
2. Body: brief and businesslike - job name/number, CO number, a one-line scope summary, and the total dollar amount, asking for review and approval. Don't invent scope language or numbers beyond what's on the CO form.
3. To: the job's usual GC/owner contact if you can find one confidently (the job's gcEmail in Job Control, prior correspondence in `10 CORRESPONDENCE`). If not confident, leave To blank and say so.
4. Attach the combined PDF.
5. Leave it as a draft - never send it. Tell Damian it's in his Drafts folder, and that only once HE says it was sent do you move the CO folder to Submitted.

## Status changes

The CO folder only moves when something has actually happened - not just because the package looks ready:

- "I sent CO 013 to the GC" / "just submitted CO 013" / the Job Control app records the submitted date -> move to Submitted
- "CO 03 on G3249 just got approved" -> move to Approved
- rejected/voided -> move to Rejected-Void
- the hourly inbox-check flags one it found

Handle the folder move and log edit in the interactive session (scheduled tasks never write/move anything):

1. Confirm which job and CO number if there is any ambiguity.
2. Move the whole `CO 0XX - ...` folder (not its contents) from its current stage folder to the matching one.
3. Append an OPEN line to `5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt` (format defined at the top of that file) so Damian keeps getting reminded until he reflects it in his real GEC2 Job Control Workbook (.xlsm) for that job.
4. Tell Damian what moved and that the reminder is tracked.

## When Damian confirms the workbook is updated

1. Find that CO's line in `_PENDING WORKBOOK UPDATES.txt`, flip `OPEN` to `DONE`, fill in `resolved YYYY-MM-DD`, and move it to the `---- DONE ----` section.
2. Send a short confirmation: job, CO number, status, reminder cleared.

This is an honest acknowledgment of what Damian reported, not independent verification - Claude cannot open .xlsm files through this connector. Never imply otherwise.

## Don't

- Don't silently skip a step - if a folder move, rename, copy or log edit fails, say so and ask how to proceed.
- Don't renumber an existing CO once assigned.
- Don't touch the Job Control Workbook (.xlsm); track the reminder in `_PENDING WORKBOOK UPDATES.txt`.
- Don't send the GC email yourself, ever - always a draft.
- Don't move a CO folder to Submitted just because the package or draft looks complete.
- Don't guess which file is the right backup when more than one matches - list them and ask.
- Don't guess a GC/owner email address - leave To blank and say so.
- Don't put vendor quotes in 01 ESTIMATE - LABOR & MATERIAL, and don't name a quote folder from a product brand - use the company on the quote.
- Don't put the next CO's empty ready folder inside `1 PENDING` - it waits in `04 CHANGE ORDERS` itself until it is filled.
- Don't delete or move original backup files out of their home folders when assembling a package - copy them. The only exceptions are the loose CO PDF itself (moved) and a loose plain `CO 0XX` folder at the root of 04 CHANGE ORDERS once every file in it has been copied into the CO folder and the sizes match (then delete it, recoverable from the recycle bin).