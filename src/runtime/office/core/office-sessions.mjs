import { access, copyFile, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice, detectMicrosoftOffice, microsoftOfficeComSupported, openMicrosoftOfficeSession } from '../com/com-adapter.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';
import { createPortableOoxmlDocument, portableCreateSupported } from '../portable/portable-package.mjs';
import { createPdf, snapshotPdf } from '../pdf/pdf-adapter.mjs';
import { createTabular, snapshotTabular } from './tabular.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './pagination.mjs';
import { applyPdfDesign } from '../design/design-system.mjs';
import { analyzeOfficeFilePromptInjection, analyzeOfficePromptInjection, combineOfficeTrustReviews } from '../quality/assurance.mjs';
import { FORMATS, TABULAR_FORMATS, bounded, documentFileKind, documentFormat, documentSessionKey, documentSessions, isInteractiveOfficeSession, normalizeOfficeFormat, registerOfficeSession, resolveOfficeDesignContext, serializedToolValue, sessions } from './office-core.mjs';

export function fullPath(path, cwd) {
  if (!path) throw new Error('path is required');
  return isAbsolute(path) ? resolve(path) : resolve(cwd || process.cwd(), path);
}


function defaultOutput(source) {
  const extension = extname(source);
  return join(dirname(source), `${basename(source, extension)}.mixdog-edit${extension}`);
}


export function defaultRenderOutput(source) {
  return join(dirname(source), `${basename(source, extname(source))}.mixdog-preview.pdf`);
}


export async function exists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}


function officeDetectionFor(result, format) {
  return result?.applications?.find((entry) => entry?.format === format) || null;
}


export async function selectMode(requested, format, source) {
  if (format === 'pdf') return { mode: 'portable', backend: 'mixdog-pdf' };
  let mode = String(requested || 'auto').toLowerCase();
  if (mode === 'live') mode = 'attach';
  if (!['auto', 'attach', 'visible', 'background', 'portable'].includes(mode)) {
    throw new Error(`Unsupported Office mode: ${mode}`);
  }
  if (TABULAR_FORMATS.has(format)) {
    if (['attach', 'visible'].includes(mode)) throw new Error(`${mode} is unsupported for ${format.toUpperCase()}; use auto, background, or portable mode`);
    return { mode: 'portable', backend: 'mixdog-tabular' };
  }
  if (mode === 'portable') return { mode, backend: 'mixdog-ooxml' };
  if (!microsoftOfficeComSupported()) {
    if (['attach', 'visible', 'background'].includes(mode)) {
      throw new Error(`${mode} Office editing requires Microsoft Office on Windows`);
    }
    return { mode: 'portable', backend: 'mixdog-ooxml' };
  }
  if (mode !== 'auto') return { mode, backend: 'microsoft-office-com' };
  const detection = await detectMicrosoftOffice({ format, path: source });
  const app = officeDetectionFor(detection, format);
  if (app?.installed) return { mode: 'background', backend: 'microsoft-office-com' };
  return { mode: 'portable', backend: 'mixdog-ooxml' };
}


