---
name: gec2-co-folder-scan-rules
description: "Use when Claude scans a GEC2 change order folder in OneDrive (Find backup, Pull documents), fills Reference numbers, builds a final CO or CO LOG PDF, or is woken by the Job Control app."
metadata:
  title: Change orders: folder scan rules
  source: GEC2 Job Control (Claude skills)
  output_category: COR
---

# GEC2 change order folder scan rules

Standing rules from Damian for anytime Claude looks through a change order folder, in the Job Control app or in a queued request.

## Where Claude looks
- The CO folder: `01 COST CONTROL\04 CHANGE ORDERS\<stage>\CO ### - title\` with its subfolders, including the company folders inside `05 QUOTES` (four levels down: CO folder > 05 QUOTES > VENDORS > company > file). The in-app scan walks three levels below the CO folder so it reaches those files.
- Purchase Orders (`01 COST CONTROL\06 PURCHASE ORDERS`): job-wide POs and sub quotes.
- Payment Applications (`05 PAYMENT APPLICATIONS (MONTHLY BILLING)`): the SOV PDF.
- Nothing outside the job folder. Root: `C:\Users\Palacio\OneDrive - gec2\5. PROJECTS\<job>`.
- Stage folders inside 04 CHANGE ORDERS: `1 PENDING (not yet submitted to GC)` -> `2 SUBMITTED (awaiting GC-owner approval)` (moves when the email goes out / the submitted date is set) -> `3 APPROVED` (`4 REJECTED-VOID` for void).
- The next CO number's empty ready folder (`CO 003`) sits directly in `04 CHANGE ORDERS`, outside the stage folders. It is empty, so it adds no files; the app finds it as a folder at the root and moves it into `1 PENDING` once it is filled.
- `5. CO LOG` also sits directly in `04 CHANGE ORDERS` (see CO LOG PDFs below). Every job and the job template carry it. It holds log PDFs only and is never a change order folder or backup.

## Folder layout inside a CO folder
01 ESTIMATE - LABOR & MATERIAL = the McCormick estimate only. 02 RFP-RFI REFERENCE. 03 T&M TAGS. 04 APPROVED CO DOCUMENTATION. 05 QUOTES with VENDORS, SUBCONTRACTORS, CONSULTANTS and PROFESSIONAL SERVICES, each holding one folder per company the quote came from. Vendor quotes never go in 01. Name the company folder from the quote's letterhead, never from the product brand (the Bus Tap quote for Eaton parts was from Regency Supply).

## Never duplicate files
- Bring in exactly the files that exist in the CO folder (including subfolders), each once. The listing is the source of truth; Claude only adds the kind.
- Same name and size = one file. A copy found elsewhere in OneDrive is not listed again. Windows copies named "quote (1).pdf" with the same size as "quote.pdf" count as the same file.
- Searching again gives the same list, not a longer one. Match on file name (ignore case/spaces) before adding.
- Never add a material line, hour entry or sub line already on the CO from the same document.
- Files the app's own PDF package filed are not new backup: anything named "CO ### - ..." (for example "CO 002 - Vendor Quote - Regency Supply Change 5.pdf") and the final PDF whose name starts with the job number and contains "CO ###". Skip them, along with desktop.ini, Thumbs.db and ~$ temp files.

## Quick buttons in the black ribbon (sidebar)
The app's sidebar has a Quick actions section with two buttons that look across every job in the PM's list:
- **Find backup · all jobs**: opens the Pending and Submitted CO folders of every job (Approved and Void change orders are skipped), lists files that are in the folder but not on the change order's documents list, and shows a count badge. It changes nothing. "Review with Claude" on a row opens that job and CO on the Documents step and runs the normal Find backup, where Read & fill in needs the PM's check before anything is added. Kind of file comes from the subfolder it was dropped in.
- **Check if sent**: for change orders with a final PDF made but no submitted date, searches Outlook Sent Items (`outlook_email_search`, folder Sent Items) for a message with an attachment, sent on or after the PDF date minus one day, to the job's GC email (or any non-@gec2.com address if none is set). The earliest match wins. Apply sets the CO to 2 Submitted & Pending with the sent date, adds a feed line, and moves the folder to `2 SUBMITTED`. Needs the Outlook search permission the app asks for.

## Reference numbers fill in automatically
- RFI, PCI, FWO, PCO, COP, or a design directive (CCD, DCD, DCN, ASI) in the folder: put its number in the Reference numbers without being asked. RFI -> RFI # box; PCI/FWO/PCO/COP -> GC Tracking with the matching label; CCD/DCD/DCN/ASI -> Design change with the matching label.
- Read the number from the file name first, then the document. Drop leading zeros.
- Only fill empty boxes or add a second number (41, 42). Never overwrite a typed number; never change a locked CO. Only the CO's own folder drives these. Say which were filled, in one line.

## Viewing documents
Every document has a View button. Dropped files open as the real PDF. OneDrive files show the text the connector extracts, page by page (the M365 connector returns text only for PDF and xlsx, never the file bytes), with Open in OneDrive (OneDrive's own link from search, folder-path link as fallback), Copy link, and Attach a copy to view here (the PM picks the file once; the app stores a copy and shows the real PDF inline from then on). If the stored path no longer matches, the app searches the CO folder and offers a pick list.

## Backup files: Read & fill in, Add to documents, Dismiss
- Each file Find backup lists has three actions: Read & fill in, Add to documents, Dismiss. Dismiss hides a file the PM does not want on that change order, and Dismiss all hides every listed file not yet on the documents list. It is saved on the CO (`dismissed`), listed under a collapsed Dismissed (n) with Restore and Restore all, and skipped by Read all and by the all-jobs Find backup count. Never re-add a dismissed file.
- A subcontractor quote read for a company that is not on the Subs & Consultants master list adds that company to the list (`company/catalog/subs`), typed from the folder it sits in (SUBCONTRACTORS, CONSULTANTS or PROFESSIONAL SERVICES), so it becomes a Company choice across the whole app. A company already on the list (any spelling or case) is never added twice.
- McCormick estimates that exist as both a PDF and an Excel file in the same CO folder are read together and compared: identical means counted ONCE (hours and material never duplicated); a mismatch is flagged to the PM.

## Scanned tickets and photos: read them, never skip them
A scanned PDF (no text layer, for example a CamScanner file) or a photo (jpg, jpeg, png, heic) in a CO folder is usually a daily time voucher or T&M ticket, and it carries the hours and material for the change order. The app and the M365 connector cannot read pictures (text only, no OCR, no bytes), so the app reports "no text". That is NOT a reason to skip it. In a Claude chat session, whenever a CO folder is scanned or a pull-documents, build-pdf or read-scan request is processed:
1. If a PDF returns no text, or a file is an image, stage that file from the PM's computer (device bridge) and look at it (render the PDF pages to images and view them).
2. Read it as the T&M ticket it is: ticket date or week ending, company, job number on the ticket (a mismatch is fine on the test job G9999), description of work, each worker with class (F, JW, AP, GF) and straight, overtime and double-time hours per day, daily and weekly totals, class totals, approver, and the material list if any. Check the day totals add up to the weekly total. A voucher from a subcontractor (for example R.J. & J. Construction) is a sub's billing, not GEC2 hours: it goes on the Subcontractors step with the sub's own total, and the company is added to the master list.
3. Report what was read in chat, and fill it into the change order the same way a typed T&M would (hours into the class/shift grid, material into material lines, description into the description of work) only after the PM checks it, exactly like Read & fill in. Never silently add or double count hours already on the CO.
4. Say plainly when a mark (for example a Material Y/N box) or a handwritten reference number is not clear or does not match another document, rather than guessing.
5. If the file is not in a folder the device bridge can reach, ask the PM to attach it instead of leaving it unread.

## When the app wakes Claude (instant wake-up line)
A queued request in the app fires the standing task `trig_01CjFckLQPwAsw4k7EivieDb` (Claude Code Remote `fire_trigger`, no `text` argument, retried once on a transient error). It reaches this chat only while the session is open; otherwise the request stays queued and the app shows a Nudge Claude button. The notification says "Job Control app wake-up" and does not name requests: read the queued requests in `data/users/me` (kind request, status queued) and process the ones just created, set `working` then `done` or `error`. Skip `cancelled` (the PM may cancel right after clicking, so always re-read before building). Never send the GC email without the PM's OK in chat.

Build-pdf request: stage the CO's backup from the user's computer, render the CO form (`coPrintHTML` via Playwright, footer "GECTWO Inc. · COR-001 · Page X of Y · Last printed"), merge in the package order (end sheet, Reference, Material sheets, Vendor quotes, Subcontractor/consultant/professional services quotes, Other backup), name it with the request's `fileName`, and save it in the CO's own folder in `1 PENDING` (the ready `CO ###` folder from `04 CHANGE ORDERS` is renamed to `CO ### - title` and moved there) with the backup copied (not moved) into its subfolders. Then: delete any other loose `CO ###` folder holding the backup at the root of 04 CHANGE ORDERS after verifying every file was copied with the same size (recycle bin, 93 days), and create the next CO number's empty ready folder directly in `04 CHANGE ORDERS` (not in `1 PENDING`) from `_CO FOLDER TEMPLATE (DUPLICATE ME)`. Flag stale text on the form (for example a placeholder Description of Work) to the PM instead of silently changing it. A rebuild of a CO that was already sent gets a version suffix and is flagged to the PM, since the sent file would differ.

