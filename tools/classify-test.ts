/**
 * Checks the gear classifier against descriptions taken from real rental lists.
 *
 * The rules run in order and are easy to break by adding one in the wrong
 * place — putting the flat-panel rule before the audio rules once turned a
 * "PA/Monitor Speaker" into a television. These cases pin the orderings that
 * matter.
 */

import { classify, parseSize } from '../src/inventory/classify.js';

let checks = 0;
let failures = 0;

function expect(description: string, category: string): void {
  checks++;
  const got = classify(description).category;
  if (got !== category) {
    failures++;
    console.error(`  FAIL  ${description}\n        expected ${category}, got ${got}`);
  }
}

// Projectors, including ones named only by model.
expect('Panasonic PT-RZ21KU Laser Projector', 'projector');
expect('20K Barco HDX-W20 FLEX Projector', 'projector');
expect('Xenon Projector', 'projector');

// A cable that names a projector is still a cable.
expect('Barco 20K IEC to L-630 - 3\'', 'not-drawn');
expect('Barco Short Throw Fixed Lens - .67:1', 'not-drawn');
expect('Panasonic ET-D75LE40 WU 4.6-7.4:1 Lens', 'not-drawn');

// Lighting, where the model name carries all the meaning.
expect('GLP Impression X4S', 'moving-light');
expect('SolaSpot Frame 1500 Fixture', 'moving-light');
expect('Source Four LED Ellipsoidal Series 2 Lustr', 'ellipsoidal');
expect('Chauvet Freedom Flex H4 IP Fixture', 'par-light');
expect('COLORdash Batten-Quad 12', 'light-batten');
expect('Astera FP5-NYX Bulbs', 'not-drawn');

// Audio must be decided before video, or "monitor" claims these.
expect('Behringer - Eurolive B205D Ultra-Compact 150-Watt PA/Monitor Speaker', 'speaker');
expect('L-Acoustics SB15M Subwoofer', 'subwoofer');
expect('Yamaha QL5 Digital Mixer', 'mixer');
expect('Shure ULXD-H50 Handheld Transmitter', 'not-drawn');
expect('K&M Boom Mic Stand', 'not-drawn');

// Video.
expect('65" Samsung Standard TV', 'flat-panel');
expect('Marshall Mini HD Camera', 'camera');
expect('Camera Riser Platform Package', 'riser');

// Structure.
expect('20.5" x 8\' Box Truss - Black', 'truss');
expect('36" Truss Base Plate', 'truss-base');
expect('4\' x 8\' Stage Deck', 'riser');
expect('Sumner Eventer 25\' Stage Lift', 'lift');
expect('Gray Velour Drape w/Pockets - 16\' x 14.5\'', 'drape');
expect('Upright - 7\'- 17\' (3 piece telescoping)', 'drape-upright');

// Package sub-components are not separate objects.
expect('Frame Stage Left - 11\'X20\'', 'not-drawn');
expect('Leg Stage Right - 6\'X10\'', 'not-drawn');
expect('Truss Socks - 20.5"x 10\' - White', 'not-drawn');
expect('Please send diffusion & holders', 'not-drawn');

// Sizes parsed out of descriptions, in tenths of an inch.
function expectSize(text: string, width: number, height: number): void {
  checks++;
  const got = parseSize(text);
  if (got.width !== width || got.height !== height) {
    failures++;
    console.error(
      `  FAIL  ${text}\n        expected ${width}x${height}, got ${got.width}x${got.height}`,
    );
  }
}

expectSize('4\' x 8\' Stage Deck', 480, 960);
expectSize('20.5" x 8\' Box Truss - Black', 205, 960);
expectSize('Riser 6\'x8\'', 720, 960);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
