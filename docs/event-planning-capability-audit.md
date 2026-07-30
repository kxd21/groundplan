# Groundplan → professional event-room planning: capability audit and plan

Audited 2026-07-29 against `/Users/princedavidthompson/Groundplan`.

**Verified** = read out of the file, cited. **Assumed** = judgement, flagged as such.

---

## 1. The finding that explains everything else

Groundplan cannot create anything. It can only **clone something that already exists in
the open file and rewrite parts of it**.

This is stated in the source, not inferred:

> "nothing is written from scratch: an existing label or dimension in the file is cloned
> and its text or endpoints rewritten, so the font block and the pen settings stay
> byte-valid." — `src/format/annotate.ts:9-12`

`placeGear()` works the same way: it finds a template shape in the document, duplicates it,
and moves the copy (`src/format/place.ts:232-245`). The seating generator is a loop around
`placeGear`, so it too can only place chairs the file already contains.

**Why it is like this.** The app's core safety property is that a `.rv4` file must
re-serialize to its original bytes before it is considered editable. That gate is what makes
saving trustworthy — it currently holds for 1,954 of 1,955 files in the corpus. But the MFC
archive format has no schema: object layouts existed only in the original C++ `Serialize()`
methods. Synthesizing a *new* object of a class the file does not already contain means
guessing a byte layout, and a wrong guess produces a file Room Viewer cannot open.

So the constraint is real and was the right call. It is also the direct cause of nearly every
gap in the brief:

| Missing capability | Why |
| --- | --- |
| Parametric room creation | Would require writing wall objects from nothing |
| Curved wall authoring | Would require writing `RVSegmentArc` from nothing |
| Stage builder | Would require writing deck/riser objects from nothing |
| New dimension types | Can only clone a dimension the file already has |
| Screen↔projector pairing | The format has nowhere to store a relationship |
| Seating that stays parametric | The format has nowhere to store the configuration |

Treating these as twelve separate features would be a mistake. They are one problem.

---

## 2. Existing capability map (verified)

**Solid, keep as-is**

| Area | State |
| --- | --- |
| Format read/write | 25 `RV*` classes; 1,954/1,955 byte-identical round-trip |
| Coordinate system | Tenths of an inch, `UNITS_PER_FOOT = 120`, consistent throughout |
| Canvas | Canvas2D, rulers, two-tier grid, hover, selection handles, marquee |
| Zoom / pan | Wheel + pinch + space-drag; verified working |
| Undo / redo | Snapshot-based, bounded at 100, `dirty` compares against last-saved bytes |
| Snapping | Grid + object alignment guides |
| Multi-select | Marquee and shift-click, with group move/rotate/duplicate/delete |
| Inventory | 701 items, categories, departments, search, persistent, migrating |
| Public catalog | Signed, versioned, delta updates, rollback, repair — genuinely complete |
| Symbol generation | 22 categories drawn from published dimensions |
| Image → outline tracer | Threshold, largest-region, boundary trace, RDP simplify |
| DXF export | Real blocks + inserts (25 blocks / 2,390 placements), layers, inches |
| Print to PDF | True architectural scales, verified 5.222″ measured vs 5.219″ expected |
| Self-update | Ed25519-signed, both platforms, verified end to end |
| Packaging | electron-builder — DMG+ZIP (arm64/x64), NSIS+portable, AppImage |

**Partial**

| Area | What exists | What is missing |
| --- | --- | --- |
| Seating | `round`, `theatre`, `schoolroom`; angled blocks | 9 of 12 layout types; all sections/wings/stagger/clearance logic; **configuration is discarded** |
| Dimensions | Create by cloning; `formatDistance` | Associativity, non-imperial units, radius/diameter/arc/angle |
| Layers | 5 fixed scene layers, visibility toggles | Technical systems, locking, reorder, per-layer export |
| Object model | Placed shapes with size/rotation | No definition-vs-instance split; no aspect ratio, elevation, obstruction |
| Reports | Item counts, schedule CSV | Stage build lists, shortages, allocation, revision history |

**Missing entirely** — no code exists

Room model · parametric room creation · wall entities · curve *authoring* · boolean geometry ·
area/perimeter/capacity · Event→Room→Version hierarchy · templates · stage builder ·
screen↔projector pairing · throw/lens math · line-of-sight analysis · aspect-ratio presets ·
inventory quantity tracking (owned/placed/remaining) · shortage warnings · custom shape editor ·
metric units · tooltips component · onboarding · installation docs

---

## 3. The two claims most worth knowing

**There is no room.** `Scene.roomExtent` is `{minX, minY, maxX, maxY}` — an axis-aligned
bounding box computed from wall primitives (`src/format/scene.ts:50-62`). There are no wall
entities, no area, no perimeter, no capacity. Every requirement in §4–5 of your brief
(irregular rooms, curves, composite boundaries, seating that respects real geometry) depends
on a model that does not exist yet.

