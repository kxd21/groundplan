## Groundplan __VERSION__

Installers for first-time setup. After install, Groundplan can update itself
(Help → Check for Updates) or from a USB stick.

### What’s new in this release

**Shell redesign**
- Exclusive modes: Browse · Place · Inspect · Setup · Draw
- Command palette (⌘K) with the same stable IDs as menus and agent IPC
- Agent playbook: `docs/agent-commands.md` · `npm run test:commands`

**Readable chrome**
- Dark and light text contrast across Settings, Place, doc tabs, and Inspect Layers
- Status bar shows mode + last command; Help shortcuts stay in sync with the catalog

**Reliability**
- New Plan no longer hangs on a dirty open file (quiet autosave first)
- Open folder / Open file busy toast releases if the system dialog stays open

**Room edit**
- One layout workspace for size and walls; Inspect → Room opens that path

### Also in 1.2.x

**Show scale: 20-person rooms through concert floors**
- New Plan quick starts and bundled show kits
- Group / Ungroup; banquet / classroom layout recipes

**Setup polish**
- Room-first New Plan; autosave into Documents/Groundplan
- Edit walls mode; atomic Save / Save As with `.bak` backups

### Download page

Open the [download guide](https://kxd21.github.io/groundplan/download/) for an
OS-detected button and Gatekeeper / SmartScreen steps — or pick a file below.

| Machine | File |
| --- | --- |
| Mac, Apple silicon | `Groundplan-__VERSION__-mac-arm64.dmg` |
| Mac, Intel | `Groundplan-__VERSION__-mac-x64.dmg` |
| Windows 10/11 | `Groundplan-Setup-__VERSION__-win-x64.exe` |
| Windows, no admin | `Groundplan-Portable-__VERSION__-win-x64.exe` |
| Linux (x64) | `Groundplan-__VERSION__-linux-x64.AppImage` |

### First open

- **macOS:** if Gatekeeper blocks the app, right-click → Open → Open again (once). Builds are not Apple-notarised yet.
- **Windows:** if SmartScreen appears, More info → Run anyway. Builds are not Authenticode-signed yet.

Full instructions: [docs/installation.md](https://github.com/kxd21/groundplan/blob/main/docs/installation.md)
