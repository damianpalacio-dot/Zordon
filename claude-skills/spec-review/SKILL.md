---
name: spec-review
description: Read Division 26, 27 and 28 specification sections (or any section) and pull out what matters to an electrical contractor - submittals, approved manufacturers, cost-driving requirements, testing, warranties and closeout - as a summary and a submittal register.
metadata:
  title: Spec review (Div 26/27/28)
  output_category: Specification
---

# Spec review — what the specs make us do

## Inputs

Spec sections (PDF), usually Div 26, 27 and 28, plus Div 01 (submittal procedures, closeout, substitutions). Note the spec issue or date.

## For each section, extract

- **Submittals:** product data, shop drawings, samples, calculations, coordination drawings, test reports, certifications, O&M, warranties, as-builts, training. Note any timing ("within 30 days of NTP").
- **Products:** basis of design, acceptable manufacturers, "or equal" vs no substitutions, Buy American / BABA, and the substitution request deadline.
- **Cost drivers:** copper only / no aluminium, minimum wire size, MC cable allowed or not, conduit types per area (EMT/RGC/PVC), seismic bracing, labelling and arc-flash labels, spare capacity, color coding, fire-rated assemblies, extra stock.
- **Testing and commissioning:** NETA acceptance testing, megger, torque, infrared scans, fire alarm and ERRCS acceptance, third-party commissioning.
- **Warranty and closeout:** warranty length and start, extended warranties, O&M format, training hours, attic stock.
- **Coordination:** work by others (pads, trenching, final connections to equipment), and conflicts with the drawings.

## Output

1. A **summary** per section: one screen, cost drivers first.
2. A **submittal register** (xlsx) with columns: spec section, title, submittal type, description, required by, manufacturer(s), lead-time risk, notes. It's ready to load into Procore.
3. **Conflicts and questions:** spec vs drawings, and anything that should become an RFI.
4. Save to the job's `05 SPECIFICATIONS` per `Zordon/FILING.md`, e.g. `G3251_32ND ST - SPEC - Div 26 Review and Submittal Register (10.05.2026).xlsx`.
5. In the job note, list long-lead items and any "no substitution" products. Zordon tracks these on the RFIs & Submittals page.
