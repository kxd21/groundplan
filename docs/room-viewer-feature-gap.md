# What Room Viewer does that Groundplan does not

Compiled 2026-07-30 from screenshots of the original application. Everything
below is read off those screens — no guessing at features that were not visible.

The point of this document is that the capability audit was written against the
*file format*, and answered "what can the format hold?". It never asked "what
did the application do?". These are not the same list, and this one is longer.

**Legend** — ✅ built · 🟡 partly built, engine only · ❌ missing

---

## 1. Event Room Data — the dialog the whole app turns on

One modal, four tabs. It is where a plan is actually specified, and Groundplan
has no equivalent: the same settings are scattered across a side panel with
different names, and several do not exist at all.

### Seating tab

| Field | State | Note |
| --- | --- | --- |
| Room Name | ❌ | No room naming in the UI |
| Dimensions L × W × **H** | 🟡 | Width and depth only. **Ceiling height is not enterable** |
| Seating Style (7 radio) | ✅ | 12 styles, superset |
| **Chair Type** — named catalogue (`Standard 18"x18"`) | ❌ | Groundplan lists whatever the plan already contains |
| **Table Type** — named catalogue (`Round 60"`, `6'x30"`) | ❌ | Same |
| **Chairs/Table** | 🟡 | In the engine; not in the UI |
| **Total Seats** readout | ✅ | Live preview |
| **Optimum Seating** | 🟡 | `solveOptimum` searches orientation and stagger. Engine only |
| **Crescent Seating** | 🟡 | A separate style, not a modifier that applies to banquet |

### Spacing tab

| Field | State |
| --- | --- |
| Aisle — Center | ✅ |
| Aisle — **Side** | ✅ |
| Aisle — **Wing** | ✅ |
| Aisle — **Horizontal** + **# Rows Between** | 🟡 `rowsPerBlock` exists, no separate horizontal width |
| **Front** clearance | ✅ |
| **Rear** clearance | ✅ |
| **Front Wall** | ✅ |
| **Layout faces: Short Wall / Long Wall** | 🟡 | In the engine (`orientation`); not yet in the UI |
| **Center to Center Distance** | 🟡 Row spacing, differently expressed |

### Design Options tab

| Field | State |
| --- | --- |
| Theater/Schoolroom — **Chevron** on/off + **Angle** | ✅ `splay` |
| Theater/Schoolroom — **Sections** | 🟡 Engine only |
| **# Tables/Center**, **# Tables/Wing** | 🟡 Engine only |
| Banquet — **Stagger** as a *mode* dropdown | 🟡 `none`/`half`; the other entries were not legible |
| Banquet — **# End Chairs** | ❌ |
| Banquet — **Rotate 90°** | ❌ |
| U-Shape/Conference — **Chairs on both sides of U** | 🟡 Field exists; solver does not read it yet |
| U-Shape/Conference — **# Tables Across** | 🟡 Field exists; solver does not read it yet |

### A/V tab

Not captured in the screenshots. Unknown contents — do not assume.

---

## 2. Shape Editor Wizard

A guided three-page editor for defining a shape. Groundplan can *synthesize* a
shape (`createShape`) and *describe* one (`ItemSpec`) but has no wizard, and is
missing several of the properties outright.

### Page 1 — Name

| Field | State |
| --- | --- |
| Category tree: Screens, Additional A/V, Chairs, Dance Floors, Miscellaneous, Risers, Room Features, Tables | ✅ `ShapeCategory`, the same eight |
| Category Type | ❌ |
| Name | ✅ |
| **Spanish Name** — used on Spanish reports | 🟡 On the spec; reports are not translated yet |
| **Category Maintenance** | ❌ |

### Page 2 — General

| Field | State |
| --- | --- |
| **How tall is this shape?** | ✅ `height` |
| **Resizeable** (and: polygons/coloured shapes cannot be) | 🟡 Flag exists; not enforced by the resize tool |
| **Obstacle** — "Room Viewer will automatically set color around this shape" | ✅ `obstacle` + `clearance`; the seating solver keeps off it |
| Line of Sight — **obstructs the view** (column, planter, stand) | ✅ `obstruction` |
| Line of Sight — **is the thing the audience is trying to see** (screen, stage, podium) | ✅ `sightTarget`; `screensFromItems` finds them |
| Elevation — **placed on the ceiling** (chandelier) | 🟡 `ceilingMounted` on the spec; nothing consumes it yet |
| Elevation — **how far down from the ceiling it hangs** | 🟡 `dropFromCeiling` on the spec; needs the room's ceiling height to resolve |

### Page 3 — Specific (per category; Table shown)

| Field | State |
| --- | --- |
| **Valid seating styles this table may be auto-placed in** (6 checkboxes) | 🟡 `validStyles` on the spec; solver does not filter on it yet |
| **Table Type: Other / Round / Rectangular** | 🟡 `tableKind` on the spec |
| **Allow Chairs** | 🟡 `allowChairs` on the spec |
| **Default number of chairs for this table** | 🟡 `seats` on the spec |

---

## 3. Insert — the A/V catalogue

A deep menu of real, named products, and **the same item in several views**:

```
Additional A/V ▸ Front Views / Rear Views / Side Views / Audio /
                 Lighting / Other A/V / Scaffolding / Truss / Video
Projectors     ▸ …
Screens        ▸ …
Screen and Projector Combo…
```

