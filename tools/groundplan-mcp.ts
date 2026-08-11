#!/usr/bin/env node
/**
 * Thin MCP server for Groundplan layout recipes (stdio JSON-RPC).
 *
 *   npx tsx tools/groundplan-mcp.ts
 *
 * Tools call the same applyFullLayoutRecipe path as the CLI / in-app Apply kit.
 * Configure in Cursor MCP settings as a stdio server pointing at this script.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { Session } from '../src/main/session.js';
import { openPlanModel, resetPlanModel } from '../src/main/plan-model.js';
import { createBlankPlan } from '../src/format/blank.js';
import { buildSchedule } from '../src/format/schedule.js';
import { loadBuffer } from '../src/format/index.js';
import {
  isLayoutRecipe,
  recipeCatalogueStub,
  validateLayoutRecipe,
  type LayoutRecipe,
} from '../src/inventory/layout-recipe.js';
import { applyFullLayoutRecipe, recipeBlankPlanArgs } from '../src/inventory/apply-layout.js';
import { emptyInventory, mergeItems } from '../src/inventory/model.js';
import { listLayoutKits, loadLayoutKit } from '../src/inventory/layout-kits.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER_DATA = process.env.GROUNDPLAN_USER_DATA || join(process.env.HOME || '.', '.groundplan-agent');

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const TOOLS = [
  {
    name: 'validate_layout_recipe',
    description: 'Validate a groundplan-layout-recipe v1 JSON object (seat maths + structure).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'object', description: 'Layout recipe object' },
        recipePath: { type: 'string', description: 'Path to recipe JSON file' },
      },
    },
  },
  {
    name: 'list_layout_kits',
    description: 'List bundled and user layout kits available to apply.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apply_layout_recipe',
    description:
      'Create or overwrite an .rv4 plan by applying a layout recipe (room, stage, seating, gear, labels). Same path as Show kits → Apply kit.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'object' },
        recipePath: { type: 'string' },
        kitId: { type: 'string', description: 'Id from list_layout_kits' },
        outPath: { type: 'string', description: 'Output .rv4 path' },
      },
      required: ['outPath'],
    },
  },
  {
    name: 'open_plan_summary',
    description: 'Read chair/gear counts from an existing .rv4 file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

function loadRecipe(params: Record<string, unknown>): LayoutRecipe {
  if (typeof params.kitId === 'string') {
    const kit = loadLayoutKit(USER_DATA, params.kitId);
    if (!kit) throw new Error(`kit not found: ${params.kitId}`);
    return kit;
  }
  if (typeof params.recipePath === 'string') {
    const raw = JSON.parse(readFileSync(resolve(params.recipePath), 'utf8'));
    if (!isLayoutRecipe(raw)) throw new Error('file is not a groundplan-layout-recipe v1');
    return raw;
  }
  if (params.recipe && isLayoutRecipe(params.recipe)) return params.recipe as LayoutRecipe;
  throw new Error('provide recipe, recipePath, or kitId');
}

async function callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  if (name === 'validate_layout_recipe') {
    const recipe = loadRecipe(params);
    const inv = emptyInventory();
    mergeItems(inv, recipeCatalogueStub(recipe));
    return validateLayoutRecipe(recipe, inv);
  }
  if (name === 'list_layout_kits') {
    return listLayoutKits(USER_DATA);
  }
  if (name === 'open_plan_summary') {
    const path = resolve(String(params.path));
    const loaded = loadBuffer(readFileSync(path), path);
    const sched = buildSchedule(loaded.document);
    const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    const gear = sched.groups.filter((g) => !/chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    return {
      path,
      chairs,
      gear,
      groups: sched.groups.map((g) => ({ name: g.name, count: g.count })),
    };
  }
  if (name === 'apply_layout_recipe') {
    const recipe = loadRecipe(params);
    const outPath = resolve(String(params.outPath));
    const inv = emptyInventory();
    mergeItems(inv, recipeCatalogueStub(recipe));
    const validated = validateLayoutRecipe(recipe, inv);
    if (!validated.ok) return validated;

    const blank = createBlankPlan(recipeBlankPlanArgs(recipe));
    if (!blank.ok || !blank.file) return { ok: false, reason: blank.reason };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, blank.file);

    resetPlanModel();
    const session = new Session(outPath, readFileSync(outPath));
    await openPlanModel(outPath, session.loaded.document, 'imperial');
    session.checkpoint();
    const applied = applyFullLayoutRecipe(session, recipe, {
      inventory: inv,
      replaceExistingSeating: true,
      forceRoom: true,
    });
    if (!applied.ok) {
      session.rollback();
      return applied;
    }
    writeFileSync(outPath, session.file());
    const sched = buildSchedule(session.loaded.document);
    const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    return {
      ok: true,
      path: outPath,
      status: applied.status,
      chairs,
      chairsPlaced: applied.chairsPlaced,
      gearPlaced: applied.gearPlaced,
      stagesPlaced: applied.stagesPlaced,
    };
  }
  throw new Error(`unknown tool: ${name}`);
}

function reply(msg: JsonRpc): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg: JsonRpc): Promise<void> {
  const id = msg.id ?? null;
  try {
    if (msg.method === 'initialize') {
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'groundplan', version: '1.2.1' },
        },
      });
      return;
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'initialized') return;
    if (msg.method === 'tools/list') {
      reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, args);
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      });
      return;
    }
    if (msg.method === 'ping') {
      reply({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    reply({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  } catch (err) {
    reply({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

if (!existsSync(join(ROOT, 'tools', 'fixtures', 'card-party-layout-recipe.json'))) {
  process.stderr.write('warning: card-party fixture not found next to repo root\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: JsonRpc;
  try {
    msg = JSON.parse(trimmed) as JsonRpc;
  } catch {
    return;
  }
  void handle(msg);
});
