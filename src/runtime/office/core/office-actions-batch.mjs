import { copyFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { applyPortableOoxmlBatch, clearPortablePresentationSlides } from '../portable/portable-ooxml.mjs';
import { applyPdfBatch } from '../pdf/pdf-adapter.mjs';
import { assertOfficeOperationContracts } from '../capabilities.mjs';
import { quoteUnquotedSheetReferences, validateXlsxOperations } from '../portable/xlsx-contract.mjs';
import { applyTabularBatch } from './tabular.mjs';
import { expandOfficeDesignOperations } from '../design/design-system.mjs';
import { createPptxSlideSelection } from '../design/library/design-library.mjs';
import { expandTemplatePageOperations } from '../design/library/design-template-fill.mjs';
import { assertOfficeMutationAllowed } from '../quality/assurance.mjs';
import { inlineOfficeAudit } from '../quality/inline-audit.mjs';
import { DEFAULT_SERIES_COLORS } from '../portable/portable-chart.mjs';
import { measureTextWidth } from '../portable/text-metrics.mjs';
import { PIXELS_TO_POINTS, imagePixelSize } from '../portable/portable-opc.mjs';
import { naturalColumnWidths } from '../shared/column-widths.mjs';
import { figureColumnAlignments } from '../shared/column-alignments.mjs';
import { pageSizePoints } from '../shared/page-sizes.mjs';
import {
  TABULAR_FORMATS,
  emptyOfficeDesignState,
  isMicrosoftOfficeSession,
  mergeOfficeDesignRequest,
} from './office-core.mjs';
import { fullPath, materializeWorkingCopy, trustForMutation } from './office-sessions.mjs';
import {
  assertTransactionUnchanged,
  captureSessionState,
  persistOfficeTransaction,
  recordTransactionOperations,
  transactionDocumentDiff,
  transactionView,
} from './office-transactions.mjs';

import { koreanParticleReplacements } from '../shared/korean-particles.mjs';

// Excel fills an unstyled series from the workbook theme (a teal and an orange on the default one) while the
// portable writer paints its own hue family, so the same add_chart drew two different charts. A chart that
// names no colours takes the portable palette on both backends; a named palette is kept as written.
function withSharedChartDefaults(session, operations) {
  if (session.format === 'pptx') return withTemplateParticles(operations.map(withSlideChartColors));
  if (session.format !== 'xlsx') return withTemplateParticles(operations);
  return operations.map((operation) =>
    operation?.op === 'add_chart' && !(Array.isArray(operation.seriesColors) && operation.seriesColors.length)
      ? { ...operation, seriesColors: [...DEFAULT_SERIES_COLORS] }
      : operation
  );
}

// PowerPoint fills an unstyled series from the deck theme as Excel does (a teal and an orange beside the portable
// writer's blues): a slide chart that names no colour takes the portable palette too — a series its colour, a pie or
// doughnut slice its own, as the portable writer cycles them.
function withSlideChartColors(operation) {
  if (operation?.op !== 'add_chart' || !Array.isArray(operation.series)) return operation;
  const palette = DEFAULT_SERIES_COLORS;
  const slices = /^(?:pie|doughnut|donut)$/i.test(String(operation.chartType || '').trim());
  return {
    ...operation,
    series: operation.series.map((entry, index) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (!slices) return entry.color ? entry : { ...entry, color: palette[index % palette.length] };
      if (Array.isArray(entry.pointColors) && entry.pointColors.length) return entry;
      const values = Array.isArray(entry.values) ? entry.values : [];
      return { ...entry, pointColors: values.map((_, point) => palette[point % palette.length]) };
    }),
  };
}

// Word and PowerPoint fill a template with the same particle rewrites the portable writer runs
// (shared/korean-particles.mjs), handed over with the operation so "{{company}}은" lands as 모아페이는 on both.
function withTemplateParticles(operations) {
  return operations.map((operation) =>
    operation?.op === 'fill_template' ? { ...operation, particles: koreanParticleReplacements(operation.tokens) } : operation
  );
}

