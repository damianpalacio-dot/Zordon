---
name: gec2-sub-quote-po-filing
description: File a sub/consultant's quote, an LOI/NTP sent to them, or an issued PO/subcontract, into that job's Purchase Orders folder with the right naming.
metadata:
  title: Sub quotes, LOI/NTP & PO filing
  source: GEC2 Job Control (Claude skills)
  output_category: Procurement
---

# GEC2 sub/consultant quote, LOI-NTP & PO filing

Built per sub, per job, under `06 PURCHASE ORDERS`, created on demand - not pre-built:

```
06 PURCHASE ORDERS/
    [SUB OR CONSULTANT NAME]/
        QUOTES/
        LOI-NTP/
        PURCHASE ORDER/
```

Identify the job from the document's own content (job name/address/description), not just whatever job was mentioned most recently - confirm if it's ambiguous. Use the sub/consultant's name as it appears on the document, not an abbreviation.

- **Quote received** -> file into that sub's `QUOTES/`, named `Quote - [Sub Name] - [Job#] - YYYY-MM-DD.pdf`.
- **LOI/NTP sent** (before a PO exists yet) -> file into that sub's `LOI-NTP/`, named `LOI - [Sub Name] - [Job#].pdf` (or `NTP - [Sub Name] - [Job#].pdf`).
- **PO/subcontract issued** -> file a copy into that sub's `PURCHASE ORDER/`, named `PO [#####] - [Sub Name] - [Job#].pdf`, using the PO number exactly as issued (no reformatting/padding). Then rename the matching LOI/NTP file in `LOI-NTP/` (if one exists for that sub) to tag on the same PO number: `LOI - [Sub Name] - [Job#] - PO [#####].pdf`. That renamed filename is the visual signal that a PO has already been issued for that sub - an un-renamed LOI/NTP means it hasn't been yet. Not every sub gets an LOI/NTP, so skip the rename if there isn't one.

Everything is filed and named as a "PO" regardless of whether it's a materials vendor or a labor subcontractor - there's no separate subcontract numbering scheme. Dates in any filename are always YYYY-MM-DD.
