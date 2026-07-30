# Public inventory catalog — architecture audit and implementation plan

Status: **audit and plan complete; the offline core is built and tested.**
`src/catalog/` holds the model, signed manifests, deltas, staged install with
rollback, and generated symbols — 72 checks in `tools/catalog-test.ts`. Still to
build: the download layer, update scheduling, the notification UI, and the
publishing workflow.

Everything under "Verified" was read out of the codebase on 2026-07-29 and is
cited with a file. Everything under "Assumption" is a judgement call that needs
your confirmation, because getting it wrong would waste weeks.

---

## 1. Map of the current inventory architecture

### Verified

There is **one** inventory system and it is entirely local. There is no second
competing catalog to reconcile with.

```
Gear PDF ──importGearPdf──┐
Plans (.rv4) ──listSymbols─┤
CSV ──parseCsv────────────┴──► mergeItems() ──► Inventory (in memory, main process)
                                                    │
                                                    ├─ saveInventory() ─► inventory.json
                                                    └─ manageInventorySymbols() ─► inventory-assets/
                                                                                    (SHA-256 named)
        renderer ◄── IPC 'inventory:*' ── main process (sole owner of the data)
```

- The renderer never touches the filesystem. Every read and write goes through
  the enumerated IPC surface in `src/preload/index.ts`, and all 48 handlers are
  wrapped so a throw returns a reason rather than rejecting silently
  (`src/main/index.ts`, `handle()`).
- The inventory lives in the main process as a single module-level
  `Inventory` object (`src/main/index.ts`), persisted on every mutation.

### Verified: what does **not** exist

This matters more than what does, because the brief assumes several of these.

| Assumed by the brief | Reality |
| --- | --- |
| Central/public catalog | **Does not exist.** No server, no hosted data. |
| Any network layer | **Does not exist.** No `fetch`, `https.request`, `axios`, `node-fetch`, or `WebSocket` anywhere in `src/` or `tools/`. Runtime dependencies are `cfb`, `mdb-reader`, `pdfjs-dist` — none networked. |
| User accounts / "when the user signs in" | **Does not exist.** No auth, sessions, or identity of any kind. |
| Application auto-update | **Does not exist.** `electron-builder.yml` has no `publish` block and `electron-updater` is not a dependency. Updating the app today means reinstalling a DMG or EXE. |
| Public/private data separation | **Does not exist.** One flat `InventoryItem`. |
| Manufacturer / brand / model fields | **Do not exist.** `name` is free text lifted from a rental-house PDF, e.g. `"Panasonic PT-RZ21KU Laser Projector"`. |
| Images, manuals, accessories, compatibility, replacement links | **Do not exist.** |
| Quantity owned, barcode, asset no., serial, purchase/rental price, maintenance, damage, availability, show assignment | **Do not exist as fields.** |
| Search index | **Does not exist.** `searchInventory()` is a linear scan over the in-memory array (`src/inventory/model.ts`). Fine for 701 items, not for a platform catalog. |

### Verified: useful groundwork that already exists

Three pieces of the brief are effectively already built, and the plan should
extend them rather than replace them.

1. **A versioned, migrating file format.** `INVENTORY_FILE_VERSION = 2`;
   `migrateInventory()` accepts v1 and v2, assigns deterministic replacement IDs
   for missing or duplicated ones, and **preserves unknown forward-compatible
   fields** so an older build does not destroy data written by a newer one
   (`src/inventory/store.ts`).
2. **A content-addressed asset store.** `inventory-assets/` beside the inventory
   file, files named by SHA-256, with validation that rejects path traversal,
   requires the declared asset directory prefix, and requires the filename to
   match its hash (`src/inventory/store.ts`). This is exactly the shape a
   catalog's images and manuals need.
3. **Crash-safe writes.** `atomicWrite()` writes to a unique temp file opened
   `wx` with mode `0o600`, then renames — so an interrupted write cannot leave a
   truncated inventory.

---

## 2. Current catalog source of truth

**Verified:** the user's own machine. Specifically
`~/Library/Application Support/Groundplan/inventory.json`, built from gear-list
PDFs and symbols harvested out of their own plans.

There is no authority above that. Two installs of Groundplan today share
nothing.

---

## 3. Local storage technology

**Verified: a single JSON document, not a database.**

- Path: `inventoryPath(app.getPath('userData'))` → `<userData>/inventory.json`
- Assets: `<userData>/inventory-assets/<sha256>[.ext]`
- Not SQLite. Not IndexedDB. Not LevelDB. The whole inventory is parsed into
  memory at launch and rewritten in full on every change.

