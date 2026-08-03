# Drafting quality audit — visual output vs. Room Viewer

Analysis only. **No implementation code was changed to produce this document.**

Every claim below is marked:

- **VERIFIED** — traced to specific code or measured from real data, with the evidence shown.
- **ASSUMED** — a reasonable inference that has *not* been proven, and which the
  implementation must confirm before relying on it.

Test subject: `Card Party 2 Tiered Stage Layout.rv4` (the plan in the reference
image), plus the 1,955-file corpus at `/Volumes/Prince/Roomviewer`.

---

## 0. The headline finding

The brief names three defects. Investigation found that **all three, plus several
more, are symptoms of one root cause**, and that one of the three is worse than
reported.

> **The scene model carries no drafting properties at all.**
>
> `ScenePrimitive` — the only thing either renderer ever sees — has exactly one
> appearance field: `color`. There is no stroke width, no fill, no line pattern,
> no hatch, no font size, no opacity, no z-order. So there is nothing to preserve,
> nothing to export, and nothing for a style system to read. Both renderers
> invent their own appearance from scratch, independently.

And the correction to the brief's framing:

> **The Card Party stage decks are not losing their fill. Seven of them are not
> being drawn at all.**
>
> The plan places 7 × `Riser 6'x8'`. They produce **zero** drawing primitives.
> They are absent from the canvas, the print, the PDF and the SVG. The greyed
> decks that *are* visible in our output are different objects — raw rectangles —
> which render as hollow outlines.

---

## 1. Side-by-side: Room Viewer vs. Groundplan

Rendered from the *same file*, so differences are ours, not the data's.

Current Groundplan export: [`card-party-current.svg`](card-party-current.svg)
(rasterised alongside it as `.png`).

| Aspect | Room Viewer | Groundplan today | Status |
|---|---|---|---|
| Catalogue shapes (`Riser 6'x8'`) | Drawn, filled, labelled | **Not drawn** — 7 objects, 0 primitives | VERIFIED |
| Deck / platform fill | Solid darker fill | `fill="none"` on every polygon | VERIFIED |
| Line weights | Graded by object class | **Two** weights, keyed on scene *layer* | VERIFIED |
| Printed weight @ 1/8" | Legible | 0.90 pt walls / **0.38 pt** everything else | VERIFIED (computed) |
| Printed weight @ 1/16" | Legible | 0.45 pt / **0.19 pt** — effectively invisible | VERIFIED (computed) |
| Dimension line style | Solid, with ticks and a text gap | Dashed, no ticks, text **overprinted** by the line | VERIFIED |
| Dimension extension lines | Present | Absent | VERIFIED |
| Text sizing | Scales with drawing scale | Fixed `font-size="90"` | VERIFIED |
| Text collision | Managed | Labels overlap illegibly (see render) | VERIFIED |
| Object colour | Preserved | Preserved — cyan/yellow/black all survive | VERIFIED |
| Near-white objects | Drawn as-is on white | Forced to `#2b2b2b` | VERIFIED |
| Canvas vs. print consistency | One renderer | Two independent renderers | VERIFIED |
| Hatch / fill patterns | Present in format | Never decoded | VERIFIED |
| Title block on export | Present | Print only; absent from SVG | VERIFIED |

---

## 2. Missing or inaccurate rendering properties

`src/format/scene.ts` — the complete appearance surface of a primitive:

```ts
export interface ScenePrimitive {
  id: number; nodeId: number; selectId: number;
  type: PrimitiveType; pts: number[];
  color: number;        // COLORREF 0x00BBGGRR  <- the ONLY style field
  cls: string; layer: Layer; owner?: string; text?: string;
}
```

Absent from the model entirely:

