import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeOfficeTool, resetOfficeSessionsForTest } from '../index.mjs';
import { renderPortableOoxml } from '../portable/portable-ooxml.mjs';
import { renderPdfPages } from '../pdf/pdf-render.mjs';
import { compareRenderedPages } from '../quality/visual-diff.mjs';
import { resultValue } from './bench-support.mjs';

const OFFICE_EXTENSIONS = new Set([
  '.docx', '.dotx', '.docm', '.dotm',
  '.xlsx', '.xltx', '.xlsm', '.xltm',
  '.pptx', '.potx', '.pptm', '.potm',
  '.csv', '.tsv', '.pdf',
]);
const SNAPSHOT_LIMIT = 10_000;
const SNAPSHOT_MAX_CHARS = 100_000;
const LARGE_SPREADSHEET_VISUAL_CELLS = 50_000;
const DEFAULT_DOCUMENT_TIMEOUT_MS = 10 * 60_000;

export function officeBenchmarkSnapshotRequest(session, cursor = null) {
  return {
    action: 'snapshot',
    session,
    ...(cursor ? { cursor } : { limit: SNAPSHOT_LIMIT }),
    maxChars: SNAPSHOT_MAX_CHARS,
  };
}

export function officeBenchmarkVisualPolicy({
  format = '',
  totalCells = 0,
} = {}) {
  const spreadsheet = /^(xlsx|xlsm|xltx|xltm)$/i.test(String(format));
  if (spreadsheet && Number(totalCells) > LARGE_SPREADSHEET_VISUAL_CELLS) {
    return {
      mode: 'performance-only',
      reason: `Spreadsheet has ${Number(totalCells)} cells; full-page rendering is excluded from the large-load gate.`,
    };
  }
  return { mode: 'full' };
}

async function timed(operation) {
  const startedAt = performance.now();
  try {
    return {
      ok: true,
      value: await operation(),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    };
  }
}

function wordOperations(index) {
  return [
    ...Array.from({ length: index === 7 ? 1_000 : 120 }, (_, paragraph) => ({
      op: 'append_text',
      text: `Document ${index + 1} paragraph ${paragraph + 1}: Office Use benchmark content with Unicode 한글 日本語.`,
    })),
    { op: 'set_header_footer', section: 1, kind: 'primary', header: true, text: `Benchmark document ${index + 1}` },
    { op: 'add_page_numbers', section: 1, includeTotal: true },
    { op: 'insert_toc', lowerHeadingLevel: 1, upperHeadingLevel: 3 },
  ];
}

function workbookOperations(index) {
  if (index === 7) {
    return [
      {
        op: 'set_range',
        sheet: 'Sheet1',
        range: 'A1:A100000',
        values: Array.from({ length: 100_000 }, (_, row) => [row + 1]),
      },
      { op: 'set_formula', sheet: 'Sheet1', cell: 'B100000', formula: '=SUM(A1:A100000)' },
      { op: 'freeze_panes', sheet: 'Sheet1', row: 2, column: 0 },
    ];
  }
  const rows = Array.from({ length: 500 }, (_, row) => (
    Array.from({ length: 10 }, (_, column) => column === 0
      ? `Item ${index + 1}-${row + 1}`
      : (row + 1) * (column + 1))
  ));
  return [
    { op: 'set_range', sheet: 'Sheet1', range: 'A1:J500', values: rows },
    { op: 'set_formula', sheet: 'Sheet1', cell: 'K2', formula: '=SUM(B2:J2)' },
    { op: 'add_note', sheet: 'Sheet1', cell: 'B2', text: 'Source: generated Office benchmark corpus' },
    { op: 'add_table', sheet: 'Sheet1', range: 'A1:K500', name: `Benchmark${index + 1}` },
    { op: 'add_conditional_format', sheet: 'Sheet1', range: 'K2:K500', formula: '=K2>1000', fillColor: 'FFF2CC' },
    { op: 'freeze_panes', sheet: 'Sheet1', row: 2, column: 1 },
    { op: 'define_name', name: `BenchmarkTotal${index + 1}`, refersTo: 'Sheet1!$K$2' },
  ];
}

