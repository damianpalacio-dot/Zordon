---
name: gec2-labor-rate-rules
description: "Use whenever pricing labor, reading Honor's IBEW rate sheets, or building change order labor and end-sheet rows - standing rate rules such as double time being the same on every shift."
metadata:
  title: Labor rate rules (IBEW)
  source: GEC2 Job Control (Claude skills)
---

# GEC2 labor rate rules (standing, from Damian)

- **Double time (DT) is the same rate on every shift.** 1st DT = 2nd DT = 3rd DT. Honor's rate sheets list only one DT column; use it for all three shifts. The Job Control app's rate tables show seven columns (1st ST, 1st OT, 1st DT, 2nd ST, 2nd OT, 3rd ST, 3rd OT) because of this. On the change order end sheet, the 2nd DT and 3rd DT rows carry the same rate as 1st DT.
- Each change order keeps the rates it was priced at. New rate sheets only apply to change orders created after they are loaded.
- Rate schedule tiers: Base (Honor's 0% sheet), 5%, 10%, 15% (markups on the 0% sheet), and OCIP/CCIP (Honor's separate OCIP sheet, never a markup on base).
- Rate sheets live in `OneDrive - gec2\5. PROJECTS\_02 LABOR RATES\`. Current sheets sit loose; older ones move to ARCHIVE when new rates are loaded.