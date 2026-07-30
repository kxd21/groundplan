/**
 * Renders a plan to SVG without launching the UI — used to eyeball parser
 * output during development and to batch-convert plans.
 *
 *   npm run inspect -- <file>              # numbers
 *   npx tsx tools/export-svg.ts <file> <out.svg>
 */

import { writeFileSync } from 'node:fs';

import { loadFile } from '../src/format/index.js';
import { buildScene, type Layer } from '../src/format/scene.js';
import { toSvg } from '../src/renderer/src/svg.js';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: export-svg <input> <output.svg>');
  process.exit(1);
}

const loaded = loadFile(input);
const scene = buildScene(loaded.document);
const layers = new Set<Layer>(['walls', 'furniture', 'annotation', 'region', 'other']);

writeFileSync(output, toSvg(scene, layers), 'utf8');

const e = scene.extent;
console.log(`${loaded.name}`);
console.log(`  primitives ${scene.primitives.length}`);
if (e) {
  console.log(`  extent     ${((e.maxX - e.minX) / 120).toFixed(1)}ft x ${((e.maxY - e.minY) / 120).toFixed(1)}ft`);
}
console.log(`  inventory  ${scene.inventory.slice(0, 6).map((i) => `${i.name} x${i.count}`).join(', ')}`);
console.log(`  wrote      ${output}`);