**Assessment (assumption):** JSON is adequate to roughly 10k items and becomes
the wrong choice beyond that — full rewrite per mutation, no partial read, no
index, no transaction across records. A platform catalog of tens of thousands of
models with specs and relations wants SQLite.

**Decided: JSON for both.** SQLite was the instinct, but Windows installers are
cross-built from macOS through wine and `better-sqlite3` is a native module
needing per-platform prebuilt binaries — it would break that cross-build
outright. JSON also reuses the migration and atomic-write machinery the private
inventory already has. The cost is linear search, which is fine into the tens of
thousands of products; if the catalog ever outgrows that, an in-process index
built at load is the next step, not a native database.

---

## 4. Proposed catalog versioning strategy

Three independent version numbers, deliberately not conflated:

| Version | Example | Meaning | Compatibility rule |
| --- | --- | --- | --- |
| **Catalog content version** | `2.5.0` | Which published release of the data | semver over content |
| **Catalog schema version** | `3` | Shape of the catalog DB | app declares min/max it can read |
| **App version** | `1.2.0` | The desktop build | release states `minAppVersion` |

- **Patch** (`2.5.0 → 2.5.1`): corrections to existing records. Always delta.
- **Minor** (`2.5.0 → 2.6.0`): new models, manufacturers, manuals. Delta.
- **Major** (`2.x → 3.0.0`): schema change. Full download, and gated on
  `minAppVersion`.

Downgrade is refused: the client rejects any release whose version sorts below
the installed one, which closes the rollback-attack path in §9.

---

## 5. Update manifest structure

One signed manifest, fetched by itself, small enough to poll cheaply.

```jsonc
{
  "schema": 1,
  "catalogVersion": "2.5.0",
  "catalogSchemaVersion": 3,
  "released": "2026-07-29T00:00:00Z",
  "minAppVersion": "1.2.0",
  "urgent": false,
  "channel": "stable",
  "counts": { "added": 24, "updated": 11, "deprecated": 2, "manuals": 7 },
  "notes": "https://…/releases/2.5.0.html",

  "full": {
    "url": "https://…/catalog/2.5.0/full.tar.zst",
    "bytes": 41_884_672,
    "sha256": "…"
  },

  // Deltas keyed by the version they apply *from*.
  "deltas": {
    "2.4.1": { "url": "…/2.4.1-2.5.0.patch.zst", "bytes": 18_874_368, "sha256": "…" },
    "2.4.0": { "url": "…/2.4.0-2.5.0.patch.zst", "bytes": 22_020_096, "sha256": "…" }
  },

  "signature": "base64 Ed25519 over the canonical JSON of every field above"
}
```

Notes on the shape:

- The signature covers the manifest, and the manifest carries the package
  hashes — so one signature transitively protects the payloads. The packages
  themselves need no separate signature.
- `deltas` is a map rather than a chain: the client does **one** hop or falls
  back to full. Chaining N patches multiplies the failure surface for no real
  saving.
- `urgent` drives the labelling in the brief's "Important Inventory Correction"
  case.

---

## 6. Incremental update strategy

**Record-level JSON patch, not binary diff.**

A binary diff of a SQLite file is fragile — page layout shifts under unrelated
writes. A record-level patch is inspectable, verifiable, and survives the local
DB being vacuumed or re-indexed.

```jsonc
{
  "fromVersion": "2.4.1",
  "toVersion": "2.5.0",
  "upsert": [ { "id": "gp:panasonic:pt-rz21ku", "…": "…" } ],
  "deprecate": [ { "id": "gp:barco:hdx-w20", "replacedBy": "gp:barco:udx-4k32" } ],
  "delete": [],
  "assets": {
    "add": [ { "sha256": "…", "url": "…", "bytes": 240_128, "kind": "manual" } ],
    "drop": [ "…" ]
  }
}
```

- Assets are content-addressed, so an asset already present from an earlier
  release is never re-downloaded — the existing `inventory-assets` validation
  logic ports directly.
- Applied inside one SQLite transaction; either the whole release lands or none
  of it does.

---

## 7. Full-update fallback

Triggered when — matching the brief exactly — the local catalog is missing or
corrupt, no delta exists from the installed version, the schema version changed,
verification failed, or the user asked for a clean reinstall.

The full package is the same SQLite file the server built, compressed. Install
is: download → verify → open read-only and sanity-query → swap into place →
keep the previous file until the next successful launch.

---

## 8. Package signing and validation

- **Ed25519** over the canonical JSON of the manifest. Small, fast, no
  parameter-choice footguns, and available in Node's `crypto` without a
  dependency (`crypto.verify(null, data, publicKey, sig)`).
- **Public key pinned in the app binary.** Not fetched — fetching the key
  defeats the purpose.