// A Word page is named the way a PDF page is (`letter`, `a4`, or [width, height] in points). The name is
// resolved here once, so Word and the portable writer receive the same two numbers.
function withPageSizePoints(session, operations) {
  if (session.format !== 'docx') return operations;
  return operations.map((operation) => {
    if (operation?.op !== 'set_page' || operation.properties?.pageSize == null) return operation;
    const { pageSize, ...properties } = operation.properties;
    const [pageWidth, pageHeight] = pageSizePoints(pageSize, 'set_page pageSize');
    return { ...operation, properties: { ...properties, pageWidth, pageHeight } };
  });
}

// A Word table that declares no column alignments sets its columns of figures right, as the PDF writer sets them
// (shared/column-alignments.mjs): "2.6억 원" and 184,200 had started at the left edge under a left header.
function withFigureColumnAlignments(session, operations) {
  if (session.format !== 'docx') return operations;
  return operations.map((operation) => {
    if (operation?.op !== 'add_table' || !Array.isArray(operation.values) || operation.values.length < 2) {
      return operation;
    }
    if (Array.isArray(operation.properties?.columnAlignments)) return operation;
    const rows = operation.values.map((row) => (Array.isArray(row) ? row : [row]).map((value) => String(value ?? '')));
    const alignments = figureColumnAlignments(rows, Math.max(...rows.map((row) => row.length)));
    if (!alignments.includes('right')) return operation;
    return { ...operation, properties: { ...operation.properties, columnAlignments: alignments } };
  });
}

// A picture given one side takes the other from its own proportions, on every backend: the side left out fell to a
// fixed default (240 × 180 pt in the portable file, 320 × 240 through Office, the height Word had fitted to the page)
// and the picture came out stretched. A slide picture given neither side is 240 pt wide at its proportions, a sheet
// picture keeps its own size; a Word picture given neither is left to the page it lands on.
async function withImageProportions(session, operations) {
  if (!['docx', 'xlsx', 'pptx'].includes(session.format)) return operations;
  const next = [];
  for (const operation of operations) {
    const width = Number(operation?.width) > 0 ? Number(operation.width) : 0;
    const height = Number(operation?.height) > 0 ? Number(operation.height) : 0;
    const stretch = String(operation?.fit || 'stretch').toLowerCase() === 'stretch';
    if (
      operation?.op !== 'add_image' ||
      !operation.path ||
      (width && height) ||
      !stretch ||
      (session.format === 'docx' && !width && !height)
    ) {
      next.push(operation);
      continue;
    }
    // A file that cannot be read is left to the backend, which names it in its own refusal.
    const data = await readFile(operation.path).catch(() => null);
    const pixels = data ? imagePixelSize(data) : null;
    if (!pixels?.width || !pixels?.height) {
      next.push(operation);
      continue;
    }
    const ratio = pixels.height / pixels.width;
    let size = { width: pixels.width * PIXELS_TO_POINTS, height: pixels.height * PIXELS_TO_POINTS };
    if (width) size = { width, height: width * ratio };
    else if (height) size = { width: height / ratio, height };
    else if (session.format === 'pptx') size = { width: 240, height: 240 * ratio };
    next.push({
      ...operation,
      width: Math.round(size.width * 100) / 100,
      height: Math.round(size.height * 100) / 100,
    });
  }
  return next;
}

// A built-in Excel table style in the name Excel stores ("TableStyleMedium2"), however the author spaced or cased it
// ("Table Style Medium 2", "medium 2", "TableStyleNone"): Excel refused the spelled-out name and failed the batch, and
// the portable file carried a style Excel does not have. A custom style's name stays as written.
function withTableStyleNames(session, operations) {
  if (session.format !== 'xlsx') return operations;
  return operations.map((operation) => {
    if (operation?.op !== 'add_table' || operation.style === undefined) return operation;
    const compact = String(operation.style).replace(/[\s_-]+/g, '');
    if (!compact || /^(?:tablestyle)?none$/i.test(compact)) return { ...operation, style: 'none' };
    const builtIn = /^(?:tablestyle)?(light|medium|dark)(\d{1,2})$/i.exec(compact);
    if (!builtIn) return operation;
    const tone = `${builtIn[1][0].toUpperCase()}${builtIn[1].slice(1).toLowerCase()}`;
    return { ...operation, style: `TableStyle${tone}${Number(builtIn[2])}` };
  });
}