Hundreds of entries — Fastfold at a dozen sizes each with/without dress kit and
with/without front leg, Risers 4'×12" through 8'×72", Tripod 4×4 to 8×8, Cradle
10'/12', Run Off Drape per screen size, plasma/monitor, piano grand and spinet,
podium, booths, I-beam, borderlight, amp rack, boom stand, carts at three sizes
with and without drape.

| Capability | State |
| --- | --- |
| A named product catalogue | 🟡 Inventory exists, but it is *this company's* stock, not a standard catalogue |
| **Front / Rear / Side view variants of one item** | ❌ | Groundplan has one symbol per item |
| **Screen and Projector Combo** — place the pair, already matched | ❌ | The pairing *maths* exists; placing them as a unit does not |
| Menu organised by discipline | 🟡 Categories exist; not this tree |

---

## 4. Drawing and editing tools

| Tool | State |
| --- | --- |
| Draw ▸ **Select** | ✅ Pointer button |
| Draw ▸ **Line** | ✅ |
| Draw ▸ **Rectangle** | ✅ |
| Draw ▸ **Ellipse** | ✅ 64-segment closed polyline |
| Text (A) | ✅ In the toolbar |
| Rotate CW / CCW | ✅ |
| Bring to front / Send to back | ✅ `reorderChild` |
| Duplicate / Delete | ✅ |
| **Cut / Copy / Paste** | ✅ | Internal plan clipboard; Copy / Paste on the toolbar |
| **Group / Ungroup** | ✅ | Sidecar links; grouped items move/rotate/duplicate/delete together |
| Fill, line style, line weight dropdowns | 🟡 Line colour only, in Properties |
| Zoom in / out / fit in the toolbar | 🟡 In the floating zoom control instead |
| Print preview | ✅ | Print popover shows paper fit before PDF |
| **Region** menu (whole top-level menu) | ❌ Contents not captured |
| Left icon palette — tables, chairs, drape, dance floor, projector, screens, misc | ❌ |

---

## 4b. The launcher's File menu

| Item | State |
| --- | --- |
| **New Event** | ✅ "New plan" — name, size, presets |
| **New Room** | ❌ A room document, distinct from an event |
| **New Shape** | ❌ Opens the Shape Editor Wizard |
| Open… + recent files | ✅ |
| **Category Maintenance…** | ❌ |
| **Library Maintenance…** | ❌ |
| Preferences… | ✅ Settings |
| Register Room Viewer… | n/a |
| **Shape Linker…** | ❌ |
| **Utilities…** | ❌ Contents not captured |

---

## 5. Dimensions and text

| Feature | State |
| --- | --- |
| Dimension **Length** entered numerically | ❌ |
| Dimension **Angle** entered numerically | ❌ |
| **Scale Drawing To Dimension** | ✅ | Inspector field on a selected dimension |
| **Font dialog** — face, style, size, colour, strikeout, underline | ❌ | Labels are synthesized with a borrowed or default font; nothing is choosable |
| Per-dimension font | ❌ |

---

## 6. Build A Stage

| Feature | State |
| --- | --- |
| Riser Type: **Riser 4'×8', 6'×8', 8'×4', 8'×6'** | ✅ Equivalent stock |
| Riser Type: **8' Circle** | ❌ |
| Riser Type: **Circular Stage Decks** | ❌ |
| Width / Depth in feet | ✅ |
| **Height from a stock dropdown** | 🟡 Free text; stock heights are known but not offered |
| **Multiple levels in one plan** (the reference plan has 8'×42'×32" *and* 8'×42'×24") | 🟡 The model supports levels; `simpleStage` only makes one |

---

## 7. Status bar

Room Viewer shows, continuously:

```
Chairs:102  Tables:17   Aisles: Center:0.00 Side:3.21 Wing:0.00
Front:8.00  Front Wall:0.00  Rear:45.20  Horz:0.00
```

Groundplan shows the file path and the zoom level. The live counts and the
resolved aisle values are not displayed anywhere.

---

## 8. Reporting

| Feature | State |
| --- | --- |
| Chair/table counts on the sheet ("2234 Chairs") | 🟡 In the report, not on the drawing |
| **Spanish reports** | ❌ |

---

## What to build first

Ordered by how much of the daily job each unblocks.

1. **Event Room Data dialog** — one modal, four tabs, replacing the scattered
   panel. Needs: room name, ceiling height, chair/table type catalogue,
   chairs-per-table, optimum and crescent seating, the five missing aisle
   fields, short/long wall orientation, and the seven missing design options.
2. **Shape Editor Wizard** — with the missing properties that other features
   depend on: line-of-sight *target*, ceiling-hung elevation, obstacle
   auto-clearance, table type and valid seating styles.
3. **Draw tools** — line, rectangle, ellipse. The synthesis layer is already
   there; this is canvas interaction only.
4. **Scale Drawing To Dimension** — small, and it is the tool that makes a
   traced plan trustworthy.
5. **Screen and Projector Combo** — the maths exists; place them as a pair.
6. **Status bar counts** — cheap, and constantly useful.
7. **A/V catalogue with view variants** — the largest data job; needs the real
   product list, which is not derivable from the screenshots.
