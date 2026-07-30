# AGENTS.md

## Cursor Cloud specific instructions

Groundplan is a single **Electron desktop application** (electron-vite + React +
TypeScript) that reads and edits legacy Room Viewer floor-plan files. There is no
server/backend and no database — everything runs in one Electron process tree.
Standard commands live in `package.json` `scripts` and `README.md`; only the
non-obvious cloud caveats are captured here.

### Running the GUI headlessly

`npm run dev` launches Electron, which needs an X display and a sandbox opt-out
in this container:

- A VNC desktop is already running on `DISPLAY=:1` (this is the display the
  computer-use tooling controls). Start the app with `DISPLAY=:1` so it is
  visible/interactable, e.g. `DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 npm run dev`.
  Run it in a long-lived tmux session, not a one-shot foreground command.
- `ELECTRON_DISABLE_SANDBOX=1` is required — the Chromium sandbox cannot
  initialize in this container and Electron exits without it.
- If you only need to smoke-test without interaction, `xvfb-run -a npm run dev`
  works too, but that renders to a throwaray display the computer-use tools
  cannot see.
- Harmless noise you can ignore at startup: `Failed to connect to the bus`
  (no D-Bus), `dconf-WARNING ... transport "disabled"`, and a transient
  `CreateCommandBuffer` / GPU message (software rendering). None of these
  indicate a failure.

### Working with plans in the app

- Creating a new plan (New plan → Create plan…) opens a **native GTK Save
  dialog**; you must pick a location (e.g. the Home folder) to complete it. It
  writes a real `.rv4` OLE2 compound-document file on disk and then opens it.
- A blank plan has no label template, so pressing `T` to add a text label
  reports "This plan has no compatible label template." That is expected —
  labels/dimensions are created by cloning an existing one (see `annotate.ts`).
  To demonstrate an edit on a fresh plan, use the draw/pen tool or move an
  object instead.
- The "Recover unsaved work" entry that appears after an edit is the normal
  autosave/recovery feature, not an error.

### Lint / test / build

- There is no ESLint config; `npm run typecheck` (`tsc --noEmit`) is the type/lint
  gate.
- `npm test` is the hermetic domain test suite — it builds a synthetic plan and
  needs no external files or corpus, so it runs fully in CI/cloud.
- `npm run check` = typecheck + test + production build. `npm run build`
  (electron-vite) produces `out/`.
- Corpus-dependent scripts (`scan`, `roundtrip`, `test:corpus`, etc.) need a
  private production plans directory that is not in the repo; skip them here.
