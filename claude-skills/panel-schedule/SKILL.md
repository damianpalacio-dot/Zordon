---
name: panel-schedule
description: Build or check electrical panel schedules and panel directories for a GEC2 job from E-sheets, single-lines or a load list, using the GEC2 panel schedule template.
metadata:
  title: Panel schedules & directories
  output_category: Drawing
---

# Panel schedules & panel directories

**Template:** `00 Cowork Claude/Panel Schedules/GEC2_PANEL_SCHEDULE.xlsm` (macros in `GEC2_PANEL_Module_v*.bas`, use the highest version). Work on a copy. Never change the template's layout, formulas or macros. If the job's inputs don't fit the template, stop and ask.

## Inputs

Panel schedule sheets (E-6xx), the single-line diagram, or a circuit/load list. Note the drawing revision you used.

## For each panel, capture

- Name, location, fed from (upstream panel and breaker), voltage / phase / wires, bus rating, MLO or main breaker size, AIC rating, mounting (surface or flush), enclosure (NEMA), and whether it's electronic-grade, TVSS/SPD or has a feed-through.
- Each circuit: number, description, breaker trip / poles, load in VA per phase, and wire / conduit if shown.
- Number circuits odd on the left and even on the right. Multi-pole breakers take consecutive positions on the same side. Mark spares and spaces as shown on the drawings; don't invent them.

## Checks (report every one you find; don't silently fix)

1. Phase balance: compare the VA on A/B/C. Flag the heaviest phase if it's more than 15% above the average.
2. Total connected load and demand vs bus rating and main / feeder breaker.
3. Breaker vs load: continuous loads at 125%; motors per their nameplate if given.
4. Ratings: AIC vs the short-circuit study or the drawings; 2/3-pole positions physically possible.
5. Drawing conflicts: panel schedule vs single-line vs plan (breaker sizes, fed-from, AIC, mounting). These often turn into RFIs or submittal comments.

## Outputs

1. The filled schedule workbook: one tab per panel, with a summary tab listing panels, loads, % of bus and every flag.
2. If asked, a typed **panel directory** PDF for each panel door, named like the existing `G3249 ... Panel Directory` files.
3. Save the job copy to the job's `03 CONSTRUCTION SET` folder, named per `Zordon/FILING.md`, e.g. `G3251_32ND ST - DWG - Panel Schedules LP-2A LP-4 (10.05.2026).xlsm`. Keep your working copy in `00 Cowork Claude/Panel Schedules/Current`, and move older versions to `Archive/` with a date.
4. List any flags that need an RFI or submittal comment in the job note.