| Property | Where it lives in `.rv4` | Currently |
|---|---|---|
| Stroke width / pen style | pen block, bytes +26..+54 | **never decoded** |
| Fill colour | brush block, bytes +26..+54 | **never decoded** |
| Fill pattern / hatch | brush block | **never decoded** |
| Line pattern (dash) | pen block | **never decoded** |
| Opacity / transparency | unknown | not modelled |
| Z-order / draw priority | implicit in stream order | not modelled |
| Font size / weight / face | `LOGFONT` | **partially** decoded — see below |
| Layer-as-authored | unknown | we *derive* a layer by heuristic |

**VERIFIED** — `src/format/rv.ts` reads the `COLORREF` at byte +54 and skips
bytes +26..+54. Grepping the format layer for `brush`, `fill`, `pattern` or
`hatch` returns only comments; there is no decode path.

**Partial exception, VERIFIED:** `readLogFont` *does* recover `lfHeight`, weight
and typeface for `RVLabel`, and `node.bold` / `node.color` exist. That data is
parsed and then **discarded** — neither renderer reads it. `svg.ts` hardcodes
`font-size="90"`; `PlanCanvas.tsx` computes `Math.max(9, Math.min(21, 130*scale))`.

**ASSUMED:** that the +26..+54 block is in fact `LOGPEN` + `LOGBRUSH`. The offset
and size are consistent with those MFC structures and with the corpus, but the
field layout has not been decoded or validated. **Phase 1 of the plan is to prove
this, and the whole plan depends on it.**

---

## 3. VERIFIED cause — thin print lines

Three facts compose to produce hairlines.

**(a) There are only two weights**, and they key off the *derived* layer, not the
object's class or its authored pen. `src/renderer/src/svg.ts:49`:

```ts
const w = p.layer === 'walls' ? 12 : 5;
```

**(b) Those numbers are drawing units** — tenths of an inch of *real room*, not
paper. The SVG `viewBox` is in room units.

**(c) Print scales the sheet to the drawing scale.** `src/main/print.ts`:

```ts
width:${(extent.width / 120) * scale.inchesPerFoot}in
```

So one viewBox unit prints as `inchesPerFoot / 120` inches, and the stroke
shrinks with the scale:

| Scale | Walls (12u) | Everything else (5u) |
|---|---|---|
| 1/16" = 1' | 0.45 pt | **0.19 pt** |
| 3/32" = 1' | 0.68 pt | **0.28 pt** |
| 1/8" = 1' | 0.90 pt | **0.38 pt** |
| 3/16" = 1' | 1.35 pt | **0.56 pt** |
| 1/4" = 1' | 1.80 pt | **0.75 pt** |

Drafting practice puts the thinnest usable printed line at **0.13 mm ≈ 0.35 pt**.
Every non-wall line is at or below that from 1/8" down, and 0.19 pt is below what
most office printers and PDF viewers will render as a solid line at all.

This is why the brief's rule *"do not simply increase every line weight globally"*
is right: the defect is not "the number 5 is too small." It is that **stroke width
is specified in room units and therefore is not a line weight at all** — it is a
physical thickness in the room, which is a different quantity. The fix is a change
of unit, not a change of value.

---

## 4. VERIFIED cause — the Card Party stage decks

Two independent defects were found. The second is the one that matters.

**(a) Nothing is ever filled — canvas or export.**

`svg.ts:72` emits `fill="none"` unconditionally:

```ts
parts.push(`<${tag} points="..." fill="none" stroke="${stroke}" stroke-width="${w}"${dash}/>`);
```

`PlanCanvas.tsx:461` sets `ctx.fillStyle` but **never calls `ctx.fill()`** for a
scene primitive — only `ctx.stroke()`. `fillStyle` is used solely by `fillText`.

Neither renderer can fill anything, because §2 shows there is no fill to read.

**(b) The named risers produce no geometry at all.** This is the real defect.

```
inventory:            7 x Riser 6'x8'
primitives by owner:  37 (no owner) | 16 Steps | 2 Serpentine 24"x48"
                      ^^ no riser entry
```

Inspecting the object directly:

