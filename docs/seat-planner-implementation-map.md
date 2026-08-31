# Seat Planner / Room Layout — implementation map

Audit of the connected design system: UI → state → object model → geometry → persistence.

## Stack

```
Rail / Setup launchers
  → workspace.ts (mode + overlays: seating, room-layout, wall-edit)
  → App.tsx (selection, isolation, planView, table-ops inspector, collision)
  → RoomPanel.tsx (fill-room planner, stamp bank, spacing, variants)
  → RoomRefineWorkspace.tsx (exclusive room-layout dock)
  → preload IPC → main/index.ts → plan-model.ts
  → seating-plan.ts (solve) · seating-render.ts (draw) · table-ops.ts (stamp/redistribute)
  → companion-store.ts (.groundplan.json seating spine + banks)
  → overlap-check.ts (place/move collision)
```

## UI owners

| Surface | File | Role |
|---|---|---|
| Seating planner | `RoomPanel.tsx` | Fill room, stamp bank, spacing, layout variants, live preview |
| Room refine | `RoomRefineWorkspace.tsx` | Whole-room + wall edit workspace |
| Table ops | `App.tsx` inspector | Chairs/table, CTC spacing, auto-number |
| Add / Place | `AddPanel.tsx` | Unified inventory by category + plan-view filter |
| Stage | `BuildStageDialog.tsx` | Deck presets, stairs, multi-level |
| Views | `plan-view.ts`, `ElevationCanvas.tsx` | Top / front / side |
| Collision | `collision-ui.ts`, `overlap-check.ts` | Overlap prompts on place/move |
| Custom shapes | `ShapeEditorWizard.tsx` | Multi-view shape authoring |

## Object model

- **Plan nodes**: `RVShape`, `RVLabel` in `.rv4`
- **Parametric intent**: `CompanionSeating` spine + `seatingBanks` in companion
- **Table/chair sets**: individual shapes; `object-links` `group` pairs table↔chairs after redistribute/stamp
- **Sections (solver)**: wing splay in `seating-plan.ts` — not user-drawn zones yet
- **Stage**: `StageBuild` in companion; stairs via `stage-stairs` links

## Geometry engines

| Engine | File | Notes |
|---|---|---|
| Full-room solve | `seating-plan.ts` | Styles, clearances, claimSeat grid, optimum orientation |
| Stamp banks | `seating.ts` | Round / theatre / schoolroom click-to-place |
| Table grid | `table-ops.ts` | `stampTableGrid`, `redistributeChairsAroundTable`, `autoNumberTables` |
| Footprints | `place.ts` | `circleOutline` for round tables by name heuristic |
| Overlap | `overlap.ts`, `overlap-check.ts` | AABB; stack-on whitelist |
| Capacity estimate | `seating-capacity.ts` | Max layout vs requested (preview) |

## Implemented vs gaps (42-item spec)

| Area | Status |
|---|---|
| Top-down asset filtering | `filterSeatingAssets`, `filterItemsForPlanView` — enforce on all pickers |
| Front/side/top views | Ribbon + `ElevationCanvas` — silhouettes, not full AFF editing |
| Chair spacing / collision | Solver + overlap on place/move — category matrix partial |
| Capacity calculation | Live preview + `estimateLayoutCapacity` max estimate |
| Center-to-center spacing | Solver + inspector `spaceTables` |
| Table stamp | RoomPanel stamp + `stampTableGrid` — no drag-fill yet |
| Auto numbering | `autoNumberTables` + prefix/suffix |
| Edit chair count | `setTableSeats` + redistribute + group links |
| Circle table square outline | `place.ts` circle + circular selection frame when selected |
| Room sections / isolate | Solo by IDs only — named zones not yet |
| Air-wall tracks | `virtual` walls + union — no track layer |
| Terminology | RoomPanel plain labels + tooltips |
| Flicker | 180ms debounce; stale preview kept during re-solve |

## Recommended phase order

1. **Correctness** — assets, selection, preview stability, collision categories
2. **Workflows** — capacity estimate, table ops, stamp unification
3. **Spatial** — section zones, isolation, alignment guides
4. **Views & room** — elevation AFF, air-wall tracks, detail presets
5. **Shell** — Add consolidation, BUILD/EDIT/PLAN IA, performance at scale

See also `docs/ui-ownership.md` for UI ownership freeze.
