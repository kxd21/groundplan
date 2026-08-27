# UI ownership freeze (Phase 1)

Single homes for each capability. New UI must land in the owner — not a second surface.

| Capability | Owner | Launchers only (no stamp UI) |
|---|---|---|
| **Add / Place** | Place mode left rail (`InventoryPalette` / gear / on-plan) + optional thin category strip | Show Setup “Insert”, ObjectPalette → opens Place |
| **Seating** | `RoomPanel` seating overlay (planner + stamp-bank / table-grid mode); companion `seating` spine | Show Setup “Seating”, editor rail Seating |
| **Table stamp / number / chairs** | Seating stamp (grid) + Inspect → Properties (tables) | — |
| **Isolation / sections** | Inspect Solo + seating bank Solo | — |
| **Layout variants** | Seating → Save / Apply variant (kits + version snapshot) | Setup Apply kit |
| **Stage edit / stairs** | BuildStageDialog (rebuild) + Attach stairs | Setup Stage |
| **Custom multi-view** | Shape Editor Wizard (plan + FV/SV stubs / elevation authoring) · Inventory item Views | Inventory |
| **Hang / flown** | Setup Advanced → Hang plot · plan report Hang section · schedule AFF column | Inspect AFF |
| **Stage** | `BuildStageDialog` | Show Setup / editor rail Stage |
| **Inspector** | Inspect → Properties (type-aware sections) | Canvas Array HUD = shortcuts to same APIs |
| **Layers / underlay** | Inspect → Layers + `BackgroundLayerPanel` | Setup “Add site plan” opens import wizard |
| **Room layout / walls** | Rail **Room** primary = wall-edit overlay; secondary ▾ = exclusive `room-layout` workspace | Inspect → Room gate, Setup venue actions |
| **Draw / annotations** | Rail **Draw** workspace + Draw tools dock (shapes, text, cables, measure) | Compact rail Tools = Select / Edit points / Hand / Measure only |
| **View (Top / Front / Side)** | Workspace `planView` + PlanCanvas | Ribbon view switcher |

## Rules

1. Show Setup is orchestration (checklist + deep-links). It must not embed seating stamp forms or a second equipment browser.
2. Table/chair pickers for seating always use `filterSeatingAssets` (plan-view chairs/tables only).
3. In **Top** view, Place offers plan-view inventory only. Elevation (FV/SV) assets appear in Front/Side.
4. Collision feedback lives on place/move (`overlap.ts`), not a separate panel.
5. Prefer Inspector + canvas handles over new modals and floating cards.
6. Fill-room seating intent lives in the companion (`seating` spine). Update placed seating must replace managed node ids after reopen — never stack a second layout.
7. **Draw dock scope**: Navigate + Draw + Systems + Measure only. No Place / Stage / Seating / Room launchers in the Draw dock.
8. **Tools stay panels**: Annotation tools (measure, shapes from Draw dock, edit points) must not force `enterMode('canvas')` when already in Draw or Inspect. Select (**V**) and Hand may leave Draw intentionally.
9. **Esc unwind** (one layer per press): cancel in-progress gesture / put tool to Select → workspace escape (overlay → leave room → leave mode) → clear selection.
10. **Arrange + wall edit**: Arrange strip stays visible with a selection during wall edit; wall gestures sit as a compact adjacent chip (not an exclusive ribbon replacement).
