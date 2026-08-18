#!/usr/bin/env node
/** Dev server with CDP + E2E save-path bypass. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE =
  process.env.GROUNDPLAN_E2E_SAVE_PATH ||
  path.join(process.env.HOME || '', 'Downloads', 'CardParty-UI-stress.rv4');

console.log('E2E save →', SAVE);
const child = spawn('npx', ['electron-vite', 'dev', '--', '--remote-debugging-port=9222'], {
  cwd: ROOT,
  env: {
    ...process.env,
    GROUNDPLAN_E2E: '1',
    GROUNDPLAN_E2E_SAVE_PATH: SAVE,
    GROUNDPLAN_E2E_SAVE_DIR: path.dirname(SAVE),
    GROUNDPLAN_E2E_SAVE_NAME: path.basename(SAVE),
    GROUNDPLAN_E2E_GRANT_ROOT: path.dirname(SAVE),
  },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
