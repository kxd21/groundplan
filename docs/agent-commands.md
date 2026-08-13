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

1. `room.edit` — layout workspace  
2. or `room.walls` — wall push/curve/length  
3. `mode.none` — full canvas

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
