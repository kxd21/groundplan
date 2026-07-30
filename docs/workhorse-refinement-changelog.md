# Groundplan workhorse refinement

**Completed:** 2026-07-29  
**Release:** 1.0.1  
**Targets:** macOS and Windows desktop

## What changed

- Rebuilt the Plan workspace around predictable Recent, Folders, Browse, and
  Equipment sources so browsing a disk folder no longer hides recent plans.
- Added nested virtual plan folders for client, venue, quarter, year, or custom
  organization. Users can create subfolders, rename/remove folders, add several
  plans at once or file the open plan, and remove a reference without moving or
  deleting the source file. One plan may appear in several folders, and missing
  originals remain visible with a clear warning.
- Made navigation fluid and drafting-safe: trackpad scroll pans, pinch or
  modifier-wheel zooms, Hand and held Space override every drawing tool, and
  middle/right/Alt drag also pan.
- Added professional selection and edit behavior: filled-shape hit testing,
  crossing/containing marquee selection, duplicate-and-select, alignment,
  distribution, rotation, mirroring, sizing, recoloring, labels, seating, and
  object-linked persistent dimensions.
- Clearly separated temporary Measure from saved Dimension. Unsupported
  annotation tools are disabled per plan instead of failing after the click.
- Added persistent associative dimension metadata. Attached endpoints follow
  moved/rotated objects, deleted endpoints remain fixed rather than attaching
  to a similar nearby object, and bindings participate in Undo/Redo.
- Scoped Save, Undo/Redo, tools, exports, titles, status, shortcuts, and native
  menu commands to the visible Plan or Gear workspace.
- Added safe Save/Save As behavior, external-file conflict detection for plans
  and gear lists, atomic replacement, last-good backups, and snapshot-aware
  saves so an edit made during disk I/O remains visibly unsaved.
- Added crash recovery for dirty plans and gear lists. Recovery records retain
  the exact source revision, so restored work cannot overwrite a newer external
  file without a conflict.
- Added durable UUID identities and validated, reversible edits for Gear and
  the Equipment Library, including persistent Undo notices.
- Added versioned migrations, corrupt-file quarantine, rotating backups,
  content-addressed managed symbols, and distinct import/job provenance.
- Added a local Show manifest linking the exact saved plan and gear list, plus
  revision-aware reconciliation that invalidates stale comparisons.
- Replaced unstable schedule position keys with durable metadata identities
  that follow safe moves and survive Save As.
- Added cancellable Equipment Library harvesting with live progress, periodic
  durable checkpoints, and close protection until partial results are saved.
- Hardened the Electron boundary with sandboxing, navigation/webview blocking,
  sender and payload validation, granted filesystem paths, size limits,
  fail-closed confirmations, and consistent IPC error results.
- Added crash-safe recents, schedule, association, inventory, gear, SVG, CSV,
  and DXF persistence.
- Added responsive/narrow-window and keyboard/accessibility refinements.
- Added all eight legacy file associations and clarified that Electron is
  Groundplan's development runtime, not a second product.

## Verification

- Hermetic plan/session/recovery/show/schedule/dimension/folder suite: **78/78**
- Gear and Equipment Library durability suite: **33/33**
- Editable fixture sweep: move, delete, duplicate, and relabel all pass
- TypeScript typecheck, production build, release audit, packaged-ASAR and
  executable smoke checks pass
- Native CI covers Ubuntu tests plus macOS and Windows packaging/launch checks
- Isolated macOS interaction testing covered navigation, workspace scoping,
  recovery, responsive panels, annotation capabilities, and large-scan cancel

## Distribution boundary

Groundplan is a local professional desktop editor. The broad brief's proposed
Sales, Finance, Crew, Client, authentication, tenant, and cloud database system
does not exist in this codebase and was not represented as completed. The
delivered local Show manifest is the safe operational spine for the current
product.

Release signing is the only external prerequisite: macOS builds are ad-hoc
signed and Windows builds are unsigned until Apple Developer ID and Windows
code-signing credentials are supplied.
