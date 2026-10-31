import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { resolveOfficeDesign } from '../design/design-system.mjs';
import { nativeOfficeDesign, usesNativeOfficeDesign } from '../design/native-design.mjs';
import { persistOfficeDesignBinding, resolveOfficeDesignLibrary } from '../design/library/design-library.mjs';
import { FACTS_SAMPLE_DISCLOSURE } from '../authoring/pptx-brief.mjs';
import { plainObject } from '../shared/values.mjs';

export const FILE_KIND_TO_FORMAT = Object.freeze({
  docx: 'docx',
  dotx: 'docx',
  docm: 'docx',
  dotm: 'docx',
  xlsx: 'xlsx',
  xltx: 'xlsx',
  xlsm: 'xlsx',
  xltm: 'xlsx',
  pptx: 'pptx',
  potx: 'pptx',
  pptm: 'pptx',
  potm: 'pptx',
  csv: 'csv',
  tsv: 'tsv',
  pdf: 'pdf',
});

export const FORMATS = new Set(Object.values(FILE_KIND_TO_FORMAT));

export const TABULAR_FORMATS = new Set(['csv', 'tsv']);

export const OOXML_FORMATS = new Set(['docx', 'xlsx', 'pptx']);

export const sessions = new Map();

export const documentSessions = new Map();

export function isInteractiveOfficeSession(session) {
  return ['attach', 'visible', 'live'].includes(String(session?.mode || ''));
}

export function isMicrosoftOfficeSession(session) {
  return session?.backend === 'microsoft-office-com';
}

