---
name: gec2-new-job-setup
description: Set up a brand-new GEC2 job folder in 5. PROJECTS from the standard job template, when given a job number and job name/description.
metadata:
  title: New job folder setup (older)
  source: GEC2 Job Control (Claude skills)
---

> Older version kept for reference. Where it differs, follow `gec2-job-folder-setup`.

# New GEC2 job folder setup

When given a new job number (e.g. `G3300`) and a short job name/description (e.g. `Lincoln MS Fire Alarm Upgrade`):

1. Duplicate `5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE` into `5. PROJECTS`, naming the copy `[JOB NUMBER] - [JOB NAME]` (matching the convention already used by jobs like G3212, G3249, G3063).
2. Check first that a folder for this job doesn't already exist (by job number or name) - don't create a duplicate.
3. Report back the new folder's location/link.

There are no tracking-log spreadsheets to fill in. Submittals, change orders, and billing/SOV are tracked in that job's own `GEC2_Job_Control_Workbook.xlsm`, not in this folder structure - this template only provides where the underlying documents get filed and organized.

See `5. PROJECTS/0. JOB TEMPLATE - DO NOT DELETE/README - JOB FOLDER TEMPLATE.txt` for the full folder structure and naming conventions. Keep this skill in sync with that README if the template changes.
