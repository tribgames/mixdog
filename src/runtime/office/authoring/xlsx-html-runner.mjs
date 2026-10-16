// The `author` action's Excel input: lay the HTML's <section data-sheet> pages out in a local browser, read each back
// as a grid (xlsx-html-measure.mjs), photograph pictures and each section for the review, and write the .xlsx.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { htmlFailure, launchHtmlBrowser, photographCaptures, runInBrowser } from './html-browser.mjs';
import { noteOfficeWrite } from '../core/office-write-ledger.mjs';
import { iconTable, injectIcons } from './pptx-html-measure.mjs';
import { extractXlsxSheets } from './xlsx-html-measure.mjs';
import { drawDataCharts } from './pdf-html-charts.mjs';
import { buildXlsxFromSheets } from './xlsx-html-build.mjs';

/**
 * Runs inside the page: a chart whose data-range names table cells by id (`{mh}:{m9},{wh}:{w9}`, each area one column
 * from its header down, the first the categories) takes the labels and values those cells show, so the reference
 * draws the chart the workbook will; a chart with values of its own, or a range not written that way, is left alone.
 */
function fillRangeCharts() {
  for (const element of document.querySelectorAll('[data-chart][data-range]')) {
    let spec;
    try {
      spec = JSON.parse(element.dataset.chart);
    } catch {
      continue;
    }
    if (spec.values || spec.series) continue;
    const columns = element.dataset.range.split(',').map((area) => {
      const ids = [...area.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((match) => document.getElementById(match[1]));
      const [from, to] = ids;
      if (ids.length !== 2 || !from || !to || from.cellIndex === undefined) return null;
      const table = from.closest('table');
      if (!table || table !== to.closest('table') || from.cellIndex !== to.cellIndex) return null;
      const rows = [...table.rows].slice(from.parentElement.rowIndex, to.parentElement.rowIndex + 1);
      return rows.map((row) => (row.cells[from.cellIndex]?.innerText || '').trim());
    });
    if (columns.length < 2 || columns.some((column) => !column || column.length !== columns[0].length)) continue;
    const number = (text) => Number(String(text).replace(/[^\d.-]/g, '')) || 0;
    const [labels, ...values] = columns;
    element.dataset.chart = JSON.stringify({
      ...spec,
      labels: labels.slice(1),
      ...(values.length === 1
        ? { values: values[0].slice(1).map(number) }
        : { series: values.map((column) => ({ name: column[0], values: column.slice(1).map(number) })) }),
    });
  }
}

/** Artifacts kept beside the workbook: its HTML and the browser's picture of each sheet. */
export function xlsxHtmlArtifacts(target) {
  return {
    source: `${target}.mixdog-source.html`,
    shot: (sheet) => `${target}.mixdog-html-sheet-${sheet}.png`,
    compare: (page) => `${target}.mixdog-compare-page-${page}.png`,
  };
}

export async function runXlsxHtmlAuthoring(html, output, { target, signal = null, timeoutMs = 90_000 }) {
  const startedAt = performance.now();
  const artifacts = xlsxHtmlArtifacts(target);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await writeFile(artifacts.source, html, 'utf8');
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-xlsx-captures-'));
  let browser;
  try {
    browser = await launchHtmlBrowser('xlsx-html-browser', { signal });
  } catch (error) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    return htmlFailure(error, startedAt);
  }
  const work = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(artifacts.source).href, { waitUntil: 'load' });
    await page.evaluate(injectIcons, iconTable().table, '0 0 24 24');
    await page.evaluate(() => document.fonts.ready);
    const measure = await page.evaluate(extractXlsxSheets);
    const captures = await photographCaptures(page, 'data-xlsx-capture', measure.captures, scratch);
    // The reference each sheet is held against: its section as the browser drew it, cut at its content (a data sheet's
    // section runs the window's width), with its charts drawn — a chart over its cells (data-range="{a}:{b},…") from
    // the text those cells show.
    await page.evaluate(fillRangeCharts);
    await page.evaluate(drawDataCharts);
    const extents = await page.evaluate(() =>
      [...document.querySelectorAll('section[data-sheet]')].map((section) => {
        const box = section.getBoundingClientRect();
        const cs = getComputedStyle(section);
        let right = box.left;
        let bottom = box.top;
        for (const el of section.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          right = Math.max(right, r.right);
          bottom = Math.max(bottom, r.bottom);
        }
        return {
          x: box.left + window.scrollX,
          y: box.top + window.scrollY,
          width: Math.min(box.width, right - box.left + (parseFloat(cs.paddingRight) || 0)),
          height: Math.min(box.height, bottom - box.top + (parseFloat(cs.paddingBottom) || 0)),
        };
      })
    );
    const htmlPages = [];
    for (const [index, clip] of extents.entries()) {
      const path = artifacts.shot(index + 1);
      noteOfficeWrite(path);
      await page.screenshot({ path, clip, captureBeyondViewport: true });
      htmlPages.push({ page: index + 1, path });
    }
    return { measure, captures, htmlPages, title: await page.title() };
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
    const built = await buildXlsxFromSheets(laid.measure, output, { captures: laid.captures, title: laid.title });
    laid.measure.notes.push(...built.notes);
    return {
      ok: true,
      output,
      bytes: (await stat(output)).size,
      htmlSource: artifacts.source,
      htmlPages: laid.htmlPages,
      logs: laid.measure.notes.map((text) => ({ level: 'warn', text })),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return htmlFailure(error, startedAt);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
