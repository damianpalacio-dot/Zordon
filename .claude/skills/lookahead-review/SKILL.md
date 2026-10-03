---
name: lookahead-review
description: Review a project's 3-week look-ahead against the baseline schedule and the equipment release log in Zordon, then produce a short action list (slips, crews and inspections to confirm, equipment to release, submittals blocking releases). Use when asked to review the look-ahead, check the schedule against the baseline, or check equipment releases.
---

# 3-week look-ahead vs baseline review

Zordon runs at `http://localhost:4000` by default (`ZORDON_URL` overrides it). If `ZORDON_API_TOKEN` is set, send it as `Authorization: Bearer <token>`.

## Gather

1. `GET /api/projects` and pick the project (ask if more than one is active and none was named).
2. `GET /api/schedule/lookahead?project_id=<id>&weeks=3`: activities in the window with `start_variance` / `finish_variance` (days vs baseline), `flag`, plus `pushed_out` (promised by the baseline in this window but moved out) and `behind`.
3. `GET /api/equipment?project_id=<id>`: each item has `need_by`, `lead_time_weeks`, `release_by`, `state` and the linked submittal status.
4. `GET /api/items?project_id=<id>&open=1`: open RFIs and submittals.

If the schedule has no baseline (`stats.has_baseline` is false), say so and ask for a baseline CSV export to import (`POST /api/schedule/import?project_id=<id>&mode=baseline`, body is the CSV).

## Review

Report, in this order and briefly:

1. **Slipping work**: every activity with `finish_variance > 0`, worst first. For each, name the likely driver when the data shows one (open RFI or submittal on the same trade or spec, late predecessor, equipment not released).
2. **Pushed out of the window**: `pushed_out` items. These are commitments the baseline made that the update quietly moved.
3. **Confirm this week**: crews, inspections and deliveries that start within 7 days.
4. **Equipment releases**: `release_overdue` first, then `blocked_by_submittal`, then `release_soon`. Give the release-by date and what is needed (approval, release letter to vendor, a revised lead time).
5. **Actions**: at most 8, each with an owner and a date.

## Follow-through (only when the user says so)

Create the actions as tasks: `POST /api/tasks` with `{ "title", "project_id", "owner_id", "due_date", "priority", "source": "routine" }`. Don't create tasks on your own initiative.