// PowerPoint's cell margins, left and right together, in points.
const SLIDE_CELL_PADDING = 14.4;

// A slide table that names no column widths takes the widths its text needs, as a Word, PDF, or kit table does
// (naturalColumnWidths), measured in its own face at its own size (PowerPoint's 18 pt when it names none), the
// header bold. Equal columns broke a hub name over three lines beside columns of short figures. Both backends
// receive the same widths.
function withSlideTableWidths(session, operations) {
  if (session.format !== 'pptx') return operations;
  return operations.map((operation) => {
    if (operation?.op !== 'add_table' || !Array.isArray(operation.values)) return operation;
    const properties = operation.properties || {};
    if (Array.isArray(properties.columnWidths)) return operation;
    const rows = operation.values.filter(Array.isArray);
    const font = {
      fontName: properties.fontName || 'Calibri',
      fontSize: Number(properties.fontSize) > 0 ? Number(properties.fontSize) : 18,
    };
    const measure = (text, rowIndex) =>
      measureTextWidth(text, { ...font, bold: rowIndex === 0 }) * 1.05 + SLIDE_CELL_PADDING;
    const widths = naturalColumnWidths(rows, measure, Number(operation.width) > 0 ? Number(operation.width) : 480);
    if (!widths) return operation;
    return {
      ...operation,
      properties: { ...properties, columnWidths: widths.map((width) => Math.round(width * 100) / 100) },
    };
  });
}

// Operations whose `path` names a file the caller supplied relative to its cwd.
const PATH_OPERATIONS = new Set([
  'add_image',
  'replace_image',
  'stamp_image',
  'add_attachment',
  'merge_pdf',
  'apply_theme',
  'import_slides',
  'use_template_page',
  'add_media',
]);
const FONT_PATH_OPERATIONS = ['add_text', 'watermark', 'ocr_pages', 'fill_form', 'add_form_field', 'flatten_form'];
const OUTPUT_PATH_OPERATIONS = ['extract_pages', 'split_pages', 'extract_attachment'];

// Every path an operation carries resolves against the caller's cwd, not the
// document's directory.
function localizeOperation(operation, baseDir) {
  let normalized = operation;
  const op = String(operation?.op || '');
  if (operation?.path && PATH_OPERATIONS.has(op)) {
    normalized = { ...normalized, path: fullPath(operation.path, baseDir) };
  }
  if (operation?.fontPath && FONT_PATH_OPERATIONS.includes(op)) {
    normalized = { ...normalized, fontPath: fullPath(operation.fontPath, baseDir) };
  }
  if (operation?.op === 'merge_pdf' && Array.isArray(operation.sources)) {
    normalized = {
      ...normalized,
      sources: operation.sources.map((entry) => {
        if (typeof entry === 'string') return fullPath(entry, baseDir);
        return entry?.path ? { ...entry, path: fullPath(entry.path, baseDir) } : entry;
      }),
    };
  }
  if (operation?.output && OUTPUT_PATH_OPERATIONS.includes(op)) {
    normalized = { ...normalized, output: fullPath(operation.output, baseDir) };
  }
  return normalized;
}

function microsoftOfficeCall(session, target, request, timeoutMs) {
  return callMicrosoftOffice(
    { session: session.id, format: session.format, mode: session.mode, path: target, ...request },
    { signal: session.activeSignal || null, timeoutMs }
  );
}

