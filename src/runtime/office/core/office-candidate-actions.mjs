import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { applyBatch, closeSession, render } from './office-actions.mjs';
import {
  advancePptxFreeformRevision,
  compilePptxFreeformCandidateBoards,
  summarizePptxFreeformCandidateBoards,
} from '../design/design-freeform-board.mjs';
import {
  persistPptxAuthoredDecision,
  persistPptxAuthoredProject,
} from '../design/pptx/design-pptx-authored-project.mjs';
import {
  evaluatePptxRevisionDecision,
  evaluatePptxVisualDecision,
} from '../design/pptx/design-pptx-review-gate.mjs';
import { compilePptxReferenceVisualCatalog, summarizePptxReferenceVisualCatalog } from '../design/design-reference-visual-catalog.mjs';
import { fullPath, createSession } from './office-sessions.mjs';
import { imageBuffer, plainObject } from '../shared/values.mjs';

const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_PREVIEWS = 16;
const previews = new Map();

function safeName(value) {
  return String(value || 'candidate').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || 'candidate';
}

function svgText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
    : extension === '.webp' ? 'image/webp'
      : 'image/png';
}

function purgePreviews() {
  const now = Date.now();
  for (const [token, record] of previews) {
    if (record.expiresAt <= now) previews.delete(token);
  }
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
}

async function loadReferences(catalog) {
  const entries = new Map();
  for (const entry of catalog.entries) {
    await access(entry.imagePath);
    entries.set(entry.id, {
      ...entry,
      mimeType: mimeType(entry.imagePath),
      data: await readFile(entry.imagePath),
    });
  }
  return entries;
}

async function loadBaseline(design, slideCount, cwd) {
  const baseline = plainObject(design.baseline) ? design.baseline : null;
  if (!baseline) return null;
  const slides = Array.isArray(baseline.slides) ? baseline.slides : [];
  if (slides.length !== slideCount) {
    throw new Error(`design.baseline.slides must contain exactly ${slideCount} full-size slide images.`);
  }
  const loaded = new Map();
  for (const entry of slides) {
    const slide = Number(entry?.slide);
    if (!(slide >= 1 && slide <= slideCount) || loaded.has(slide)) {
      throw new Error('design.baseline.slides must identify every slide exactly once.');
    }
    const path = fullPath(entry.imagePath, cwd);
    await access(path);
    const data = await readFile(path);
    const metadata = await sharp(data).metadata();
    loaded.set(slide, {
      page: slide,
      width: Number(entry.width || metadata.width || 0),
      height: Number(entry.height || metadata.height || 0),
      mimeType: mimeType(path),
      data,
    });
  }
  return {
    id: String(baseline.id || 'baseline'),
    slides: loaded,
  };
}

async function panel(data, width, height) {
  return await sharp(data)
    .resize(width, height, {
      fit: 'contain',
      background: { r: 248, g: 249, b: 251, alpha: 1 },
    })
    .png()
    .toBuffer();
}

async function comparisonSheet({
  candidateId,
  slide,
  candidateImage,
  referenceIds,
  references,
  baselineImage,
}) {
  const width = 1400;
  const height = 820;
  const label = 34;
  const referenceWidth = 410;
  const referenceHeight = 218;
  const candidateWidth = 920;
  const candidateHeight = 730;
  const composites = [];
  const selected = referenceIds.slice(0, baselineImage ? 2 : 3);
  if (baselineImage) {
    composites.push({
      input: await panel(imageBuffer(baselineImage), referenceWidth, referenceHeight),
      left: 20,
      top: 50,
    });
    composites.push({
      input: Buffer.from(`<svg width="${referenceWidth}" height="${label}"><text x="2" y="24" font-family="Arial" font-size="18" font-weight="700" fill="#252A32">BASELINE</text></svg>`),
      left: 20,
      top: 18,
    });
  }
  for (const [index, id] of selected.entries()) {
    const reference = references.get(id);
    if (!reference) continue;
    composites.push({
      input: await panel(reference.data, referenceWidth, referenceHeight),
      left: 20,
      top: 50 + ((index + (baselineImage ? 1 : 0)) * 250),
    });
    composites.push({
      input: Buffer.from(`<svg width="${referenceWidth}" height="${label}"><text x="2" y="24" font-family="Arial" font-size="18" fill="#252A32">REFERENCE ${index + 1} · ${svgText(id)}</text></svg>`),
      left: 20,
      top: 18 + ((index + (baselineImage ? 1 : 0)) * 250),
    });
  }
  composites.push({
    input: await panel(imageBuffer(candidateImage), candidateWidth, candidateHeight),
    left: 460,
    top: 58,
  });
  composites.push({
    input: Buffer.from(`<svg width="${candidateWidth}" height="${label}"><text x="2" y="25" font-family="Arial" font-size="20" font-weight="700" fill="#111827">CANDIDATE · ${svgText(candidateId)} · SLIDE ${slide}</text></svg>`),
    left: 460,
    top: 18,
  });
  const data = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 234, g: 237, b: 242, alpha: 1 },
    },
  }).composite(composites).png().toBuffer();
  return {
    page: slide,
    width,
    height,
    mimeType: 'image/png',
    data: data.toString('base64'),
  };
}

