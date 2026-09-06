import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { renderPortableOoxml } from '../portable/portable-ooxml.mjs';
import { renderPdfPages } from '../pdf/pdf-render.mjs';
import { resolveOfficeRenderOutput } from '../quality/quality-pipeline.mjs';
import { defaultRenderOutput, exists, fullPath } from './office-sessions.mjs';
import { completePageCoverage, pptxPageSignatures, reusablePptxPages } from './pptx-page-cache.mjs';

function request(session, args, cwd) {
  return {
    output: resolveOfficeRenderOutput(args.output ? fullPath(args.output, cwd) : defaultRenderOutput(session.target)),
    pages: Array.isArray(args.pages) && args.pages.length ? args.pages.map(Number) : null,
    maxWidth: Number(args.maxWidth) || 1400,
  };
}

function cacheable(session) {
  return session.mode !== 'visible' && session.mode !== 'attach'
    && session.ownership === 'owned' && session.visible !== true;
}

// Finalization may reuse the completed visual read even when its output path or
// resolution differed from the defaults. Explicit requests still take precedence.
export async function cachedOfficePreview(session, args, cwd, { reuseLatest = false } = {}) {
  session.activeSignal?.throwIfAborted();
  const cache = session.renderCache;
  if (!cacheable(session) || !cache || cache.target !== session.target
    || cache.version !== Number(session.snapshotVersion || 0)) return null;
  const wanted = request(session, args, cwd);
  const previous = cache.request;
  if (!previous) return null;
  if ((!reuseLatest || args.output) && wanted.output !== previous.output) return null;
  if ((!reuseLatest || args.maxWidth != null) && wanted.maxWidth !== previous.maxWidth) return null;
  if ((!reuseLatest || args.pages != null) && JSON.stringify(wanted.pages) !== JSON.stringify(previous.pages)) return null;
  if (reuseLatest && cache.result.visualCoverage?.complete !== true) return null;
  const images = cache.result._images || [];
  if (!images.length || !images.every((image) => image.data && image.path)) return null;
  if (!(await Promise.all(images.map((image) => exists(image.path)))).every(Boolean)) return null;
  // A missing intermediate PDF does not invalidate persisted page images.
  const exportAvailable = await exists(cache.result.output);
  return { ...structuredClone(cache.result), reused: true, exportAvailable };
}

async function exportDocument(session, output) {
  if (session.format === 'pdf') {
    if (output !== session.target) await copyFile(session.target, output);
  } else if (session.backend === 'microsoft-office-com') {
    const result = await callMicrosoftOffice({
      action: 'render', session: session.id, format: session.format,
      mode: session.mode, path: session.target, output,
    }, { signal: session.activeSignal || null, timeoutMs: 300_000 });
    if (!result.ok) throw new Error(result.error || 'Microsoft Office render failed');
  } else {
    await renderPortableOoxml(session.target, output);
  }
}

function reviewToken(session, version, rendered) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify({ target: session.target, pageCount: rendered.pageCount, coverage: rendered.visualCoverage }));
  for (const image of rendered.images) {
    digest.update(JSON.stringify([image.page, image.pages, image.width, image.height]));
    digest.update(image.data || '');
  }
  // Interactive sessions must refresh, but identical pixels still represent the
  // same review. New pixels invalidate approval even without a batch revision.
  return `${session.id}:${version}:${digest.digest('hex')}`;
}

