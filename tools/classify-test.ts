/**
 * Checks the gear classifier against descriptions taken from real rental lists.
 *
 * The rules run in order and are easy to break by adding one in the wrong
 * place — putting the flat-panel rule before the audio rules once turned a
 * "PA/Monitor Speaker" into a television. These cases pin the orderings that
 * matter.
 */

import { classify, parseSize, splitView } from '../src/inventory/classify.js';

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

/*
 * Elevation drawings are the same object, seen from somewhere else.
 *
 * Room Viewer ships each object several times over — `Buffet Line 1`, `(FV)`,
 * `(SV)` — and 321 of the 828 rows in a stock catalogue are elevations. The
 * suffix used to defeat every pattern in the classifier, so `Podium/Lectern`
 * was a podium and `Podium/Lectern (SV)` was nothing at all, and a picker in a
 * TOP-DOWN plan offered a table drawn from the side.
 */
function expectView(description: string, view: string, baseName: string): void {
  const got = splitView(description);
  const ok = got.view === view && got.baseName === baseName;
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${description} — got ${got.view} / "${got.baseName}"`);
  }
}

expectView('Buffet Line 1', 'plan', 'Buffet Line 1');
expectView('Buffet Line 1 (FV)', 'front', 'Buffet Line 1');
expectView('Buffet Line 1 (SV)', 'side', 'Buffet Line 1');
expectView('Barco 8100 (RV)', 'rear', 'Barco 8100');
expectView('Box Truss (R)', 'rear', 'Box Truss');
expectView('Round 30" (FV-SV)', 'front-side', 'Round 30"');
// A parenthesis that is not a view tag stays part of the name.
expectView('Casino - Single Roulette (8\')', 'plan', 'Casino - Single Roulette (8\')');
expectView('Obstacle Course (2 Mod)', 'plan', 'Obstacle Course (2 Mod)');

// An elevation classifies as whatever the object IS.
expect('Podium/Lectern (SV)', 'podium');
expect('Round 60" (FV)', 'table-round');
expect('Speaker - EAW BH853F (FV)', 'speaker');
expect('Steps (SV)', 'stairs');

/*
 * The furniture a stock catalogue is mostly made of.
 *
 * Two thirds of it used to land in `not-drawn` — 111 rows of buffet line alone,
 * plus every serpentine, square and half round. An uncategorised item cannot be
 * offered in the table picker, grouped in a palette, or filtered out of one; it
 * just swells a flat list of 828 names.
 */
expect('Buffet Line 12', 'table-rect');
expect('Serpentine 24"x48"', 'table-round');
expect('Half Round', 'table-round');
expect('Quarter Round', 'table-round');
expect('Square 3\'x3\'', 'table-rect');
expect("Family 6'x30\"", 'table-rect');
expect('Plate 10"', 'table-round');
expect('Stacked Chairs', 'chair');
expect('18"x18" - No Detail', 'chair');
expect('18" x 18"', 'chair');
expect('Piano - Grand', 'desk');
expect('Whiteboard 3x5', 'desk');
expect('Flipchart', 'desk');
expect('Booth 10\' x 10\'', 'table-rect');
expect('Plasma - 42"', 'flat-panel');
expect('Door - Double (Out)', 'door');
expect('Door - Single (In) Left Swing', 'door');
expect('Source Four barn door', 'not-drawn');

// …without swallowing things that are not furniture.
expect('Box Truss', 'truss');
expect('Speaker', 'speaker');
expect('Genie Lift', 'lift');

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
