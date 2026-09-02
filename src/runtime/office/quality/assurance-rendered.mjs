import { createCanvas, loadImage } from '@napi-rs/canvas';
import { reviewRenderedOfficeAesthetics } from './design-aesthetics.mjs';
import { issue } from './assurance-structure.mjs';

function imagePages(image) {
  return Array.isArray(image?.pages) && image.pages.length ? image.pages.map(Number) : [Number(image?.page) || 0];
}

async function renderedPageMetric(image) {
  if (imagePages(image).length !== 1 || !image?.data) return null;
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
  const bodyVerticalSpan = bodyMaxY >= bodyMinY
    ? (bodyMaxY - bodyMinY + step) / (bodyBottom - bodyTop)
    : 0;
  return {
    page: imagePages(image)[0],
    width: canvas.width,
    height: canvas.height,
    inkCoverage: sampled ? Number((ink / sampled).toFixed(4)) : 0,
    horizontalSpan: Number(horizontalSpan.toFixed(4)),
    verticalSpan: Number(verticalSpan.toFixed(4)),
    bodyVerticalSpan: Number(bodyVerticalSpan.toFixed(4)),
    lowerBodyInkRatio: bodyInk ? Number((lowerBodyInk / bodyInk).toFixed(4)) : 0,
    leftMargin: Number(leftMargin.toFixed(4)),
    rightMargin: Number(rightMargin.toFixed(4)),
  };
}

export async function reviewRenderedOfficePages(images = [], {
  format = '',
  pageRoles = {},
} = {}) {
  const normalized = String(format || '').toLowerCase();
  const pages = [];
  const issues = [];
  for (const image of images || []) {
    const metric = await renderedPageMetric(image);
    if (!metric) continue;
    pages.push(metric);
    if (!['docx', 'xlsx', 'pdf'].includes(normalized)) continue;
    if (metric.inkCoverage < 0.0015) {
      issues.push(issue(
        'blank_page',
        `/page[${metric.page}]`,
        'Rendered page is effectively blank.',
        'render-review',
      ));
      continue;
    }
    if (
      normalized === 'docx'
      && (metric.leftMargin < 0.002 || metric.rightMargin < 0.002)
    ) {
      issues.push(issue(
        'content_touches_page_edge',
        `/page[${metric.page}]`,
        'Rendered document content touches a horizontal page edge and may be clipped.',
        'render-review',
      ));
    }
    if (
      ['docx', 'pdf'].includes(normalized)
      && metric.page > 1
      && (
        (metric.inkCoverage < 0.025 && metric.verticalSpan < 0.22)
        || (
          metric.bodyVerticalSpan < 0.34
          && metric.lowerBodyInkRatio < 0.08
        )
      )
    ) {
      issues.push(issue(
        'sparse_page',
        `/page[${metric.page}]`,
        `Rendered page uses only ${(metric.verticalSpan * 100).toFixed(1)}% of its height.`,
        'render-review',
      ));
    }
    if (
      normalized === 'xlsx'
      && metric.inkCoverage < 0.095
      && (
        (metric.horizontalSpan < 0.7 && metric.verticalSpan < 0.5)
        || (metric.height > metric.width * 1.2 && metric.verticalSpan < 0.3)
      )
    ) {
      issues.push(issue(
        'worksheet_print_too_small',
        `/page[${metric.page}]`,
        'Worksheet content is scaled into a small area of the rendered page.',
        'render-review',
      ));
    }
  }
  const aesthetics = await reviewRenderedOfficeAesthetics(images, {
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