function normalizedPreviewDesign(session) {
  const request = plainObject(session.designRequest) ? session.designRequest : {};
  return {
    ...request,
    review: false,
    freeform: {
      ...(plainObject(request.freeform) ? request.freeform : {}),
      protocol: 'reference-assisted-freeform-v2',
      required: true,
    },
  };
}

function normalizedCompileDesign(session, candidate) {
  const request = plainObject(session.designRequest) ? session.designRequest : {};
  const authoredSceneRequired = candidate?.expression === 'authored-scene-v1';
  return {
    ...request,
    freeform: {
      ...(plainObject(request.freeform) ? request.freeform : {}),
      protocol: 'reference-assisted-freeform-v2',
      required: true,
      authoredSceneRequired,
    },
  };
}

export async function previewPptxCandidates(session, args, cwd, dataDir, signal) {
  if (session.format !== 'pptx') throw new Error('preview supports PPTX sessions only');
  const design = plainObject(args.design) ? args.design : {};
  const previewMode = String(design.previewMode || '').toLowerCase() === 'background'
    ? 'background'
    : 'portable';
  const catalog = compilePptxReferenceVisualCatalog(
    design.referenceCatalog,
    { resolvePath: (value) => fullPath(value, cwd) },
  );
  const compiled = compilePptxFreeformCandidateBoards(design.candidateBoards, catalog);
  const parentToken = String(design.parentPreviewToken || '');
  const parent = parentToken ? previews.get(parentToken) : null;
  let round = 1;
  let revision = null;
  let critiqueHistory = [];
  if (parentToken) {
    if (!parent) throw new Error('preview requires a live design.parentPreviewToken.');
    if (
      parent.sessionId !== session.id
      || parent.target !== session.target
      || parent.snapshotVersion !== Number(session.snapshotVersion || 0)
    ) {
      throw new Error('The parent candidate preview is stale because the target PPTX session changed.');
    }
    const review = evaluatePptxRevisionDecision(parent, design);
    revision = advancePptxFreeformRevision(parent.compiled, compiled, parent.round || 1);
    round = revision.round;
    critiqueHistory = [...(parent.critiqueHistory || []), review.historyEntry];
  }
  const references = await loadReferences(catalog);
  const baseline = await loadBaseline(design, compiled.slideCount, cwd);
  const token = `pptx_preview_${randomUUID().replaceAll('-', '')}`;
  const root = join(tmpdir(), 'mixdog-office-candidates', token);
  const images = [];
  const candidateRenders = [];
  const comparisonImages = [];
  await mkdir(root, { recursive: true });
  try {
    for (const candidate of compiled.candidates) {
      const stem = safeName(candidate.id);
      const target = join(root, `${stem}.pptx`);
      const candidateSession = await createSession({
        path: target,
        format: 'pptx',
        mode: previewMode,
        overwrite: true,
        design: normalizedPreviewDesign(session),
        __signal: signal,
      }, cwd, dataDir);
      try {
        candidateSession.activeSignal = signal;
        await applyBatch(candidateSession, {
          operations: candidate.operations,
          design: normalizedPreviewDesign(session),
          save: true,
          requireChanges: true,
          __cwd: cwd,
        });
        const rendered = await render(candidateSession, {
          output: join(root, `${stem}.pdf`),
          maxWidth: Math.max(900, Math.min(1600, Number(args.maxWidth) || 1200)),
        }, cwd);
        if (rendered.pageCount !== compiled.slideCount) {
          throw new Error(`Candidate "${candidate.id}" rendered ${rendered.pageCount} slides; expected ${compiled.slideCount}.`);
        }
        for (const slide of candidate.slides) {
          const candidateImage = rendered._images.find((image) => Number(image.page) === slide.slide);
          if (!candidateImage) throw new Error(`Candidate "${candidate.id}" has no rendered image for slide ${slide.slide}.`);
          candidateRenders.push({
            candidateId: candidate.id,
            slide: slide.slide,
            image: candidateImage,
          });
          const comparison = await comparisonSheet({
            candidateId: candidate.id,
            slide: slide.slide,
            candidateImage,
            referenceIds: slide.referenceIds,
            references,
            baselineImage: baseline?.slides.get(slide.slide),
          });
          images.push(comparison);
          comparisonImages.push({
            candidateId: candidate.id,
            slide: slide.slide,
            image: comparison,
          });
        }
      } finally {
        await closeSession(candidateSession, { save: false, signal }).catch(() => {});
      }
    }
    const artifact = await persistPptxAuthoredProject({
      dataDir,
      token,
      session,
      compiled,
      round,
      parentToken,
      revision,
      critiqueHistory,
      candidateRenders,
      comparisonImages,
      baseline,
    });
    purgePreviews();
    previews.set(token, {
      token,
      sessionId: session.id,
      snapshotVersion: Number(session.snapshotVersion || 0),
      target: session.target,
      createdAt: Date.now(),
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      catalog,
      compiled,
      parentToken,
      round,
      revision,
      critiqueHistory,
      artifact,
      renderReceipts: artifact.renderReceipts,
      baselineReceipts: artifact.baselineReceipts,
    });
    return {
      ok: true,
      action: 'preview',
      readOnly: true,
      protocol: 'reference-assisted-freeform-v2',
      session: session.id,
      snapshotVersion: Number(session.snapshotVersion || 0),
      previewToken: token,
      previewRound: round,
      parentPreviewToken: parentToken || null,
      revision,
      expiresInSeconds: PREVIEW_TTL_MS / 1_000,
      referenceCatalog: summarizePptxReferenceVisualCatalog(catalog),
      boards: summarizePptxFreeformCandidateBoards(compiled),
      authoredProject: {
        contract: artifact.contract,
        root: artifact.root,
        manifestPath: artifact.manifestPath,
      },
      fullSizeRenders: artifact.renderReceipts,
      baselineRenders: artifact.baselineReceipts,
      comparisonImages: images.map((image, index) => ({
        index: index + 1,
        candidate: compiled.candidates[Math.floor(index / compiled.slideCount)].id,
        slide: (index % compiled.slideCount) + 1,
        width: image.width,
        height: image.height,
      })),
      nextAction: round < 2 && compiled.candidates.some((candidate) => candidate.expression === 'authored-scene-v1')
        ? 'Open every persisted full-size render, critique every slide, revise the authored pages, then call preview again with design.parentPreviewToken and revisionCritique.'
        : 'Open every persisted full-size render and baseline. Call compile with decision:accept only when one candidate is better on every slide; otherwise call compile with decision:reject-all.',
      _images: images,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

export async function compilePptxCandidate(session, args, cwd) {
  if (session.format !== 'pptx') throw new Error('compile supports PPTX sessions only');
  purgePreviews();
  const design = plainObject(args.design) ? args.design : {};
  const token = String(design.previewToken || '');
  const record = previews.get(token);
  if (!record) throw new Error('compile requires a live design.previewToken from preview.');
  if (
    record.sessionId !== session.id
    || record.target !== session.target
    || record.snapshotVersion !== Number(session.snapshotVersion || 0)
  ) {
    throw new Error('The candidate preview is stale because the target PPTX session changed.');
  }
  const decision = evaluatePptxVisualDecision(record, design);
  if (decision.kind === 'reject-all') {
    const decisionPath = await persistPptxAuthoredDecision(record.artifact, decision);
    session.designState ||= {};
    session.designState.freeformRejection = {
      protocol: 'reference-assisted-freeform-v2',
      previewToken: token,
      artifact: record.artifact,
      decision,
      decisionPath,
    };
    previews.delete(token);
    return {
      ok: true,
      action: 'compile',
      compiled: false,
      rejected: true,
      decision: 'reject-all',
      session: session.id,
      previewRound: Number(record.round || 1),
      artifact: record.artifact,
      decisionPath,
      nextAction: 'Author materially different full-page candidates. Do not finalize or deliver the rejected deck.',
    };
  }
  const selectedCandidate = decision.candidateId;
  const candidate = record.compiled.candidates.find((entry) => entry.id === selectedCandidate);
  if (candidate.expression === 'authored-scene-v1' && Number(record.round || 1) < 2) {
    throw new Error('Authored-scene compile requires at least two rendered preview rounds.');
  }
  const critique = decision.critique;
  const requestDesign = normalizedCompileDesign(session, candidate);
  const batch = await applyBatch(session, {
    ...args,
    operations: candidate.operations,
    design: requestDesign,
    __cwd: cwd,
  });
  session.designState ||= {};
  session.designState.freeformSelection = {
    protocol: 'reference-assisted-freeform-v2',
    previewToken: token,
    selectedCandidate,
    compiledVersion: Number(session.snapshotVersion || 0),
    contentFingerprint: record.compiled.contentFingerprint,
    referenceIds: [...new Set(candidate.slides.flatMap((slide) => slide.referenceIds))],
    critique,
    previewRound: Number(record.round || 1),
    revisionHistory: record.critiqueHistory || [],
    expression: candidate.expression,
    editable: true,
    repairRequiredAfterRender: true,
    artifact: record.artifact,
  };
  const decisionPath = await persistPptxAuthoredDecision(record.artifact, decision);
  previews.delete(token);
  return {
    ok: true,
    action: 'compile',
    compiled: true,
    editable: true,
    session: session.id,
    selectedCandidate,
    previewRound: Number(record.round || 1),
    expression: candidate.expression,
    contentFingerprint: record.compiled.contentFingerprint,
    referenceIds: session.designState.freeformSelection.referenceIds,
    selectionCritique: critique,
    artifact: record.artifact,
    decisionPath,
    batch,
    nextAction: 'Render the compiled PPTX, inspect every slide at full size in PowerPoint, reject the deck if any slide falls below the baseline, then finalize only with complete per-slide evidence.',
  };
}

export function resetOfficeCandidatePreviewsForTest() {
  previews.clear();
}
