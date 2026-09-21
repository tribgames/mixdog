import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  callMicrosoftOffice,
  detectMicrosoftOffice,
  microsoftOfficeComSupported,
  openMicrosoftOfficeSession,
} from '../com/com-adapter.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';
import { normalizeExcelCellStyle } from '../portable/portable-sheet-styles.mjs';
import { summarizeXlsxConventions } from '../portable/xlsx-conventions.mjs';
import { createPortableOoxmlDocument, portableCreateSupported } from '../portable/portable-package.mjs';
import { createPdf, snapshotPdf } from '../pdf/pdf-adapter.mjs';
import { createTabular, snapshotTabular } from './tabular.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './pagination.mjs';
import { applyPdfDesign } from '../design/design-system.mjs';
import { annotatePptxSnapshotRoles } from '../design/library/design-template-induct.mjs';
import {
  analyzeOfficeFilePromptInjection,
  analyzeOfficePromptInjection,
  combineOfficeTrustReviews,
} from '../quality/assurance.mjs';
import {
  FORMATS,
  TABULAR_FORMATS,
  bounded,
  documentFileKind,
  documentFormat,
  documentSessionKey,
  documentSessions,
  emptyOfficeDesignState,
  isInteractiveOfficeSession,
  microsoftOfficeOpenFields,
  normalizeOfficeFormat,
  officeSessionForDocument,
  officeSessionId,
  registerOfficeSession,
  resolveOfficeDesignContext,
  serializedToolValue,
  sessions,
} from './office-core.mjs';

export function fullPath(path, cwd) {
  if (!path) throw new Error('path is required');
  return isAbsolute(path) ? resolve(path) : resolve(cwd || process.cwd(), path);
}

// Word, Excel, and PowerPoint answer a damaged file with their own wording, in
// the language they are installed in, and nothing else: the caller still needs
// to know which file refused to open and what to do about it.
// The application refusing to automate is not a damaged document: sending the
// caller to repair an intact file wastes the turn, while the route that works
// (no Office at all, or co-editing the instance already running) goes unsaid.
const OFFICE_APPLICATION_REFUSAL =
  /shared or unidentified application|already running|RPC server|automation server|is busy|call was rejected/i;