- Support **two** valid keys at once so a key can be rotated without stranding
  installs.
- Validation order, all before anything touches the live catalog:
  1. TLS fetch of the manifest
  2. Signature verifies against a pinned key
  3. `catalogVersion` **>** installed (downgrade refused)
  4. `minAppVersion` ≤ running app
  5. `catalogSchemaVersion` within the app's supported range
  6. Package downloaded to temp; SHA-256 matches the manifest
  7. Package opens and passes a structural query
- Anything unsigned, mismatched, older, or incompatible is refused with a
  specific reason, and the installed catalog is left untouched.

---

## 9. Installation and rollback

Follows the 14 steps in the brief. The load-bearing detail is that the live
catalog is never modified in place:

```
catalog/
  current.db      ← what the app reads
  incoming.db     ← staged copy, patched here
  previous.db     ← last known good, kept until the next clean launch
```

1. Copy `current.db` → `incoming.db`.
2. Apply the delta to `incoming.db` in one transaction.
3. Validate `incoming.db` (schema version, row counts against the manifest, a
   sample of upserted IDs actually present).
4. `current.db` → `previous.db`; `incoming.db` → `current.db` (rename, atomic on
   the same volume).
5. Reopen, rebuild the affected FTS rows, notify the renderer.
6. On any failure at any step: delete `incoming.db`, leave `current.db`
   untouched, report.

**Multi-window safety (brief calls this out):** a lock file in the catalog
directory holding the pid, plus Electron's existing single-instance behaviour.
Only the main process installs; renderers are told when to refresh.

---

## 10. Offline behaviour

The app is already fully offline and must stay that way — that is its main
advantage over anything cloud-based, and the brief agrees.

- Every catalog read is local; a failed update check changes nothing.
- Update state is surfaced, never enforced: "Last checked 3 days ago" /
  "Catalog updates unavailable — no connection".
- Failed checks queue for the next launch or network return; no retry storm.
- A stale catalog produces a non-blocking notice. The app is **never** blocked
  because the catalog is old — the only exception is a single record flagged
  `urgent`, which is marked in place rather than locking the application.

---

## 11. Application compatibility rules

- Each release declares `minAppVersion` and `catalogSchemaVersion`.
- The app declares the schema range it can read.
- If a release needs a newer app: show the brief's "Application Update Required"
  message, keep using the current catalog, do not install.
- **Verified gap:** there is no app auto-update to offer, so "Update
  application" can only link to a download page today. Wiring
  `electron-updater` is a separate piece of work and should be sequenced *before*
  the first schema-breaking catalog release, or users will be stranded.

---

## 12. Files, services, tables and components that must change

### New — desktop

| Path | Purpose |
| --- | --- |
| `src/catalog/schema.sql` | Public catalog tables + FTS5 |
| `src/catalog/db.ts` | Open, validate, query |
| `src/catalog/manifest.ts` | Fetch, parse, verify signature |
| `src/catalog/update.ts` | Plan, download (resumable), verify, install, roll back |
| `src/catalog/preferences.ts` | Update policy, incl. org-wide override |
| `src/catalog/repair.ts` | Validate, rebuild index, clean temp, restore, full reinstall |
| `src/renderer/src/CatalogUpdate.tsx` | Notification, details, progress, summary |
| `tools/catalog-test.ts` | Delta/full/rollback/tamper/downgrade tests |

### Changed — desktop

| Path | Change |
| --- | --- |
| `src/inventory/model.ts` | `InventoryItem` gains `catalogId?: string` linking to a public record; private fields stay here |
| `src/inventory/store.ts` | Bump to file version 3; migration adds the link field |
| `src/main/index.ts` | `catalog:*` handlers; check on launch and on interval |
| `src/preload/index.ts` | Enumerate the new channels |
| `src/renderer/src/InventoryPalette.tsx`, `InventoryView.tsx` | Show catalog-backed specs; deprecation badge |
| `electron-builder.yml` | Ship the pinned public key; `extraResources` for the seed catalog |

### New — server (does not exist today)

Publishing pipeline, moderation queue, duplicate detection, release builder,
delta generator, signer, static hosting. See §14 for the staged approach.

### Proposed table split — the core of the brief

```
PUBLIC  catalog.db          (replaceable, never contains company data)
        products, manufacturers, specifications, assets,
        accessories, compatibility, replacements, tags, catalog_meta

PRIVATE inventory.json      (never touched by an update)
        id, catalogId?, quantityOwned, warehouseLocation, barcode,
        assetNumber, serialNumbers[], purchasePrice, rentalPrice,
        maintenance[], damageStatus, availability, showAssignments[],
        + existing: notes, symbolAsset, category overrides
```