```
RVShape id=5 labels=["Riser 6'x8'"] pts=2 slots=0 children=0
        color=undefined bounds=[1656,-3216,2376,-2256]
```

`slots=0`, `children=0`, `color=undefined`. The shape carries a **name and correct
bounds** — 720 × 960 units is exactly 6′ × 8′ — and **no outline whatsoever**.

The geometry is not in the plan file. Room Viewer resolves the name against an
external shape catalogue at draw time. Those catalogues are on the same drive:

```
/Volumes/Prince/Roomviewer/Shapes/StockShapes.stk   1,281 objects
/Volumes/Prince/Roomviewer/Shapes/AV.add           14,948 objects
/Volumes/Prince/Roomviewer/Shapes/UserLib.lib          44 objects
   (+ Buffet.add, Casino.add, Catering.add, Game.add)
```

All seven parse cleanly and round-trip byte-identically. **The data is present.**

What is missing is the name index: our label extraction finds 0 names in
`StockShapes.stk` and 2 in `AV.add`, because library files store shape names in a
different structure than plans do, and we have not decoded it.

> This corrects an earlier note in this project that the catalogue work was
> "blocked on data." It is not. It is blocked on decoding the library's
> name-to-shape index.

**So the correct statement of the defect is:** the decks lose their fill *because
there is no fill in the model*, **and** the catalogue risers are missing entirely
*because we cannot resolve a shape name to its definition.* The visible grey-ish
rectangles in our output are unrelated `RVSegmentRect` objects that happen to sit
in the same place.

**ASSUMED:** that the catalogue entry for `Riser 6'x8'` carries the darker fill
seen in Room Viewer. Highly likely — that is what a catalogue is for — but not
proven until the library index is decoded.

---

## 5. VERIFIED cause — dimensions only support dotted lines

`src/renderer/src/svg.ts:70`:

```ts
const dash = p.type === 'dimension' ? ' stroke-dasharray="40,30"' : '';
```

`src/renderer/src/PlanCanvas.tsx:496-498`:

```ts
ctx.setLineDash([5, 4]);
ctx.globalAlpha = 0.7;
```

The pattern is a hardcoded consequence of the primitive's **type**. There is no
style input, no per-dimension setting, and no way to request a solid line. The two
renderers do not even agree: `40,30` room units vs. `5,4` screen pixels, and the
canvas additionally applies 70% alpha that the export does not.

Also missing, and visible in the render: dimensions have **no extension lines, no
terminators (ticks/arrows), and no text gap** — the dashed line runs straight
through "42 ft 0 in".

This is not a Room Viewer parity gap in the data; it is a feature we wrote and
wrote narrowly.

---

## 6. Proposed architecture — one drafting-style system

The brief forbids two conflicting systems. There is currently exactly that. The
proposal is a single module both renderers consume.

```
src/format/style.ts          <- NEW. The vocabulary and the resolver.
   ├─ DrawingStyle           resolved appearance: stroke, fill, dash, text
   ├─ StyleSource            'imported' | 'catalogue' | 'class-default' | 'override'
   └─ resolveStyle(prim, ctx) -> DrawingStyle

src/format/scene.ts          <- ScenePrimitive gains an optional `style`
src/format/rv.ts             <- decodes pen/brush into that shape
src/renderer/src/svg.ts      <- consumes resolveStyle(); emits no constants
src/renderer/src/PlanCanvas.tsx <- consumes resolveStyle(); emits no constants
```

**Resolution order** (first match wins) — this is what satisfies "preserve
imported properties" and "don't hardcode one project" simultaneously:

1. **Explicit user override** on the object (companion document).
2. **Imported style** decoded from the file's pen/brush block.
3. **Catalogue style** from the shape library definition.
4. **Class default** from the drafting standard (§7/§8/§9).
5. **Layer fallback** — last resort, what we have today.

Every resolved style records which level it came from, so the UI can show
"imported" vs. "defaulted", and so a regression test can assert that an imported
value was not silently replaced by a default.