async function microsoftBatch(session, args, target, operations) {
  const result = await microsoftOfficeCall(
    session,
    target,
    {
      action: 'batch',
      operations: withSharedChartDefaults(session, operations),
      save: args.save === true,
      requireChanges: args.requireChanges !== false,
    },
    Math.min(300_000, 90_000 + operations.length * 500)
  );
  return result;
}

// Runs the batch on the Office host. An empty new deck first takes the
// imported presentation as its source, then the remaining operations.
async function runMicrosoftBatch(
  session,
  args,
  { target, operations, emptyDeckReplacement, replacementSource, backup }
) {
  let backgroundIsolation = session.backgroundIsolation || null;
  if (!emptyDeckReplacement) {
    const result = await microsoftBatch(session, args, target, operations);
    if (!result.ok) throw new Error(result.error || 'Microsoft Office batch failed');
    return {
      results: result.results,
      saved: result.saved,
      undoUnits: Number(result.undoUnits) || 0,
      backgroundIsolation: result.backgroundIsolation || backgroundIsolation,
    };
  }
  const operation = operations[0];
  const replaced = await microsoftOfficeCall(
    session,
    target,
    {
      action: 'replace_presentation_from_source',
      source: replacementSource || operation.path,
      ...(replacementSource ? {} : { slides: operation.slides }),
      checkpoint: backup,
    },
    120_000
  );
  if (!replaced.ok) {
    throw new Error(`PowerPoint source replacement failed: ${replaced.error || 'unknown error'}`);
  }
  backgroundIsolation = replaced.backgroundIsolation || backgroundIsolation;
  const results = Array.isArray(replaced.results) ? replaced.results : [replaced.results];
  const remaining = operations.slice(1);
  if (!remaining.length) return { results, saved: replaced.saved === true, undoUnits: 0, backgroundIsolation };
  const result = await microsoftBatch(session, args, target, remaining);
  if (!result.ok) throw new Error(result.error || 'Microsoft Office batch failed after native template import');
  results.push(...(Array.isArray(result.results) ? result.results : [result.results]));
  return {
    results,
    saved: result.saved,
    undoUnits: Number(result.undoUnits) || 0,
    backgroundIsolation: result.backgroundIsolation || backgroundIsolation,
  };
}

// Records the applied batch on the open transaction; a journal that could not
// be written is reported, not fatal.
async function recordAppliedTransaction(session, transaction, operations, results, undoUnits) {
  const current = await captureSessionState(session);
  transaction.expectedFingerprint = current.fingerprint;
  transaction.currentDocument = current.document;
  transaction.undoUnits += undoUnits;
  recordTransactionOperations(transaction, session.format, operations, results);
  transaction.diff = transactionDocumentDiff(transaction, current.document);
  transaction.phase = 'active';
  let journalWarning = '';
  try {
    await persistOfficeTransaction(session);
  } catch (error) {
    journalWarning = error?.message || String(error);
  }
  const view = transactionView(transaction);
  if (journalWarning) view.journalWarning = journalWarning;
  return view;
}

function recordDesignState(session, prepared) {
  session.designState.semanticCount += prepared.semantic.length;
  session.designState.compositions = [
    ...(session.designState.compositions || []),
    ...prepared.semantic.map((entry) => entry?.composition).filter(Boolean),
  ];
  if (session.format !== 'pptx' || !session.design.review.required) return;
  session.designState.requiresVisualReview = true;
  const existingPlans = new Map((session.designState.slidePlans || []).map((plan) => [Number(plan.slide), plan]));
  for (const semantic of prepared.semantic) {
    if (semantic?.plan && Number(semantic.slide) > 0) {
      existingPlans.set(Number(semantic.slide), {
        ...semantic.plan,
        kind: semantic.kind,
        slideRole: semantic.slideRole,
        backgroundRole: semantic.backgroundRole,
      });
    }
  }
  session.designState.slidePlans = [...existingPlans.values()].sort((left, right) => left.slide - right.slide);
}