The separation is **physical, not conventional**: private data lives in a
different file that the update path has no write access to. That is what makes
"an update must never overwrite private records" a structural guarantee instead
of a promise.

---

## 13. Migration sequence

1. **File version 3.** Add `catalogId?` to `InventoryItem`. Existing items get
   `undefined` — they remain valid, purely local records. No data moves.
2. **Ship a seed catalog** inside the app (`extraResources`) so a fresh install
   has something before its first download.
3. **Backfill link suggestions** by running the existing `classify()` /
   `chooseSymbol()` matcher against catalog products, proposing links for the
   user to confirm. Never auto-link silently — a wrong link would show wrong
   specs for their gear.
4. **Enable update checks** with notify-only defaults.
5. **Enable auto-download** for small updates once the pipeline has proven
   itself.

Every step is independently shippable and reversible. No step requires the user
to re-enter anything.

---

## 14. Testing and recovery plan

The brief's test list is the acceptance criteria; the ones needing real
infrastructure are marked.

**Testable in-repo today** (extend the existing 11-file suite, which is green):

- Delta apply produces byte-identical state to a full install of the same
  version — the strongest single check, and the one that catches most delta bugs
- Tampered package rejected; unsigned rejected; wrong-key rejected
- Downgrade refused; incompatible `minAppVersion` refused
- Failed install restores the previous catalog and it opens
- Private inventory byte-identical before and after an update (quantities,
  barcodes, prices, locations, serials)
- Deprecated public item leaves the company record intact and shows a
  replacement
- Interrupted download resumes; corrupt resume restarts cleanly
- Concurrent windows install once
- FTS returns new items without restart

**Needs the server** — cannot be tested until it exists: end-to-end submit →
moderate → release → client picks it up.

**Recovery**: the repair option from the brief, driven by `repair.ts` — validate,
rebuild index, clear temp files, restore previous, or download a clean full
catalog. All of it resets public data only; `inventory.json` is never in scope.

---

## Decided: what is shared, and what never leaves the machine

**Shared** — the product record. Manufacturer, brand, model, category,
dimensions, weight, power, inputs and outputs, manuals, accessories,
compatibility, replacements. None of it is proprietary; it is on the
manufacturer's data sheet. Everyone having the same gear list is the point.

**Never shared** — the drawings. Symbols harvested out of a plan carry that
show with them: the room, the surrounding labels, the client it belonged to.
Those stay on the machine that made them and are never uploaded.

That raised an obvious problem. If the shared catalog holds only specifications,
every downloaded item places as a plain box — which is exactly the failure this
project already fixed once. The resolution is to **draw symbols from the
specifications** rather than lift them from anyone's drawings
(`src/catalog/symbols.ts`): a projector with a published footprint can be drawn
as a body, a lens and a throw arrow without reference to any real plan.

Precedence when an item is placed:

1. a symbol harvested from the user's own plans — private, never uploaded
2. the generated symbol — public, identical for everyone
3. a plain sized box — last resort

So a shop that has drawn its own Barco keeps its own drawing, and a shop that has
never seen one still places something that reads as a projector. 22 categories
are drawn to trade convention and verified by rendering, not only by assertion.

---

## Scope reality — read this before scheduling

**Verified:** roughly 60% of this brief is server-side work against
infrastructure that does not exist. Groundplan has never made a network request.
There is no backend, no hosting, no accounts, no moderation tooling, no signing
keys.

The desktop half — versioning, manifests, deltas, verification, install,
rollback, offline, repair, public/private separation — is buildable now and is
genuinely useful. The publishing half needs decisions only you can make.

**Recommended staging, cheapest useful thing first:**

- **Stage 1 — no server at all.** Catalog releases are signed static files on
  any HTTPS host (S3, R2, GitHub Releases). Moderation is a pull request against
  a data repo; CI builds, signs and publishes the release. This satisfies
  versioning, signing, deltas, verification, rollback and offline in full, with
  zero servers to run or pay for. For a shop your size this may be the permanent
  answer, not a stepping stone.
- **Stage 2** — a small submission form writing to that repo, if PRs prove too
  awkward for contributors.
- **Stage 3** — a real service with accounts and a moderation queue, only if the
  contributor base outgrows Stage 2.

**Decisions I need from you before any code:**

1. Stage 1 static hosting, or a real backend from the start?
2. SQLite for the public catalog — accepting a native dependency and
   `electron-rebuild` in the build — or stay on JSON and cap catalog size?
3. Who holds the signing key, and where?
4. Is there an existing product database to seed from, or does the catalog start
   empty and grow from contributions?

Answer those and I will start at §13 step 1.
