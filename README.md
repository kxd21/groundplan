# Groundplan

A cross-platform rebuild of the discontinued Windows-only event-diagramming tool
(last built 2013) that reads **and edits** the original plan files directly. It
runs on **Windows, macOS, and Linux** and needs no Windows VM.

The original editor is a 32-bit Win32 binary that cannot run on modern macOS at
all. This project replaces the application while keeping the data: the file
formats were reverse-engineered so existing plans open, edit and save unchanged.

*A "ground plan" is the standard term in theatre and live events for a scaled
overhead drawing of a venue — which is exactly what these files hold.*

## Download

**First-time install:** open the
[download page](https://kxd21.github.io/groundplan/download/) — it picks the
installer for your Mac, Windows, or Linux machine — or grab a file from
[Releases](https://github.com/kxd21/groundplan/releases/latest).

| Your machine | File |
| --- | --- |
| Mac, Apple silicon | `Groundplan-<version>-mac-arm64.dmg` |
| Mac, Intel | `Groundplan-<version>-mac-x64.dmg` |
| Windows 10 or 11 | `Groundplan-Setup-<version>-win-x64.exe` |
| Windows, no admin | `Groundplan-Portable-<version>-win-x64.exe` |
| Linux (x64) | `Groundplan-<version>-linux-x64.AppImage` |

Gatekeeper / SmartScreen will warn on first open (builds are not Apple-notarised
or Authenticode-signed yet). Right-click → Open on Mac, or More info → Run
anyway on Windows — once. Step-by-step:
[docs/installation.md](docs/installation.md).

Already installed? **Help → Check for Updates…**, or
**Help → Install Update from USB…** when the venue network is useless.

## What it reads

| Extension | Contents | Container |
| --- | --- | --- |
| `.rv4` | Event floor plans | OLE2 compound file |
| `.rs4` | Room definitions | OLE2 compound file |
| `.se4` | Single shapes | OLE2 compound file |
| `.ds4` | "Deep save" plans with embedded custom shapes | OLE2 compound file |
| `.rsd` | Room schematics | Raw MFC archive |
| `.add` `.stk` `.lib` | Shape libraries and catalogues | Counted MFC archive |
| `rvtss.mdb` | Stock-shape catalogue (categories, libraries) | Jet / Access, read-only |
| Gear list `.pdf` | Printed equipment list from the rental system | Text positions |
| `.gear.json` | Groundplan's working copy of a gear list | JSON |

Verified against the full 1,955-file corpus on the production drive: **0 files
fail to open**, every file yields geometry, 2.49 million objects decode, and
**99.7% parse with no diagnostics at all**.

## Three views

**Plan** — open, edit and save the original floor plans.
**Gear** — one job's equipment list, imported straight from the PDF your rental
system prints.
**Inventory** — the company's equipment library, which accumulates across jobs
and is what new plans get built from.

They meet at placement: a gear line becomes an object on the diagram, either as
the real catalogue shape (when the plan already contains one by that name) or as
a box sized from the description — `Intellistage 4' x 4' Stage Deck` lands as a
4ft square, `65" Samsung Standard TV` as a 65in one. Cables and jumpers are
deliberately left unsized rather than becoming room-sized boxes.

## Features

- Pan, zoom, zoom-to-fit, rulers in feet, two-tier grid and a scale bar
- A readable, independently scrollable recent-plan list with folder and
  last-opened context for long or duplicate filenames
- Nested virtual plan folders for organizing work by client, venue, quarter,
  year, or any combination. Plans stay at their original paths, can appear in
  more than one folder, and missing originals are clearly identified.
- Click to select, drag to move, arrow keys to nudge (a foot, or an inch with
  Shift), duplicate, delete, and edit label text
- Rotate by any angle, mirror horizontally or vertically, recolour linework,
  and resize by typing a size in feet
- Seating generator: rounds with N seats turned to face the table, plus theatre
  and classroom blocks that can be **angled** — Scott's arena plan flanks a
  straight centre bank with 227 chairs at +30° and 227 at −30°
- Create text labels (including multi-line) and dimension lines, which 98% and
  91% of the corpus carry and neither of which could be added before
- Measure between two points (`M`), read out in feet and inches
- Multi-select: shift-click, band-select by dragging empty space, `Cmd/Ctrl+A`;
  move, align, evenly distribute, rotate, mirror, recolour, duplicate and
  delete apply to the whole selection as one undoable step
- **Check the gear list against the plan** — what is drawn but not on the
  truck, what is listed but not drawn, and where the counts disagree
- Upload assets from existing plans and shape libraries — those arrive as the
  **real drawn symbol**, not a box
- Full undo/redo, a dirty indicator, and Save / Save As
- Layer toggles: walls, tables and equipment, regions, dimensions and labels
- Live inventory — every placed item counted, with its catalogue category
  resolved from `rvtss.mdb` when the installation is nearby
- A separate disk-folder browser with filtering, for working through a plans
  directory without mixing physical locations with organizational folders
- SVG export, so plans can go into decks, email, or a printer on any platform
- Gear lists imported from the rental system's PDF: departments, packages and
  every piece inside them, with hierarchy rebuilt from the printed layout
- Tick-off prep tracking, editable quantities and descriptions, and CSV export
- A persistent equipment library: import gear-list PDFs and CSVs, add items by
  hand, search and filter by department, and place any item on a plan
- Footprints you correct once are remembered and used for every later placement
- Damaged-file recovery: files whose compound-file header or FAT has decayed
  are repaired in memory and carved for whatever geometry survives

## Everyday controls

Groundplan follows the native modifier key on each platform: `Cmd` on macOS and
`Ctrl` on Windows.

| Action | Shortcut or gesture |
| --- | --- |
| Open / Save / Save As | `Cmd/Ctrl+O`, `Cmd/Ctrl+S`, `Cmd/Ctrl+Shift+S` |
| Hide plan browser / inspector | `Cmd/Ctrl+B`, `Cmd/Ctrl+Shift+B` |
| Pan / zoom | `H` toggles the Hand tool; hold `Space`, middle-drag, right-drag, or two-finger scroll to pan; pinch or `Cmd/Ctrl` + wheel to zoom |
| Fit the plan | `Cmd/Ctrl+0` |
| Select several items | Shift-click or drag a band across empty space |
| Nudge | Arrow keys for 1ft; Shift + arrow for 1in |
| Duplicate / delete | `Cmd/Ctrl+D`, Delete or Backspace |
| Rotate | `[` and `]` for 90°; type any angle in **Edit tools** |
| Align / mirror / recolour | Select one or more items, then use **Edit tools** |
| Toggle snapping | `S` |
| Measure / dimension | `M` measures temporarily, then **Save dimension** keeps it; `D` draws a saved dimension directly. Endpoints clicked on objects follow those objects. |
| Add a label | `T`, enter the text, then click **Place label** |
| Cancel the current tool | Escape |

## How editing stays safe

These are irreplaceable event plans, and the file format has fields this
project never identified. Three rules protect them:

1. **Only archive streams that reproduce themselves exactly can be saved.** On
   open, Groundplan re-serializes the legacy `Contents` stream and compares
   it byte for byte with what it read. A stream that does not match is opened
   read-only and says so.
   **1,954 of the 1,955 files pass**; the only one that does not has physically
   damaged sectors.
2. **Edits patch bytes, they do not regenerate them.** Moving a table rewrites
   its insertion point and leaves every other byte of that object untouched, so
   pen styles, fill patterns, seat counts and unidentified fields all survive.
3. **The original is backed up before it is overwritten**, and saves are
   written to a temporary file and renamed, so an interrupted save cannot leave
   a half-written plan.

Run `npm test` to exercise the parser, move/undo/redo, annotations, schedules,
inventory and gear persistence, edit sweep, save, and reopen pipeline against a
synthetic plan built from scratch. Production plans are never copied into CI.

## Running it

Requires [Node.js](https://nodejs.org) 22.12 or newer. Identical on both
platforms:

```bash
npm install
npm run dev
```

To open a plan straight from a terminal:

```bash
npx electron . "/path/to/plan.rv4"
```

### Groundplan and Electron

Groundplan is one application. Electron is the cross-platform runtime it is
built with, not a second edition of the product. A development run may be named
**Electron** in the Dock or Task Manager; packaged installers and their
executables are named **Groundplan**.

## Building installers

The native GitHub Actions matrix is the canonical release path. A configured
macOS workstation can also cross-build unsigned Windows artifacts when its
Wine/NSIS prerequisites are available:

```bash
npm run dist:all     # macOS .dmg/.zip (arm64 + x64) and Windows .exe (x64)
npm run dist:mac
npm run dist:win
```

Output lands in `release/`:

| Artifact | Platform |
| --- | --- |
| `Groundplan-1.0.1-mac-arm64.dmg` | macOS, Apple Silicon |
| `Groundplan-1.0.1-mac-x64.dmg` | macOS, Intel |
| `Groundplan-Setup-1.0.1-win-x64.exe` | Windows installer, x64 |
| `Groundplan-Portable-1.0.1-win-x64.exe` | Windows portable, x64 |

The workflow runs the corpus-independent test gate on Ubuntu, macOS, and
Windows, builds natively, inspects each packaged ASAR, launches the unpacked app
with isolated user data, and uploads the installers.

### Running it on another machine

Current macOS builds are **ad-hoc signed**, not Developer ID signed or
notarised. Current Windows builds are not Authenticode signed. They are suitable
for controlled internal testing, but they are not production distribution
artifacts: Gatekeeper or SmartScreen will warn on another machine. Production
release requires Developer ID signing/notarisation on macOS and Authenticode
signing on Windows. Do not train customers to bypass those protections.

Only one production copy of Groundplan runs at a time, so opening a second plan
hands it to the existing window instead of starting a competing writer.

## How the file formats work

The original editor persisted its documents with MFC's `CArchive`, which writes a tag
stream with no field metadata — the layouts lived only in the original C++
`Serialize()` methods. `src/format/` reconstructs them:

- **`mfc.ts`** — the `CArchive` tag stream: new-class tags carrying a schema and
  class name, class back-references (`0x8000 | index`), object back-references,
  and `CString` / `CRect` primitives. Classes and objects share one 1-based
  load array, which is why the second `RVSegmentLine` in a file reads as tag
  `0x8003`.
- **`rv.ts`** — the 25 `RV*` classes. Every object opens with `int32 version`
  plus a `CRect`. Containers then declare a child count; segments carry a
  pen/brush block and an array of points as pairs of doubles. Units are tenths
  of an inch, so an "8' Circle" is 958 units across.
- **`scene.ts`** — flattens the object graph into a draw list, resolving the two
  coordinate systems (see below).
- **`write.ts`** — serializes back. Object bodies are copied verbatim; only the
  tag stream is regenerated, because MFC resolves classes and shared objects
  through a load array built in read order, so inserting or removing one object
  renumbers every later reference.
- **`edit.ts`** — the operations, as byte patches at known offsets.
- **`catalog.ts`** — the Jet catalogue.
- **`place.ts`** — turning a gear line into an object on the plan. Placement
  never writes an object from scratch: it clones one already in the file and
  rewrites the fields it understands, so the pen and brush blocks stay valid.
- **`gear/reconcile.ts`** — comparing the list with the drawing. Cable,
  adapters and consumables are filtered out; without that, hundreds of "missing
  from the plan" rows bury the findings that matter.
- **`library/`** — the equipment library, stored in the app's user-data
  directory because it outlives any one job. Items dedupe by name; a size set by
  hand is marked `user` and is never overwritten by a guess on a later import.
- **`annotate.ts`** — creating labels and dimensions by cloning an existing one
  and rewriting its text or endpoints.
- **`symbol.ts`** — importing a shape from another file. An imported object has
  no bytes in the destination, so every node carries its own header *and*
  trailer across.
- **`seating.ts`** — rounds, theatre rows and classroom layouts. Chairs are
  placed then rotated to face the focus; a chair's stored outline faces up the
  page, so the turn needed is the bearing to the table plus a quarter.
- **`gear/import-pdf.ts`** — rebuilding a gear list from its printout. None of
  the hierarchy is stored as structure; it exists only as *x* positions, so a
  department heading is text at x≈15, a top-level line at x=138 and a package's
  contents at x=156. Headings repeat as "Audio Continued" across pages, and one
  PDF can hold several lists end to end.

Three details cost real effort and are worth knowing before changing anything:

1. **Placement comes from the insertion point, not the `CRect`.** The rect is a
   cached bounding box that goes stale when a table-and-chairs group is
   duplicated. One plan has 105 chairs with 105 distinct insertion points but
   only 20 distinct rects — trusting the rect stacks the room on itself.
2. **Repeated geometry is shared by back-reference.** Identical chairs are
   written once and referenced many times, so dropping back-references loses
   most of a plan. Some files also reference an object still being read — a
   parent pointer — which is ignored to avoid building a cycle.
3. **Arcs store a cubic Bézier in their last four points.** A circle is two of
   them, with controls at 4/3·r.

Point arrays are located by searching for the alignment that fits a whole
number of plausible coordinate pairs *and ends exactly on a valid tag*, because
the pen/brush block is not a fixed size — the same `RVSegmentRect` class starts
its points at +62 in a shape library and +70 inside a floor plan. Two subtler
traps are worth knowing:

- **Tags are not 2-byte aligned.** A length-prefixed string of odd length
  shifts everything after it, so scanning for the next tag must step one byte
  at a time. Stepping two silently skipped objects and swallowed them into the
  preceding segment.
- **A boundary landing on a class tag is strong evidence; a plain object
  reference is not**, being just a small integer. The parser prefers class-tag
  boundaries and falls back to ambiguous ones only when nothing else fits.
- **Every object opens with a version field of 1** — 296,883 of 296,889 in the
  corpus, the six exceptions being misparses. Checking it costs four bytes and
  settles the cases where two candidate alignments *both* end on a plausible
  class tag, which was the last thing keeping a large plan read-only.

Both were found by round-tripping the corpus: a file that does not reproduce
itself is a file the parser has misunderstood, which makes byte-identity a far
sharper test than "did it render".

## Development tools

```bash
npm test                                   # mandatory synthetic release gate
npm run test:corpus -- "/path/to/Data" 40  # optional private edit sweep
npm run check                              # typecheck + test + production build
npm run audit:release                      # production/Electron high + full critical
npm run scan -- "/path/to/Roomviewer"      # parse every file, report coverage
npm run roundtrip -- "/path/to/Roomviewer" # parse, re-serialize, compare bytes
npm run inspect -- "<file>" --tree         # object tree, warnings, hex window
npx tsx tools/coverage.ts "<file>"         # bytes no object accounts for
npx tsx tools/hidden.ts "<file>"           # objects buried inside another span
npx tsx tools/export-svg.ts <in> <out>     # render to SVG without the UI
npm run typecheck
```

`npm test` has no workstation-specific paths and exits nonzero when any edit
sweep check fails or when no editable plan was exercised. The optional corpus
sweep accepts an explicit directory or `GROUNDPLAN_CORPUS_DIR`; private
production plans remain outside the repository.

`npm run roundtrip` is the parser's real regression harness — the class layouts
were derived from the corpus, so a drop in its byte-identical count means a
layout assumption broke. Current baselines: **99.7% clean parse,
1,954/1,955 byte-identical, 0 failures.**

`npm run package:dir` builds an unpacked application in `release-smoke/`.
`npm run smoke:packaged -- release-smoke` verifies its executable, manifest,
main/preload/renderer payload, ASAR, and macOS identity/file associations. Add
`--launch` only in an isolated test session; CI uses it with a temporary
user-data directory.

The release audit blocks high-severity production dependency or packaged
Electron findings and critical findings anywhere in the build tree. Run full
`npm audit` during dependency maintenance as well: electron-builder still
carries upstream high-severity development-only transitive findings with no
stable, compatible zero-finding release at the time of this update.

## Limitations

- **No freehand drawing.** You can place gear, move, duplicate, delete and
  relabel, but not draw new walls or trace a room from scratch.
- **Synthesized gear is a labelled box**, not a real catalogue symbol. Gear that
  matches a shape already in the plan places the genuine article; everything
  else gets a rectangle, sized from the library if you have set a size and from
  the item's name otherwise.
- **Some legacy objects refuse transforms.** Rotation, mirroring, recolouring,
  and resizing work when the source object exposes a safely writable outline;
  Groundplan declines the operation when it cannot preserve the object.
- One physically damaged corpus file opens read-only.
- Text is drawn unrotated, and label font sizing is approximated rather than
  taken from the stored `LOGFONT` height.
- `.add` / `.stk` shape libraries open and their shapes decode, but they are
  catalogues rather than plans, so all entries share an origin.
- A physically damaged source file can open in recovery mode with partial
  geometry and is flagged in the UI.