// A column fitted while its formulas were uncached was measured against
// empty cells: the widths are only final once the workbook has been
// recalculated, so the session remembers what to fit again then. The fit is
// replayed whole — its minWidth and whether it fits rows — and in order with the
// explicit widths and heights set after it: replayed bare, a composed report's
// 19-character columns shrank to their content, and a gutter set by
// set_column_width after the fit was widened again.
const SIZING_FIELDS = ['sheet', 'range', 'minWidth', 'rows', 'column', 'row', 'width', 'height', 'count'];
function sizingKey(operation) {
  const target = operation.op === 'autofit_range' ? `${operation.range}|${operation.rows === true}` : `${operation.column ?? operation.row}|${operation.count ?? 1}`;
  return `${operation.op}|${operation.sheet || ''}|${target}`;
}
function rememberAutofitRanges(session, operations) {
  const sized = operations
    .filter(
      (operation) =>
        (operation.op === 'autofit_range' && operation.range) ||
        operation.op === 'set_column_width' ||
        operation.op === 'set_row_height'
    )
    .map((operation) =>
      Object.fromEntries([['op', operation.op], ...SIZING_FIELDS.filter((field) => operation[field] !== undefined).map((field) => [field, operation[field]])])
    );
  if (!sized.length) return;
  // The latest request for a target wins and takes its place in the order.
  const keys = new Set(sized.map(sizingKey));
  session.autofitRanges = [...(session.autofitRanges || []).filter((entry) => !keys.has(sizingKey(entry))), ...sized];
}

// Resolves what the batch will run: the design-expanded, cwd-localized,
// contract-checked operation list and the design plan it came from.
async function prepareBatchOperations(session, args) {
  const designRequest = mergeOfficeDesignRequest(session.designRequest, args.design);
  const requested = Array.isArray(args.operations) ? args.operations : [];
  assertOfficeOperationContracts({ format: session.format, backend: session.backend, operations: requested });
  const prepared = expandOfficeDesignOperations({
    format: session.format,
    backend: session.backend,
    operations: requested,
    design: designRequest,
    library: session.designLibrary,
    created: session.created === true,
    snapshotVersion: session.snapshotVersion,
  });
  session.designRequest = designRequest;
  session.design = prepared.design;
  session.designState ||= emptyOfficeDesignState();
  const baseDir = args.__cwd || dirname(session.target);
  let operations = Array.isArray(prepared.operations)
    ? prepared.operations.map((operation) => localizeOperation(operation, baseDir))
    : [];
  if (!operations.length) throw new Error('batch requires at least one operation');
  if (
    session.format === 'pptx' &&
    operations.some((operation) => operation.op === 'import_slides') &&
    operations.some((operation) => operation.op === 'keep_slides')
  ) {
    throw new Error('Run keep_slides in a later batch after import_slides has been saved');
  }
  assertOfficeOperationContracts({ format: session.format, backend: session.backend, operations });
  // A template page is chosen and filled before any backend sees the batch: it
  // arrives as the import of that one page and the writes into its own slots,
  // which both backends already perform.
  operations = await expandTemplatePageOperations(session.format, operations);
  if (session.format === 'xlsx' || TABULAR_FORMATS.has(session.format)) validateXlsxOperations(operations);
  // Excel rejects `My Sheet!A1` outright; the portable writer quotes it from
  // the sheet list, and an Excel session gets the same courtesy here.
  if (session.format === 'xlsx' && isMicrosoftOfficeSession(session)) {
    for (const operation of operations) {
      if (operation?.op === 'set_formula' && typeof operation.formula === 'string') {
        operation.formula = quoteUnquotedSheetReferences(operation.formula);
      }
    }
  }
  operations = withTableStyleNames(
    session,
    withSlideTableWidths(session, withFigureColumnAlignments(session, withPageSizePoints(session, operations)))
  );
  operations = await withImageProportions(session, operations);
  return { prepared, operations };
}
// Marks the open transaction as applying and journals that; a journal that
// cannot be written leaves the transaction active and stops the batch.
async function markTransactionApplying(session) {
  const transaction = session.transaction;
  if (!transaction) return null;
  await assertTransactionUnchanged(session);
  transaction.phase = 'applying';
  try {
    await persistOfficeTransaction(session);
  } catch (error) {
    transaction.phase = 'active';
    throw error;
  }
  return transaction;
}

