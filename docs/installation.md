# Installing Groundplan

Groundplan opens legacy event floor plans (`.rv4` and friends) on Windows and
macOS. The original editor is not needed and does not have to be installed.

**Prefer the [download page](https://kxd21.github.io/groundplan/download/)** — it
detects your computer and offers one primary installer. Or pick a file from
[GitHub Releases](https://github.com/kxd21/groundplan/releases/latest).

---

## Which download

| Your machine | File |
| --- | --- |
| Mac, Apple silicon (M1 and later) | `Groundplan-<version>-mac-arm64.dmg` |
| Mac, Intel | `Groundplan-<version>-mac-x64.dmg` |
| Windows 10 or 11 | `Groundplan-Setup-<version>-win-x64.exe` |
| Windows, no admin rights | `Groundplan-Portable-<version>-win-x64.exe` |
| Linux (x64) | `Groundplan-<version>-linux-x64.AppImage` |

To check which Mac you have: **Apple menu → About This Mac**. "Apple M1", "M2",
"M3" or "M4" means arm64. Downloading the wrong one is not harmful — it just
will not open.

---

## macOS

1. Open the `.dmg` and drag **Groundplan** into **Applications**.
2. Eject the disk image.
3. Open Groundplan from Applications.

### The first open needs one extra step

macOS will refuse to open Groundplan the first time, with a message like
**"Apple could not verify 'Groundplan' is free of malware that may harm your
Mac or compromise your privacy."**

This is expected, and it is not a warning about Groundplan specifically. Apple
shows it for any app that has not been through their paid notarisation service.
Groundplan is distributed without it, so the message appears for every copy.

**You approve the app once. It opens normally forever after.**

Which steps you follow depends on your macOS version — Apple changed this in
macOS 15. Check with **Apple menu → About This Mac**.

#### macOS 15 (Sequoia), macOS 26 (Tahoe) and later

Control-clicking no longer works on these versions. Use System Settings:

1. Double-click **Groundplan**. A dialog says it cannot be opened. Click
   **Done**.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section. You will see
   *"Groundplan" was blocked to protect your Mac.*
4. Click **Open Anyway**.
5. Authenticate with Touch ID or your password.
6. A final dialog appears. Click **Open Anyway** again.

Groundplan opens, and opens directly from then on.

> The Security section only shows the message for about an hour after the app
> was blocked. If it is not there, double-click Groundplan again and go
> straight back to Privacy & Security.

#### macOS 14 (Sonoma) and earlier

1. **Control-click** (or right-click) **Groundplan** in Applications.
2. Choose **Open**.
3. Click **Open** in the dialog.

The Control-click matters: it is what turns the block into a choice.
Double-clicking will only ever refuse.

### If it says "damaged and can't be opened"

macOS shows this for a downloaded app whose quarantine flag it cannot resolve —
usually after the file was moved between machines. Remove the flag:

```bash
xattr -dr com.apple.quarantine /Applications/Groundplan.app
```

Then open the app normally.

### Why not just sign it?

Removing the prompt requires an Apple Developer Program membership and a
"Developer ID Application" certificate, which carries an annual fee. The
project is not enrolled, so the one-time approval above is the trade. The
build **is** signed — ad-hoc, which is what lets it run on Apple silicon at all
— it is simply not notarised by Apple.

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

1. Download the `.AppImage`.
2. Make it executable and run it:

```bash
chmod +x Groundplan-<version>-linux-x64.AppImage
./Groundplan-<version>-linux-x64.AppImage
```

On some distributions you may need FUSE support for AppImages. If the file will
not start, check your distro’s AppImage / FUSE docs, or extract with
`--appimage-extract` and run the binary inside.

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

## Keeping files compatible with the original editor

Everything Groundplan writes is ordinary legacy geometry, so a plan it has
edited still opens in the original editor. Two things are worth knowing:

- **The original editor does not read the companion files.** A room, a seating
  plan or a stage build is drawn into the `.rv4` as walls, chairs and deck
  outlines, which it shows normally — but the parameters behind them live in the
  companion, so editing the plan there and coming back means
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

### Updating with no internet

Machines in back-of-house offices and convention centre basements often have no
usable network, so a release also travels on a USB stick.

**To install one:** plug the stick in, open Groundplan, and choose
**Help → Install Update from USB…**, then pick the release folder (or just the
drive — it will find the folder). It copies the update off the stick, checks it,
and restarts.

**It is checked exactly like a downloaded one.** The manifest must carry a
signature from Groundplan's key, and the archive must match the hash that signed
manifest names. A stick someone hands you is therefore no more dangerous than a
web server — both have to clear the same two gates. Editing any file in the
folder will cause the update to be refused, which is the point.

**To prepare one** (needs the signing key):

```bash
npm run build && npx electron-builder --mac --win
npm run usb -- --version 1.1.0 --out /Volumes/YOUR_USB/GROUNDPLAN
```

That writes one folder holding the signed manifest, the self-update packages,
and the installers for a machine that has never had Groundplan on it — so the
same stick serves both "update mine" and "put it on this laptop". A `README.txt`
in the folder explains which to use.

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
in the original editor since Groundplan last wrote it, the companion data no longer
lines up. Groundplan says so on open and offers to work out the room again from
the drawing.
