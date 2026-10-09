import { createCanvas, loadImage } from '@napi-rs/canvas';
import { reviewRenderedOfficeAesthetics } from './design-aesthetics.mjs';
import { issue } from './assurance-issue.mjs';

function imagePages(image) {
  return Array.isArray(image?.pages) && image.pages.length ? image.pages.map(Number) : [Number(image?.page) || 0];
}

// A contact sheet (a deck past twelve pages) carries the page images it was
// composed from; the review reads those pages and never the sheet itself.
export function renderedPageImages(images = []) {
  const output = [];
  for (const image of images || []) {
    if (Array.isArray(image?.pageImages) && image.pageImages.length) {
      output.push(...image.pageImages.map((page) => ({ ...page, pages: [Number(page.page)] })));
    } else {
      output.push(image);
    }
  }
  return output;
}

async function renderedPageMetric(image) {
  const pageNumbers = imagePages(image);
  if (pageNumbers.length !== 1 || !image?.data) return null;
  const loaded = await loadImage(Buffer.from(image.data, 'base64'));
  const canvas = createCanvas(loaded.width, loaded.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(loaded, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 1_000_000)));
  let sampled = 0;
  let ink = 0;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  let bodyInk = 0;
  let lowerBodyInk = 0;
  let bodyMinY = canvas.height;
  let bodyMaxY = -1;
  const bodyTop = canvas.height * 0.08;
  const bodyBottom = canvas.height * 0.9;
  const lowerBodyTop = canvas.height * 0.52;
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const offset = (y * canvas.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      sampled += 1;
      if (red > 247 && green > 247 && blue > 247) continue;
      ink += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (y >= bodyTop && y <= bodyBottom) {
        bodyInk += 1;
        bodyMinY = Math.min(bodyMinY, y);
        bodyMaxY = Math.max(bodyMaxY, y);
        if (y >= lowerBodyTop) lowerBodyInk += 1;
      }
    }
  }
  const horizontalSpan = maxX >= minX ? (maxX - minX + step) / canvas.width : 0;
  const verticalSpan = maxY >= minY ? (maxY - minY + step) / canvas.height : 0;
  const leftMargin = maxX >= minX ? minX / canvas.width : 1;
  const rightMargin = maxX >= minX ? Math.max(0, canvas.width - maxX - step) / canvas.width : 1;
  const bodyVerticalSpan = bodyMaxY >= bodyMinY ? (bodyMaxY - bodyMinY + step) / (bodyBottom - bodyTop) : 0;
  // Where the body's ink stops, as a share of the body region (the running header and footer sit outside it).
  const bodyEnd = bodyMaxY >= bodyMinY ? Math.min(1, (bodyMaxY + step - bodyTop) / (bodyBottom - bodyTop)) : 0;
  return {
    page: pageNumbers[0],
    width: canvas.width,
    height: canvas.height,
    inkCoverage: sampled ? Number((ink / sampled).toFixed(4)) : 0,
    horizontalSpan: Number(horizontalSpan.toFixed(4)),
    verticalSpan: Number(verticalSpan.toFixed(4)),
    bodyVerticalSpan: Number(bodyVerticalSpan.toFixed(4)),
    bodyEnd: Number(bodyEnd.toFixed(4)),
    lowerBodyInkRatio: bodyInk ? Number((lowerBodyInk / bodyInk).toFixed(4)) : 0,
    leftMargin: Number(leftMargin.toFixed(4)),
    rightMargin: Number(rightMargin.toFixed(4)),
  };
}

// A worksheet that fits a page at full scale is small, not scaled down: its
// print reads at the size the author set, however little of the page it uses.
export function isSmallWorksheetDocument(document) {
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  return (
    sheets.length > 0 &&
    sheets.every(
      (sheet) =>
        (Number(sheet?.rows) || 0) < 40 &&
        (Number(sheet?.columns) || 0) < 12 &&
        (Number(sheet?.pageSetup?.zoom) || 100) >= 100
    )
  );
}

// A flowing page that is not the last one ends its body early when the flow pushed a block it may not split (a
// table kept whole, a figure kept with its caption, a heading kept with the next block) onto the next page: the
// foot stands empty and the reader turns the page mid-thought. A Word sample whose first page ended above its
// exhibit passed every check. Measured from the rendered ink, so it holds for Word and PDF alike; designed pages
// (a PDF of section.slide sheets) are composed, not flowed, and are left to the deck's own review.
const PAGE_BODY_END_MIN = 0.7;