**Seating is flattened on creation.** `SeatingKind = 'round' | 'theatre' | 'schoolroom'`
(`src/format/seating.ts:20`), and the file describes its own design: *"Every chair is a real
placed shape."* Once generated, 227 chairs are 227 unrelated objects. You cannot regenerate,
re-fit, lock a row, or change the chevron angle — the parameters are gone the moment the
loop ends.

---

## 4. Architecture — how to get everything without breaking a single file

You said keep all files compatible. That rules out replacing `.rv4`, and it does **not** rule
out the rest. The answer is a companion file.

```
Riverbend Hall.rv4                 ← untouched, byte-identical, opens in Room Viewer
Riverbend Hall.groundplan.json     ← room model, wall segments, curves, seating configs,
                                       stage configs, screen↔projector pairs, layers,
                                       inventory links, associative dimensions, versions
```

- `.rv4` remains canonical for **drawn geometry**. The round-trip gate stays exactly as it is.
- The companion holds **intent** — what the binary has nowhere to put.
- No companion file → behaves exactly as today. Nothing to migrate, nothing breaks.
- Precedent already in the codebase: `${planPath}.groundplan-data.json` (schedule fields).

**How it stays honest.** The companion stores a checksum of the `.rv4` it describes. If the
plan is edited elsewhere, Groundplan notices the mismatch and offers to re-derive rather than
trusting stale parameters. This is the one real weakness of the approach and it needs to be
built in from the start, not bolted on.

**What this unlocks.** A room becomes a first-class object with wall segments and curves,
living in the companion; its *rendered* walls still go into the `.rv4` as ordinary segments,
so legacy Room Viewer sees a normal room. Same for stages and seating: parametric in the
companion, drawn in the `.rv4`. Both readers get what they can use.

---

## 5. Phased plan

Each phase ships independently and is reversible. Phases 1–3 are foundation; nothing above
them works until they exist.

| # | Phase | Why here | Risk |
| --- | --- | --- | --- |
| 1 | Companion document + room model + units | Everything depends on it. Room, walls, area, perimeter, metric/imperial | med |
| 2 | Object synthesis in `.rv4` | Write new segments from scratch, guarded by the round-trip gate per write. **The key technical unlock** | **high** |
| 3 | Definition vs instance split | Library spec separate from placement; aspect ratio, elevation, obstruction | med |
| 4 | Room authoring | Parametric create, edit-after-the-fact, irregular boundaries, boolean ops | med |
| 5 | Curve authoring | Arcs, radius/arc-length entry, curve snapping. Reader already parses arcs | med |
| 6 | Associative dimensions | Attach to geometry, update on move, solid rendering audited on every path | low |
| 7 | Parametric seating | 12 layouts, sections/wings/stagger/clearances, locks, regeneration, non-rect rooms | med |
| 8 | Stage builder | Decks, risers, levels, stairs, build lists | low |
| 9 | AV + screen/projector pairing | Throw math, lens check, projection cone, sightlines | med |
| 10 | Inventory allocation | Owned/placed/remaining, shortages, conceptual items | low |
| 11 | Layers, reports, plan output | Technical systems, schedules, title block, legend | low |
| 12 | Custom shape editor, onboarding, tooltips, install docs | Includes your earlier outstanding request | low |

**Phase 2 is the crux.** If new objects can be written into `.rv4` safely, everything above it
is ordinary work. The mitigation is already proven: run `roundTrip()` after every synthesis
and refuse the write if it fails — the same gate that protects editing today, applied to
creation. I would build Phase 2 as a spike first and prove it against the 1,955-file corpus
before committing to the rest.

---

## Result, measured 2026-07-30

Phase 2 holds. Synthesis was run against every file in the corpus:

```
files scanned          1955
editable (round-trips) 1954
synthesis verified     1953   (99.9%)
refused                   1
```

Two corrections to the plan above, both found in the doing:

**`roundTrip()` cannot gate creation.** It asks whether a document still reproduces
the file it was read from, and a document with a new wall in it is deliberately not
that file — so it fails by design, on every successful synthesis. The working gate is
`verifyWritable()`: serialize, reparse, and require the reparse to round-trip byte for
byte, with a matching object census and no new warnings.

**The single refusal is a refusal, not a corruption.** In
`Augusta Room (Session 3)`, reading the written bytes back resolves one *more*
reference than the document held. The bytes are self-consistent — they round-trip —
but the object graph is not provably the intended one, so the write is declined.
Inserting at the top level of that plan rather than inside a group succeeds. No file
in the corpus was written incorrectly; one was not written at all.

The round-trip gate itself re-measured at 1,954/1,955, matching the figure above.

---

## 6. What I'd do first

Phase 2 spike, one file, one class: synthesize a single `RVSegmentLine` from scratch and prove
it round-trips across the corpus. That answers the only question that actually gates the
project. If it works, the plan holds. If it doesn't, the companion file carries more of the
load and legacy Room Viewer sees less — worth knowing in week one rather than month three.