**Units are the crux.** `DrawingStyle.strokeWidth` must be expressed in
**printed points**, not room units. Each renderer converts:

- print/SVG: `pt → in → viewBox units` via the known drawing scale
- canvas: `pt → screen px` via zoom, with a floor so lines stay visible zoomed out

That single change is what makes canvas and print agree, and it is why the fix is
not "make the numbers bigger."

---

## 7. Print-safe line-weight standard

Standard architectural pen grades, in points, chosen so the *thinnest* line stays
above the 0.35 pt floor at every supported scale.

| Grade | Weight | Applies to |
|---|---|---|
| Heavy | 1.40 pt | Building perimeter, structural walls |
| Medium | 0.90 pt | Interior partitions, stage/riser outlines, platform edges |
| Light | 0.60 pt | Furniture, equipment, catalogue shapes |
| Fine | 0.40 pt | Dimensions, leaders, extension lines, hatching |
| Hairline | 0.35 pt | Grid, centrelines, construction marks |

Rules:

- These are **absolute printed weights** and do not scale with the drawing scale.
  A wall is 1.40 pt at 1/16" and at 1/4". This is how drafting works and it is the
  opposite of current behaviour.
- **Clamp:** no resolved stroke prints below 0.35 pt. An imported pen thinner than
  that is raised to the floor, and the fact is recorded so §15 can assert it.
- Preserve *relative* hierarchy when importing: if a file's pens are all thin, map
  them onto the grade scale rather than flattening them to one value.

---

## 8. Stage and deck style definitions

| Element | Stroke | Fill | Notes |
|---|---|---|---|
| Stage deck / riser | Medium 0.90 pt | Solid, 12% black (`#e0e0e0`) | Fill from catalogue when present |
| Riser, upper tier | Medium 0.90 pt | Solid, 20% black (`#cccccc`) | Darker with height — reads as elevation |
| Stage edge (downstage) | Heavy 1.40 pt | — | Emphasised safety edge |
| Steps / treads | Light 0.60 pt | none | Tread lines at Fine |
| Platform skirt | Fine 0.40 pt | 45° hatch | |
| Height callout | — | — | Text at 3/32" printed height |

Tiering is what the Card Party plan is *about* — "24″ Height" and "32″ Height" are
two tiers. Keying fill density to deck height is the single change that makes that
plan read correctly, and it generalises: it is a rule about risers, not about this
client.

**ASSUMED:** that Room Viewer's grey is around 12–20% black. Taken from the
reference image, not from decoded brush data. Confirm during Phase 1 and use the
decoded value in preference to this table.

---

## 9. Dimension style definitions

| Part | Style |
|---|---|
| Dimension line | **Solid**, Fine 0.40 pt (was: dashed — this is the defect) |
| Extension lines | Fine 0.40 pt, 1/16″ gap from object, 1/8″ overshoot past the dim line |
| Terminators | Architectural 45° tick, 1/8″; arrow and dot available as options |
| Text | 3/32″ printed height, centred, **with the line broken behind it** |
| Text placement | Above the line when it fits; centred-with-gap otherwise |
| Short dimensions | Text and ticks move outside when the span is too narrow |
| Units | Follow the document unit setting (ft-in / decimal ft / metric) |

Dashed remains available as an explicit *choice* — for grid lines, centrelines and
reference dimensions — but it stops being the only thing on offer.

---

## 10. Import-style preservation rules

1. **Never discard a decoded property.** If the pen/brush block yields a value, it
   is stored on the primitive and takes precedence over every default.
2. **Undecoded ≠ absent.** Bytes we cannot yet interpret are retained verbatim on
   the node (as today) so saving stays byte-exact. Decoding more of them later
   must not change stored files.
3. **Defaults are marked as defaults.** A primitive that fell through to a class
   default carries `source: 'class-default'`, so it is distinguishable from one
   that genuinely imported that value.
