import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { resolveOfficeDesign } from '../design/design-system.mjs';
import { persistOfficeDesignBinding, resolveOfficeDesignLibrary } from '../design/library/design-library.mjs';

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


export function mergeOfficeDesignRequest(current, next) {
  const left = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const right = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  return {
    ...left,
    ...right,
    ...(left.palette || right.palette ? { palette: { ...(left.palette || {}), ...(right.palette || {}) } } : {}),
    ...(left.typography || right.typography ? { typography: { ...(left.typography || {}), ...(right.typography || {}) } } : {}),
  };
}


export async function resolveOfficeDesignContext({
  args,
  dataDir,
  target,
  source = '',
  format,
  created,
}) {
  const designRequest = args.design || (created ? {} : { source: 'existing-document', review: format === 'pptx' });
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
  sessions.set(session.id, session);
  documentSessions.set(documentSessionKey(session.target), session.id);
  return session;
}


export class OfficeConflictError extends Error {
  constructor(details) {
    super('Office transaction conflict: the document changed outside this transaction');
    this.details = details;
  }
}


function compactOfficeSnapshot(value) {
  return value?.document?.format === 'xlsx'
    && value.document.sheets?.some?.((sheet) => sheet?.representation === 'row-blocks');
}


export function serializedToolValue(value) {
  return JSON.stringify(value, null, compactOfficeSnapshot(value) ? 0 : 2);
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


function officeArtifact(format, fileKind, path, operation) {
  return {
    type: format === 'xlsx' || TABULAR_FORMATS.has(format)
      ? 'spreadsheet'
      : format === 'pptx'
        ? 'presentation'
        : format === 'pdf'
          ? 'pdf'
          : 'document',
    format,
    fileKind,
    operation,
    path,
  };
}


export function finalizeOfficeResult(value, {
  action,
  session = null,
  startedAt = 0,
} = {}) {
  if (!value || typeof value !== 'object') return value;
  value.metrics = {
    ...(value.metrics || {}),
    durationMs: Math.max(0, Number((performance.now() - startedAt).toFixed(2))),
  };
  const operation = action === 'create'
    ? 'create'
    : action === 'render'
      ? 'render'
      : ['batch', 'compile', 'commit', 'rollback', 'save', 'secure', 'finalize'].includes(action)
        ? 'edit'
        : '';
  const artifactPath = action === 'render'
    ? value.output
    : action === 'secure'
      ? value.output
      : operation && session
        ? session.target
        : '';
  if (operation && artifactPath) {
    value.artifacts = [officeArtifact(
      session?.format || (action === 'secure' ? 'pdf' : ''),
      session?.fileKind || (action === 'secure' ? 'pdf' : ''),
      artifactPath,
      operation,
    )];
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
    if (document.pagination) summary.pagination = {
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


export function normalizeOfficeFormat(value) {
  const kind = String(value || '').toLowerCase();
  const format = FILE_KIND_TO_FORMAT[kind];
  if (!format) throw new Error(`Unsupported Office Use format: .${kind || '(none)'}`);
  return format;
}


export function documentFileKind(path) {
  const kind = extname(path).slice(1).toLowerCase();
  if (!FILE_KIND_TO_FORMAT[kind]) throw new Error(`Unsupported Office Use format: .${kind || '(none)'}`);
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
    hash.update(name === 'xl/workbook.xml'
      ? content.toString('utf8').replace(/\bdocumentId="[^"]*"/g, 'documentId=""')
      : content);
    hash.update('\0');
  }
  return hash.digest('hex');
}


export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
