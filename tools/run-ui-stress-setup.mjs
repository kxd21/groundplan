#!/usr/bin/env node
/**
 * Launch Groundplan and run the fresh room-setup UI stress harness.
 *
 *   npm run test:ui-stress-setup
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CDP, sleep, waitForCdpPage } from './ui-cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE =
  process.env.GROUNDPLAN_E2E_SAVE_PATH ||
  path.join(process.env.HOME || '', 'Downloads', 'Groundplan-setup-stress.rv4');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
const PORT = Number(new URL(CDP).port || 9222);
const SAVE_DIR = path.dirname(SAVE);
const SAVE_NAME = path.basename(SAVE);

function cdpUp() {
  return fetch(`${CDP}/json/list`)
    .then((r) => r.json())
    .then((pages) => pages.some((p) => p.type === 'page'))
    .catch(() => false);
}

async function main() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  try {
    fs.unlinkSync(SAVE);
  } catch {
    /* ok */
  }

  const childEnv = {
    ...process.env,
    GROUNDPLAN_E2E_SAVE_DIR: SAVE_DIR,
    GROUNDPLAN_E2E_SAVE_NAME: SAVE_NAME,
    GROUNDPLAN_E2E_SAVE_PATH: SAVE,
  };

  let child = null;
  if (await cdpUp()) {
    console.log('Stopping existing CDP session for a clean launch…');
    spawn('pkill', ['-f', 'electron-vite'], { stdio: 'ignore' });
    spawn('pkill', ['-f', 'Groundplan/node_modules/electron/dist/Electron'], { stdio: 'ignore' });
    spawn('pkill', ['-f', 'remote-debugging-port=9222'], { stdio: 'ignore' });
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      if (!(await cdpUp())) break;
    }
  }

  console.log('Starting Groundplan with CDP + E2E save path…');
  console.log('  SAVE', SAVE);
  console.log('  CDP ', CDP);
  child = spawn('npm', ['run', 'dev', '--', '--', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => {
    const s = buf.toString();
    if (/DevTools listening|error|Error|Pre-transform/.test(s)) process.stdout.write(`[dev] ${s}`);
  });
  child.stderr.on('data', (buf) => {
    const s = buf.toString();
    if (/DevTools listening|error|Error|Pre-transform|ready/i.test(s)) process.stderr.write(`[dev] ${s}`);
  });

  try {
    await waitForCdpPage(CDP, 120000);
    await sleep(2000);
    console.log('\nRunning fresh room-setup UI stress…\n');
    const stress = spawn('node', ['tools/ui-stress-room-setup.mjs'], {
      cwd: ROOT,
      env: { ...childEnv, GROUNDPLAN_CDP: CDP },
      stdio: 'inherit',
    });
    const code = await new Promise((resolve) => stress.on('exit', resolve));
    process.exitCode = code ?? 1;
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await sleep(500);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ok */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