// Where the batch falls back to if a backend fails half-way: a copy of the
// target for the portable writers (a save-copy checkpoint for a COM import),
// and for an empty COM deck replaced by an import, the selection file that
// import is built from.
function batchSafetyPlan(session, target, operations) {
  const [first] = operations;
  const importsSlides = operations.some((operation) => operation.op === 'import_slides');
  const emptyDeckReplacement =
    session.backend === 'microsoft-office-com' &&
    session.format === 'pptx' &&
    session.mode === 'background' &&
    session.created === true &&
    Number(session.snapshotVersion || 0) === 0 &&
    first.op === 'import_slides' &&
    Number(first.after || 0) === 0 &&
    extname(first.path).toLowerCase() === extname(target).toLowerCase();
  const portableTemplateSeed =
    session.backend === 'mixdog-ooxml' &&
    session.format === 'pptx' &&
    session.created === true &&
    Number(session.snapshotVersion || 0) === 0 &&
    importsSlides
      ? operations.find((operation) => operation.op === 'import_slides').path
      : '';
  const needsComCheckpoint = isMicrosoftOfficeSession(session) && session.mode === 'background' && importsSlides;
  const backup =
    !isMicrosoftOfficeSession(session) || needsComCheckpoint ? `${target}.mixdog-backup-${randomUUID()}` : '';
  const replacementSource =
    emptyDeckReplacement && Array.isArray(first?.slides)
      ? join(tmpdir(), `mixdog-pptx-selection-${randomUUID()}.pptx`)
      : '';
  return { emptyDeckReplacement, portableTemplateSeed, needsComCheckpoint, backup, replacementSource };
}

async function stageBatchBackup(session, target, operations, plan) {
  const { backup, needsComCheckpoint, replacementSource } = plan;
  if (replacementSource) {
    await createPptxSlideSelection(operations[0].path, operations[0].slides, replacementSource);
  }
  if (backup && needsComCheckpoint) {
    const checkpoint = await microsoftOfficeCall(session, target, { action: 'save_copy', output: backup }, 120_000);
    if (!checkpoint.ok) {
      throw new Error(`Microsoft Office save-copy checkpoint failed: ${checkpoint.error || 'unknown error'}`);
    }
  } else if (backup) {
    await copyFile(target, backup);
  }
}

async function restoreBatchTarget(session, target, plan) {
  const { backup, emptyDeckReplacement } = plan;
  if (backup && emptyDeckReplacement) {
    await microsoftOfficeCall(
      session,
      target,
      { action: 'replace_presentation_from_source', source: backup, checkpoint: backup },
      120_000
    ).catch(() => {});
  } else if (backup) {
    await rm(target, { force: true }).catch(() => {});
    await rename(backup, target).catch(() => {});
  }
}
// Runs the operations on the session's backend and returns the raw results
// with what the Office host reports about the save and its undo units.
async function runBatchBackend(session, args, target, operations, plan) {
  if (session.backend === 'microsoft-office-com') {
    return runMicrosoftBatch(session, args, {
      target,
      operations,
      emptyDeckReplacement: plan.emptyDeckReplacement,
      replacementSource: plan.replacementSource,
      backup: plan.backup,
    });
  }
  const outcome = { saved: true, undoUnits: 0, backgroundIsolation: session.backgroundIsolation || null };
  if (session.format === 'pdf') {
    const results = await applyPdfBatch(target, operations, {
      dataDir: session.dataDir,
      signal: session.activeSignal || null,
    });
    return { ...outcome, results };
  }
  if (TABULAR_FORMATS.has(session.format)) {
    return { ...outcome, results: await applyTabularBatch(target, session.format, operations) };
  }
  if (plan.portableTemplateSeed) {
    await copyFile(plan.portableTemplateSeed, target);
    await clearPortablePresentationSlides(target);
  }
  return { ...outcome, results: await applyPortableOoxmlBatch(target, session.format, operations) };
}