function presentationOperations(index) {
  const operations = [];
  for (let slide = 1; slide <= (index === 7 ? 100 : 12); slide += 1) {
    operations.push(
      { op: 'add_slide' },
      {
        op: 'add_textbox',
        slide,
        text: `Benchmark ${index + 1}: slide ${slide} takeaway`,
        properties: { left: 40, top: 30, width: 620, height: 60, fontSize: 26 },
      },
      {
        op: 'add_shape',
        slide,
        shapeType: 'rounded_rectangle',
        paragraphs: [{ text: `Metric ${slide}: ${index * 100 + slide}`, fontSize: 18 }],
        properties: { left: 60, top: 140, width: 260, height: 100, fillColor: 'D9EAF7', lineColor: '2F5597' },
      },
      {
        op: 'add_table',
        slide,
        values: [['Metric', 'Value'], ['Actual', index * 100 + slide], ['Plan', index * 100 + slide + 5]],
        properties: { left: 360, top: 140, width: 300, height: 120 },
      },
      { op: 'set_notes', slide, text: `Source: benchmark.xlsx, Sheet1!K${slide + 1}` },
    );
  }
  return operations;
}

export async function generateOfficeBenchmarkCorpus(directory, {
  documentsPerFormat = 8,
  onProgress = null,
} = {}) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const generated = [];
  const formats = [
    ['docx', wordOperations],
    ['xlsx', workbookOperations],
    ['pptx', presentationOperations],
  ];
  for (const [format, operationsFor] of formats) {
    for (let index = 0; index < documentsPerFormat; index += 1) {
      const path = join(root, `${format}-benchmark-${String(index + 1).padStart(2, '0')}.${format}`);
      const created = resultValue(await executeOfficeTool({
        action: 'create',
        path,
        format,
        mode: 'background',
        overwrite: true,
      }, { cwd: root }));
      resultValue(await executeOfficeTool({
        action: 'batch',
        session: created.session,
        operations: operationsFor(index),
        save: true,
      }, { cwd: root }));
      resultValue(await executeOfficeTool({ action: 'close', session: created.session, save: true }, { cwd: root }));
      generated.push(path);
      onProgress?.({
        phase: 'generate',
        format,
        index: index + 1,
        total: documentsPerFormat,
        path,
        message: `generated ${format} ${index + 1}/${documentsPerFormat}`,
      });
    }
  }
  return generated;
}

async function corpusFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && OFFICE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function renderAllPdfPages(path, { signal = null } = {}) {
  const first = await renderPdfPages(path, { pages: [1], maxWidth: 900, signal });
  const images = [...first.images];
  for (let start = 2; start <= first.pageCount; start += 12) {
    if (signal?.aborted) throw new Error('Office benchmark document timed out');
    const pages = Array.from({ length: Math.min(12, first.pageCount - start + 1) }, (_, index) => start + index);
    const rendered = await renderPdfPages(path, { pages, maxWidth: 900, signal });
    images.push(...rendered.images);
  }
  return { pageCount: first.pageCount, images };
}

async function fullVisualDiff(source, output, outputDirectory, { signal = null } = {}) {
  const stem = basename(source, extname(source));
  const beforePdf = join(outputDirectory, `${stem}.before.pdf`);
  const afterPdf = join(outputDirectory, `${stem}.after.pdf`);
  if (extname(source).toLowerCase() === '.pdf') {
    await copyFile(source, beforePdf);
    await copyFile(output, afterPdf);
  } else {
    await renderPortableOoxml(source, beforePdf, { signal });
    await renderPortableOoxml(output, afterPdf, { signal });
  }
  const [before, after] = await Promise.all([
    renderAllPdfPages(beforePdf, { signal }),
    renderAllPdfPages(afterPdf, { signal }),
  ]);
  if (signal?.aborted) throw new Error('Office benchmark document timed out');
  const compared = await compareRenderedPages(before.images, after.images, afterPdf);
  return {
    available: compared.available,
    pageCountBefore: before.pageCount,
    pageCountAfter: after.pageCount,
    changedPercent: compared.changedPercent,
    pages: compared.pages,
    images: compared.images.map(({ data, ...image }) => image),
  };
}

