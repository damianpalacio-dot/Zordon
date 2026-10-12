---
name: gec2-co-status-update
description: Create and track Change Order folders for a GEC2 job - numbering, naming, and moving the CO's folder between status stages as it's submitted, approved, or rejected.
metadata:
  title: Change orders: folders & status (older)
  source: GEC2 Job Control (Claude skills)
  output_category: COR
---

> Older version kept for reference. Where it differs, follow `co-update`.

# GEC2 Change Order folders

Each job's `01 COST CONTROL/04 CHANGE ORDERS` has four status-stage folders: `1 PENDING (not yet submitted to GC)`, `2 SUBMITTED (awaiting GC-owner approval)`, `3 APPROVED`, `4 REJECTED-VOID`. There is no change-order log spreadsheet - the job's own `GEC2_Job_Control_Workbook.xlsm` is the source of truth for CO value/status; this skill only manages the CO's paperwork folder.

## New CO

1. Find the next CO number for that job: list every existing "CO 0XX - ..." folder across all four stage folders and take the next sequential number (01, 02, 03... zero-padded to 2 digits). This number is permanent once assigned - never reused or renumbered later. If the GC assigns their own PCO number later, add it in parentheses rather than renumbering: `CO 03 (GC PCO-012) - Additional Lighting Circuits`.
2. Duplicate `_CO FOLDER TEMPLATE (DUPLICATE ME)` (inside `1 PENDING`) and rename the copy `CO 0XX - [short description]`.
3. File backup inside its four subfolders, with every filename prefixed with the CO number: `CO 0X - Pricing Backup - [vendor/description].pdf`, `CO 0X - RFI ## Reference.pdf`, `CO 0X - T&M Tag - YYYY-MM-DD.pdf`, `CO 0X - Signed CO.pdf`. The CO proposal document actually sent to the GC also carries the job number, since it leaves the company entirely: `CO 0X - [Job#] - [short description].pdf`.

## Status change

Move the whole CO folder (not its contents individually) to the matching stage folder as its status changes:
- Pending -> `1 PENDING (not yet submitted to GC)`
- Submitted -> `2 SUBMITTED (awaiting GC-owner approval)`
- Approved -> `3 APPROVED`
- Rejected/void -> `4 REJECTED-VOID`

Then flag that the job's real Job Control Workbook still needs updating: add a line to `5. PROJECTS/_PENDING WORKBOOK UPDATES.txt` (format is documented at the top of that file). Don't try to open or edit the `.xlsm` workbook itself - it's a macro-enabled file and editing it directly is unsafe/unsupported; the text file is the reminder bridge until someone updates the real workbook by hand.
