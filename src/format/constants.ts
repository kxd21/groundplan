/**
 * The coordinate system, on its own.
 *
 * Room Viewer works in tenths of an inch. These two numbers are needed by the
 * parser, by every geometry module, and — through `units.ts` — by the renderer,
 * which runs in a browser context and cannot import anything that reaches
 * `Buffer` or `node:`. Keeping them in a file with no imports of its own is
 * what lets one definition serve all three rather than being restated.
 */

export const UNITS_PER_INCH = 10;
export const UNITS_PER_FOOT = 120;
