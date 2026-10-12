---
name: gec2-labor-rates-expiry
description: "Use when a new IBEW Local 11 Inside Wireman rate schedule PDF or Honor's labor-rates email arrives, or when updating labor rates in the GEC2 Job Control app."
metadata:
  title: Labor rates expiry date
  source: GEC2 Job Control (Claude skills)
---

# Labor rates: set the "Expire on" date from the rate schedule

Whenever Damian drops the IBEW Local 11 Inside Wireman Rate Schedule PDF in chat, or Honor's email carrying updated labor rates is processed (with or without the PDF attached), take the expiration date from the schedule and put it in the Job Control app's Labor Rates "Expire on" field for that rate set.

## Where the date comes from
- The PDF header reads "Rates effective <date> through <date>". The second date is the expire date.
- Page 1 also prints "Contract Expiration Date: <date>" (example: June 30, 2026). Use that same date.
- The effective date (example: January 26, 2026) is NOT the expire date. Never default to effective date + 1 year.
- If Honor's email has no PDF, use the expiration or "through" date stated in the email. If neither is given, ask Damian; do not guess.

## How to set it
- The app stores expiry dates in the artifact database document `company/rates`, field `expires`, a map of rate set id to ISO date, for example `{"2026-01":"2026-06-30"}`. The rate set id is the effective month (YYYY-MM) used in the app's RATESETS list.
- Read the doc first and write with `update` and `if_version` so the existing periods, queue and other expiry dates are kept.
- When a new rate set is added, set its expires entry at the same time. Do not leave it on the app's default.
- Tell Damian the date you set, in plain words.

## What the app does with it
- The Current rates card on Labor Rates has an editable "Expire on" date.
- Starting 30 days before the expire date (and after it passes) the app shows a blinking banner, a dot on the Labor Rates nav item, and a toast, reminding Damian to watch for Honor's email with new rates.

## Known data point
- IBEW Local 11 Inside Wireman rates effective 01/26/2026 expire 06/30/2026 (contract expiration June 30, 2026). Future bulletins are posted at laneca.org/documents.