// The `author` action's Word input: lay the HTML out in a local browser at the printable width of its @page sheet,
// read it back as Word's flow (docx-html-measure.mjs), photograph what Word cannot draw as text (an SVG, a chart, a
// canvas), print the same HTML as the reference the review compares against, and write the .docx.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { htmlFailure, launchHtmlBrowser, photographCaptures, runInBrowser } from './html-browser.mjs';
import { printableArea, readPageRule } from './pdf-html-runner.mjs';
import { iconTable, injectIcons } from './pptx-html-measure.mjs';
import { drawDataCharts } from './pdf-html-charts.mjs';
import { extractDocxFlow } from './docx-html-measure.mjs';
import { buildDocxFromFlow } from './docx-html-build.mjs';
import { renderPdfPages } from '../pdf/pdf-render.mjs';

const PX_TO_PT = 0.75;

/** Artifacts kept beside the document: its HTML and the browser's print of it. */
export function docxHtmlArtifacts(target) {
  return {
    source: `${target}.mixdog-source.html`,
    print: `${target}.mixdog-html.pdf`,
    compare: (page) => `${target}.mixdog-compare-page-${page}.png`,
  };
}

/**
 * @param {string} html the document
 * @param {string} output where the .docx is written (a staging file beside the target)
 * @param {{ target: string, signal?: AbortSignal, timeoutMs?: number }} options
 */
export async function runDocxHtmlAuthoring(html, output, { target, signal = null, timeoutMs = 90_000 }) {
  const startedAt = performance.now();
  const artifacts = docxHtmlArtifacts(target);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await writeFile(artifacts.source, html, 'utf8');
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-docx-captures-'));
  let browser;
  try {
    browser = await launchHtmlBrowser('docx-html-browser', { signal });
  } catch (error) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    return htmlFailure(error, startedAt);
  }
  const work = async () => {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(artifacts.source).href, { waitUntil: 'load' });
    const area = printableArea(await page.evaluate(readPageRule));
    // The body is the page's text column: as wide as the sheet between its margins, from the top of that column.
    await page.setViewport({ width: Math.round(area.width), height: Math.round(area.height), deviceScaleFactor: 2 });
    await page.addStyleTag({ content: 'html, body { margin: 0 !important; }' });
    await page.evaluate(injectIcons, iconTable().table, '0 0 24 24');
    const charts = await page.evaluate(drawDataCharts);
    await page.evaluate(() => document.fonts.ready);
    const flow = await page.evaluate(extractDocxFlow);
    const captures = await photographCaptures(page, 'data-docx-capture', flow.captures, scratch);
    // The reference the review holds the Word render against: the same HTML as print lays it out.
    await page.emulateMediaType('print');
    await page.pdf({ path: artifacts.print, preferCSSPageSize: true, printBackground: true });
    const title = await page.title();
    return { area, flow, captures, chartWarnings: charts.warnings, title };
  };
  let laid;
  try {
    laid = await runInBrowser(browser, { signal, timeoutMs }, work);
  } catch (error) {
    if (signal?.aborted) throw error;
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    return htmlFailure(error, startedAt);
  }
  try {
    const printed = await renderPdfPages(artifacts.print, { maxWidth: 900 }).catch(() => null);
    const points = (value) => Math.round(value * PX_TO_PT * 100) / 100;
    const built = await buildDocxFromFlow(laid.flow, output, {
      page: {
        sheet: { width: points(laid.area.sheet.width), height: points(laid.area.sheet.height) },
        margin: Object.fromEntries(Object.entries(laid.area.margin).map(([side, value]) => [side, points(value)])),
      },
      captures: laid.captures,
      title: laid.title,
    });
    return {
      ok: true,
      output,
      bytes: (await stat(output)).size,
      kit: 'html',
      htmlSource: artifacts.source,
      htmlPages: (printed?.images || []).map((image) => ({ page: image.page, path: image.path })),
      logs: [...built.notes, ...laid.chartWarnings.map((warning) => warning.message)].map((text) => ({
        level: 'warn',
        text,
      })),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return htmlFailure(error, startedAt);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
