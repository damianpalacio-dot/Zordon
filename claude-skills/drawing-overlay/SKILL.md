---
name: drawing-overlay
description: Overlay two revisions of the same drawing sheets (bulletins, ASIs, IFC set changes, RFC sketches) to show exactly what changed, and list the changes with cost and schedule impact for CORs or RFIs.
metadata:
  title: Drawing overlay (revision compare)
  output_category: Design Change
---

# Drawing overlay — what changed between revisions

## Inputs

The old and new revision of each sheet (PDF), matched by sheet number. If the sheets don't pair up cleanly, list the unmatched ones and ask.

## Method

1. Render each pair at the same DPI (200–300) and page size.
2. Align them. Sheets are usually registered already; if the new sheet is shifted or scaled, align on the title block and border. Note the alignment you used.
3. Colour the old revision **red** and the new revision **blue**. Unchanged linework stays black or grey. Produce one overlay page per sheet.
4. Cloud each changed area and number the changes. Compare text too: panel schedules, notes, fixture and device tags, and conduit/wire callouts.

## Change list (the part Damian actually uses)

For each change: sheet, change #, area or gridlines, what changed (old → new), trade impact (Div 26 / 27 / 28) and a flag:

- 💲 **Potential COR**: added devices, upsized feeders or breakers, relocated gear, more conduit, new systems.
- ❓ **RFI needed**: conflicting or unclear changes.
- 📦 **Procurement impact**: gear or long-lead items already submitted or released.
- ✓ **No impact**: cosmetic.

## Output

1. An overlay PDF with all sheets, plus a cover page summarising the change count by flag.
2. The change list as a table (xlsx or in the PDF).
3. Save both to the job's `04 DESIGN CHANGES` per `Zordon/FILING.md`, e.g. `G2707_BURB RPT - DESIGN CHANGE - Overlay E2.01-E2.05 Bulletin 8 (10.05.2026).pdf`.
4. In the job note, give the number of potential CORs and RFIs and the biggest item.
