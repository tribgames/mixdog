// The `author` action's PDF route: a local Chrome/Edge lays an HTML document
// out under its own @page rules and prints it. Before printing, the document
// is laid out at the printable width and read for what print would silently
// cut or move — a block wider than the page, a picture that never loaded —
// so the file lands only when it holds. Designed pages (section.slide on the
// sheet) are measured and gated as a deck first (pdf-author-action.mjs) and
// printed here one page per sheet.
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';

import { htmlFailure, launchHtmlBrowser, runInBrowser } from './html-browser.mjs';
import { applyDocumentProperties } from '../pdf/pdf-writer.mjs';
import { iconTable, injectIcons } from './pptx-html-measure.mjs';
import { drawDataCharts } from './pdf-html-charts.mjs';

// Runs inside the page: every h1-h3 as the browser names it in the outline (its text with the line
// breaks dropped) and as a reader sees it (a <br> read as a space).
function headingTitles() {
  return [...document.querySelectorAll('h1, h2, h3')].map((heading) => ({
    raw: heading.textContent || '',
    shown: (heading.innerText || '').replace(/\s+/g, ' ').trim(),
  }));
}

// The browser names a bookmark after its heading's text with the line breaks dropped, so a title set
// on two lines ("…틀로<br>설계하고") reads "…틀로설계하고". Each such outline entry takes the heading
// as shown. Returns how many titles changed.
function repairOutlineTitles(document, headings) {
  const key = (text) => String(text || '').replace(/\s+/g, '');
  const shown = new Map();
  for (const heading of headings) if (heading.shown) shown.set(key(heading.raw), heading.shown);
  const outlines = document.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  let changed = 0;
  const seen = new Set();
  const walk = (node) => {
    while (node && !seen.has(node)) {
      seen.add(node);
      const title = node.get(PDFName.of('Title'));
      const text = typeof title?.decodeText === 'function' ? title.decodeText() : '';
      const fixed = shown.get(key(text));
      if (fixed && fixed !== text) {
        node.set(PDFName.of('Title'), PDFHexString.fromText(fixed));
        changed += 1;
      }
      walk(node.lookupMaybe(PDFName.of('First'), PDFDict));
      node = node.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
  };
  walk(outlines?.lookupMaybe(PDFName.of('First'), PDFDict));
  return changed;
}

/** The HTML as laid out, kept beside the PDF so relative <img> paths resolve and a re-author starts from it. */
export function pdfHtmlSourcePath(target) {
  return `${target}.mixdog-source.html`;
}

// CSS px per unit (96 px to the inch) and the named sheets in millimetres, portrait.
const PX_PER_UNIT = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
const NAMED_SHEETS_MM = {
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  b4: [250, 353],
  b5: [176, 250],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  ledger: [279.4, 431.8],
};

function lengthPx(token, what) {
  const match = /^(-?\d*\.?\d+)([a-z]+)?$/i.exec(String(token).trim());
  const unit = (match?.[2] || (Number(match?.[1]) === 0 ? 'px' : '')).toLowerCase();
  if (!match || !PX_PER_UNIT[unit]) {
    throw new Error(`@page ${what} "${token}" is not a length; write it in mm, cm, in, pt, or px.`);
  }
  return Number(match[1]) * PX_PER_UNIT[unit];
}

/** The printable area in CSS px from the @page size and margins the document declared. */
export function printableArea(rule) {
  const tokens = String(rule?.size || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length || tokens[0] === 'auto') {
    throw new Error(
      'The document declares no @page size; open the stylesheet with `@page { size: A4; margin: 18mm }` (or letter, A5 landscape, 148mm 210mm).'
    );
  }
  let landscape = false;
  const lengths = [];
  let named = null;
  for (const token of tokens) {
    if (token === 'landscape') landscape = true;
    else if (token === 'portrait') landscape = false;
    else if (NAMED_SHEETS_MM[token]) named = NAMED_SHEETS_MM[token].map((mm) => mm * PX_PER_UNIT.mm);
    else lengths.push(lengthPx(token, 'size'));
  }
  let [width, height] = named || [lengths[0], lengths[1] ?? lengths[0]];
  if (!(width > 0 && height > 0)) throw new Error(`@page size "${rule.size}" names no sheet.`);
  if (named && landscape) [width, height] = [height, width];
  const margin = Object.fromEntries(
    ['top', 'right', 'bottom', 'left'].map((side) => [
      side,
      rule.margin?.[side] ? lengthPx(rule.margin[side], `margin-${side}`) : 0,
    ])
  );
  return {
    sheet: { width, height },
    margin,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  };
}

// Runs inside the page: the unnamed @page rules that apply to print, later declarations winning.
export function readPageRule() {
  const out = { size: '', margin: {} };
  const visit = (list) => {
    for (const rule of list) {
      if (rule instanceof CSSPageRule && !rule.selectorText) {
        const size = rule.style.getPropertyValue('size');
        if (size) out.size = size;
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const value = rule.style.getPropertyValue(`margin-${side}`);
          if (value) out.margin[side] = value;
        }
      } else if (rule instanceof CSSMediaRule && window.matchMedia(rule.conditionText).matches) {
        visit(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {}
  }
  return out;
}

/**
 * The canvas of a PDF's designed pages (the deck contract, pptx-html-measure.mjs): the sheet the document
 * declares, printed full-bleed, in CSS px at 96 to the inch. Runs on the page the measure has loaded.
 */
export async function frameCanvas(page) {
  await page.emulateMediaType('print');
  const area = printableArea(await page.evaluate(readPageRule));
  if (Object.values(area.margin).some((margin) => margin > 0.5)) {
    throw new Error(
      'Designed pages print full-bleed: declare `@page { size: A4; margin: 0 }` and give each section.slide the whole sheet (width: 210mm; height: 297mm), with the margins inside it.'
    );
  }
  // The viewport takes whole px; the working deck is sized from those same px so 1 px stays exactly
  // 0.75 pt (A4's 793.7 px rounded to 794 is 0.2 pt wider, and a 22 pt title stays 22 pt).
  const width = Math.round(area.sheet.width);
  const height = Math.round(area.sheet.height);
  return { width, height, inchWidth: width / 96, inchHeight: height / 96 };
}

// Designed pages print one section.slide per sheet whatever the screen CSS does; speaker notes stay off the page.
const FRAME_PRINT_CSS = `section.slide { break-after: page; break-inside: avoid; }
section.slide:last-of-type { break-after: auto; }
aside.notes { display: none !important; }`;

// Runs inside the page, laid out at the printable width under print media.
// Errors refuse the document; warnings ride on the result. Designed pages
// are measured on their canvas before printing, so only their pictures are read here.
function measurePrintLayout(area, frame) {
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : '';
    const className = typeof element.className === 'string' ? element.className.trim() : '';
    const classes = className ? `.${className.split(/\s+/).join('.')}` : '';
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `<${element.localName}${id}${classes}>${text ? ` "${text}"` : ''}`;
  };
  const px = (value) => Math.round(value);
  const findings = [];
  for (const image of document.images) {
    const src = image.getAttribute('src') || '';
    if (/^(?:https?:)?\/\//i.test(src)) {
      findings.push({
        code: 'remote_image',
        severity: 'error',
        element: describe(image),
        message: `${src} is a web address; save the picture beside the document or inline it as a data: URI.`,
      });
    } else if (!image.complete || image.naturalWidth === 0) {
      findings.push({
        code: 'image_missing',
        severity: 'error',
        element: describe(image),
        message: `${src || '(no src)'} did not load; the path resolves from the PDF's folder.`,
      });
    }
  }
  if (frame) return { findings };
  const clipped = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') return true;
    }
    return false;
  };
  const outside = (box) => box.right > area.width + 1 || box.left < -1;
  const tall = new Set();
  for (const element of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.position === 'fixed') continue;
    const box = element.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    const parent = element.parentElement;
    if (
      outside(box) &&
      !clipped(element) &&
      !(parent && parent !== document.body && outside(parent.getBoundingClientRect()))
    ) {
      findings.push({
        code: 'overflow_x',
        severity: 'error',
        element: describe(element),
        message: `spans ${px(box.left)}–${px(box.right)} px of a ${px(area.width)} px printable width; print cuts what lies past the margin.`,
      });
    }
    const unbreakable =
      ['img', 'svg', 'canvas', 'video'].includes(element.localName) ||
      ['avoid', 'avoid-page'].includes(style.breakInside);
    if (unbreakable && box.height > area.height + 1) {
      let ancestor = element.parentElement;
      while (ancestor && !tall.has(ancestor)) ancestor = ancestor.parentElement;
      tall.add(element);
      if (!ancestor) {
        findings.push({
          code: 'unbreakable_too_tall',
          severity: 'warning',
          element: describe(element),
          message: `is ${px(box.height)} px tall and may not break, but a page holds ${px(area.height)} px; print splits it anyway. Shorten it or let it break.`,
        });
      }
    }
  }
  return { findings };
}

