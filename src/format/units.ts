/**
 * Reading and writing measurements.
 *
 * Room Viewer works in tenths of an inch and nothing changes that — the stored
 * geometry is imperial whatever the user prefers to type. Units are a display
 * and entry concern only, which is why this module converts at the edges and
 * every other module keeps working in logical units.
 *
 * Entry is deliberately forgiving. People type `12'6"`, `12' 6`, `12.5ft`,
 * `150"`, `3.6m` and `3600mm` for the same handful of measurements, and a
 * dimension box that rejects four of those is a dimension box people stop
 * using.
 */

// From `constants.ts`, not `rv.ts`: the renderer imports this module for real
// and must not be dragged into the parser, which touches `Buffer`.
import { UNITS_PER_FOOT, UNITS_PER_INCH } from './constants.js';

export type UnitSystem = 'imperial' | 'metric';

/** Logical units in one metre: 39.3700787in x 10. */
export const UNITS_PER_METRE = 393.7007874015748;
export const UNITS_PER_CENTIMETRE = UNITS_PER_METRE / 100;
export const UNITS_PER_MILLIMETRE = UNITS_PER_METRE / 1000;

/** Square logical units in one square foot, and in one square metre. */
const SQ_UNITS_PER_SQ_FOOT = UNITS_PER_FOOT * UNITS_PER_FOOT;
const SQ_UNITS_PER_SQ_METRE = UNITS_PER_METRE * UNITS_PER_METRE;

export interface FormatOptions {
  /** Decimal places on the smallest unit shown. */
  precision?: number;
  /** Append the unit symbol. Metric always does; imperial marks feet/inches. */
  compact?: boolean;
}

/**
 * Renders a length for display.
 *
 * Imperial reads as feet and inches, the way a floor plan is dimensioned —
 * `12' 6"`, not `12.5'`. Whole feet drop the inches rather than printing `0"`.
 */
export function formatLength(units: number, system: UnitSystem = 'imperial', options: FormatOptions = {}): string {
  if (!Number.isFinite(units)) return '—';

  if (system === 'metric') {
    const metres = units / UNITS_PER_METRE;
    const precision = options.precision ?? (Math.abs(metres) < 1 ? 3 : 2);
    if (Math.abs(metres) < 1) {
      return `${(units / UNITS_PER_CENTIMETRE).toFixed(Math.max(0, precision - 2))} cm`;
    }
    return `${metres.toFixed(precision)} m`;
  }

  const sign = units < 0 ? '-' : '';
  const totalInches = Math.abs(units) / UNITS_PER_INCH;
  const precision = options.precision ?? 1;

  let feet = Math.floor(totalInches / 12);
  let inches = totalInches - feet * 12;

  // Rounding the inches can carry into the next foot; do it before formatting
  // so 11.99in prints as 1' 0" rather than 0' 12".
  const rounded = Number(inches.toFixed(precision));
  if (rounded >= 12) {
    feet += 1;
    inches = 0;
  } else {
    inches = rounded;
  }

  const inchText = inches.toFixed(precision).replace(/\.?0+$/, '');
  if (!inchText || inchText === '0') return `${sign}${feet}'`;
  if (feet === 0) return `${sign}${inchText}"`;
  return `${sign}${feet}' ${inchText}"`;
}

/** Renders an area in the system's usual unit. */
export function formatArea(squareUnits: number, system: UnitSystem = 'imperial'): string {
  if (!Number.isFinite(squareUnits)) return '—';
  if (system === 'metric') {
    return `${(squareUnits / SQ_UNITS_PER_SQ_METRE).toFixed(1)} m²`;
  }
  return `${Math.round(squareUnits / SQ_UNITS_PER_SQ_FOOT).toLocaleString('en-US')} sq ft`;
}

/** Area in square feet, the unit every capacity rule of thumb is stated in. */
export function toSquareFeet(squareUnits: number): number {
  return squareUnits / SQ_UNITS_PER_SQ_FOOT;
}

export function toSquareMetres(squareUnits: number): number {
  return squareUnits / SQ_UNITS_PER_SQ_METRE;
}

/** Converts a length in logical units to feet, metres, or whatever is asked. */
export function toFeet(units: number): number {
  return units / UNITS_PER_FOOT;
}

export function toMetres(units: number): number {
  return units / UNITS_PER_METRE;
}

export function fromFeet(feet: number): number {
  return feet * UNITS_PER_FOOT;
}

export function fromMetres(metres: number): number {
  return metres * UNITS_PER_METRE;
}

/**
 * Parses a typed measurement into logical units.
 *
 * Returns `null` rather than a guess when the text is not a measurement, so a
 * dimension box can leave the old value alone instead of silently resizing
 * something to zero.
 *
 * Accepted, in either system:
 *   `12' 6"`  `12'6`  `12ft 6in`  `12.5'`  `150"`  `6 in`
 *   `3.6m`  `360cm`  `3600mm`  `3.6 metres`
 * A bare number means feet in imperial and metres in metric, which is what the
 * unit toggle is for.
 */
export function parseLength(text: string, system: UnitSystem = 'imperial'): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[”″]/g, '"')
    .replace(/[’′]/g, "'")
    .replace(/\s+/g, ' ');
  if (!cleaned) return null;

  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1).trim() : cleaned;
  const signed = (value: number) => (negative ? -value : value);

  // Metric is unambiguous: the suffix names the unit.
  const metric = body.match(/^(\d+(?:\.\d+)?)\s*(mm|millimet(?:re|er)s?|cm|centimet(?:re|er)s?|m|met(?:re|er)s?)$/);
  if (metric) {
    const value = Number(metric[1]);
    const unit = metric[2];
    if (unit.startsWith('mm') || unit.startsWith('milli')) return signed(value * UNITS_PER_MILLIMETRE);
    if (unit.startsWith('cm') || unit.startsWith('centi')) return signed(value * UNITS_PER_CENTIMETRE);
    return signed(value * UNITS_PER_METRE);
  }

  // Feet and inches together, with the inch mark optional — `12'6` is what
  // people actually type when they are moving quickly.
  const both = body.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)?$/);
  if (both) {
    return signed(Number(both[1]) * UNITS_PER_FOOT + Number(both[2]) * UNITS_PER_INCH);
  }

  const feet = body.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)$/);
  if (feet) return signed(Number(feet[1]) * UNITS_PER_FOOT);

  const inches = body.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)$/);
  if (inches) return signed(Number(inches[1]) * UNITS_PER_INCH);

  const bare = body.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const value = Number(bare[1]);
    return signed(system === 'metric' ? value * UNITS_PER_METRE : value * UNITS_PER_FOOT);
  }

  return null;
}

/** The step a nudge or grid should use — one inch, or one centimetre. */
export function fineStep(system: UnitSystem): number {
  return system === 'metric' ? UNITS_PER_CENTIMETRE : UNITS_PER_INCH;
}

/** The coarse step: one foot, or ten centimetres. */
export function coarseStep(system: UnitSystem): number {
  return system === 'metric' ? UNITS_PER_CENTIMETRE * 10 : UNITS_PER_FOOT;
}

export { UNITS_PER_FOOT, UNITS_PER_INCH };
