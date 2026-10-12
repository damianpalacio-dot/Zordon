---
name: gec2-job-folder-setup
description: "Use when Damian gives a job number and job name/description and asks to set up a new job (e.g. \"new job G3300 - Lincoln MS Fire Alarm Upgrade\"). Duplicates the master job template, which already carries CO 001 ready for the first change order, and renames the Job Control Workbook with the new job number."
metadata:
  title: New job folder setup
  source: GEC2 Job Control (Claude skills)
---

# GEC2 New Job Folder Setup

When Damian says he has a new job, he gives (or ask for, if missing):

- **Job number** (e.g. `G3300`)
- **Job name / description** (e.g. `Lincoln MS Fire Alarm Upgrade`)

The target folder name is always `"[JOB NUMBER] - [JOB NAME]"`, matching jobs like `G3212`, `G3249`, `G3063` in `5. PROJECTS`.

## Steps

1. **Confirm the Microsoft 365 connector is available** (tools named `mcp__Microsoft_365__*`; load via ToolSearch if deferred). If not connected, tell Damian and stop.

2. **Find the master template folder.** `sharepoint_folder_search` with `name: "JOB TEMPLATE"`. It is named `_00 JOB TEMPLATE - DO NOT DELETE` (older notes call it `0. JOB TEMPLATE`) and lives directly inside `5. PROJECTS`. Note its `driveId` and `id`. If it is not found, tell Damian the template seems missing or renamed and stop.

3. **Find the destination parent.** `sharepoint_folder_search` for `"5. PROJECTS"` (or `"PROJECTS"`, picking the entry whose `webUrl` ends exactly in `.../Documents/5. PROJECTS`). That id is the `destinationParentItemId`.

4. **Check for a naming collision.** Search the exact job number first. If a folder exists, tell Damian and ask instead of overwriting or duplicating.

5. **Copy the template** with `sharepoint_copy_item` (`newName` = `"[JOB NUMBER] - [JOB NAME]"`). Graph copies asynchronously; if the tool reports it is still running, that is normal - do not retry, and re-check with a folder search later.

6. **Rename the Job Control Workbook.** In the new job's `01 COST CONTROL`, rename the generic `GEC2_Job Control Workbook.xlsm` to `"[JOB NUMBER]_GEC2_Job Control Workbook.xlsm"` with `sharepoint_rename_item`. Do not edit the workbook's contents (the connector cannot safely rewrite .xlsm).

7. **Check the first CO folder.** `01 COST CONTROL/04 CHANGE ORDERS/` must contain `CO 001` sitting directly in it (empty, with its subfolders; NOT inside a stage folder), a `5. CO LOG` folder (create it if missing), and `1 PENDING (not yet submitted to GC)/` must contain `_CO FOLDER TEMPLATE (DUPLICATE ME)`. If `CO 001` is missing (an older template copy), create it by copying `_CO FOLDER TEMPLATE (DUPLICATE ME)` into `04 CHANGE ORDERS` with `newName: "CO 001"`.

8. **Report back** with the new folder's name and link, and that the workbook was renamed and `CO 001` is ready. Mention anything that collided or looked off.

## Reference: what is inside the template (keep in sync if the structure changes)

```
_00 JOB TEMPLATE - DO NOT DELETE/
├── README - JOB FOLDER TEMPLATE.txt
├── 01 COST CONTROL/
│   ├── GEC2_Job Control Workbook.xlsm   (generic - renamed per step 6)
│   ├── 01 ORIGINAL ESTIMATE/
│   ├── 02 CONTRACT DOCUMENTS/
│   ├── 03 BUDGET/
│   ├── 04 CHANGE ORDERS/
│   │   ├── CO 001/                      <- ready for the job's first change order (sits here, not in a stage folder)
│   │   │   ├── 01 ESTIMATE - LABOR & MATERIAL/   (McCormick estimate only)
│   │   │   ├── 02 RFP-RFI REFERENCE/
│   │   │   ├── 03 T&M TAGS/
│   │   │   ├── 04 APPROVED CO DOCUMENTATION/
│   │   │   └── 05 QUOTES/
│   │   │       ├── VENDORS/            (one folder per vendor)
│   │   │       ├── SUBCONTRACTORS/     (one folder per company)
│   │   │       ├── CONSULTANTS/
│   │   │       └── PROFESSIONAL SERVICES/
│   │   ├── 1 PENDING (not yet submitted to GC)/
│   │   │   └── _CO FOLDER TEMPLATE (DUPLICATE ME)/   (same subfolders as CO 001)
│   │   ├── 2 SUBMITTED (awaiting GC-owner approval)/
│   │   ├── 3 APPROVED/
│   │   ├── 4 REJECTED-VOID/
│   │   └── 5. CO LOG/                   <- CO log PDFs (summary / detailed), filed by the Job Control app
│   ├── 05 PAYMENT APPLICATIONS (MONTHLY BILLING)/
│   └── 06 PURCHASE ORDERS/   (built per sub as quotes come in; see gec2-sub-quote-po-filing)
├── 02 BIM/  03 CONSTRUCTION SET/  04 DESIGN CHANGES/  05 SPECIFICATIONS/  06 SCHEDULE/
├── 07 RFIS/  08 JOB SITE PHOTOS/  09 PROCUREMENT LOG/  10 CORRESPONDENCE/  11 CLOSEOUTS/
├── 12 TEMPLATES/ (BIM, GENERAL FORMS, SAFETY)
├── 13 SAFETY/
└── 14 SUBMITTALS/
```

The old CHANGE ORDER LOG / BILLING LOG / SUBMITTAL LOG placeholder files and the old `01 PRICING - BACKUP` folder no longer exist - do not recreate them.

Standing rule: the next CO number always has an empty ready folder directly in `04 CHANGE ORDERS` (see the `co-update` skill). A new job starts with `CO 001`; when CO 001 is filled it moves into `1 PENDING` and `CO 002` is created in `04 CHANGE ORDERS`, and so on.

If Damian asks to change the template itself, edit the real folders inside `_00 JOB TEMPLATE - DO NOT DELETE` in OneDrive (add new subfolders to BOTH `CO 001` and `_CO FOLDER TEMPLATE (DUPLICATE ME)`), and update this reference tree.