export function documentSessionKey(path) {
  const canonical = resolve(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function officeSessionId() {
  return `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** Shared design-review counters. PDF/tabular creates omit slidePlans because
 *  those formats never carry a deck plan; every other session keeps the field. */
export function emptyOfficeDesignState({ requiresVisualReview = false, includeSlidePlans = true } = {}) {
  return {
    renderedVersion: null,
    semanticCount: 0,
    requiresVisualReview,
    ...(includeSlidePlans ? { slidePlans: [] } : {}),
    compositions: [],
  };
}

export function microsoftOfficeOpenFields(opened) {
  return {
    mode: opened.mode,
    ownership: opened.ownership,
    visible: opened.visible,
    appPid: opened.appPid,
    windowHwnd: opened.windowHwnd,
    foregroundActivated: opened.foregroundActivated === true,
    backgroundIsolation: opened.backgroundIsolation || null,
    documentId: opened.documentId,
  };
}

/** Bind or refresh the session design exactly once per call. Open/create only
 *  merge a preset; later calls may upgrade the library and keep a native
 *  document native instead of applying a profile it never asked for. */
export async function ensureOfficeSessionDesign(
  session,
  args,
  dataDir,
  { created = session.created === true, allowLibraryUpgrade = false, preserveNativeDesign = false } = {}
) {
  if (!session.design) {
    Object.assign(
      session,
      await resolveOfficeDesignContext({
        args,
        dataDir,
        target: session.target,
        source: session.source,
        format: session.format,
        created,
      })
    );
    session.designState = emptyOfficeDesignState();
    return session;
  }
  if (!args.design) return session;
  if (allowLibraryUpgrade && args.design.upgradeLibrary === true) {
    const upgraded = await resolveOfficeDesignContext({
      args,
      dataDir,
      target: session.target,
      source: session.source,
      format: session.format,
      created: false,
    });
    session.designLibrary = upgraded.designLibrary;
    await persistOfficeDesignBinding(dataDir, session.target, session.designLibrary.binding);
  }
  session.designRequest = mergeOfficeDesignRequest(session.designRequest, args.design);
  // A native document stays native: the `design` a later call carries is the
  // page review (reviewed, reviewToken, critique) or content, not a request
  // for a preset. Resolving it as one would hand a Word or Excel file the
  // default profile's palette and art direction it never asked for, and put
  // the preset review's gates in front of finalize.
  session.design =
    preserveNativeDesign &&
    session.design?.authoring === 'native' &&
    usesNativeOfficeDesign(session.format, session.designRequest)
      ? nativeOfficeDesign(session.format, session.designRequest)
      : resolveOfficeDesign(session.format, session.designRequest, { library: session.designLibrary });
  return session;
}

export function mergeOfficeDesignRequest(current, next) {
  const left = plainObject(current) ? current : {};
  const right = plainObject(next) ? next : {};
  return {
    ...left,
    ...right,
    ...(left.palette || right.palette ? { palette: { ...(left.palette || {}), ...(right.palette || {}) } } : {}),
    ...(left.typography || right.typography
      ? { typography: { ...(left.typography || {}), ...(right.typography || {}) } }
      : {}),
  };
}

export async function resolveOfficeDesignContext({ args, dataDir, target, source = '', format, created }) {
  const designRequest = args.design || (created ? {} : { source: 'existing-document', review: format === 'pptx' });
  if (usesNativeOfficeDesign(format, designRequest, args.operations || [])) {
    return {
      designRequest,
      designLibrary: null,
      design: nativeOfficeDesign(format, designRequest),
    };
  }
  const designLibrary = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: target,
    sourcePath: source,
    format,
    created,
    request: designRequest,
    signal: args.__signal || null,
  });
  return {
    designRequest,
    designLibrary,
    design: resolveOfficeDesign(format, designRequest, { library: designLibrary }),
  };
}

export async function registerOfficeSession(session) {
  try {
    await persistOfficeDesignBinding(session.dataDir, session.target, session.designLibrary?.binding);
  } catch (error) {
    const warning = `Office design binding could not be persisted: ${error?.message || String(error)}`;
    if (session.designLibrary) session.designLibrary.warning = warning;
    if (session.design?.library) session.design.library.warning = warning;
  }
  indexOfficeSession(session);
  return session;
}

/** Publish a session under its id and its document path. */
export function indexOfficeSession(session) {
  sessions.set(session.id, session);
  documentSessions.set(documentSessionKey(session.target), session.id);
}

/** The live session holding a document path, or null. */
export function officeSessionForDocument(target) {
  const existingId = documentSessions.get(documentSessionKey(target));
  return (existingId ? sessions.get(existingId) : null) || null;
}

/** Drop a session from both registries. The document index only releases the
 *  path when this session still owns it, so a newer session keeps its claim. */
export function releaseOfficeSession(session) {
  sessions.delete(session.id);
  const key = documentSessionKey(session.target);
  if (documentSessions.get(key) === session.id) documentSessions.delete(key);
}

export class OfficeConflictError extends Error {
  constructor(details) {
    super('Office transaction conflict: the document changed outside this transaction');
    this.details = details;
  }
}

// Results are read by a model, not by eye: indentation adds about a third to
// every audit, snapshot, and review a session returns, and buys the reader
// nothing that the structure does not already carry.
export function serializedToolValue(value) {
  return JSON.stringify(value);
}

export function toolResult(value, isError = false, images = []) {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : serializedToolValue(value) },
      ...images.map((image) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType,
          data: image.data,
        },
      })),
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function artifactType(format) {
  if (format === 'xlsx' || TABULAR_FORMATS.has(format)) return 'spreadsheet';
  if (format === 'pptx') return 'presentation';
  return format === 'pdf' ? 'pdf' : 'document';
}

function officeArtifact(format, fileKind, path, operation) {
  return {
    type: artifactType(format),
    format,
    fileKind,
    operation,
    path,
  };
}

// What a caller needs back is the design in force: its profile, tokens, the
// selected direction, and any warning. The catalogue it was chosen from — every
// available layout, the rejected direction candidates, the composition history —
// is input the caller already holds, and echoing it on every batch and finalize
// costs several times the audit it rides along with.
const DESIGN_CATALOGUE_KEYS = Object.freeze(['layouts', 'recentCompositions']);

function officeDesignDigest(design) {
  if (!design || typeof design !== 'object') return design;
  // A document opened as it is keeps its own look: the profile's palette, faces, and a default art direction the
  // runtime never applied (applyTokens false) describe another deck — a green accent beside the red one on the
  // page — and ran to five thousand characters. What it answers is where the design stands and what review is owed.
  if (design.source === 'existing-document' && design.artDirection?.applyTokens === false) {
    return Object.fromEntries(
      Object.entries({
        source: design.source,
        review: design.review ? { required: design.review.required === true } : undefined,
        ...(design.library?.warning ? { warning: design.library.warning } : {}),
      }).filter(([, entry]) => entry !== undefined)
    );
  }
  const digest = { ...design };
  for (const key of DESIGN_CATALOGUE_KEYS) delete digest[key];
  const direction = digest.artDirection;
  if (direction && typeof direction === 'object') {
    const { candidates, ...rest } = direction;
    if (Array.isArray(candidates)) rest.candidateCount = candidates.length;
    // A direction whose tokens were not applied names its style and motif; its
    // own palette and faces contradict the `tokens` in force beside it, and its
    // `deck` block repeats `creativeSystem` field for field.
    if (rest.applyTokens === false && rest.selected && typeof rest.selected === 'object') {
      const { palette, typography, deck, ...selected } = rest.selected;
      rest.selected = selected;
    }
    digest.artDirection = rest;
  }
  // The library receipt names where the design came from (source, pack, template)
  // and any warning; its template-index hash and composition count are the
  // runtime's bookkeeping, and an unset pack, template, pin or warning says nothing.
  if (digest.library && typeof digest.library === 'object') {
    const { templateIndexRevision, recentCompositionCount, ...library } = digest.library;
    digest.library = Object.fromEntries(
      Object.entries(library).filter(([, entry]) => entry !== null && entry !== '' && entry !== false)
    );
  }
  // The creative brief's discipline restates the tokens (faces by role, palette
  // slots, the list of colour roles); its rules are what it adds.
  const discipline = digest.creative?.discipline;
  if (digest.tokens && discipline && typeof discipline === 'object') {
    const { typographyRoles, paletteSlots, colorRoles, ...kept } = discipline;
    digest.creative = { ...digest.creative, discipline: kept };
  }
  // An unset intent, audience, or content reads the same absent as empty.
  for (const [key, entry] of Object.entries(digest)) if (entry === '' || entry === null) delete digest[key];
  return digest;
}

// A preset (compose_document, compose_sheet) expands one call into dozens of
// cell, run and style writes; each succeeded the same way, so they come back as
// a count per operation. A write that did not change, or reports anything past
// its address, stays in place, as does every object a later call names (a
// table, a chart).
const PRESET_ROUTINE_OPS = new Set([
  'append_text',
  'set_table_cell_style',
  'set_style',
  'merge_cells',
  'set_cell',
  'set_row_height',
]);
const PRESET_ROUTINE_FIELDS = new Set(['op', 'changed', 'style', 'table', 'row', 'col', 'sheet', 'cell', 'range']);
function presetResults(results, semantic) {
  if (!Array.isArray(semantic) || !semantic.length) return results;
  const applied = {};
  const kept = results.filter((entry) => {
    const routine =
      entry?.changed === true &&
      PRESET_ROUTINE_OPS.has(entry.op) &&
      Object.keys(entry).every((field) => PRESET_ROUTINE_FIELDS.has(field));
    if (routine) applied[entry.op] = (applied[entry.op] || 0) + 1;
    return !routine;
  });
  return Object.keys(applied).length ? [...kept, { applied }] : kept;
}

// A trust read that found nothing says only that, and the untrusted-data policy
// stays on anything that did not come from this session's own writing; the scan
// bookkeeping is the runtime's.
function trustDigest(trust) {
  if (!trust || typeof trust !== 'object') return trust;
  if (Number(trust.findingCount) > 0 || (Array.isArray(trust.findings) && trust.findings.length)) return trust;
  const { risk, complete, warning, policy, source } = trust;
  return {
    risk,
    ...(policy && source !== 'created-document' ? { policy } : {}),
    ...(complete === false ? { complete } : {}),
    ...(warning ? { warning } : {}),
  };
}

const sameValue = (left, right) => left !== undefined && JSON.stringify(left) === JSON.stringify(right);

// A QA verdict as a model reads it. The full record stays on the transaction;
// the result drops what another field of the same result already carries (the
// pre-fix list when nothing was fixed, the preview's images and coverage, a
// visual review repeated at the top) and the raw pixel measurements the issues
// were derived from. Passed checklist items reduce to the summary counts.
const issueKey = (issue) => `${issue?.code}|${issue?.path}|${issue?.message}`;

function modelFacingQaResult(result, topVisualReview, { finalized = false } = {}) {
  if (!result?.review || typeof result.review !== 'object') return result;
  const compact = { ...result };
  if (!result.fixes?.length) delete compact.issuesBefore;
  if (sameValue(compact.visualReview, topVisualReview)) delete compact.visualReview;
  const reported = new Set((Array.isArray(result.issuesAfter) ? result.issuesAfter : []).map(issueKey));
  const allReported = (issues) => Array.isArray(issues) && issues.every((issue) => reported.has(issueKey(issue)));
  // The advisory list is a subset of issuesAfter; naming the codes says which
  // ones do not hold the file back without sending each finding twice.
  if (Array.isArray(compact.advisoryIssues) && allReported(compact.advisoryIssues)) {
    const codes = [...new Set(compact.advisoryIssues.map((issue) => issue?.code).filter(Boolean))];
    delete compact.advisoryIssues;
    if (codes.length) compact.advisoryCodes = codes;
  }
  const review = { ...result.review };
  if (review.design && typeof review.design === 'object') {
    const design = { ...review.design };
    if (allReported(design.issues)) delete design.issues;
    // A finalized document is saved and closed: guidance for the next review
    // pass has no pass left to guide.
    if (finalized) delete design.modelReview;
    review.design = design;
  }
  if (finalized) delete review.polishPlan;
  // The critique entries are the ones the caller just submitted; once accepted
  // and closed, the verdict stands on its status without echoing them back.
  if (finalized && Array.isArray(compact.visualCritique?.entries)) {
    const { entries, ...verdict } = compact.visualCritique;
    compact.visualCritique = { ...verdict, entryCount: entries.length };
  }
  if (review.trust) review.trust = trustDigest(review.trust);
  // A comparison that had nothing to compare against says so by its absence.
  if (compact.baseline?.available === false) delete compact.baseline;
  const diff = review.visualDiff;
  if (diff?.available === false && !diff.pages?.length && !diff.images?.length) delete review.visualDiff;
  if (result.preview) {
    delete review.images;
    delete review.visualCoverage;
    delete review.output;
  }
  // A measured read (render:false) drew no page: an aesthetic score of no confidence, a quality score built on a
  // render that did not happen, and a render-coverage item failing by design all read as defects the page does not
  // have. The coverage entry already says the render is still owed.
  const measureOnly = result.preview?.visualCoverage?.mode === 'measure-only';
  if (review.render && typeof review.render === 'object') {
    const { pages, aesthetics, ...render } = review.render;
    if (aesthetics && typeof aesthetics === 'object' && !(measureOnly || Number(aesthetics.confidence) === 0)) {
      const { pages: aestheticPages, ...scores } = aesthetics;
      render.aesthetics = scores;
    }
    review.render = render;
  }
  if (measureOnly) delete review.quality;
  if (Array.isArray(review.checklist?.items)) {
    const renderOwed = (item) => measureOnly && item?.id === 'full-render-coverage';
    const dropped = review.checklist.items.filter(renderOwed).length;
    const summary = review.checklist.summary;
    review.checklist = {
      ...review.checklist,
      items: review.checklist.items.filter((item) => item?.status !== 'pass' && !renderOwed(item)),
      ...(dropped && summary
        ? {
            summary: {
              ...summary,
              total: summary.total - dropped,
              failed: Math.max(0, (summary.failed || 0) - dropped),
            },
          }
        : {}),
    };
  }
  if (measureOnly && compact.preview && Array.isArray(compact.preview.images) && !compact.preview.images.length) {
    const { images, ...preview } = compact.preview;
    compact.preview = preview;
  }
  const repeatedVisualReview = [topVisualReview, result.visualReview].find((entry) =>
    sameValue(entry, review.quality?.visualReview)
  );
  if (repeatedVisualReview) {
    review.quality = { ...review.quality, visualReview: { status: review.quality.visualReview.status } };
  }
  compact.review = review;
  return compact;
}

// A finalize's package check lists every fault family, almost all of them
// empty. An empty list or a null reads the same as an absent one, the session
// and path repeat the result's own, and the validator's install path is the
// runtime's business; what is left is what the check found.
function withoutEmpty(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  const kept = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined || (Array.isArray(entry) && entry.length === 0)) continue;
    kept[key] = entry && typeof entry === 'object' && !Array.isArray(entry) ? withoutEmpty(entry) : entry;
  }
  return kept;
}

// A check that passed answers with its verdict and whatever departs from the default; one that failed keeps all.
const PASSED_CHECK_DETAIL = {
  schema: {
    rawValid: () => true,
    version: () => true,
    available: () => true,
    cached: () => true,
    downloaded: () => true,
    officeVersion: () => true,
    validation: () => true,
    omittedErrors: (count) => !(Number(count) > 0),
  },
  native: {
    opened: (flag) => flag === true,
    reopened: (flag) => flag === true,
    persisted: (flag) => flag === true,
    // Not saved is news in a live or visible session: only the saved state goes.
    documentSaved: (flag) => flag === true,
    snapshotFingerprint: () => true,
    excelDpiRepairs: (count) => !(Number(count) > 0),
    issueCount: (count, check) => Number(count) === (Array.isArray(check.issues) ? check.issues.length : 0),
  },
};

function finalizeValidationDigest(validation, result, session = null) {
  const digest = withoutEmpty(validation);
  for (const key of ['session', 'path']) if (digest[key] === result[key]) delete digest[key];
  if (session?.target && digest.path === session.target) delete digest.path;
  // The session's mode and backend ride the review beside this check.
  if (result.review?.mode !== undefined) delete digest.mode;
  if (result.review?.backend !== undefined) delete digest.backend;
  if (digest.schema && typeof digest.schema === 'object') delete digest.schema.path;
  // The package's own bookkeeping — its entry count, main part and content type, the name of the check that ran —
  // describes a package that opened; a missing main content type is a fault and stays.
  for (const key of ['format', 'entries', 'mainPart', 'mainContentType', 'validation']) delete digest[key];
  if (digest.mainContentTypeMissing === false) delete digest.mainContentTypeMissing;
  const security = digest.security;
  if (
    security &&
    security.macroExecution === 'disabled' &&
    !security.digitalSignatureInvalidated &&
    Object.keys(security).length <= 2
  ) {
    delete digest.security;
  }
  for (const [check, detail] of Object.entries(PASSED_CHECK_DETAIL)) {
    const entry = digest[check];
    if (entry?.ok !== true) continue;
    digest[check] = Object.fromEntries(
      Object.entries(entry).filter(([key, field]) => !(Object.hasOwn(detail, key) && detail[key](field, entry)))
    );
  }
  if (digest.postSaveGate?.ok === true && !(Number(digest.postSaveGate.criticalCount) > 0)) delete digest.postSaveGate;
  // The baseline names what differs from the opened file. The file it was, the backend that saved it, and an
  // unbroken signature repeat the session; the parts Office adds whenever it saves (headers, theme, font table)
  // are its normalisation, not the edit — a redline's own added parts stay under redlining.
  if (digest.baseline && typeof digest.baseline === 'object') {
    const { original, originalEntries, savedBy, compared, digitalSignatureInvalidated, ...baseline } = digest.baseline;
    if (baseline.applicationSaved === true) delete baseline.addedParts;
    if (digitalSignatureInvalidated) baseline.digitalSignatureInvalidated = true;
    if (compared === false) baseline.compared = false;
    digest.baseline = baseline;
  }
  return digest;
}

// A shape's run summary lists every size, face, and colour its runs use; when
// the runs agree it holds one value, the one its `font` already states.
const RUN_SUMMARY = [
  ['sizes', 'size'],
  ['fonts', 'name'],
  ['colors', 'color'],
];

// A PowerPoint (COM) shape reports every property the object model has: null
// facets it does not carry, the MSO "mixed/undefined" sentinel, an invisible
// shadow, the fill of an unfilled box, and single-precision points. What is
// left is what the shape actually has, geometry to the hundredth of a point.
const MSO_UNDEFINED = -2147483648;
const round2 = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
const roundAll = (object) =>
  Object.fromEntries(
    Object.entries(object || {})
      .filter(([, value]) => value !== MSO_UNDEFINED)
      .map(([key, value]) => [key, round2(value)])
  );
const bgrHex = (value) =>
  [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

const POWERPOINT_TEXT_FRAME = {
  marginLeft: 7.2,
  marginTop: 3.6,
  marginRight: 7.2,
  marginBottom: 3.6,
  paragraphSpacing: 0,
};

// Excel's chart kinds by the name the portable reader and add_chart use; a kind outside this list keeps its number.
const EXCEL_CHART_TYPES = {
  51: 'column',
  52: 'stacked_column',
  53: 'stacked_column_100',
  57: 'bar',
  58: 'stacked_bar',
  59: 'stacked_bar_100',
  4: 'line',
  65: 'line',
  1: 'area',
  76: 'stacked_area',
  5: 'pie',
  '-4120': 'doughnut',
  '-4169': 'scatter',
  15: 'bubble',
  '-4151': 'radar',
};
const chartTypeName = (value) =>
  typeof value === 'number' && EXCEL_CHART_TYPES[value] ? EXCEL_CHART_TYPES[value] : value;

// A series on the primary axis with no name formula, trendline, error bars, or labels says so by omission.
const QUIET_SERIES = {
  formula: '',
  axisGroup: 1,
  trendlineCount: 0,
  hasErrorBars: false,
  hasDataLabels: false,
  dataLabels: null,
};

function comSeriesDigest(entry) {
  const kept = Object.fromEntries(
    Object.entries(entry).filter(([key, value]) => !(Object.hasOwn(QUIET_SERIES, key) && QUIET_SERIES[key] === value))
  );
  return { ...kept, ...(entry.chartType !== undefined ? { chartType: chartTypeName(entry.chartType) } : {}) };
}

// A digest step applied to the object entries of a list; anything else passes through.
const digestObjectWith = (digestEntry) => (entry) => (entry && typeof entry === 'object' ? digestEntry(entry) : entry);

function comShapeDigest(shape) {
  const digest = {};
  for (const [key, value] of Object.entries(shape)) {
    if (value === null || value === MSO_UNDEFINED) continue;
    digest[key] = ['left', 'top', 'width', 'height', 'rotation'].includes(key) ? round2(value) : value;
  }
  // A chart, table, or picture holds no text of its own: its empty frame, zero bounds, and blank face say nothing.
  if (digest.text === undefined || digest.text === '') {
    delete digest.textFrame;
    delete digest.textBounds;
    if (digest.font && !digest.font.name && !Number(digest.font.size)) delete digest.font;
  }
  if (digest.chart && typeof digest.chart === 'object') {
    const chart = { ...digest.chart, chartType: chartTypeName(digest.chart.chartType) };
    if (Array.isArray(digest.chart.series)) chart.series = digest.chart.series.map(digestObjectWith(comSeriesDigest));
    digest.chart = chart;
  }
  for (const key of ['textBounds', 'textFrame']) {
    if (digest[key] && typeof digest[key] === 'object') digest[key] = roundAll(digest[key]);
  }
  if (digest.shadow && typeof digest.shadow === 'object') {
    if (!digest.shadow.visible) delete digest.shadow;
    else digest.shadow = roundAll(digest.shadow);
  }
  if (digest.fillVisible === false) {
    delete digest.fillColor;
    delete digest.fillTransparency;
    delete digest.fillVisible;
  }
  if (digest.lineVisible === false) {
    delete digest.lineColor;
    delete digest.lineTransparency;
    delete digest.lineVisible;
  }
  // PowerPoint's own defaults say nothing: an upright shape, a text box with no preset, the inset every new box
  // gets (7.2 pt sides, 3.6 pt top and bottom), no space between paragraphs, and a face that is neither bold nor
  // italic. The portable reader reports none of them either.
  if (digest.rotation === 0) delete digest.rotation;
  if (digest.geometry === '') delete digest.geometry;
  if (digest.textFrame && typeof digest.textFrame === 'object') {
    const frame = Object.fromEntries(
      Object.entries(digest.textFrame).filter(
        ([key, value]) => !(Object.hasOwn(POWERPOINT_TEXT_FRAME, key) && POWERPOINT_TEXT_FRAME[key] === value)
      )
    );
    if (Object.keys(frame).length) digest.textFrame = frame;
    else delete digest.textFrame;
  }
  if (digest.font && typeof digest.font === 'object') {
    const font = Object.fromEntries(
      Object.entries(digest.font).filter(
        ([key, value]) => !(['bold', 'italic', 'underline'].includes(key) && (value === 0 || value === false))
      )
    );
    digest.font = font;
  }
  const runs = digest.runs;
  if (runs && typeof runs === 'object' && !Array.isArray(runs)) {
    const rest = { ...runs };
    if (Array.isArray(rest.sizes) && rest.sizes.length === 1 && rest.sizes[0] === digest.font?.size) delete rest.sizes;
    const color = String(digest.font?.color || '').toUpperCase();
    if (Array.isArray(rest.colors) && rest.colors.length === 1 && bgrHex(rest.colors[0]) === color) delete rest.colors;
    if (Object.keys(rest).length) digest.runs = rest;
    else delete digest.runs;
  }
  return digest;
}

// A COM slide's empty notes, comment and animation lists and an untimed
// transition with no effect read the same as absent.
function comSlideDigest(slide) {
  const digest = {};
  for (const [key, value] of Object.entries(slide)) {
    // notes is the backend contract's string on every slide, empty or not, as the portable reader reports it.
    if (key !== 'notes' && (value === '' || value === null || (Array.isArray(value) && !value.length))) continue;
    digest[key] = value;
  }
  const transition = digest.transition;
  if (transition && !transition.effect && !transition.advanceOnTime) delete digest.transition;
  return digest;
}

function pptxShapeDigest(shape) {
  if (shape && typeof shape === 'object' && typeof shape.type === 'number') return comShapeDigest(shape);
  if (!shape || typeof shape !== 'object' || !shape.font) return shape;
  let digest = shape;
  for (const [list, key] of RUN_SUMMARY) {
    const values = shape[list];
    if (Array.isArray(values) && values.length === 1 && values[0] === shape.font[key]) {
      if (digest === shape) digest = { ...shape };
      delete digest[list];
    }
  }
  return digest;
}

function pptxDocumentDigest(document) {
  if (document?.format !== 'pptx' || !Array.isArray(document.slides)) return document;
  // add_slide names a layout by its name or position; the part it lives in and a path built from that same
  // position repeat what the runtime resolves itself, on every one of a template's dozens of layouts.
  const layoutDigest = (layout, position) =>
    layout && typeof layout === 'object' ? { index: layout.index ?? position + 1, name: layout.name } : layout;
  const layouts = Array.isArray(document.layouts) ? document.layouts.map(layoutDigest) : document.layouts;
  return {
    ...document,
    ...(layouts ? { layouts } : {}),
    slides: document.slides.map((slide) => {
      if (!Array.isArray(slide?.shapes)) return slide;
      // A PowerPoint (COM) slide names its shapes' kinds by number and carries a transition; one without shapes is
      // known by the transition and animation lists only it reports.
      const com =
        slide.shapes.some((shape) => typeof shape?.type === 'number') ||
        (slide.transition !== undefined && Array.isArray(slide.animations));
      const { hidden, ...shown } = slide;
      // A shown slide says so by omission; a hidden one is withheld from the show and keeps the flag.
      const shaped = { ...(hidden ? slide : shown), shapes: slide.shapes.map(pptxShapeDigest) };
      return com ? comSlideDigest(shaped) : shaped;
    }),
  };
}

/** The document a model reads, by format; every digest copies and leaves the stored record whole. */
export function officeDocumentDigest(document) {
  if (!document || typeof document !== 'object') return document;
  if (document.format === 'pptx') return pptxDocumentDigest(document);
  if (document.format === 'xlsx') return xlsxDocumentDigest(document);
  if (document.format === 'docx') return docxDocumentDigest(document);
  if (document.format === 'pdf') return pdfDocumentDigest(document);
  if (TABULAR_FORMATS.has(document.format)) return tabularDocumentDigest(document);
  return document;
}

// A delimited file's cell names its place twice: the reference already says the row and the column.
function tabularDocumentDigest(document) {
  if (!Array.isArray(document.sheets)) return document;
  const cellDigest = digestObjectWith(({ row, column, ...rest }) => rest);
  return {
    ...document,
    sheets: document.sheets.map((sheet) =>
      Array.isArray(sheet?.cells) ? { ...sheet, cells: sheet.cells.map(cellDigest) } : sheet
    ),
  };
}

// What a sheet entry says when it has nothing to report: an empty family, a zero count, a visible sheet, an
// unprotected one, a page setup nobody set. The families that hold something stay whole.
const QUIET_SHEET_ENTRY = { visibility: 'visible' };
const QUIET_PAGE_SETUP = { orientation: '', zoom: 100, fitToPage: false, fitToPagesWide: 0, fitToPagesTall: 0 };

function xlsxSheetDigest(sheet, defaults) {
  if (!sheet || typeof sheet !== 'object') return sheet;
  const digest = {};
  for (const [key, entry] of Object.entries(sheet)) {
    if (entry === null || (Array.isArray(entry) && entry.length === 0)) continue;
    if (/Count$/.test(key) && key !== 'cellCount' && entry === 0) continue;
    if (Object.hasOwn(QUIET_SHEET_ENTRY, key) && QUIET_SHEET_ENTRY[key] === entry) continue;
    digest[key] = entry;
  }
  if (digest.protection && typeof digest.protection === 'object' && !Object.values(digest.protection).some(Boolean)) {
    delete digest.protection;
  }
  if (digest.freezePanes?.frozen === false) delete digest.freezePanes;
  if (digest.pageSetup && typeof digest.pageSetup === 'object') {
    const setup = Object.fromEntries(
      Object.entries(digest.pageSetup).filter(
        ([key, entry]) =>
          entry !== '' && entry !== false && !(Object.hasOwn(QUIET_PAGE_SETUP, key) && QUIET_PAGE_SETUP[key] === entry)
      )
    );
    if (Object.keys(setup).length) digest.pageSetup = setup;
    else delete digest.pageSetup;
  }
  if (Array.isArray(digest.cells)) digest.cells = digest.cells.map((cell) => xlsxCellDigest(cell, defaults));
  // Lineage repeated each formula and every precedent's path beside the cell that already holds the formula:
  // a model reads the dependency as the cell and the cells it reads.
  if (Array.isArray(digest.formulaLineage)) {
    digest.formulaLineage = digest.formulaLineage.map((entry) => {
      const cell = /\/cell\[([^\]]+)\]$/.exec(String(entry?.from || ''))?.[1] || entry?.from;
      const precedents = (entry?.precedents || []).map((precedent) =>
        precedent?.sheet && precedent.sheet !== sheet.name
          ? `${precedent.sheet}!${precedent.ref}`
          : (precedent?.ref ?? precedent)
      );
      return { cell, precedents };
    });
    delete digest.lineageCount;
  }
  return digest;
}

// A cell's style names what differs from the workbook's own: the default face and size, and the plain state —
// not bold, not italic, General — say nothing a reader can use.
const PLAIN_CELL_STYLE = { bold: false, italic: false, underline: false, numberFormat: 'General' };

function xlsxCellDigest(cell, defaults) {
  if (!cell || typeof cell !== 'object') return cell;
  const { formula, style, ...rest } = cell;
  const digest = { ...rest, ...(formula != null && formula !== '' ? { formula } : {}) };
  if (style && typeof style === 'object') {
    const kept = Object.fromEntries(
      Object.entries(style).filter(
        ([key, entry]) =>
          !(defaults && Object.hasOwn(defaults, key) && String(defaults[key]) === String(entry)) &&
          !(Object.hasOwn(PLAIN_CELL_STYLE, key) && PLAIN_CELL_STYLE[key] === entry)
      )
    );
    if (Object.keys(kept).length) digest.style = kept;
  }
  return digest;
}

function xlsxDocumentDigest(document) {
  if (document?.format !== 'xlsx' || !Array.isArray(document.sheets)) return document;
  const defaults = document.defaultStyle || null;
  const digest = { ...document, sheets: document.sheets.map((sheet) => xlsxSheetDigest(sheet, defaults)) };
  // A workbook with no defined names and no calculation settings said so as definedNames:[], definedNameCount:0,
  // and calculation:{ mode:'', fullCalcOnLoad:false, forceFullCalc:false }; absent reads the same.
  if (Array.isArray(digest.definedNames) && !digest.definedNames.length) {
    delete digest.definedNames;
    if (digest.definedNameCount === 0) delete digest.definedNameCount;
  }
  if (plainObject(digest.calculation) && Object.values(digest.calculation).every((value) => !value))
    delete digest.calculation;
  return digest;
}

// A Word paragraph of one plain run repeats its text in that run, and the main
// part's text repeats every paragraph and cell; the header, footer, and note
// parts carry text nothing else in the snapshot does, so they stay.
const PLAIN_RUN_KEYS = new Set(['path', 'index', 'text']);

// A PDF read lists every family it looks for — attachments, outline, scanned pages — and every flag, almost all
// of them empty or off. What reads the same absent goes: an empty list, a zero count, an off flag, a blank metadata
// entry, the pagination of a read that holds every page, a page's upright rotation, a field that is neither
// read-only, required, nor multiline. An encrypted file keeps passwordRequired either way; coordinates keep 2 places.
const PDF_KEPT_FALSE = new Set(['passwordRequired', 'value']);

function withoutPdfDefaults(entry, keptFalse = PDF_KEPT_FALSE) {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key, field]) =>
        field !== null &&
        field !== undefined &&
        !(field === false && !keptFalse.has(key)) &&
        !(Array.isArray(field) && field.length === 0)
    )
  );
}

const roundPoint = (field) => (typeof field === 'number' ? Math.round(field * 100) / 100 : field);

function pdfDocumentDigest(document) {
  if (document?.format !== 'pdf') return document;
  const digest = withoutPdfDefaults(document);
  for (const key of Object.keys(digest))
    if (/Count$/.test(key) && key !== 'pageCount' && digest[key] === 0) delete digest[key];
  if (digest.metadata && typeof digest.metadata === 'object') {
    const metadata = Object.fromEntries(
      Object.entries(digest.metadata).filter(([, field]) => field !== '' && field != null)
    );
    if (Object.keys(metadata).length) digest.metadata = metadata;
    else delete digest.metadata;
  }
  if (digest.pagination && digest.pagination.hasMore !== true && !(Number(digest.pagination.offset) > 0))
    delete digest.pagination;
  if (Array.isArray(digest.pages)) {
    digest.pages = digest.pages.map((page) => {
      const { rotation, width, height, ...rest } = page || {};
      return { ...rest, width: roundPoint(width), height: roundPoint(height), ...(rotation ? { rotation } : {}) };
    });
  }
  if (Array.isArray(digest.fields)) {
    digest.fields = digest.fields.map((field) => {
      const kept = withoutPdfDefaults(field);
      if (Array.isArray(kept.widgets)) {
        kept.widgets = kept.widgets.map((widget) =>
          Object.fromEntries(Object.entries(widget || {}).map(([key, point]) => [key, roundPoint(point)]))
        );
      }
      return kept;
    });
  }
  return digest;
}

// A paragraph's format and face name what it sets: Word (COM) reports the resolved zero of every flag, an empty
// face name, and the character offsets it read the paragraph at, none of which a reader can act on.
const QUIET_PARAGRAPH_FORMAT = { alignment: 0, spacingBefore: 0, keepWithNext: 0, keepTogether: 0, pageBreakBefore: 0 };
const QUIET_PARAGRAPH_FONT = { name: '', bold: false, italic: false, underline: false };

function quietParagraph(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const { start, end, ...paragraph } = raw;
  if (paragraph.pageEnd !== undefined && paragraph.pageEnd === paragraph.pageStart) delete paragraph.pageEnd;
  if (paragraph.font && typeof paragraph.font === 'object') {
    paragraph.font = Object.fromEntries(
      Object.entries(paragraph.font).filter(
        ([key, value]) => !(Object.hasOwn(QUIET_PARAGRAPH_FONT, key) && QUIET_PARAGRAPH_FONT[key] === value)
      )
    );
    if (!Object.keys(paragraph.font).length) delete paragraph.font;
  }
  return paragraph;
}

// The body's order in runs: consecutive paragraphs as one span, so the order says only where a table falls.
function blockOrderDigest(blocks) {
  const spans = [];
  for (const block of blocks) {
    const index = Number(block?.index);
    const last = spans.at(-1);
    if (block?.type === 'paragraph' && last?.type === 'paragraph' && index === last.to + 1) last.to = index;
    else spans.push({ type: block?.type, from: index, to: index, path: block?.path });
  }
  return spans.map((span) =>
    span.type === 'paragraph' && span.to > span.from ? `/body/p[${span.from}..${span.to}]` : span.path
  );
}

function docxDocumentDigest(document) {
  if (document?.format !== 'docx' || !Array.isArray(document.paragraphs)) return document;
  const paragraphs = document.paragraphs.map((entry) => {
    // Word (COM) reports each paragraph's format in single-precision points
    // with an empty tab list when it sets none.
    const raw = quietParagraph(entry);
    const format = raw?.format;
    const paragraph =
      format && typeof format === 'object' && !Array.isArray(format)
        ? {
            ...raw,
            format: roundAll(
              Object.fromEntries(
                Object.entries(format).filter(
                  ([key, value]) =>
                    !(Array.isArray(value) && !value.length) &&
                    !(Object.hasOwn(QUIET_PARAGRAPH_FORMAT, key) && (value === 0 || value === false))
                )
              )
            ),
          }
        : raw;
    const runs = paragraph?.runs;
    if (
      !Array.isArray(runs) ||
      runs.length !== 1 ||
      runs[0]?.text !== paragraph.text ||
      !Object.keys(runs[0]).every((key) => PLAIN_RUN_KEYS.has(key))
    ) {
      return paragraph;
    }
    const { runs: _single, ...rest } = paragraph;
    return rest;
  });
  // Only a snapshot holding every paragraph makes the main part's text redundant;
  // a paged one may be the only place the rest of the body shows.
  const complete = document.pagination?.hasMore !== true && document.truncated !== true;
  // A part left with its name alone says nothing the paragraphs do not.
  const parts = Array.isArray(document.parts)
    ? document.parts.filter(
        (part) =>
          !(
            complete &&
            part?.part === 'word/document.xml' &&
            paragraphs.length &&
            Object.keys(part).every((key) => key === 'part' || key === 'text')
          )
      )
    : document.parts;
  // A family the counts already call empty (comments, revisions, notes, controls, images) reads the same absent.
  const digest = Object.fromEntries(
    Object.entries(document).filter(([, value]) => !(Array.isArray(value) && !value.length))
  );
  // Word (COM) places a table by character offsets and reports its left alignment as 0; a comment that is open and
  // unanswered says so by omission, as the portable reader writes it.
  if (Array.isArray(digest.tables)) {
    digest.tables = digest.tables.map((table) => {
      if (!table || typeof table !== 'object') return table;
      const { start, end, ...rest } = table;
      if (rest.alignment === 0) delete rest.alignment;
      if (rest.pageEnd !== undefined && rest.pageEnd === rest.pageStart) delete rest.pageEnd;
      return rest;
    });
  }
  // Word (COM) states a section's margins in single-precision points (70.9000015258789), its orientation by number,
  // and a header that is its own as linkToPrevious:false.
  if (Array.isArray(digest.sections)) {
    digest.sections = digest.sections.map((section) => {
      if (!section || typeof section !== 'object') return section;
      const rest = { ...section };
      for (const key of ['topMargin', 'bottomMargin', 'leftMargin', 'rightMargin', 'columnSpacing']) {
        if (typeof rest[key] === 'number') rest[key] = round2(rest[key]);
      }
      if (rest.orientation === 0) rest.orientation = 'portrait';
      else if (rest.orientation === 1) rest.orientation = 'landscape';
      // A single column is every section's default; a section says so only when it lays its text out in more.
      if (rest.columns === 1) delete rest.columns;
      // A story Word breaks into paragraphs with \r reads with \n, as the portable reader joins them; an empty header
      // or footer (Word keeps one on every section) says nothing.
      if (Array.isArray(rest.stories)) {
        rest.stories = rest.stories
          .filter((story) => !(story && typeof story === 'object' && story.text === ''))
          .map((story) => {
            if (!story || typeof story !== 'object') return story;
            const kept = { ...story };
            if (kept.linkToPrevious === false) delete kept.linkToPrevious;
            if (typeof kept.text === 'string') kept.text = kept.text.replace(/\r\n?/g, '\n');
            return kept;
          });
        if (!rest.stories.length) delete rest.stories;
      }
      return rest;
    });
  }
  if (Array.isArray(digest.comments)) {
    digest.comments = digest.comments.map((comment) => {
      if (!comment || typeof comment !== 'object') return comment;
      const rest = { ...comment };
      if (rest.resolved === false) delete rest.resolved;
      if (Array.isArray(rest.replies) && !rest.replies.length) delete rest.replies;
      return rest;
    });
  }
  if (Array.isArray(document.blockOrder) && document.blockOrder.length)
    digest.blockOrder = blockOrderDigest(document.blockOrder);
  if (!parts?.length) delete digest.parts;
  return { ...digest, paragraphs, ...(parts?.length ? { parts } : {}) };
}

// The design in force rides on every batch of a session (commitBatch returns
// session.design), four kilobytes of tokens, direction and brief that were
// already delivered with the create. It goes out once per session and again only
// when it changes; later results say which profile holds and that it is unchanged.
function designOnce(design, session) {
  if (!session || !design || typeof design !== 'object') return design;
  // The creative brief is rebuilt for each batch's own operations (a plain edit after a composed create carries an
  // empty thesis and no briefs), so it is not what says the design changed: keyed on it, every batch resent the
  // whole design. What holds across the session — profile, direction, tokens, format — is the key.
  const { creative, ...held } = design;
  const key = JSON.stringify(held);
  if (session.deliveredDesign !== key) {
    session.deliveredDesign = key;
    return design;
  }
  return {
    ...(design.profile ? { profile: design.profile } : {}),
    ...(design.authoring ? { authoring: design.authoring } : {}),
    unchanged: true,
  };
}

// The review guidance is the same list on every qa and finalize of a session;
// it goes out once, and a later review repeats it only if it changes.
function modelReviewOnce(design, session) {
  if (!session || !design || !Array.isArray(design.modelReview)) return design;
  const key = JSON.stringify(design.modelReview);
  if (session.deliveredModelReview === key) {
    const { modelReview, ...rest } = design;
    return rest;
  }
  session.deliveredModelReview = key;
  return design;
}

export function finalizeOfficeResult(value, { action, session = null, startedAt = 0 } = {}) {
  if (!value || typeof value !== 'object') return value;
  if (action === 'qa') {
    const compact = modelFacingQaResult(value);
    for (const key of Object.keys(value)) if (!Object.hasOwn(compact, key)) delete value[key];
    Object.assign(value, compact);
    if (value.review?.design) value.review = { ...value.review, design: modelReviewOnce(value.review.design, session) };
  }
  // create/open with finalize:true answer with a finalize result of their own.
  const finalizing = action === 'finalize' || typeof value.finalized === 'boolean';
  if (finalizing && value.review) {
    value.review = modelFacingQaResult(value.review, value.visualReview, { finalized: value.finalized === true });
    const inner = value.review.review;
    if (inner?.design)
      value.review = { ...value.review, review: { ...inner, design: modelReviewOnce(inner.design, session) } };
  }
  if (finalizing) {
    // The reopened file's full shape inventory proves persistence, which its
    // fingerprint and issue count already state; the inventory itself is a
    // snapshot the caller can ask for.
    const native = value.validation?.native;
    if (native && typeof native === 'object' && native.snapshot) {
      const { snapshot, ...rest } = native;
      value.validation = { ...value.validation, native: rest };
    }
    if (value.validation && typeof value.validation === 'object') {
      value.validation = finalizeValidationDigest(value.validation, value, session);
    }
    // A refused finalize ran no recalculation or review to report.
    for (const key of ['recalculation', 'review']) if (value[key] === null) delete value[key];
    // A document composed without the preset composer has no composition to report.
    if (value.composition && !(Number(value.composition.count) > 0)) delete value.composition;
    if (value.compositionHistory === null) delete value.compositionHistory;
    // A script-authored deck carries its design in its own brief; the session's
    // preset design was never applied to it and only misdescribes the deck.
    if (session?.authored === true) delete value.design;
  }
  if (['create', 'open', 'attach'].includes(action)) {
    // A session that opened as expected — in the background, fresh, nothing brought forward, no window to isolate —
    // says so by omission; a visible, reused, or foregrounded one still says what happened.
    for (const [key, quiet] of [
      ['foregroundActivated', false],
      ['backgroundIsolation', null],
      ['reused', false],
      ['visible', false],
      ['created', false],
    ]) {
      if (value[key] === quiet) delete value[key];
    }
  }
  // A delimited file has no styles, pages, or composition: the design a session carries by default describes
  // nothing in it (three and a half thousand characters on its first batch), and its review is structural —
  // the verdict, what remains, and that the structural read covered it.
  if (TABULAR_FORMATS.has(session?.format)) {
    delete value.design;
    if (value.batch?.design) value.batch = { ...value.batch, design: undefined };
    if (finalizing && value.review && typeof value.review === 'object') {
      const { ok, issuesAfter, fixes, preview } = value.review;
      value.review = withoutEmpty({
        ok,
        issuesAfter,
        fixes,
        ...(preview?.visualCoverage ? { preview: { visualCoverage: preview.visualCoverage } } : {}),
      });
    }
  }
  if (value.design) value.design = designOnce(officeDesignDigest(value.design), session);
  if (value.batch?.design) {
    value.batch = { ...value.batch, design: designOnce(officeDesignDigest(value.batch.design), session) };
  }
  if (value.trust) value.trust = trustDigest(value.trust);
  if (value.document) value.document = officeDocumentDigest(value.document);
  if (value.batch?.trust) value.batch = { ...value.batch, trust: trustDigest(value.batch.trust) };
  // A recalculation reports what it computed and every error it met; how the
  // LibreOffice save was normalized and how many bytes it wrote are the runtime's.
  if (value.recalculation && typeof value.recalculation === 'object') {
    const { normalized, outputBytes, ...recalculation } = value.recalculation;
    const digest = withoutEmpty(recalculation);
    if (digest.errorSummary && !Object.keys(digest.errorSummary).length) delete digest.errorSummary;
    value.recalculation = digest;
  }
  // An operation's result names what it did; an empty string field says nothing.
  const withoutBlank = (entry) =>
    entry && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).filter(([, field]) => field !== ''))
      : entry;
  if (Array.isArray(value.results))
    value.results = presetResults(value.results.map(withoutBlank), value.semanticOperations);
  if (Array.isArray(value.batch?.results)) {
    value.batch = {
      ...value.batch,
      results: presetResults(value.batch.results.map(withoutBlank), value.batch.semanticOperations),
    };
  }
  value.metrics = {
    ...(value.metrics || {}),
    durationMs: Math.max(0, Number((performance.now() - startedAt).toFixed(2))),
  };
  // A deck whose brief declared its figures illustrative carries that
  // disclosure on every result the author reads, so the delivery says so.
  if (session?.authoredBrief?.factsMode === 'sample' && ['author', 'qa', 'render', 'finalize'].includes(action)) {
    value.factsMode = 'sample';
    value.disclosure = FACTS_SAMPLE_DISCLOSURE;
  }
  attachOfficeArtifacts(value, action, session);
  return value;
}

// The file an action produced or edited, named as an artifact of the result.
function attachOfficeArtifacts(value, action, session) {
  let operation = '';
  if (action === 'create' || (action === 'author' && value.output)) operation = 'create';
  else if (action === 'render') operation = 'render';
  else if (['batch', 'commit', 'rollback', 'save', 'secure', 'finalize'].includes(action)) operation = 'edit';
  let artifactPath = '';
  if (action === 'render' || action === 'secure') artifactPath = value.output;
  else if (operation && session) artifactPath = session.target;
  if (!operation || !artifactPath) return;
  value.artifacts = [
    officeArtifact(
      session?.format || (action === 'secure' ? 'pdf' : ''),
      session?.fileKind || (action === 'secure' ? 'pdf' : ''),
      artifactPath,
      operation
    ),
  ];
  value.outputCount = value.artifacts.length;
  value.expectedOutputCount = 1;
}

export function bounded(value, maxChars, length = null) {
  const text = serializedToolValue(value);
  if ((length ?? text.length) <= maxChars) return value;
  const document = value?.document && typeof value.document === 'object' ? value.document : null;
  const summary = {};
  if (document) {
    for (const [key, item] of Object.entries(document)) {
      if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) summary[key] = item;
    }
    if (document.pagination)
      summary.pagination = {
        ...document.pagination,
        nextCursor: null,
        retryRequired: true,
        retryWithLimit: Math.max(1, Math.floor(Number(document.pagination.limit || 2) / 2)),
      };
  }
  const metadata = Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'document'));
  return {
    ...metadata,
    ...(document ? { document: summary } : {}),
    truncated: true,
    preview: `${text.slice(0, maxChars)}\n... [office snapshot truncated]`,
  };
}

// The binary formats of Office 97-2003 are not packages: nothing here reads
// them directly. `open` converts one to its package format through LibreOffice;
// every other entry point names that conversion.
const LEGACY_BINARY_FORMATS = Object.freeze({
  doc: 'docx',
  dot: 'dotx',
  xls: 'xlsx',
  xlt: 'xltx',
  ppt: 'pptx',
  pot: 'potx',
  pps: 'pptx',
});

function unsupportedFormatError(kind) {
  const modern = LEGACY_BINARY_FORMATS[kind];
  return new Error(
    modern
      ? `Unsupported Office Use format: .${kind} is a legacy binary file, not an Office package. action:'open' converts it to .${modern} beside the original when LibreOffice is installed; otherwise save it as .${modern} in Microsoft Office first, then work on that file.`
      : `Unsupported Office Use format: .${kind || '(none)'}`
  );
}

/** The package extension a legacy binary file converts to (`doc` → `docx`), or '' for any other file. */
export function legacyPackageKind(path) {
  return LEGACY_BINARY_FORMATS[extname(path).slice(1).toLowerCase()] || '';
}

export function normalizeOfficeFormat(value) {
  const kind = String(value || '').toLowerCase();
  const format = FILE_KIND_TO_FORMAT[kind];
  if (!format) throw unsupportedFormatError(kind);
  return format;
}

export function documentFileKind(path) {
  const kind = extname(path).slice(1).toLowerCase();
  if (!FILE_KIND_TO_FORMAT[kind]) throw unsupportedFormatError(kind);
  return kind;
}

export function documentFormat(path) {
  return normalizeOfficeFormat(documentFileKind(path));
}

export async function documentFingerprint(path, format) {
  const buffer = await readFile(path);
  const hash = createHash('sha256');
  if (!OOXML_FORMATS.has(format)) return hash.update(buffer).digest('hex');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && !['docProps/core.xml', 'docProps/app.xml'].includes(name))
    .sort();
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    const content = await zip.files[name].async('nodebuffer');
    hash.update(
      name === 'xl/workbook.xml' ? content.toString('utf8').replace(/\bdocumentId="[^"]*"/g, 'documentId=""') : content
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
