/**
 * Prepare a site-plan underlay for Background Studio.
 * Accepts PNG / JPEG / WebP, plus PDF (page 1) and SVG → raster.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_EDGE = 4096;

export type PreparedUnderlay = {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
};

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file is not a readable image.'));
    image.src = source;
  });
}

function canvasToUnderlay(
  canvas: HTMLCanvasElement,
  name: string,
): PreparedUnderlay {
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.88),
    width: canvas.width,
    height: canvas.height,
    name,
  };
}

function rasterFromImage(
  image: HTMLImageElement,
  name: string,
): PreparedUnderlay {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The image could not be prepared.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvasToUnderlay(canvas, name);
}

async function prepareRasterImage(file: File): Promise<PreparedUnderlay> {
  const source = await readDataUrl(file);
  const image = await loadImage(source);
  return rasterFromImage(image, file.name);
}

async function prepareSvg(file: File): Promise<PreparedUnderlay> {
  const text = await file.text();
  const blob = new Blob([text], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    return rasterFromImage(image, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function preparePdf(file: File): Promise<PreparedUnderlay> {
  const data = new Uint8Array(await readArrayBuffer(file));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Renderer has a DOM canvas; keep work on the main thread to avoid worker path issues.
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
  }
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  try {
    if (doc.numPages < 1) throw new Error('That PDF has no pages.');
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, MAX_IMAGE_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The PDF page could not be prepared.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return canvasToUnderlay(canvas, file.name);
  } finally {
    await doc.cleanup?.();
  }
}

function kindOf(file: File): 'image' | 'pdf' | 'svg' | 'unknown' {
  const type = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (/^image\/(png|jpe?g|webp)$/i.test(type) || /\.(png|jpe?g|webp)$/i.test(name)) return 'image';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  return 'unknown';
}

/** Rasterise a site plan / CAD export for use as a plan underlay. */
export async function prepareBackgroundFile(file: File): Promise<PreparedUnderlay> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Choose a file smaller than 25 MB.');
  const kind = kindOf(file);
  if (kind === 'image') return prepareRasterImage(file);
  if (kind === 'svg') return prepareSvg(file);
  if (kind === 'pdf') return preparePdf(file);
  throw new Error('Choose a PNG, JPEG, WebP, PDF, or SVG site plan.');
}

export const BACKGROUND_FILE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/svg+xml,application/pdf,.pdf,.svg';
