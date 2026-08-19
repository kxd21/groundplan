import type { Layer, Scene, ScenePrimitive } from '../../format/scene.js';
import type { PlanBackground } from '../../format/companion.js';
import {
  pointsToUnits,
  resolveStyle,
  SCALE_INCHES_PER_FOOT,
  TEXT_POINTS,
} from '../../format/style.js';

/**
 * Renders a scene to standalone SVG so plans can leave the app — the legacy
 * viewer could only print from Windows.
 *
 * Appearance comes from `format/style.ts`, the same module the canvas reads, so
 * what is exported is what was on screen. Weights are stated in printed points
 * and converted here for the chosen scale; they are not sizes in the room.
 */
export function toSvg(
  scene: Scene,
  visible: Set<Layer>,
  scaleId = '1/8',
  background: PlanBackground | null = null,
): string {
  const exportBackground = background?.visible && background.includeInExport ? background : null;
  const inchesPerFoot = SCALE_INCHES_PER_FOOT[scaleId] ?? SCALE_INCHES_PER_FOOT['1/8'];
  const units = (points: number) => pointsToUnits(points, inchesPerFoot);

  // Plan y grows upward, SVG y grows down — see `screenY` in PlanCanvas for why
  // the drawing was coming out mirrored. Flipping the coordinates once, here,
  // means the extent, the viewBox and every element below are all computed in
  // the flipped space and need no further thought. Doing it with an SVG
  // transform instead would mirror the type as well, and every label on the
  // sheet would read backwards.
  scene = {
    ...scene,
    primitives: scene.primitives.map((p) => ({
      ...p,
      pts: p.pts.map((v, i) => (i % 2 === 1 ? -v : v)),
      textStyle: p.textStyle
        ? { ...p.textStyle, angleDegrees: -p.textStyle.angleDegrees }
        : p.textStyle,
    })),
  };

  // Frame on drawn geometry only. A single mispositioned annotation would
  // otherwise stretch the page and shrink the plan to a corner of it.
  let extent: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const p of scene.primitives) {
    if (!visible.has(p.layer) || p.layer === 'annotation') continue;
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = p.pts[i];
      const y = p.pts[i + 1];
      if (!extent) extent = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        if (x < extent.minX) extent.minX = x;
        if (y < extent.minY) extent.minY = y;
        if (x > extent.maxX) extent.maxX = x;
        if (y > extent.maxY) extent.maxY = y;
      }
    }
  }
  if (exportBackground) {
    const cx = exportBackground.x + exportBackground.width / 2;
    const cy = exportBackground.y + exportBackground.height / 2;
    const radians = (exportBackground.rotation * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    for (const [x, y] of [
      [exportBackground.x, exportBackground.y],
      [exportBackground.x + exportBackground.width, exportBackground.y],
      [exportBackground.x + exportBackground.width, exportBackground.y + exportBackground.height],
      [exportBackground.x, exportBackground.y + exportBackground.height],
    ]) {
      const rx = cx + (x - cx) * cosine - (y - cy) * sine;
      const ry = cy + (x - cx) * sine + (y - cy) * cosine;
      if (!extent) extent = { minX: rx, minY: ry, maxX: rx, maxY: ry };
      else {
        extent.minX = Math.min(extent.minX, rx);
        extent.minY = Math.min(extent.minY, ry);
        extent.maxX = Math.max(extent.maxX, rx);
        extent.maxY = Math.max(extent.maxY, ry);
      }
    }
  }
  extent ??= scene.extent;
  if (!extent) return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';

  const pad = 240; // two feet of margin, in tenths of an inch
  const minX = extent.minX - pad;
  const minY = extent.minY - pad;
  const width = extent.maxX - extent.minX + pad * 2;
  const height = extent.maxY - extent.minY + pad * 2;

  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const esc = (s: string) =>
    s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);

  const textSize = units(TEXT_POINTS);

  /**
   * A dimension, drawn the way a drawing does it: a solid run with a gap for
   * its own text and a tick at each end. It used to be a dashed line straight
   * through the numbers, which is both the wrong convention and unreadable.
   */
  const dimension = (p: ScenePrimitive, stroke: string, w: number): string[] => {
    const out: string[] = [];
    const [x0, y0, x1, y1] = p.pts;
    if (p.pts.length < 4) return out;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;

    const gap = p.text ? Math.min(length / 2 - units(2), (p.text.length * textSize) / 2.6 + units(3)) : 0;
    const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const line = (ax: number, ay: number, bx: number, by: number) =>
      `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}" stroke="${stroke}" stroke-width="${n(w)}"/>`;

    if (gap > 0) {
      out.push(line(x0, y0, mid.x - ux * gap, mid.y - uy * gap));
      out.push(line(mid.x + ux * gap, mid.y + uy * gap, x1, y1));
    } else {
      out.push(line(x0, y0, x1, y1));
    }

    // Architectural 45-degree ticks, 1/8in on paper.
    const t = units(9);
    const tx = (ux + -uy) * t * 0.5;
    const ty = (uy + ux) * t * 0.5;
    out.push(line(x0 - tx, y0 - ty, x0 + tx, y0 + ty));
    out.push(line(x1 - tx, y1 - ty, x1 + tx, y1 + ty));

    if (p.text) {
      const ox = -uy * units(2.5);
      const oy = ux * units(2.5);
      out.push(
        `<text x="${n(mid.x + ox)}" y="${n(mid.y + oy)}" font-size="${n(textSize)}" ` +
          `font-family="Helvetica, Arial, sans-serif" fill="${stroke}" text-anchor="middle" ` +
          `dominant-baseline="middle">${esc(p.text)}</text>`,
      );
    }
    return out;
  };

  // Fills are laid down before strokes so an outline is never buried by the
  // surface of the thing next to it.
  const fills: string[] = [];
  const strokes: string[] = [];

  for (const p of scene.primitives) {
    if (!visible.has(p.layer)) continue;
    const style = resolveStyle(p);
    const stroke = style.stroke;
    const w = units(style.strokePoints);

    if (p.type === 'text') {
      if (!p.text) continue;
      const typography = p.textStyle;
      const size = textSize * ((typography?.size ?? 9) / 9);
      const family = esc(typography?.family || 'Arial');
      const decorations = [typography?.underline ? 'underline' : '', typography?.strikeOut ? 'line-through' : '']
        .filter(Boolean)
        .join(' ');
      const lines = p.text.replace(/\r/g, '').split('\n');
      const lineHeight = size * 1.2;
      const content = lines
        .map((line, index) => `<tspan x="${n(p.pts[0])}" dy="${index === 0 ? n(-((lines.length - 1) * lineHeight) / 2) : n(lineHeight)}">${esc(line)}</tspan>`)
        .join('');
      strokes.push(
        `<text x="${n(p.pts[0])}" y="${n(p.pts[1])}" font-size="${n(size)}" ` +
          `font-family="${family}, Arial, sans-serif" font-weight="${typography?.bold ? 700 : 400}" ` +
          `font-style="${typography?.italic ? 'italic' : 'normal'}"${decorations ? ` text-decoration="${decorations}"` : ''} ` +
          `fill="${stroke}" text-anchor="middle" dominant-baseline="middle" ` +
          `transform="rotate(${n(typography?.angleDegrees ?? 0)} ${n(p.pts[0])} ${n(p.pts[1])})">${content}</text>`,
      );
      continue;
    }

    if (p.type === 'dimension') {
      strokes.push(...dimension(p, stroke, w));
      continue;
    }

    if (p.type === 'bezier' && p.pts.length >= 8) {
      strokes.push(
        `<path d="M ${n(p.pts[0])} ${n(p.pts[1])} C ${n(p.pts[2])} ${n(p.pts[3])}, ${n(p.pts[4])} ${n(p.pts[5])}, ${n(p.pts[6])} ${n(p.pts[7])}" fill="none" stroke="${stroke}" stroke-width="${n(w)}"/>`,
      );
      continue;
    }

    const coords: string[] = [];
    for (let i = 0; i < p.pts.length; i += 2) coords.push(`${n(p.pts[i])},${n(p.pts[i + 1])}`);
    if (coords.length < 2) continue;

    const dash = style.dash ? ` stroke-dasharray="${style.dash.map((d) => n(units(d))).join(',')}"` : '';
    const tag = p.type === 'polygon' ? 'polygon' : 'polyline';

    if (style.fill) {
      fills.push(`<${tag} points="${coords.join(' ')}" fill="${style.fill}" stroke="none"/>`);
    }
    strokes.push(
      `<${tag} points="${coords.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${n(w)}"${dash}/>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}" width="${n(width / 10)}" height="${n(height / 10)}">`,
    `<rect x="${n(minX)}" y="${n(minY)}" width="${n(width)}" height="${n(height)}" fill="#ffffff"/>`,
    ...(exportBackground
      ? [
          `<image href="${exportBackground.dataUrl}" x="${n(exportBackground.x)}" y="${n(exportBackground.y)}" width="${n(exportBackground.width)}" height="${n(exportBackground.height)}" opacity="${n(exportBackground.opacity)}" transform="translate(${n(exportBackground.x + exportBackground.width / 2)} ${n(exportBackground.y + exportBackground.height / 2)}) rotate(${n(exportBackground.rotation)}) scale(${exportBackground.flipX ? -1 : 1} ${exportBackground.flipY ? -1 : 1}) translate(${n(-(exportBackground.x + exportBackground.width / 2))} ${n(-(exportBackground.y + exportBackground.height / 2))})" preserveAspectRatio="none" style="mix-blend-mode:${exportBackground.blendMode};filter:brightness(${exportBackground.brightness}) contrast(${exportBackground.contrast}) saturate(${exportBackground.saturation}) grayscale(${exportBackground.grayscale})"/>`,
        ]
      : []),
    `<g stroke-linejoin="round" stroke-linecap="round" shape-rendering="geometricPrecision">`,
    ...fills,
    ...strokes,
    `</g>`,
    `</svg>`,
  ].join('\n');
}
