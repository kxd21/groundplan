# Agent command playbook

Groundplan exposes stable action IDs shared by the ⌘K palette, native menus, status bar, and automation.

## API

```js
await window.groundplan.commandsList()
await window.groundplan.commandsRun('mode.place')
```

From a machine with CDP on port 9222:

```bash
npm run test:commands -- mode.place
```

The status bar shows `status-mode` and `status-command` after each run.

## Common sequences

### New show from home

1. `plan.new` — room-first new plan dialog  
2. (user finishes room / kit in UI)  
3. `mode.setup` — show progress panel  
4. `stage.build` or apply a kit in Setup  
5. `seating.planner` — whole-floor seating  
6. `plan.print` — PDF

### Kit-first banquet / arena

1. `plan.new` — pick a sized room (Ballroom / Concert / …)  
2. `mode.setup`  
3. Apply kit in Setup (or `stage.build` + seating stamps)  
4. `mode.place` — add remaining gear  
5. `mode.inspect` — layer/property pass  
6. `plan.print` / `plan.export-svg`

### Stamp equipment

1. `mode.place` — equipment rail  
2. (arm an item in the UI, click the plan)  
3. `mode.inspect` — tweak selection properties

### Draw annotations

1. `mode.draw` — drawing dock  
2. `tool.text` / `tool.dimension` / `tool.measure`  
3. `view.fit` when done

### Room refine

1. `room.edit` — exclusive room layout workspace (resize / add-cut)  
2. or `room.walls` — wall push/curve/length **without** closing Place  
3. Place + walls can stay armed together; `Esc` / Done turns walls off  
4. `mode.none` — full canvas

### Mode strip tour (exclusive)

1. `mode.browse` — recent / folders rail  
2. `mode.place` — stamp surface  
3. `mode.inspect` — layers + properties  
4. `mode.setup` — show progress  
5. `mode.draw` — tool dock  
6. `mode.none` — hide side panels / full canvas

### Help / discovery

1. `palette.open` — ⌘K command palette  
2. `help.shortcuts` — cheat sheet (built from the command catalog)  
3. `settings.open` — Plan / App preferences

### File hygiene

- `plan.open` / `plan.open-folder` / `plan.save` / `plan.save-as`  
- `plan.export-dxf` / `plan.export-svg`  
- `workspace.plan` | `workspace.gear` | `workspace.inventory`

## Notes

- IDs are kebab-stable; treat renames as breaking.  
- Prefer `commandsRun` over clicking chrome when automating.  
- Native menus map through the same IDs (`MENU_TO_COMMAND` in `src/shell/command-ids.ts`).  
- Help → Keyboard shortcuts is generated from `COMMAND_CATALOG` (+ a few canvas extras).  
- `plan.new` with autosave quietly saves a dirty open plan first (avoids a blocking native discard sheet under CDP).  
- Open file/folder busy toasts release after 8s if a system dialog is still open, so the UI does not stay locked.

## CDP / E2E automation env

Start with `--remote-debugging-port=9222` and set:

| Variable | Purpose |
| --- | --- |
| `GROUNDPLAN_E2E=1` | Enable automation helpers |
| `GROUNDPLAN_E2E_SAVE_PATH` / `_DIR`+`_NAME` | Skip native Save for new plans |
| `GROUNDPLAN_E2E_IMPORT_PATH` | Gear **Import PDF** uses this path (no open sheet) |
| `GROUNDPLAN_E2E_GEAR_SAVE_PATH` | Gear Save As target (defaults beside the E2E plan as `*.gear.json`) |
| `GROUNDPLAN_E2E_GRANT_ROOT` | Extra folder where `openPath` / `gearImportPath` may grant without a dialog |
| `GROUNDPLAN_E2E_GRANT_PATHS` | Colon/newline list of explicit grantable files |
| `GROUNDPLAN_E2E_AUTO_DISCARD` | Default on in E2E — discard dirty docs without a sheet (`0` to disable) |

Pull sheet PDFs (LEMG **PULL SHEET** and classic **GEAR LIST**) both import via Gear → Import PDF.

## MCP: driving a plan file directly

`npm run mcp` (`tools/groundplan-mcp.ts`) is a stdio MCP server. It used to
expose four whole-file operations — validate a recipe, list kits, apply a
recipe, count the result — so an agent could generate a plan from scratch or
read a total, and nothing in between. It could not look at a plan, find the
projector, and move it four feet.

`tools/mcp-plan-tools.ts` adds a headless editing session on the same `Session`
the Electron main process uses, so an agent gets the app's capabilities without
a window open. Every save is gated on `verifyWritable`: an agent inherits the
byte-identity guarantee rather than routing around it.

| Tool | What it does |
| --- | --- |
| `describe_units` | The coordinate system. Logical units = tenths of an inch, 120/ft, +y is DOWN |
| `open_plan` | Open an `.rv4`; returns object count, layers, extent, and whether it is editable |
| `list_objects` | Every addressable object with id / name / layer / centre / size / angle; filter by `nameContains`, `layer`, `cls` |
| `describe_object` | One object in full, including bounds and raw labels |
| `move_objects` / `rotate_objects` / `flip_objects` | Transforms by id |
| `resize_object` | Absolute width × height, scaled about the centre |
| `duplicate_objects` / `delete_objects` | Returns the new ids / the count removed |
| `set_object_text` | Rewrite a label's wording or an object's catalogue name |
| `plan_schedule` | Counted schedule grouped by catalogue name |
| `room_summary` | Walls, area, extent — and `source`/`closed`, so an extent-derived guess is not mistaken for a drawn room |
| `undo_edit` | Step back one edit in the session |
| `save_plan` | Write back; refuses if the document no longer reproduces |
| `list_commands` | Every stable UI command id, for driving a *running* app over CDP |

Two surfaces, deliberately: `list_commands` is for driving the live app through
`window.groundplan.commandsRun('<id>')` over CDP, and everything else works on a
file with no app running. `npm run test:mcp` walks a full round trip — open,
find by name, move, verify the coordinate changed, undo, verify it changed back,
save byte-identical.