function normalizeBatchResults(results) {
  return (Array.isArray(results) ? results : [results]).filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  );
}

// An operation may declare allowNoChange (a routine normalize_runs, a
// fit_text that already fits); the Office host honours it per entry and
// the portable path does the same when results map onto operations.
function unchangedResults(operations, results) {
  const aligned = results.length === operations.length;
  return results.filter(
    (entry, index) => entry.changed === false && !(aligned && operations[index]?.allowNoChange === true)
  );
}

function assertBatchChanged(session, args, noChange) {
  if (args.requireChanges === false || !noChange.length || session.backend === 'microsoft-office-com') return;
  // An operation that knows why it changed nothing says so: "no change" on
  // its own sends the caller back to look for a fault that is not there.
  throw new Error(
    `Office batch produced no change for: ${noChange
      .map((entry) => `${entry.op || 'operation'}${entry.unchangedReason ? ` (${entry.unchangedReason})` : ''}`)
      .join(', ')}`
  );
}

// Records the applied batch on the session and builds the batch result.
async function commitBatch(session, args, { trust, prepared, operations, transaction, target, outcome }) {
  const results = normalizeBatchResults(outcome.results);
  const noChange = unchangedResults(operations, results);
  assertBatchChanged(session, args, noChange);
  const transactionResult = transaction
    ? await recordAppliedTransaction(session, transaction, operations, results, outcome.undoUnits)
    : undefined;
  recordDesignState(session, prepared);
  if (session.format === 'xlsx') rememberAutofitRanges(session, operations);
  session.snapshotVersion = Number(session.snapshotVersion || 0) + 1;
  session.designState.renderedVersion = null;
  session.backgroundIsolation = outcome.backgroundIsolation;
  // The measured read rides on the mutation result so a fit, bounds, or
  // package fault surfaces in the turn that caused it; qa owns the full
  // review and passes audit:false for its own repair batches.
  const audit = args.audit === false ? null : await inlineOfficeAudit(session, { operations });
  return {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    saved: outcome.saved,
    atomic: true,
    results,
    changeSummary: {
      requested: operations.length,
      changed: results.filter((entry) => entry.changed === true).length,
      noChange: noChange.length,
    },
    ...(audit ? { audit } : {}),
    design: session.design,
    semanticOperations: prepared.semantic,
    ...(outcome.backgroundIsolation ? { backgroundIsolation: outcome.backgroundIsolation } : {}),
    trust,
    ...(transactionResult ? { transaction: transactionResult } : {}),
  };
}

export async function applyBatch(session, args) {
  const trust = await trustForMutation(session);
  assertOfficeMutationAllowed({
    trust,
    acknowledged: args.acknowledgeUntrustedContent === true,
  });
  const { prepared, operations } = await prepareBatchOperations(session, args);
  // A session that was opened to read holds the user's file; the first edit
  // moves it onto a working copy first.
  await materializeWorkingCopy(session);
  const transaction = await markTransactionApplying(session);
  const target = session.target;
  const plan = batchSafetyPlan(session, target, operations);
  await stageBatchBackup(session, target, operations, plan);
  try {
    const outcome = await runBatchBackend(session, args, target, operations, plan);
    return await commitBatch(session, args, { trust, prepared, operations, transaction, target, outcome });
  } catch (error) {
    await restoreBatchTarget(session, target, plan);
    if (transaction) {
      transaction.phase = 'active';
      await persistOfficeTransaction(session).catch(() => {});
    }
    throw error;
  } finally {
    if (plan.backup) await rm(plan.backup, { force: true }).catch(() => {});
    if (plan.replacementSource) await rm(plan.replacementSource, { force: true }).catch(() => {});
  }
}
