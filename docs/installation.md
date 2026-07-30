# Installing Groundplan

Groundplan opens Room Viewer floor plans (`.rv4` and friends) on Windows and
macOS. Room Viewer itself is not needed and does not have to be installed.

---

## Which download

| Your machine | File |
| --- | --- |
| Mac, Apple silicon (M1 and later) | `Groundplan-<version>-arm64.dmg` |
| Mac, Intel | `Groundplan-<version>.dmg` |
| Windows 10 or 11 | `Groundplan-Setup-<version>.exe` |
| Windows, no admin rights | `Groundplan-<version>-portable.exe` |
| Linux | `Groundplan-<version>.AppImage` |

To check which Mac you have: **Apple menu → About This Mac**. "Apple M1", "M2",
"M3" or "M4" means arm64. Downloading the wrong one is not harmful — it just
will not open.

---

## macOS

1. Open the `.dmg` and drag **Groundplan** into **Applications**.
2. Eject the disk image.
3. Open Groundplan from Applications.

**"Groundplan can't be opened because Apple cannot check it for malicious
software."** This appears when the build has not been notarised by Apple.
Right-click (or Control-click) the app and choose **Open**, then **Open** again
in the dialog. You only have to do this once.

**"Groundplan is damaged and can't be opened."** macOS shows this for a
downloaded app whose quarantine flag it cannot resolve. Remove the flag:

```bash
xattr -dr com.apple.quarantine /Applications/Groundplan.app
```

---

## Windows

1. Run `Groundplan-Setup-<version>.exe`.
2. Choose **Just me** unless you want every user on the machine to have it.
3. Finish, and launch from the Start menu.

**"Windows protected your PC."** SmartScreen shows this for installers it has
not seen often yet. Click **More info**, then **Run anyway**.

**No admin rights?** Use the portable build. It needs no installation — put it
anywhere you can write, including a USB stick, and run it. Settings and the
equipment inventory are still saved to your user profile.

---

## Linux

```bash
chmod +x Groundplan-<version>.AppImage
./Groundplan-<version>.AppImage
```

If it will not start, install FUSE (`sudo apt install libfuse2` on Debian and
Ubuntu), or extract it with `--appimage-extract` and run the binary inside.

---

## Opening your first plan

**File → Open**, then pick a plan. Groundplan reads:

| Extension | What it is |
| --- | --- |
| `.rv4` | A floor plan — the main one |
| `.rs4`, `.se4`, `.ds4` | Shape sets and saved elements |
| `.add`, `.stk`, `.lib` | Symbol libraries |
| `.rsd` | A single shape |

**Plans open read-only unless Groundplan can prove it understands them.** Before
a file can be saved it must re-serialize to exactly the bytes it was read from.
A plan that fails that check opens normally, and everything except saving works —
you can view, measure, print and export it. This holds for all but one file in a
1,955-plan test corpus, so it is rare, but it is deliberate: a file it does not
fully understand is a file it will not risk writing over.

---

## Where your data lives

Groundplan never writes into your plans without being asked, and it keeps its
own data in two places.

**Beside each plan**, as ordinary files you can copy, back up and delete:

| File | What it holds |
| --- | --- |
| `Plan.rv4.groundplan.json` | The room model, seating plans, stage builds, layers |
| `Plan.rv4.groundplan-data.json` | Schedule fields — purpose, channel, weight, power |
| `Plan.rv4.groundplan-dimensions.json` | Which dimensions are attached to which objects |

Delete any of them and the plan still opens; you lose only the extra
information, never the drawing. **Copy the plan somewhere else and these do not
follow it**, so move them together.

**In your user profile**, the equipment inventory and settings:

- macOS — `~/Library/Application Support/Groundplan/`
- Windows — `%APPDATA%\Groundplan\`
- Linux — `~/.config/Groundplan/`

---

## Keeping files compatible with Room Viewer

Everything Groundplan writes is ordinary Room Viewer geometry, so a plan it has
edited still opens in Room Viewer. Two things are worth knowing:

- **Room Viewer does not read the companion files.** A room, a seating plan or a
  stage build is drawn into the `.rv4` as walls, chairs and deck outlines, which
  Room Viewer shows normally — but the parameters behind them live in the
  companion, so editing the plan in Room Viewer and coming back means
  Groundplan can no longer match its saved settings to the drawing. It notices
  and tells you, rather than applying settings that no longer describe the file.

- **Layers are a Groundplan idea.** Hiding a layer changes what you see and what
  prints; it does not remove anything from the file. A hidden layer is still
  there when the plan is opened elsewhere.

---

## Updating

Groundplan checks for updates on start and installs them in the background. Each
update is signed, and one with a signature that does not verify is discarded
rather than installed. **Help → Check for Updates** forces a check.

---

## Uninstalling

- **macOS** — drag Groundplan from Applications to the Bin.
- **Windows** — Settings → Apps → Groundplan → Uninstall, or delete the
  portable `.exe`.
- **Linux** — delete the AppImage.

None of these remove your inventory or your companion files. To remove those
too, delete the user-profile folder listed above, and any `.groundplan*.json`
files beside your plans.

---

## If something goes wrong

**A plan opens but looks empty.** The file may be a shape library rather than a
floor plan — those hold symbols, not a room. Check the status bar, which reports
what kind of file was opened and how many objects were read.

**A plan opens read-only.** See the round-trip note above. **Help → Why is this
read-only?** reports which part of the file could not be accounted for.

**Text or dimensions look wrong after editing elsewhere.** If a plan was saved
in Room Viewer since Groundplan last wrote it, the companion data no longer
lines up. Groundplan says so on open and offers to work out the room again from
the drawing.