export function officeOpenFailure(reason, path) {
  const message = String(reason || '')
    .trim()
    .replace(/\.+$/, '');
  if (!message) return `Microsoft Office could not open ${path}`;
  if (message.includes(path)) return message;
  if (OFFICE_APPLICATION_REFUSAL.test(message)) {
    return (
      `Microsoft Office could not open ${path}: ${message}.` +
      " This is the Office application, not the file: retry with mode:'portable' (no Office needed)," +
      " or mode:'attach' to co-edit the instance that is already open."
    );
  }
  return (
    `Microsoft Office could not open ${path}: ${message}.` +
    ' If the file is damaged or incomplete, ask for an intact copy or let Office repair it and save a fresh file.'
  );
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

// Several operations take a folder (split_pages, rendered page images), so a
// caller naturally points output at one here too. Writing the document onto a
// directory fails deep in a copy with an OS error that names neither the field
// nor the document: the answer says what output is for, and what to pass.
async function assertDocumentOutput(output, source) {
  let entry;
  try {
    entry = await stat(output);
  } catch {
    return output;
  }
  if (!entry.isDirectory()) return output;
  const suggestion = join(output, basename(defaultOutput(source)));
  throw new Error(
    `Office output is the file to write, not a folder: ${output} is a directory. Pass a file path such as ${suggestion}.`
  );
}

function officeDetectionFor(result, format) {
  return result?.applications?.find((entry) => entry?.format === format) || null;
}

function reusedDocumentSession(target) {
  const existing = officeSessionForDocument(target);
  return existing ? { ...existing, reused: true } : null;
}

function pptxReviewDesignState(design, format) {
  return emptyOfficeDesignState({
    requiresVisualReview: format === 'pptx' && design.review.required,
  });
}

function portableCreateDesignState() {
  return emptyOfficeDesignState({ includeSlidePlans: false });
}

function assertCreateTargetAvailable(target, existed, overwrite) {
  if (existed && overwrite !== true) {
    throw new Error(`Office create target already exists: ${target}`);
  }
}

function buildOfficeSessionRecord({
  id = officeSessionId(),
  source,
  target,
  fileKind,
  format,
  mode,
  backend,
  dataDir,
  created = false,
  createdNewFile,
  designContext,
  designState,
  extra = {},
}) {
  return {
    id,
    source,
    target,
    fileKind,
    format,
    mode,
    backend,
    openedAt: new Date().toISOString(),
    dataDir,
    created,
    snapshotVersion: 0,
    ...(createdNewFile !== undefined ? { createdNewFile } : {}),
    ...(designContext || {}),
    designState,
    ...extra,
  };
}

export async function selectMode(requested, format, source) {
  if (format === 'pdf') return { mode: 'portable', backend: 'mixdog-pdf' };
  let mode = String(requested || 'auto').toLowerCase();
  if (mode === 'live') mode = 'attach';
  if (!['auto', 'attach', 'visible', 'background', 'portable'].includes(mode)) {
    throw new Error(`Unsupported Office mode: ${mode}`);
  }
  if (TABULAR_FORMATS.has(format)) {
    if (['attach', 'visible'].includes(mode))
      throw new Error(`${mode} is unsupported for ${format.toUpperCase()}; use auto, background, or portable mode`);
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

async function editableTarget(args, cwd, source) {
  const target = args.output ? await assertDocumentOutput(fullPath(args.output, cwd), source) : defaultOutput(source);
  if (target.toLowerCase() === source.toLowerCase())
    throw new Error('background/portable editing requires an output path different from the source');
  return target;
}

async function attachMicrosoftOffice(session, { id, format, fileKind = '', mode, target, signal }) {
  const opened = await openMicrosoftOfficeSession(
    { session: id, format, ...(fileKind ? { fileKind } : {}), mode, path: target },
    { signal }
  );
  // The file a caller can act on is the one they named, not the working copy.
  if (!opened.ok) throw new Error(officeOpenFailure(opened.error, session.source || target));
  Object.assign(session, microsoftOfficeOpenFields(opened));
}

export async function openSession(args, cwd, dataDir, { readOnly = false } = {}) {
  const source = fullPath(args.path, cwd);
  if (!(await exists(source))) throw new Error(`Office document not found: ${source}`);
  const fileKind = documentFileKind(source);
  const format = documentFormat(source);
  const selected = await selectMode(args.mode, format, source);
  // Reading a document does not need a copy of it, and making one overwrote
  // the working copy an earlier edit had already been told was saved: the
  // next read of the same path silently threw that edit away. A read opens
  // the file itself; the working copy appears when an edit does.
  const reads = readOnly && !args.output && ['mixdog-ooxml', 'mixdog-pdf', 'mixdog-tabular'].includes(selected.backend);
  const copies = !reads && ['background', 'portable'].includes(selected.mode);
  const target = copies ? await editableTarget(args, cwd, source) : source;
  const existing = reusedDocumentSession(target);
  if (existing) return existing;
  if (copies) {
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
  const id = officeSessionId();
  const session = buildOfficeSessionRecord({
    id,
    source,
    target,
    fileKind,
    format,
    mode: selected.mode,
    backend: selected.backend,
    dataDir,
    created: false,
    designContext,
    designState: pptxReviewDesignState(designContext.design, format),
    extra: {
      ...(selected.backend === 'mixdog-ooxml' ? { ownership: 'owned', visible: false } : {}),
      // The session reads the file itself; the first edit gives it a working
      // copy so the user's document is never written in place.
      ...(reads ? { readsSource: true } : {}),
    },
  });
  if (selected.backend === 'microsoft-office-com') {
    await attachMicrosoftOffice(session, { id, format, mode: selected.mode, target, signal: args.__signal || null });
  }
  await registerOfficeSession(session);
  return session;
}

// Content handed to create under a field this format does not read produced an
// empty document and a success answer: the caller spent a turn discovering the
// file was blank. Each shape is refused with the field that does write it.
const filledList = (value) => Array.isArray(value) && value.length > 0;

function contentFieldFault(format, args) {
  if (format === 'pdf') {
    if (!filledList(args.operations)) return '';
    return (
      "PDF create writes blocks, not operations: pass blocks:[{ type:'heading', text }, …] (and fields for a form)," +
      " or create the file first and edit it with action:'batch' operations:[…]."
    );
  }
  if (!filledList(args.blocks)) return '';
  return (
    `${format.toUpperCase()} create writes operations, not blocks: pass operations:[{ op: … }].` +
    ' blocks is the PDF create field.'
  );
}

// Facts and claims describe what the deliverable must carry; they do not
// write it. Handed over with nothing that does, the call produced an empty
// file and reported success, and the caller found out only on opening it.
function scriptFault(format, args) {
  if (format === 'pdf' || typeof args.script !== 'string' || !args.script.trim()) return '';
  const authorHint = format === 'pptx' ? " A deck written from a script uses action:'author' with script." : '';
  return `${format.toUpperCase()} create takes no script.${authorHint}`;
}

function contentWithoutWriterFault(format, args) {
  const content = args.design?.content;
  const carriesContent =
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    (filledList(content.facts) ||
      filledList(content.claims) ||
      String(content.objective || content.decision || '').trim());
  const writes = format === 'pdf' ? filledList(args.blocks) || filledList(args.fields) : filledList(args.operations);
  if (!carriesContent || writes) return '';
  const route =
    {
      pptx: "author the deck with action:'author' script:… (design travels on that call), or add slides here with operations:[{ op: 'add_slide' }, …]",
      docx: "pass operations:[{ op: 'compose_document', … }] or the append_text/add_table operations that write it",
      xlsx: "pass operations:[{ op: 'compose_sheet', … }] or the set_range/add_chart operations that write it",
      pdf: "pass blocks:[{ type: 'heading', text }, …] (and fields for a form)",
    }[format] || 'pass the operations that write it';
  return `${format.toUpperCase()} create writes nothing from design.content on its own: ${route}.`;
}

function assertCreateContentFields(format, args) {
  const faults = [
    contentFieldFault(format, args),
    filledList(args.values)
      ? `${format.toUpperCase()} create takes no top-level values:` +
        " pass operations:[{ op: 'set_range', range: 'A1:B2', values: [[…]] }]."
      : '',
    scriptFault(format, args),
    contentWithoutWriterFault(format, args),
  ].filter(Boolean);
  if (faults.length === 1) throw new Error(faults[0]);
  if (faults.length)
    throw new Error(
      `This create request breaks ${faults.length} input contracts; fix them together. ${faults.join(' ')}`
    );
}

// Registers the session record of a document this create call produced.
async function registerCreatedSession(creation, fields) {
  const { target, fileKind, format, dataDir, targetExisted, designContext } = creation;
  const session = buildOfficeSessionRecord({
    source: target,
    target,
    fileKind,
    format,
    dataDir,
    created: true,
    createdNewFile: !targetExisted,
    designContext,
    ...fields,
  });
  await registerOfficeSession(session);
  return session;
}

// `design` is where authoring intent and content go for every other format,
// so blocks named there are the document's content, not an unknown key to
// drop: dropping them wrote an empty PDF and reported success.
function firstListed(direct, designed) {
  if (Array.isArray(direct) && direct.length) return direct;
  return Array.isArray(designed) ? designed : [];
}

async function createPdfSession(creation, args, cwd) {
  const { target, designContext } = creation;
  await mkdir(dirname(target), { recursive: true });
  const requestedBlocks = firstListed(args.blocks, args.design?.blocks);
  const requestedFields = firstListed(args.fields, args.design?.fields);
  const designed = applyPdfDesign(
    requestedBlocks.map((block) => (block?.path ? { ...block, path: fullPath(block.path, cwd) } : block)),
    designContext.designRequest,
    { library: designContext.designLibrary }
  );
  const written = await createPdf(target, {
    blocks: designed.blocks,
    fields: requestedFields,
    properties: {
      ...designed.properties,
      ...args.properties,
      ...(args.properties?.fontPath ? { fontPath: fullPath(args.properties.fontPath, cwd) } : {}),
    },
  });
  return registerCreatedSession(creation, {
    mode: 'portable',
    backend: 'mixdog-pdf',
    designState: portableCreateDesignState(),
    extra: {
      // What the writer decided (numbering, the font it embedded) rides on the
      // create result so the caller need not re-open the file to learn it.
      createReceipt: {
        pageNumbers: written.pageNumbers,
        font: written.font,
        // What the writer actually flowed: a document with nothing in it is a
        // result the caller has to see, not a silent success.
        blocks: designed.blocks.length,
        fields: requestedFields.length,
        ...(written.form?.issueCount ? { formIssues: written.form.issues } : {}),
      },
      ownership: 'owned',
      visible: false,
    },
  });
}

async function createTabularSession(creation) {
  await mkdir(dirname(creation.target), { recursive: true });
  await createTabular(creation.target);
  return registerCreatedSession(creation, {
    mode: 'portable',
    backend: 'mixdog-tabular',
    designState: portableCreateDesignState(),
    extra: { ownership: 'owned', visible: false },
  });
}

async function createPortableOoxmlSession(creation) {
  const { target, fileKind, format, designContext } = creation;
  if (!portableCreateSupported(fileKind)) {
    throw new Error(
      `Creating .${fileKind} without Microsoft Office is unsupported; open Microsoft Office or choose a docx, xlsx, or pptx target`
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await createPortableOoxmlDocument(target, { fileKind, title: basename(target, extname(target)) });
  return registerCreatedSession(creation, {
    mode: 'portable',
    backend: 'mixdog-ooxml',
    designState: pptxReviewDesignState(designContext.design, format),
    extra: { ownership: 'owned', visible: false },
  });
}

async function createMicrosoftOfficeSession(creation, args, mode) {
  const { target, fileKind, format, designContext } = creation;
  const id = officeSessionId();
  const opened = await openMicrosoftOfficeSession(
    { session: id, format, fileKind, mode, path: target, create: true, overwrite: args.overwrite === true },
    { signal: args.__signal || null }
  );
  if (!opened.ok) throw new Error(opened.error || 'Microsoft Office document creation failed');
  return registerCreatedSession(creation, {
    id,
    mode: opened.mode,
    backend: 'microsoft-office-com',
    designState: pptxReviewDesignState(designContext.design, format),
    extra: microsoftOfficeOpenFields(opened),
  });
}

export async function createSession(args, cwd, dataDir) {
  const requestedPath = String(args.path || args.output || '').trim();
  if (!requestedPath) throw new Error('create requires path or output');
  const target = fullPath(requestedPath, cwd);
  const fileKind = documentFileKind(target);
  const inferredFormat = documentFormat(target);
  const format = args.format ? normalizeOfficeFormat(args.format) : inferredFormat;
  if (format !== inferredFormat)
    throw new Error(`Office create format ${args.format} does not match target .${fileKind}`);
  assertCreateContentFields(format, args);
  // Whether this call brings the file into being decides what a failed create
  // may clean up afterwards: a file it wrote itself, never one already there.
  const targetExisted = await exists(target);
  const designContext = await resolveOfficeDesignContext({ args, dataDir, target, format, created: true });
  const creation = { target, fileKind, format, dataDir, targetExisted, designContext };
  if (format === 'pdf') {
    assertCreateTargetAvailable(target, targetExisted, args.overwrite);
    return createPdfSession(creation, args, cwd);
  }
  if (!FORMATS.has(format)) {
    throw new Error('Office create currently supports Word, Excel, PowerPoint, CSV, and TSV files');
  }
  assertCreateTargetAvailable(target, targetExisted, args.overwrite);
  const existing = reusedDocumentSession(target);
  if (existing) return existing;
  if (TABULAR_FORMATS.has(format)) return createTabularSession(creation);
  const requestedMode = String(args.mode || 'auto').toLowerCase();
  if (['attach', 'live'].includes(requestedMode)) {
    throw new Error('Office create requires visible, background, or portable mode');
  }
  const selected = await selectMode(requestedMode, format, target);
  if (selected.backend === 'mixdog-ooxml') return createPortableOoxmlSession(creation);
  return createMicrosoftOfficeSession(creation, args, selected.mode);
}

// A deck written by an authoring script already exists on disk; the session
// owns that file in place so render, critique, and finalize treat it like a
// created deliverable while the design gates know a script, not the
// composer, decided the layout.
export function validatePptxAuthorMode(requested) {
  const requestedMode = String(requested || 'auto').toLowerCase();
  if (['attach', 'live', 'visible'].includes(requestedMode)) {
    throw new Error('author requires auto, background, or portable mode');
  }
  if (!['auto', 'background', 'portable'].includes(requestedMode)) {
    throw new Error(`Unsupported Office mode: ${requestedMode}`);
  }
  return requestedMode;
}

// The script's brief owns the background plan and the slide roles; the
// composer's deck plan (sandwich/dark/light) would only contradict it.
function authoredDesignContext(resolved) {
  return {
    ...resolved,
    design: {
      ...resolved.design,
      deck: { ...(resolved.design?.deck || {}), backgroundMode: 'custom', enforce: false },
    },
  };
}

export async function createAuthoredSession(args, _cwd, dataDir, target) {
  const fileKind = documentFileKind(target);
  const format = documentFormat(target);
  if (format !== 'pptx') throw new Error('author currently supports PowerPoint targets only');
  const requestedMode = validatePptxAuthorMode(args.mode);
  const selected = await selectMode(requestedMode, format, target);
  const designContext = authoredDesignContext(
    await resolveOfficeDesignContext({ args, dataDir, target, format, created: true })
  );
  const id = officeSessionId();
  const session = buildOfficeSessionRecord({
    id,
    source: target,
    target,
    fileKind,
    format,
    mode: selected.mode,
    backend: selected.backend,
    dataDir,
    created: true,
    designContext,
    designState: emptyOfficeDesignState({
      requiresVisualReview: designContext.design.review.required,
    }),
    extra: { authored: true, ownership: 'owned', visible: false },
  });
  if (selected.backend === 'microsoft-office-com') {
    await attachMicrosoftOffice(session, {
      id,
      format,
      fileKind,
      mode: selected.mode,
      target,
      signal: args.__signal || null,
    });
  }
  await registerOfficeSession(session);
  return session;
}

export async function resolveSession(args, cwd, dataDir, { readOnly = false } = {}) {
  if (args.session) {
    const session = sessions.get(String(args.session));
    if (!session) throw new Error(`Unknown or closed Office Use session: ${args.session}`);
    return { session, implicit: false };
  }
  if (!args.path) throw new Error('session or path is required');
  return { session: await openSession(args, cwd, dataDir, { readOnly }), implicit: true };
}

// A session opened for reading holds the user's own file. Before the first
// edit it takes the working copy it would have had, so the edit lands beside
// the document instead of inside it.
export async function materializeWorkingCopy(session) {
  if (!session?.readsSource) return session.target;
  const target = defaultOutput(session.source);
  if (target.toLowerCase() === session.source.toLowerCase()) {
    throw new Error('portable editing requires an output path different from the source');
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(session.source, target);
  if (documentSessions.get(documentSessionKey(session.target)) === session.id) {
    documentSessions.delete(documentSessionKey(session.target));
  }
  session.target = target;
  delete session.readsSource;
  documentSessions.set(documentSessionKey(target), session.id);
  return target;
}

// Excel's cells read like the portable snapshot's: RRGGBB colors with
// defaults omitted, and text cells flagged, so the formula audit and the
// model see one shape from both readers.
function normalizeExcelSnapshotStyles(document) {
  for (const sheet of document?.sheets || []) {
    for (const cell of sheet?.cells || []) {
      if (!cell || typeof cell !== 'object') continue;
      if (cell.style) cell.style = normalizeExcelCellStyle(cell.style);
      if (!cell.formula && typeof cell.value === 'string' && cell.value !== '') cell.dataType = 'text';
    }
  }
}

async function fetchSnapshotDocument(session, request, { maxChars, password }) {
  if (session.backend === 'microsoft-office-com') {
    const result = await callMicrosoftOffice(
      {
        action: 'snapshot',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: session.target,
        ...request,
      },
      { signal: session.activeSignal || null }
    );
    if (!result.ok) throw new Error(result.error || 'Microsoft Office snapshot failed');
    if (session.format === 'xlsx') normalizeExcelSnapshotStyles(result.value);
    return result.value;
  }
  // A user password only unlocks this read; it is never kept on the session.
  if (session.format === 'pdf')
    return await snapshotPdf(session.target, {
      maxChars,
      ...request,
      ...(password ? { password: String(password) } : {}),
    });
  if (TABULAR_FORMATS.has(session.format)) return await snapshotTabular(session.target, session.format, request);
  return await snapshotPortableOoxml(session.target, session.format, request);
}

async function wrappedSnapshot(session, value) {
  return {
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
      })
    ),
  };
}

export async function snapshot(session, args, { full = false } = {}) {
  const maxChars = Math.min(100_000, Math.max(1000, Number(args.maxChars) || 30_000));
  const requestArgs = {
    ...args,
    includeSelection:
      args.includeSelection !== false &&
      session.backend === 'microsoft-office-com' &&
      isInteractiveOfficeSession(session),
  };
  let request = createOfficeSnapshotRequest(session, requestArgs, { full });
  // Reading a deck back out of PowerPoint costs seconds (thousands of COM round trips), and one authoring
  // cycle asks for it several times — the receipt, qa, finalize's review — with nothing changed in between.
  // A background session we own changes only through our own batches, and those bump snapshotVersion, so the
  // last document stays true until then. An attached or visible session is never cached: the user edits it.
  const cacheable =
    session.backend === 'microsoft-office-com' &&
    session.mode === 'background' &&
    session.ownership === 'owned' &&
    session.visible !== true;
  const fetchDocument = () => fetchSnapshotDocument(session, request, { maxChars, password: args.password });
  const load = async () => {
    if (!cacheable) return await fetchDocument();
    const key = `${session.snapshotVersion || 0}|${JSON.stringify(request)}`;
    if (session.snapshotCache?.key === key) return structuredClone(session.snapshotCache.value);
    const value = await fetchDocument();
    session.snapshotCache = { key, value: structuredClone(value) };
    return value;
  };
  let wrapped;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await load();
    finalizeOfficeSnapshotPage(value, session, request);
    if (session.format === 'xlsx' && Array.isArray(value?.sheets)) {
      const conventions = summarizeXlsxConventions(value);
      if (conventions) value.conventions = conventions;
    }
    // A deck is read to be reused: without the job each page does and the slot
    // each box fills, a page the user already owns can only be copied by eye.
    if (session.format === 'pptx') annotatePptxSnapshotRoles(value);
    wrapped = await wrappedSnapshot(session, value);
    if (!session.created) session.trustReview = wrapped.trust;
    const serializedLength = serializedToolValue(wrapped).length;
    if (full || serializedLength <= maxChars || request.limit <= 1) break;
    const measured = Math.max(1, serializedLength);
    const nextLimit = Math.max(1, Math.min(request.limit - 1, Math.floor((request.limit * maxChars * 0.8) / measured)));
    request = { ...request, limit: nextLimit };
  }
  return full ? wrapped : bounded(wrapped, maxChars);
}

export async function trustForMutation(session) {
  if (session.created) {
    return combineOfficeTrustReviews(
      analyzeOfficePromptInjection(
        {},
        {
          format: session.format,
          source: 'created-document',
        }
      )
    );
  }
  if (session.trustReview) return session.trustReview;
  const current = await snapshot(session, {}, { full: true });
  return current.trust;
}

// A match answers where the text is, not with the whole field it sits in: a
// document body comes back as the text around each hit, so a query costs a few
// lines instead of the page (or the entire PDF) that contains them.
const QUERY_VALUE_LIMIT = 240;
const QUERY_EXCERPT_RADIUS = 90;

function queryMatchValue(value, query) {
  const text = String(value);
  if (text.length <= QUERY_VALUE_LIMIT) return { value: text };
  const haystack = text.toLowerCase();
  const hits = [];
  for (let from = 0; hits.length < 3; ) {
    const index = haystack.indexOf(query, from);
    if (index < 0) break;
    hits.push(index);
    from = index + Math.max(1, query.length);
  }
  let occurrences = hits.length;
  for (let from = hits.at(-1) ?? 0; occurrences < 1000; ) {
    const index = haystack.indexOf(query, from + Math.max(1, query.length));
    if (index < 0) break;
    occurrences += 1;
    from = index;
  }
  const excerpt = hits
    .map((index) => {
      const start = Math.max(0, index - QUERY_EXCERPT_RADIUS);
      const end = Math.min(text.length, index + query.length + QUERY_EXCERPT_RADIUS);
      return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
    })
    .join(' ⋯ ');
  return {
    value: excerpt || text.slice(0, QUERY_VALUE_LIMIT),
    excerpt: true,
    valueLength: text.length,
    ...(occurrences > hits.length ? { occurrences } : {}),
  };
}

export function queryObject(value, query, path = '$', matches = []) {
  if (matches.length >= 100) return matches;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(query)) matches.push({ path, ...queryMatchValue(value, query) });
    return matches;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) queryObject(entry, query, `${path}[${index}]`, matches);
    return matches;
  }
  if (value && typeof value === 'object') {
    const logicalPath = typeof value.path === 'string' ? value.path : path;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'path') continue;
      if (typeof entry === 'string' && entry.toLowerCase().includes(query)) {
        matches.push({ path: logicalPath, field: key, ...queryMatchValue(entry, query) });
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