export async function openSession(args, cwd, dataDir) {
  const source = fullPath(args.path, cwd);
  if (!await exists(source)) throw new Error(`Office document not found: ${source}`);
  const fileKind = documentFileKind(source);
  const format = documentFormat(source);
  const selected = await selectMode(args.mode, format, source);
  let target = source;
  if (['background', 'portable'].includes(selected.mode)) {
    target = args.output ? fullPath(args.output, cwd) : defaultOutput(source);
    if (target.toLowerCase() === source.toLowerCase()) throw new Error('background/portable editing requires an output path different from the source');
  }
  const key = documentSessionKey(target);
  const existingId = documentSessions.get(key);
  const existing = existingId ? sessions.get(existingId) : null;
  if (existing) return { ...existing, reused: true };
  if (['background', 'portable'].includes(selected.mode)) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const designContext = await resolveOfficeDesignContext({
    args,
    dataDir,
    target,
    source,
    format,
    created: false,
  });
  const id = `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const session = {
    id,
    source,
    target,
    fileKind,
    format,
    mode: selected.mode,
    backend: selected.backend,
    openedAt: new Date().toISOString(),
    dataDir,
    created: false,
    snapshotVersion: 0,
    ...designContext,
    designState: {
      renderedVersion: null,
      semanticCount: 0,
      requiresVisualReview: format === 'pptx' && designContext.design.review.required,
      slidePlans: [],
      compositions: [],
    },
  };
  if (selected.backend === 'microsoft-office-com') {
    const opened = await openMicrosoftOfficeSession({
      session: id,
      format,
      mode: selected.mode,
      path: target,
    }, { signal: args.__signal || null });
    if (!opened.ok) throw new Error(opened.error || 'Microsoft Office session open failed');
    Object.assign(session, {
      mode: opened.mode,
      ownership: opened.ownership,
      visible: opened.visible,
      appPid: opened.appPid,
      windowHwnd: opened.windowHwnd,
      foregroundActivated: opened.foregroundActivated === true,
      backgroundIsolation: opened.backgroundIsolation || null,
      documentId: opened.documentId,
    });
  }
  await registerOfficeSession(session);
  return session;
}


export async function createSession(args, cwd, dataDir) {
  const requestedPath = String(args.path || args.output || '').trim();
  if (!requestedPath) throw new Error('create requires path or output');
  const target = fullPath(requestedPath, cwd);
  const fileKind = documentFileKind(target);
  const inferredFormat = documentFormat(target);
  const format = args.format ? normalizeOfficeFormat(args.format) : inferredFormat;
  if (format !== inferredFormat) throw new Error(`Office create format ${args.format} does not match target .${fileKind}`);
  const designContext = await resolveOfficeDesignContext({
    args,
    dataDir,
    target,
    format,
    created: true,
  });
  const { designRequest, designLibrary, design } = designContext;
  if (format === 'pdf') {
    if (await exists(target) && args.overwrite !== true) {
      throw new Error(`Office create target already exists: ${target}`);
    }
    await mkdir(dirname(target), { recursive: true });
    const designed = applyPdfDesign((args.blocks || []).map((block) => (
      block?.path ? { ...block, path: fullPath(block.path, cwd) } : block
    )), designRequest, { library: designLibrary });
    await createPdf(target, {
      blocks: designed.blocks,
      fields: args.fields,
      properties: {
        ...designed.properties,
        ...args.properties,
        ...(args.properties?.fontPath ? { fontPath: fullPath(args.properties.fontPath, cwd) } : {}),
      },
    });
    const session = {
      id: `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      source: target,
      target,
      fileKind,
      format,
      mode: 'portable',
      backend: 'mixdog-pdf',
      openedAt: new Date().toISOString(),
      dataDir,
      created: true,
      ownership: 'owned',
      visible: false,
      snapshotVersion: 0,
      designRequest,
      designLibrary,
      design,
      designState: { renderedVersion: null, semanticCount: 0, requiresVisualReview: false, compositions: [] },
    };
    await registerOfficeSession(session);
    return session;
  }
  if (!FORMATS.has(format) || format === 'pdf') {
    throw new Error('Office create currently supports Word, Excel, PowerPoint, CSV, and TSV files');
  }
  if (await exists(target) && args.overwrite !== true) {
    throw new Error(`Office create target already exists: ${target}`);
  }
  const key = documentSessionKey(target);
  const existingId = documentSessions.get(key);
  const existing = existingId ? sessions.get(existingId) : null;
  if (existing) return { ...existing, reused: true };
  if (TABULAR_FORMATS.has(format)) {
    await mkdir(dirname(target), { recursive: true });
    await createTabular(target);
    const session = {
      id: `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      source: target,
      target,
      fileKind,
      format,
      mode: 'portable',
      backend: 'mixdog-tabular',
      openedAt: new Date().toISOString(),
      dataDir,
      created: true,
      ownership: 'owned',
      visible: false,
      snapshotVersion: 0,
      designRequest,
      designLibrary,
      design,
      designState: { renderedVersion: null, semanticCount: 0, requiresVisualReview: false, compositions: [] },
    };
    await registerOfficeSession(session);
    return session;
  }
  const requestedMode = String(args.mode || 'auto').toLowerCase();
  if (['attach', 'live'].includes(requestedMode)) {
    throw new Error('Office create requires visible, background, or portable mode');
  }
  const selected = await selectMode(requestedMode, format, target);
  if (selected.backend === 'mixdog-ooxml') {
    if (!portableCreateSupported(fileKind)) {
      throw new Error(`Creating .${fileKind} without Microsoft Office is unsupported; open Microsoft Office or choose a docx, xlsx, or pptx target`);
    }
    await mkdir(dirname(target), { recursive: true });
    await createPortableOoxmlDocument(target, {
      fileKind,
      title: basename(target, extname(target)),
    });
    const session = {
      id: `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      source: target,
      target,
      fileKind,
      format,
      mode: 'portable',
      backend: 'mixdog-ooxml',
      openedAt: new Date().toISOString(),
      dataDir,
      created: true,
      ownership: 'owned',
      visible: false,
      snapshotVersion: 0,
      designRequest,
      designLibrary,
      design,
      designState: {
        renderedVersion: null,
        semanticCount: 0,
        requiresVisualReview: format === 'pptx' && design.review.required,
        slidePlans: [],
        compositions: [],
      },
    };
    await registerOfficeSession(session);
    return session;
  }
  const id = `office_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const opened = await openMicrosoftOfficeSession({
    session: id,
    format,
    fileKind,
    mode: selected.mode,
    path: target,
    create: true,
    overwrite: args.overwrite === true,
  }, { signal: args.__signal || null });
  if (!opened.ok) throw new Error(opened.error || 'Microsoft Office document creation failed');
  const session = {
    id,
    source: target,
    target,
    fileKind,
    format,
    mode: opened.mode,
    backend: 'microsoft-office-com',
    openedAt: new Date().toISOString(),
    dataDir,
    created: true,
    ownership: opened.ownership,
    visible: opened.visible,
    appPid: opened.appPid,
    windowHwnd: opened.windowHwnd,
    foregroundActivated: opened.foregroundActivated === true,
    backgroundIsolation: opened.backgroundIsolation || null,
    documentId: opened.documentId,
    snapshotVersion: 0,
    designRequest,
    designLibrary,
    design,
    designState: {
      renderedVersion: null,
      semanticCount: 0,
      requiresVisualReview: format === 'pptx' && design.review.required,
      slidePlans: [],
      compositions: [],
    },
  };
  await registerOfficeSession(session);
  return session;
}


export async function resolveSession(args, cwd, dataDir) {
  if (args.session) {
    const session = sessions.get(String(args.session));
    if (!session) throw new Error(`Unknown or closed Office Use session: ${args.session}`);
    return { session, implicit: false };
  }
  if (!args.path) throw new Error('session or path is required');
  return { session: await openSession(args, cwd, dataDir), implicit: true };
}


export async function snapshot(session, args, { full = false } = {}) {
  const maxChars = Math.min(100_000, Math.max(1000, Number(args.maxChars) || 30_000));
  const requestArgs = {
    ...args,
    includeSelection: args.includeSelection !== false
      && session.backend === 'microsoft-office-com'
      && isInteractiveOfficeSession(session),
  };
  let request = createOfficeSnapshotRequest(session, requestArgs, { full });
  const load = async () => {
    if (session.backend === 'microsoft-office-com') {
      const result = await callMicrosoftOffice({
        action: 'snapshot',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: session.target,
        ...request,
      }, { signal: session.activeSignal || null });
      if (!result.ok) throw new Error(result.error || 'Microsoft Office snapshot failed');
      return result.value;
    }
    if (session.format === 'pdf') return await snapshotPdf(session.target, { maxChars, ...request });
    if (TABULAR_FORMATS.has(session.format)) return await snapshotTabular(session.target, session.format, request);
    return await snapshotPortableOoxml(session.target, session.format, request);
  };
  let wrapped;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await load();
    finalizeOfficeSnapshotPage(value, session, request);
    wrapped = {
      session: session.id,
      mode: session.mode,
      backend: session.backend,
      fileKind: session.fileKind,
      source: session.source,
      output: session.target,
      ownership: session.ownership,
      visible: session.visible,
      appPid: session.appPid,
      windowHwnd: session.windowHwnd,
      documentId: session.documentId,
      document: value,
      trust: combineOfficeTrustReviews(
        analyzeOfficePromptInjection(value, {
          format: session.format,
          source: 'structured-snapshot',
        }),
        await analyzeOfficeFilePromptInjection(session.target, {
          format: session.format,
        }),
      ),
    };
    if (!session.created) session.trustReview = wrapped.trust;
    const serializedLength = serializedToolValue(wrapped).length;
    if (full || serializedLength <= maxChars || request.limit <= 1) break;
    const measured = Math.max(1, serializedLength);
    const nextLimit = Math.max(1, Math.min(request.limit - 1, Math.floor(request.limit * maxChars * 0.8 / measured)));
    request = { ...request, limit: nextLimit };
  }
  return full ? wrapped : bounded(wrapped, maxChars);
}


export async function trustForMutation(session) {
  if (session.created) {
    return combineOfficeTrustReviews(analyzeOfficePromptInjection({}, {
      format: session.format,
      source: 'created-document',
    }));
  }
  if (session.trustReview) return session.trustReview;
  const current = await snapshot(session, {}, { full: true });
  return current.trust;
}


export function queryObject(value, query, path = '$', matches = []) {
  if (matches.length >= 100) return matches;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(query)) matches.push({ path, value });
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => queryObject(entry, query, `${path}[${index}]`, matches));
    return matches;
  }
  if (value && typeof value === 'object') {
    const logicalPath = typeof value.path === 'string' ? value.path : path;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'path') continue;
      if (typeof entry === 'string' && entry.toLowerCase().includes(query)) {
        matches.push({ path: logicalPath, field: key, value: entry });
      } else {
        queryObject(entry, query, `${logicalPath}.${key}`, matches);
      }
    }
  }
  return matches;
}


export function findByDocumentPath(value, target) {
  if (!value || typeof value !== 'object') return null;
  if (value.path === target) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findByDocumentPath(entry, target);
      if (match) return match;
    }
    return null;
  }
  for (const entry of Object.values(value)) {
    const match = findByDocumentPath(entry, target);
    if (match) return match;
  }
  return null;
}


export function snapshotSelectionForTarget(format, target) {
  if (format === 'xlsx' || TABULAR_FORMATS.has(format)) {
    const cell = /^\/sheet\[([^\]]+)]\/cell\[([A-Z]+\d+)]$/i.exec(target);
    if (cell) return { sheet: cell[1], range: `${cell[2]}:${cell[2]}` };
    const range = /^\/sheet\[([^\]]+)]\/range\[([A-Z]+\d+:[A-Z]+\d+)]$/i.exec(target);
    if (range) return { sheet: range[1], range: range[2] };
  }
  if (format === 'pptx') {
    const slide = /^\/slide\[(\d+)]/.exec(target);
    if (slide) return { pages: [Number(slide[1])] };
  }
  return {};
}