export async function renderOfficePreview(session, args, cwd, {
  reuseLatest = false,
  exportPreview = exportDocument,
  rasterize = renderPdfPages,
} = {}) {
  session.activeSignal?.throwIfAborted();
  const cached = await cachedOfficePreview(session, args, cwd, { reuseLatest });
  if (cached) return cached;
  const requested = request(session, args, cwd);
  // COM documents can contain unsaved edits; only the owned portable package
  // is authoritative enough for cross-revision page reuse.
  const incremental = cacheable(session) && session.format === 'pptx' && session.backend === 'mixdog-ooxml';
  const signatures = incremental ? await pptxPageSignatures(session.target) : null;
  const retained = signatures
    ? await reusablePptxPages(session.pageRenderCache?.target === session.target ? session.pageRenderCache : null, signatures, requested)
    : new Map();
  const wantedPages = signatures
    ? requested.pages || signatures.map((entry) => entry.page)
    : null;
  if (wantedPages && (requested.pages?.length > 12 || wantedPages.some((page) => !Number.isInteger(page) || page < 1 || page > signatures.length))) {
    throw new Error('render accepts at most 12 explicit pages, within the presentation range');
  }
  const missingPages = wantedPages?.filter((page) => !retained.has(page));
  await mkdir(dirname(requested.output), { recursive: true });
  // Clear approval before work that can fail, rather than leaving an earlier
  // render marked current after a failed refresh.
  session.designState ||= {};
  session.designState.renderedVersion = null;
  session.designState.reviewToken = '';
  session.renderCache = null;
  session.pageRenderCache = null;
  // The PDF remains a full, current export. Only rasterization is incremental;
  // a subset PDF would renumber fields and misrepresent the saved document.
  const exportKey = `${session.target}\0${Number(session.snapshotVersion || 0)}\0${requested.output}`;
  if (!incremental || session.previewExportKey !== exportKey || !await exists(requested.output)) {
    session.previewExportKey = null;
    await exportPreview(session, requested.output);
    if (incremental) session.previewExportKey = exportKey;
  }
  let rendered;
  if (signatures && wantedPages.length <= 12) {
    const fresh = missingPages.length ? await rasterize(requested.output, {
      pages: missingPages, maxWidth: requested.maxWidth, signal: session.activeSignal || null,
    }) : { pageCount: signatures.length, images: [] };
    if (fresh.pageCount !== signatures.length) throw new Error('Rendered page count differs from the current presentation');
    for (const image of fresh.images) retained.set(image.page, image);
    if (wantedPages.some((page) => !retained.get(page)?.data)) throw new Error('Renderer omitted requested presentation pages');
    rendered = {
      pageCount: signatures.length,
      images: [...new Set(wantedPages)].map((page) => retained.get(page)),
      visualCoverage: completePageCoverage(signatures.length, wantedPages),
    };
  } else {
    rendered = await rasterize(requested.output, {
      pages: requested.pages, maxWidth: requested.maxWidth, signal: session.activeSignal || null,
    });
  }
  const version = Number(session.snapshotVersion || 0);
  const result = {
    session: session.id, backend: session.backend, output: requested.output, format: 'pdf',
    pageCount: rendered.pageCount, visualCoverage: rendered.visualCoverage,
    images: rendered.images.map(({ data, pageImages, ...image }) => image),
    _images: rendered.images,
    reviewToken: reviewToken(session, version, rendered),
    exportAvailable: true,
    ...(signatures && wantedPages.length <= 12 ? {
      changedPages: missingPages,
      reusedPages: wantedPages.filter((page) => !missingPages.includes(page)),
      pageIdentities: signatures.map(({ page, slideId }) => ({ page, slideId })),
    } : {}),
  };
  Object.assign(session.designState, {
    renderedVersion: version, reviewToken: result.reviewToken,
    renderedPageCount: result.pageCount, renderedCoverage: structuredClone(result.visualCoverage),
  });
  if (cacheable(session)) {
    session.renderCache = { target: session.target, version, request: requested, result: structuredClone(result) };
  }
  if (signatures) {
    for (const image of rendered.images) if (Number.isInteger(image.page)) retained.set(image.page, image);
    session.pageRenderCache = {
      target: session.target, output: requested.output, maxWidth: requested.maxWidth,
      pages: signatures.filter((entry) => retained.has(entry.page)).map((entry) => ({
        ...entry, image: structuredClone(retained.get(entry.page)),
      })),
    };
  }
  return result;
}
