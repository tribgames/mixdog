import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { resolveOfficeDesign } from '../design/design-system.mjs';
import { nativeOfficeDesign, usesNativeOfficeDesign } from '../design/native-design.mjs';
import { persistOfficeDesignBinding, resolveOfficeDesignLibrary } from '../design/library/design-library.mjs';
import { FACTS_SAMPLE_DISCLOSURE } from '../authoring/pptx-brief.mjs';

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
  // for a preset. Resolving it as one used to hand a Word or Excel file the
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
  const left = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const right = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
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
  const digest = { ...design };
  for (const key of DESIGN_CATALOGUE_KEYS) delete digest[key];
  const direction = digest.artDirection;
  if (direction && typeof direction === 'object' && Array.isArray(direction.candidates)) {
    const { candidates, ...rest } = direction;
    digest.artDirection = { ...rest, candidateCount: candidates.length };
  }
  return digest;
}

export function finalizeOfficeResult(value, { action, session = null, startedAt = 0 } = {}) {
  if (!value || typeof value !== 'object') return value;
  if (value.design) value.design = officeDesignDigest(value.design);
  if (value.batch?.design) value.batch = { ...value.batch, design: officeDesignDigest(value.batch.design) };
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
  let operation = '';
  if (action === 'create' || (action === 'author' && value.output)) operation = 'create';
  else if (action === 'render') operation = 'render';
  else if (['batch', 'commit', 'rollback', 'save', 'secure', 'finalize'].includes(action)) operation = 'edit';
  let artifactPath = '';
  if (action === 'render' || action === 'secure') artifactPath = value.output;
  else if (operation && session) artifactPath = session.target;
  if (operation && artifactPath) {
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
  return value;
}

export function bounded(value, maxChars) {
  const text = serializedToolValue(value);
  if (text.length <= maxChars) return value;
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
  if (!['docx', 'xlsx', 'pptx'].includes(format)) return hash.update(buffer).digest('hex');
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