/**
 * Lays out and prints an HTML document to `output`.
 * @param {string} html the document
 * @param {string} output where the PDF is written (a staging file beside the target)
 * @param {{ sourcePath: string, properties?: object, frame?: boolean, timeoutMs?: number, signal?: AbortSignal }} options
 *   frame: designed pages (section.slide on the sheet, already measured): one page per sheet, icons drawn
 * @returns {Promise<object>} `{ ok:true, output, bytes, pageCount, area, warnings }`, or
 *   `{ ok:false, error }` / `{ ok:false, layout }` when the browser failed or the layout check refused it
 */
export async function printHtmlPdf(
  html,
  output,
  { sourcePath, properties = {}, frame = false, timeoutMs = 90_000, signal = null }
) {
  const startedAt = performance.now();
  await writeFile(sourcePath, html, 'utf8');
  await rm(output, { force: true });
  let browser;
  try {
    browser = await launchHtmlBrowser('pdf-html-browser', { signal });
  } catch (error) {
    return htmlFailure(error, startedAt);
  }
  const work = async () => {
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'load' });
    const area = printableArea(await page.evaluate(readPageRule));
    if (frame) {
      await page.evaluate(injectIcons, iconTable().table, '0 0 24 24');
      await page.addStyleTag({ content: FRAME_PRINT_CSS });
    }
    await page.setViewport({ width: Math.round(area.width), height: Math.round(area.height), deviceScaleFactor: 1 });
    await page.evaluate(() => document.fonts.ready);
    // Charts are drawn at the size print lays them out, before the layout is read for what print would cut.
    const charts = await page.evaluate(drawDataCharts);
    const measured = await page.evaluate(measurePrintLayout, { width: area.width, height: area.height }, frame);
    const errors = measured.findings.filter((finding) => finding.severity === 'error');
    if (errors.length) return { refused: errors, area };
    const headings = await page.evaluate(headingTitles);
    await page.pdf({ path: output, preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
    return {
      area,
      headings,
      charts: charts.drawn,
      warnings: [...charts.warnings, ...measured.findings.filter((finding) => finding.severity !== 'error')],
    };
  };
  let printed;
  try {
    printed = await runInBrowser(browser, { signal, timeoutMs }, work);
  } catch (error) {
    if (signal?.aborted) throw error;
    return htmlFailure(error, startedAt);
  }
  if (printed.refused)
    return htmlFailure(new Error('layout check refused the document'), startedAt, { layout: printed.refused });
  const document = await PDFDocument.load(await readFile(output));
  const described = ['title', 'author', 'subject', 'keywords'].some((key) => properties?.[key] != null);
  if (described) applyDocumentProperties(document, properties);
  if (repairOutlineTitles(document, printed.headings) || described) await writeFile(output, await document.save());
  return {
    ok: true,
    output,
    bytes: (await stat(output)).size,
    pageCount: document.getPageCount(),
    area: { width: Math.round(printed.area.width), height: Math.round(printed.area.height) },
    ...(printed.charts ? { charts: printed.charts } : {}),
    warnings: printed.warnings,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}
