export type BrowserScreenshotFormat = 'jpeg' | 'png';

export interface BrowserScreenshotOptions {
  format: BrowserScreenshotFormat;
  quality: number;
  fullPage: boolean;
}

export interface BrowserScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_QUALITY = 75;
const MAX_FULL_PAGE_DIMENSION = 32_768;
const MAX_FULL_PAGE_PIXELS = 24_000_000;
const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;

export function browserScreenshotBytesFitBudget(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_SCREENSHOT_BYTES;
}

export function normalizeScreenshotOptions(input: {
  format?: unknown;
  quality?: unknown;
  fullPage?: unknown;
}): BrowserScreenshotOptions {
  const format = String(input.format || 'jpeg')
    .trim()
    .toLowerCase();
  if (format !== 'jpeg' && format !== 'png') {
    throw new Error('snapshot format must be jpeg or png');
  }
  if (format === 'png' && input.quality !== undefined) {
    throw new Error('snapshot quality is supported only with format=jpeg');
  }
  const rawQuality = input.quality === undefined ? DEFAULT_QUALITY : Number(input.quality);
  if (!Number.isFinite(rawQuality) || rawQuality < 0 || rawQuality > 100) {
    throw new Error('snapshot quality must be between 0 and 100');
  }
  return {
    format,
    quality: Math.round(rawQuality),
    fullPage: input.fullPage === true,
  };
}

export function measuredFullPageRect(contentSize: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): BrowserScreenshotRect {
  const x = Math.max(0, Math.floor(Number(contentSize.x) || 0));
  const y = Math.max(0, Math.floor(Number(contentSize.y) || 0));
  const width = Math.ceil(Number(contentSize.width) || 0);
  const height = Math.ceil(Number(contentSize.height) || 0);
  if (width < 1 || height < 1) throw new Error('full-page screenshot has no measurable content');
  return { x, y, width, height };
}

/** A stitched page at its own resolution must fit the image limits. */
export function boundedFullPageRect(contentSize: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): BrowserScreenshotRect {
  const rect = measuredFullPageRect(contentSize);
  const { width, height } = rect;
  if (width > MAX_FULL_PAGE_DIMENSION || height > MAX_FULL_PAGE_DIMENSION || width * height > MAX_FULL_PAGE_PIXELS) {
    throw new Error(
      `full-page screenshot is too large (${width}x${height}); limit is ` +
        `${MAX_FULL_PAGE_DIMENSION}px per side and ${MAX_FULL_PAGE_PIXELS.toLocaleString()} pixels`
    );
  }
  return rect;
}

/** Whether a page of `rect` CSS px, at `pixelRatio` image px per CSS px, is
 *  past the image limits. The ratio is the capture's estimate, so a page within
 *  a rounding of the limits counts as past them: the banded capture measures
 *  the real ratio and keeps such a page at full size if it does fit. */
export function fullPageExceedsLimits(rect: BrowserScreenshotRect, pixelRatio: number): boolean {
  const slack = 1.002;
  return (
    fullPageOutputSize(Math.ceil(rect.width * pixelRatio * slack) + 1, Math.ceil(rect.height * pixelRatio * slack) + 1)
      .scale < 1
  );
}

/** The most pixels one band of a page past the limits is read as. */
export const MAX_FULL_PAGE_BAND_PIXELS = 4_000_000;
/** Image px a band's capture area can gain per axis when it is rounded out to
 *  whole DIPs (up to two DIPs at a display scale of up to 4). */
const BAND_EDGE_PIXELS = 8;
/** Time a band may take on top of the capture's base time. */
const FULL_PAGE_BAND_MS = 250;

/** The CSS size of the bands a page past the limits is read in: the visible
 *  viewport (the page is never resized for a capture), cut down until one
 *  band's image fits the band budget at `pixelRatio` image px per CSS px. */
export function fullPageBandPlan(
  page: { width: number; height: number },
  viewport: { width: number; height: number },
  pixelRatio: number
): { width: number; height: number; bands: number } {
  const pixels = (css: number) => css * pixelRatio + BAND_EDGE_PIXELS;
  // The most CSS px one side can have when the other side has `css`.
  const side = (css: number) => Math.floor((MAX_FULL_PAGE_BAND_PIXELS / pixels(css) - BAND_EDGE_PIXELS) / pixelRatio);
  const width = Math.max(1, Math.min(Math.floor(viewport.width), page.width, side(1)));
  const height = Math.max(1, Math.min(Math.floor(viewport.height), page.height, side(width)));
  return { width, height, bands: Math.ceil(page.width / width) * Math.ceil(page.height / height) };
}