4. **Round-trip is unconditional.** Reading a file, resolving styles, and writing
   it back without an edit must still produce a byte-identical file. The existing
   1954/1955 gate covers this and must not regress.
5. **User overrides live in the companion**, never in the binary, so a plan opened
   in Room Viewer is unchanged.
6. **Catalogue styles do not overwrite file styles.** A shape that carries its own
   pen keeps it; the catalogue only supplies what the file omits.

---

## 11. Files and components that must change

| File | Change |
|---|---|
| `src/format/style.ts` | **NEW** — `DrawingStyle`, `StyleSource`, `resolveStyle`, the grade table |
| `src/format/rv.ts` | Decode `LOGPEN`/`LOGBRUSH` at +26..+54; expose `pen`/`brush` on `RVNode` |
| `src/format/scene.ts` | `ScenePrimitive.style?: DrawingStyle`; populate from node pen/brush |
| `src/format/catalogue.ts` | **NEW** — decode `.stk`/`.add`/`.lib` name index; resolve name → geometry + style |
| `src/renderer/src/svg.ts` | Delete the two weight constants and the dash constant; consume `resolveStyle`; emit fill; scale text; add dimension geometry |
| `src/renderer/src/PlanCanvas.tsx` | Same source of truth; call `ctx.fill()`; pt→px conversion with a visibility floor |
| `src/main/print.ts` | Pass drawing scale into style resolution so pt→unit conversion is correct |
| `src/format/dimension-render.ts` | Emit extension lines, terminators, and a text gap |
| `src/format/companion.ts` | Persist per-object style overrides |
| `src/main/plan-model.ts` | IPC for reading/setting overrides |

---

## 12. Data model and serialization changes

- **`RVNode`** gains `pen?: PenStyle` and `brush?: BrushStyle`, both optional and
  both purely *read* — the raw bytes remain the source of truth for writing, so
  round-trip is untouched.
- **`ScenePrimitive`** gains `style?: DrawingStyle`. Optional, so nothing that
  ignores it breaks.
- **Companion document** gains a `styles` map keyed by object id. Companion
  versioning already exists; add a migration that treats a missing `styles` key as
  an empty map. **No existing companion file becomes unreadable.**
- **No change to the `.rv4` binary writer.** Style overrides never touch the file.
  This is what preserves existing project data, and it means a mistake in the
  style system cannot corrupt a plan.

---

## 13. Print and PDF pipeline changes

- Style resolution must run **with the target scale in hand**, because pt→unit
  conversion depends on it. Today `svg.ts` runs scale-blind.
- `toSvg` takes a `scale` argument; `print.ts` passes the chosen scale;
  screen preview passes the fit scale.
- Add `shape-rendering="geometricPrecision"` and explicit `stroke-linecap` so
  thin lines render consistently across PDF viewers.
- Emit fills **before** strokes within a layer so outlines are never buried.
- Give the SVG export the same title block the print path has, so an exported file
  is a usable drawing on its own.
- **PDF must be checked separately from print.** Browser print and PDF export take
  different paths through the SVG and can disagree on sub-point strokes.

---

## 14. Phased implementation plan

Each phase ends green — nothing is left half-migrated.

| Phase | Work | Done when |
|---|---|---|
| **1. Decode** | Decode pen/brush at +26..+54 across the full 1,955-file corpus. Validate against known-appearance files. *No rendering change.* | Decoded values are self-consistent corpus-wide; round-trip still 1954/1955 |
| **2. Model** | Add `PenStyle`/`BrushStyle` to `RVNode`, `DrawingStyle` to `ScenePrimitive`, build `style.ts` with the grade table and resolver. *Renderers untouched.* | Unit tests on resolution order; corpus parses unchanged |
| **3. Unify** | Both renderers consume `resolveStyle`. Delete every hardcoded weight, dash and colour constant. Introduce pt→unit and pt→px conversion. | Canvas and export agree; the §7 floor holds at every scale |
| **4. Fill** | Emit fills in both renderers. Apply §8 stage/deck styles including height-keyed tiering. | Card Party decks fill on canvas, print, PDF and SVG |
| **5. Dimensions** | Solid default, extension lines, terminators, text gap, style options. | §9 satisfied; dashed still reachable as a choice |
| **6. Catalogue** | Decode the `.stk`/`.add`/`.lib` name index; resolve shape names to geometry and style. | The 7 `Riser 6'x8'` objects draw |
| **7. Overrides** | Companion persistence + UI for per-object style. | Override survives save/reopen |
| **8. Verify** | Full visual regression suite (§15) and the before/after renders (§16). | All five surfaces pass on the corpus sample |