async function benchmarkDocument(path, outputDirectory, {
  onProgress = null,
  documentTimeoutMs = DEFAULT_DOCUMENT_TIMEOUT_MS,
} = {}) {
  const extension = extname(path);
  const output = join(outputDirectory, `${basename(path, extension)}.roundtrip${extension}`);
  const report = {
    path,
    output,
    bytes: (await stat(path)).size,
    format: extension.slice(1).toLowerCase(),
    timeoutMs: documentTimeoutMs,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), documentTimeoutMs);
  timer.unref?.();
  let session = '';
  try {
    const context = { cwd: dirnameOf(path), signal: controller.signal };
    const opened = await timed(async () => resultValue(await executeOfficeTool({
      action: 'open',
      path,
      output,
      mode: 'background',
    }, context)));
    report.open = opened;
    if (!opened.ok) {
      report.timedOut = controller.signal.aborted;
      return report;
    }
    session = opened.value.session;
    const snapshot = await timed(async () => {
      let cursor = null;
      let calls = 0;
      let returned = 0;
      let scanned = 0;
      let total = 0;
      let finalLimit = 0;
      do {
        const page = resultValue(await executeOfficeTool(
          officeBenchmarkSnapshotRequest(session, cursor),
          context,
        ));
        const pagination = page.document?.pagination || {};
        calls += 1;
        returned += Number(pagination.returned || 0);
        scanned += Number(pagination.scanned || 0);
        total = Math.max(total, Number(pagination.total || 0));
        finalLimit = Number(pagination.limit || finalLimit);
        cursor = pagination.nextCursor || null;
        // scanned counts spreadsheet cells and only Excel reports it. Word and
        // PowerPoint report returned units, so a bare scanned printed 0 progress
        // for them however far the walk had actually gone.
        const covered = scanned || returned;
        if (calls === 1 || calls % 25 === 0 || !cursor) {
          onProgress?.({
            phase: 'snapshot',
            path,
            calls,
            scanned,
            returned,
            total,
            message: `snapshot ${basename(path)}: ${covered}/${total || '?'} units in ${calls} call(s)`,
          });
        }
      } while (cursor && calls < 10_000);
      if (cursor) throw new Error('Office benchmark snapshot exceeded 10,000 pagination calls');
      return { calls, returned, scanned, total, finalLimit };
    });
    report.snapshot = snapshot;
    if (controller.signal.aborted) {
      report.timedOut = true;
      report.success = false;
      return report;
    }
    report.validation = await timed(async () => resultValue(await executeOfficeTool({
      action: 'validate',
      session,
      compatibility: true,
    }, context)));
    report.save = await timed(async () => resultValue(await executeOfficeTool({
      action: 'save',
      session,
    }, context)));
    report.visualPolicy = officeBenchmarkVisualPolicy({
      format: report.format,
      totalCells: report.snapshot.value?.total || 0,
    });
    report.visualRequired = report.visualPolicy.mode === 'full'
      && (report.format === 'pdf' || report.validation.value?.compatibility?.available === true);
    if (report.visualRequired) {
      const previewPath = join(outputDirectory, `${basename(path, extension)}.preview.pdf`);
      report.render = await timed(async () => resultValue(await executeOfficeTool({
        action: 'render',
        session,
        output: previewPath,
        pages: [1],
        maxWidth: 900,
      }, context)));
      report.visual = await timed(async () => await fullVisualDiff(path, output, outputDirectory, {
        signal: controller.signal,
      }));
    } else {
      const reason = report.visualPolicy.mode !== 'full'
        ? report.visualPolicy.reason
        : 'LibreOffice compatibility rendering is unavailable; visual comparison was not run.';
      report.render = {
        ok: true,
        skipped: true,
        reason,
        durationMs: 0,
      };
      report.visual = {
        ok: true,
        skipped: true,
        available: false,
        reason,
        durationMs: 0,
      };
    }
    report.timedOut = controller.signal.aborted;
    report.visualThresholdPercent = 0.5;
    report.success = !report.timedOut
      && report.snapshot.ok
      && report.validation.ok
      && report.validation.value.ok
      && report.render.ok
      && (!report.visualRequired || (
        report.visual.ok
        && report.visual.value.available
        && report.visual.value.pageCountBefore === report.visual.value.pageCountAfter
        && report.visual.value.changedPercent <= report.visualThresholdPercent
      ));
    report.roundTrip = {
      lostProtectedParts: report.validation.value?.baseline?.lostProtectedParts || [],
      changedProtectedParts: report.validation.value?.baseline?.changedProtectedParts || [],
      digitalSignatureInvalidated: report.validation.value?.security?.digitalSignatureInvalidated === true,
    };
  } finally {
    clearTimeout(timer);
    if (session) {
      await executeOfficeTool({ action: 'close', session }, { cwd: dirnameOf(path) }).catch(() => {});
    }
  }
  return report;
}

