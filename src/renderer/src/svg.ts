import type { Layer, Scene } from '../../format/scene.js';

/**
 * Renders a scene to standalone SVG so plans can leave the app — the legacy
 * viewer could only print from Windows.
 */
export function toSvg(scene: Scene, visible: Set<Layer>): string {
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
  extent ??= scene.extent;
  if (!extent) return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';

  const pad = 240; // two feet of margin, in tenths of an inch
  const minX = extent.minX - pad;
  const minY = extent.minY - pad;
  const width = extent.maxX - extent.minX + pad * 2;
  const height = extent.maxY - extent.minY + pad * 2;

  const css = (color: number): string => {
    const r = color & 0xff;
    const g = (color >> 8) & 0xff;
    const b = (color >> 16) & 0xff;
    return r > 235 && g > 235 && b > 235 ? '#2b2b2b' : `rgb(${r},${g},${b})`;
  };

  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const esc = (s: string) =>
    s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);

  const parts: string[] = [];
  for (const p of scene.primitives) {
    if (!visible.has(p.layer)) continue;
    const stroke = css(p.color);
    const w = p.layer === 'walls' ? 12 : 5;

    if (p.type === 'text') {
      if (!p.text) continue;
      parts.push(
        `<text x="${n(p.pts[0])}" y="${n(p.pts[1])}" font-size="90" font-family="Helvetica, Arial, sans-serif" fill="${stroke}" text-anchor="middle" dominant-baseline="middle">${esc(p.text)}</text>`,
      );
      continue;
    }

    if (p.type === 'bezier' && p.pts.length >= 8) {
      parts.push(
        `<path d="M ${n(p.pts[0])} ${n(p.pts[1])} C ${n(p.pts[2])} ${n(p.pts[3])}, ${n(p.pts[4])} ${n(p.pts[5])}, ${n(p.pts[6])} ${n(p.pts[7])}" fill="none" stroke="${stroke}" stroke-width="${w}"/>`,
      );
      continue;
    }

    const coords: string[] = [];
    for (let i = 0; i < p.pts.length; i += 2) coords.push(`${n(p.pts[i])},${n(p.pts[i + 1])}`);
    if (coords.length < 2) continue;

    const dash = p.type === 'dimension' ? ' stroke-dasharray="40,30"' : '';
    const tag = p.type === 'polygon' ? 'polygon' : 'polyline';
    parts.push(`<${tag} points="${coords.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}"${dash}/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}" width="${n(width / 10)}" height="${n(height / 10)}">`,
    `<rect x="${n(minX)}" y="${n(minY)}" width="${n(width)}" height="${n(height)}" fill="#ffffff"/>`,
    `<g stroke-linejoin="round" stroke-linecap="round">`,
    ...parts,
    `</g>`,
    `</svg>`,
  ].join('\n');
}
