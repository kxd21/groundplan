#!/usr/bin/env node
/**
 * The UI half of the gate.
 *
 *   npm run test:ui
 *
 * `npm test` holds the file and geometry layers to byte-identity, and holds the
 * interface to nothing. Every interface bug found in the 1.2.3 review — a print
 * preview that drew no plan, a setup checklist that still read "done" after the
 * undo that emptied the room, furniture that could only be clicked on its
 * outline — was reachable by a script and caught by none, because the harnesses
 * that could have caught them were not runnable unattended:
 *
 *   - `ui-stress-contrast` exited telling the operator to start `npm run dev`.
 *   - `command-run` waited 60s for a CDP session that nothing had started.
 *
 * They were attach-mode tools, not tests. This gives them the missing half: one
 * app launch, every check against that session, guaranteed teardown, and a
 * non-zero exit if any of them fail.
 *
 * The save path is redirected into a temp directory. Several of these harnesses
 * default to writing under ~/Downloads, which is nobody's idea of a test
 * fixture directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = process.env.GROUNDPLAN_CDP || 'http://127.0.0.1:9222';
const PORT = Number(new URL(CDP).port || 9222);
const LAUNCH_TIMEOUT_MS = 90_000;

/** Checks that run against one shared session, in order. */
const CHECKS = [
  { id: 'commands', script: 'command-run.mjs', what: 'command catalogue resolves and dispatches' },
  { id: 'usability', script: 'ui-stress-usability.mjs', what: 'whole-app usability and responsiveness' },
  { id: 'contrast', script: 'ui-stress-contrast.mjs', what: 'WCAG contrast across themes and surfaces' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdpUp = () =>
  fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .then((pages) => pages.some((p) => p.type === 'page'))
    .catch(() => false);

/**
 * Decides what to do about a CDP session that is already listening.
 *
 * Reusing one is how this used to behave, and it is why the gate could report a
 * dozen failures that had nothing to do with the code: a leftover Electron from
 * an earlier run — possibly a different build, possibly parked on the welcome
 * screen — was driven as though the gate had put it there. A gate that does not
 * know what state it is testing is not a gate.
 *
 * So the default is to refuse and say which processes are in the way. Reuse is
 * still available for the attach workflow, but it has to be asked for, because
 * asking for it is the moment you take responsibility for the state.
 */
async function freePort() {
  if (!(await cdpUp())) return;

  if (process.env.GROUNDPLAN_REUSE_CDP === '1') {
    console.log('· a CDP session is already up — reusing it (GROUNDPLAN_REUSE_CDP=1)');
    return 'reused';
  }

  let owners = '';
  try {
    owners = execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf8' }).trim();
  } catch {
    /* lsof is best-effort; the message is still useful without it. */
  }

  console.error(
    `\nui gate: something is already serving CDP on ${PORT}.\n` +
      (owners ? `  process ${owners.split('\n').join(', ')}\n` : '') +
      '  This is usually a Groundplan left running from an earlier session, and\n' +
      '  driving it would test whatever state it happens to be in.\n\n' +
      `  Close it — pkill -f "Groundplan/node_modules/electron" — and run again,\n` +
      '  or set GROUNDPLAN_REUSE_CDP=1 to drive it deliberately.',
  );
  process.exit(2);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'groundplan-ui-gate-'));
  const env = {
    ...process.env,
    GROUNDPLAN_KEEP_CDP: '1',
    GROUNDPLAN_E2E_SAVE_DIR: sandbox,
    GROUNDPLAN_E2E_SAVE_NAME: 'ui-gate.rv4',
    GROUNDPLAN_E2E_SAVE_PATH: path.join(sandbox, 'ui-gate.rv4'),
    GROUNDPLAN_E2E_GRANT_ROOT: sandbox,
  };

  const reused = await freePort();
  let app = null;

  if (!reused) {
    console.log(`· launching Groundplan with CDP on ${PORT}`);
    app = spawn('npm', ['run', 'dev', '--', '--', `--remote-debugging-port=${PORT}`], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
      detached: false,
    });
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline && !(await cdpUp())) await sleep(500);
    if (!(await cdpUp())) {
      app.kill('SIGKILL');
      rmSync(sandbox, { recursive: true, force: true });
      console.error(`\nui gate: the app never exposed CDP on ${PORT} within ${LAUNCH_TIMEOUT_MS / 1000}s`);
      process.exit(2);
    }
    // The renderer needs to finish first paint before anything can be driven.
    await sleep(3000);
  }

  const results = [];
  for (const check of CHECKS) {
    console.log(`\n──────── ${check.id}: ${check.what}`);
    const code = await run('node', [path.join('tools', check.script)], env);
    results.push({ ...check, code });
  }

  if (app) {
    app.kill('SIGTERM');
    await sleep(1500);
    app.kill('SIGKILL');
  }
  rmSync(sandbox, { recursive: true, force: true });

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n═══════ ui gate ═══════');
  for (const r of results) console.log(`  ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.id}`);
  if (failed.length) {
    console.error(`\n${failed.length} of ${results.length} UI checks failed`);
    process.exit(1);
  }
  console.log(`\nall ${results.length} UI checks passed`);
}

await main();
