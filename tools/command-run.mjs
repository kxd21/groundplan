#!/usr/bin/env node
/**
 * Smoke-test structured commands over CDP.
 * Usage: node tools/command-run.mjs [commandId]
 * Requires Electron with --remote-debugging-port=9222.
 */
import { connectCdp } from './ui-cdp.mjs';

const id = process.argv[2] ?? 'mode.inspect';
const base = process.env.GROUNDPLAN_CDP ?? 'http://127.0.0.1:9222';

const cdp = await connectCdp({ base });
try {
  const catalog = await cdp.ev(`window.groundplan.commandsList()`);
  if (!Array.isArray(catalog) || catalog.length < 10) {
    throw new Error(`commandsList failed: ${JSON.stringify(catalog)}`);
  }

  const reply = await cdp.ev(`window.groundplan.commandsRun(${JSON.stringify(id)})`);
  if (!reply?.ok) {
    throw new Error(`commandsRun(${id}) failed: ${JSON.stringify(reply)}`);
  }

  const statusCommand = await cdp.ev(
    `document.querySelector('.statusbar .status-command')?.textContent?.trim() || ''`,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: id,
        catalogSize: catalog.length,
        statusCommand: statusCommand || null,
      },
      null,
      2,
    ),
  );
} finally {
  cdp.close();
}