Phases 1–5 fix the three reported defects. Phase 6 fixes the larger one found
during this audit. Phase 6 can be deferred without blocking 1–5.

---

## 15. Visual regression tests

The brief's rule — *nothing is "fixed" until canvas, print, PDF, save and reopen
are all tested* — becomes the test matrix, not a promise.

**Per-surface, per fixture plan:**

| Surface | Assertion |
|---|---|
| Canvas | Rasterise offscreen; compare to a golden PNG within tolerance |
| Print HTML | Snapshot the generated markup |
| SVG export | Snapshot; assert no `fill="none"` on a filled class |
| PDF | Render to raster via headless Chromium; compare to golden |
| Save | Round-trip byte-identical after style resolution — **existing 1954/1955 gate** |
| Reopen | Companion overrides survive a save/load cycle |

**Property assertions, run corpus-wide** (these catch the bug classes, not just
the fixtures):

1. No resolved stroke prints below 0.35 pt, at any of the five scales.
2. An imported pen or brush value is never replaced by a default —
   `source === 'imported'` wherever the file supplied one.
3. Distinct object classes do not collapse to identical styles (guards the
   "don't flatten everything" rule).
4. Canvas and SVG resolve to the *same* `DrawingStyle` for the same primitive.
5. Every drawable object produces ≥1 primitive — **this is the test that would
   have caught the missing risers**, and its absence is why they went unnoticed.

**Fixtures:** Card Party (tiered stage), a banquet round-table plan, a theatre
plan with curved walls, a plan with imported non-default pens, and a
newly-created blank plan.

---

## 16. Before-and-after comparison renders

**Before** is captured and committed now, as part of this analysis:
[`docs/audit/card-party-current.svg`](card-party-current.svg) + `.png`.

Reading it against the reference image, the visible defects are: hollow decks,
uniform hairlines, overlapping labels, a dimension line printed through its own
text, no extension lines or ticks, and no title block.

**After** renders cannot be produced honestly until the phases run. The plan is to
regenerate the same file at the end of each phase and commit the render, so the
progression is auditable rather than asserted:

| Checkpoint | Expected visible change |
|---|---|
| After Phase 3 | Graded line weights; canvas matches print |
| After Phase 4 | Decks filled; upper tier darker than lower |
| After Phase 5 | Solid dimensions with ticks and a text gap |
| After Phase 6 | The 7 catalogue risers appear |

---

## Open questions the implementation must answer

1. **Is +26..+54 really `LOGPEN` + `LOGBRUSH`?** Everything in §6–§14 assumes it.
   Phase 1 exists to answer this before anything depends on it. If the answer is
   no, §7–§10 still stand — they would simply run entirely on class defaults, and
   rule 10.1 becomes vacuous rather than wrong.
2. **How do library files index shapes by name?** Needed for Phase 6. The files
   parse; the naming structure does not match the plan-file layout.
3. **What is Room Viewer's actual deck grey?** §8 estimates it from an image.
   Prefer the decoded value once Phase 1 lands.
4. **Why does the export frame so much empty sheet?** Visible in the current
   render. Noticed, not yet traced — outlying objects appear to stretch the
   extent. Logged for investigation; not part of the three reported defects.