/** How long a banded capture may run: its base time plus a share per band,
 *  never past `ceilingMs` (what the command leaves it), so the capture ends on
 *  its own clock and still puts the page back. */
export function fullPageBandTimeoutMs(bands: number, baseMs: number, ceilingMs: number): number {
  return Math.min(ceilingMs, baseMs + bands * FULL_PAGE_BAND_MS);
}

/** The DIP area of the page's view a band is captured from: the band sits
 *  `offset` CSS px into the visible viewport, rounded out to whole DIPs. */
export function bandCaptureArea(
  offset: { x: number; y: number },
  band: { width: number; height: number },
  dipPerCss: number
): BrowserScreenshotRect {
  const x = Math.floor(offset.x * dipPerCss);
  const y = Math.floor(offset.y * dipPerCss);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil((offset.x + band.width) * dipPerCss) - x),
    height: Math.max(1, Math.ceil((offset.y + band.height) * dipPerCss) - y),
  };
}

/** The band itself inside the image captured from `area`. */
export function bandImageCrop(
  offset: { x: number; y: number },
  band: { width: number; height: number },
  dipPerCss: number,
  area: BrowserScreenshotRect,
  image: { width: number; height: number }
): BrowserScreenshotRect {
  const axis = (start: number, length: number, areaStart: number, areaLength: number, size: number) => {
    const perCss = (size / areaLength) * dipPerCss;
    const from = Math.min(size - 1, Math.max(0, Math.round((start - areaStart / dipPerCss) * perCss)));
    const to = Math.min(size, Math.max(from + 1, Math.round((start + length - areaStart / dipPerCss) * perCss)));
    return [from, to - from];
  };
  const [x, width] = axis(offset.x, band.width, area.x, area.width, image.width);
  const [y, height] = axis(offset.y, band.height, area.y, area.height, image.height);
  return { x, y, width, height };
}

/** Where a band at `band` CSS px into the page lands in the output image.
 *  Neighbouring bands share each edge, so rounding leaves no gap or overlap. */
export function bandOutputRect(
  band: BrowserScreenshotRect,
  page: { width: number; height: number },
  output: { width: number; height: number }
): BrowserScreenshotRect {
  const edge = (css: number, pageSize: number, outputSize: number) =>
    Math.min(outputSize, Math.round((css * outputSize) / pageSize));
  const x = edge(band.x, page.width, output.width);
  const y = edge(band.y, page.height, output.height);
  return {
    x,
    y,
    width: edge(band.x + band.width, page.width, output.width) - x,
    height: edge(band.y + band.height, page.height, output.height) - y,
  };
}

/** The image a full page of `width`x`height` device pixels is delivered as:
 *  the page itself when it fits the per-side and pixel limits, otherwise the
 *  whole page scaled down to fit. */
export function fullPageOutputSize(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(
    1,
    MAX_FULL_PAGE_DIMENSION / width,
    MAX_FULL_PAGE_DIMENSION / height,
    Math.sqrt(MAX_FULL_PAGE_PIXELS / (width * height))
  );
  if (scale === 1) return { width, height, scale };
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

/** Fixed and sticky elements are positioned against the viewport, so a
 *  full-page clip paints a header over the middle of the document. Anchoring
 *  them in flow for the capture keeps them where the reader expects; the
 *  inline style is put back exactly as it was. */
export const FULL_PAGE_LAYOUT_PREPARE = `(() => {
  if (window.__mixdogFullPageLayout) return 0;
  const changed = [];
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (++scanned > 5000) break;
    const position = getComputedStyle(node).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    changed.push({
      node,
      value: node.style.getPropertyValue('position'),
      priority: node.style.getPropertyPriority('position'),
    });
    node.style.setProperty('position', position === 'fixed' ? 'absolute' : 'relative', 'important');
  }
  window.__mixdogFullPageLayout = changed;
  return changed.length;
})()`;

export const FULL_PAGE_LAYOUT_RESTORE = `(() => {
  const changed = window.__mixdogFullPageLayout;
  if (!changed) return 0;
  delete window.__mixdogFullPageLayout;
  for (const entry of changed) {
    if (entry.value) entry.node.style.setProperty('position', entry.value, entry.priority);
    else entry.node.style.removeProperty('position');
  }
  return changed.length;
})()`;