## CO LOG PDFs (request group `log`)
There is one log PDF: the detailed log (`pdfKind: detlog`). The PM is asked which change orders to show, and the request carries `logShow`: `all`, `open` (open amount above zero), `lapsed` (open and more than 30 working days since submitted) or `approved`, plus `logShowLabel`. Build it with `buildlog.py detlog <out.pdf> <logShow>` (the TOTALS bar and count cover the shown rows; the CONTRACT TOTAL and REVISED TOTAL bars always cover the whole job). Older requests with `log` or `summary` may still exist; build them as asked.
Create `01 COST CONTROL\04 CHANGE ORDERS\5. CO LOG` directly under CHANGE ORDERS (not inside a stage folder) if it does not exist, and file the PDF there under the request's `fileName`: `<job> <job name> CO LOG - Detailed <date>.pdf` for All, and `... CO LOG - Detailed - Open <date>.pdf`, `- Lapsed 30+ days`, `- Approved` for the others. If the name already exists, add a version suffix (v2, v3); never overwrite.
If the request has `emailGc: true`, after filing the PDF create an Outlook draft with `outlook_create_draft` to `gcEmail`, using `emailSubject` and `emailBody` (convert the plain text to simple HTML paragraphs). The draft tool cannot attach files, so say in the body or in chat that the PDF is in the 5. CO LOG folder and the PM attaches it. Then write on the request doc `draft: {status:'ready', to, subject, link: <webLink>}` with status `done`; the app shows the Email to the GC is ready banner at the top of the CO Log page. The PM reviews and sends it from Outlook, or says "send it" in chat. Never send before the PM's OK. Dollar amounts in a draft body must be written as `&#36;` (HTML entity): a pair of plain `$` signs made the connector silently drop the whole sentence. If `gcEmail` is empty, file the PDF only and say so. If a draft for the log already exists, update it instead of creating a second one.

## Delete requests (delete-co)
Only run a delete-co request after the PM confirms in chat (AskUserQuestion), and say what will be removed: the folder and the number of files in it. If the folder holds files, confirm even when the CO in the app is blank or untitled. If the CO folder is the empty ready folder, keep it. Deletes go to the OneDrive recycle bin (93 days). Afterwards restore the empty ready CO folder from `_CO FOLDER TEMPLATE (DUPLICATE ME)` directly in `04 CHANGE ORDERS`.

## The app cannot see that an email was sent
The wake-up line does not watch Outlook. The folder moves to `2 SUBMITTED` only when (a) the PM sets the status or submitted date in the app, which moves the folder right away, (b) the PM runs Check if sent and applies it, or (c) the PM tells Claude it was sent. The "watch for send" box on Review & PDF only flags the request. When the PM says a CO was sent: move the folder to `2 SUBMITTED`, set the CO to status 2 (Submitted & Pending) with today's date as submitted (read the job doc fresh, send whole `cos` and `feed` arrays with `if_version`, new `saveId`), add the open line to `5. PROJECTS/Zordon/_PENDING WORKBOOK UPDATES.txt`.