export async function reviewRenderedOfficePages(
  images = [],
  {
    format = '',
    pageRoles = {},
    smallWorksheet = false,
    pageCount = 0,
    designedPages = false,
    // Page numbers that open with a deliberate forced break (CSS break-before / page-break-before: page in authored
    // HTML, a Word page break or pageBreakBefore paragraph), computed by quality/forced-break-pages.mjs. Null when
    // there is no authored source to read them from.
    forcedBreakPages = null,
  } = {}
) {
  const forcedBreaks = forcedBreakPages ? new Set([...forcedBreakPages].map(Number)) : null;
  const normalized = String(format || '').toLowerCase();
  const pageImages = renderedPageImages(images);
  const lastPage = Number(pageCount) || Math.max(0, ...pageImages.flatMap((image) => imagePages(image)));
  const pages = [];
  const issues = [];
  for (const image of pageImages) {
    const metric = await renderedPageMetric(image);
    if (!metric) continue;
    pages.push(metric);
    if (!['docx', 'xlsx', 'pdf'].includes(normalized)) continue;
    if (metric.inkCoverage < 0.0015) {
      issues.push(issue('blank_page', `/page[${metric.page}]`, 'Rendered page is effectively blank.', 'render-review'));
      continue;
    }
    if (normalized === 'docx' && (metric.leftMargin < 0.002 || metric.rightMargin < 0.002)) {
      issues.push(
        issue(
          'content_touches_page_edge',
          `/page[${metric.page}]`,
          'Rendered document content touches a horizontal page edge and may be clipped.',
          'render-review'
        )
      );
    }
    const flowing = ['docx', 'pdf'].includes(normalized) && !designedPages;
    // The cover/title page is short by design, and a page followed by a deliberate forced break ends where the
    // author ended it.
    const endsBeforeForcedBreak = forcedBreaks?.has(metric.page + 1) === true;
    if (flowing && metric.page > 1 && !endsBeforeForcedBreak && metric.page < lastPage && metric.bodyEnd < PAGE_BODY_END_MIN) {
      const empty = Math.round((1 - metric.bodyEnd) * 100);
      issues.push(
        issue(
          'page_bottom_empty',
          `/page[${metric.page}]`,
          `The body stops ${Math.round(metric.bodyEnd * 100)}% of the way down page ${metric.page} and the next page goes on: ${empty}% of its body region stands empty. A block kept whole (a table, a figure with its caption, a heading kept with the next block) usually moved on; let a long table break across the page, move a shorter block up, or tighten what comes before.${forcedBreaks ? '' : ' If the next page opens with a deliberate forced break, ignore this.'}`,
          'render-review',
          'warning'
        )
      );
      continue;
    }
    // A short chapter is the author's: the page ends before a forced break, or it is the last page and opens with one.
    const deliberateShort = endsBeforeForcedBreak || (forcedBreaks?.has(metric.page) === true && metric.page >= lastPage);
    if (
      ['docx', 'pdf'].includes(normalized) &&
      metric.page > 1 &&
      !deliberateShort &&
      ((metric.inkCoverage < 0.025 && metric.verticalSpan < 0.22) ||
        (metric.bodyVerticalSpan < 0.34 && metric.lowerBodyInkRatio < 0.08))
    ) {
      issues.push(
        issue(
          'sparse_page',
          `/page[${metric.page}]`,
          `Rendered body spans ${(metric.bodyVerticalSpan * 100).toFixed(1)}% of the body region; inspect paragraph flow and intentional whitespace.`,
          'render-review'
        )
      );
    }
    if (
      normalized === 'xlsx' &&
      !smallWorksheet &&
      metric.inkCoverage < 0.095 &&
      ((metric.horizontalSpan < 0.7 && metric.verticalSpan < 0.5) ||
        (metric.height > metric.width * 1.2 && metric.verticalSpan < 0.3))
    ) {
      issues.push(
        issue(
          'worksheet_print_too_small',
          `/page[${metric.page}]`,
          'Worksheet content is scaled into a small area of the rendered page.',
          'render-review'
        )
      );
    }
  }
  const aesthetics = await reviewRenderedOfficeAesthetics(pageImages, {
    format: normalized,
    pageRoles,
  });
  issues.push(...aesthetics.issues);
  return {
    ok: issues.length === 0,
    format: normalized,
    pages,
    aesthetics,
    issues,
  };
}