function dirnameOf(path) {
  return dirname(path);
}

function summarize(results) {
  const successful = results.filter((entry) => entry.success).length;
  const durations = results.map((entry) => (
    Number(entry.open?.durationMs || 0)
    + Number(entry.snapshot?.durationMs || 0)
    + Number(entry.validation?.durationMs || 0)
    + Number(entry.render?.durationMs || 0)
    + Number(entry.visual?.durationMs || 0)
  ));
  return {
    documents: results.length,
    successful,
    failed: results.length - successful,
    successRate: results.length ? Number((successful / results.length).toFixed(4)) : 0,
    totalDurationMs: Number(durations.reduce((sum, value) => sum + value, 0).toFixed(2)),
    averageDurationMs: results.length
      ? Number((durations.reduce((sum, value) => sum + value, 0) / results.length).toFixed(2))
      : 0,
    regressions: results.filter((entry) => !entry.success).map((entry) => ({
      path: entry.path,
      error: entry.open?.error
        || entry.snapshot?.error
        || entry.validation?.error
        || entry.render?.error
        || (entry.timedOut ? 'document timed out' : 'verification failed'),
    })),
  };
}

export async function runOfficeBenchmark({
  corpus,
  output,
  baseline = '',
  generate = false,
  documentsPerFormat = 8,
  documentTimeoutMs = DEFAULT_DOCUMENT_TIMEOUT_MS,
  onProgress = null,
} = {}) {
  const corpusDirectory = resolve(corpus);
  const outputDirectory = resolve(output || join(corpusDirectory, 'benchmark-output'));
  try {
    await mkdir(outputDirectory, { recursive: true });
    if (generate) await generateOfficeBenchmarkCorpus(corpusDirectory, { documentsPerFormat, onProgress });
    const files = await corpusFiles(corpusDirectory);
    const results = [];
    for (let index = 0; index < files.length; index += 1) {
      const path = files[index];
      onProgress?.({
        phase: 'document-start',
        index: index + 1,
        total: files.length,
        path,
        message: `checking ${index + 1}/${files.length}: ${basename(path)}`,
      });
      const result = await benchmarkDocument(path, outputDirectory, { onProgress, documentTimeoutMs });
      results.push(result);
      onProgress?.({
        phase: 'document-complete',
        index: index + 1,
        total: files.length,
        path,
        success: result.success === true,
        message: `completed ${index + 1}/${files.length}: ${basename(path)} (${result.success ? 'pass' : 'fail'})`,
      });
    }
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      corpus: corpusDirectory,
      output: outputDirectory,
      summary: summarize(results),
      results,
    };
    if (baseline) {
      const previous = JSON.parse(await readFile(resolve(baseline), 'utf8'));
      report.comparison = {
        baseline: resolve(baseline),
        successRateDelta: Number((report.summary.successRate - Number(previous.summary?.successRate || 0)).toFixed(4)),
        averageDurationDeltaMs: Number((report.summary.averageDurationMs - Number(previous.summary?.averageDurationMs || 0)).toFixed(2)),
        newRegressions: report.summary.regressions.filter((entry) => !(previous.summary?.regressions || []).some((prior) => prior.path === entry.path)),
      };
    }
    const reportPath = join(outputDirectory, 'office-benchmark-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { reportPath, report };
  } finally {
    resetOfficeSessionsForTest();
  }
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const corpus = argument('--corpus');
  if (!corpus) throw new Error('Usage: node benchmark.mjs --corpus DIR [--output DIR] [--generate] [--baseline REPORT]');
  const terminate = (signal) => {
    resetOfficeSessionsForTest();
    process.stderr.write(`[office-benchmark] interrupted by ${signal}; owned Office sessions were stopped\n`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => terminate('SIGINT');
  const onSigterm = () => terminate('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const result = await runOfficeBenchmark({
      corpus,
      output: argument('--output'),
      baseline: argument('--baseline'),
      generate: process.argv.includes('--generate'),
      documentsPerFormat: Number(argument('--per-format', '8')),
      documentTimeoutMs: Number(argument('--document-timeout-ms', String(DEFAULT_DOCUMENT_TIMEOUT_MS))),
      onProgress: ({ message }) => process.stderr.write(`[office-benchmark] ${message}\n`),
    });
    process.stdout.write(`${JSON.stringify({ reportPath: result.reportPath, summary: result.report.summary }, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
