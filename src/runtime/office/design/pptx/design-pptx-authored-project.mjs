import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageBuffer, plainObject, sha256 } from '../../shared/values.mjs';

function safeName(value, fallback = 'artifact') {
  return String(value || fallback).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || fallback;
}

function canonicalCandidate(candidate) {
  return {
    id: candidate.id,
    grammar: candidate.grammar,
    rationale: candidate.rationale,
    expression: candidate.expression,
    compositionFingerprint: candidate.compositionFingerprint,
    pages: candidate.slides.map((slide) => ({
      slide: slide.slide,
      grammar: slide.grammar,
      role: slide.role,
      visualType: slide.visualType,
      density: slide.density,
      domain: slide.domain,
      contentFingerprint: slide.contentFingerprint,
      referenceIds: slide.referenceIds,
      operation: slide.operation,
    })),
  };
}

export function canonicalPptxAuthoredProject(compiled, {
  token,
  target,
  sessionId,
  snapshotVersion,
  round,
  parentToken,
  revision,
  critiqueHistory,
} = {}) {
  const candidates = Array.isArray(compiled?.candidates) ? compiled.candidates : [];
  if (!candidates.length) throw new Error('A canonical PPTX authored project requires candidates.');
  return {
    version: 1,
    contract: 'canonical-authored-project-v1',
    token: String(token || ''),
    target: String(target || ''),
    sessionId: String(sessionId || ''),
    snapshotVersion: Number(snapshotVersion || 0),
    createdAt: new Date().toISOString(),
    round: Number(round || 1),
    parentToken: String(parentToken || '') || null,
    revision: plainObject(revision) ? revision : null,
    critiqueHistory: Array.isArray(critiqueHistory) ? critiqueHistory : [],
    slideCount: Number(compiled.slideCount || 0),
    contentFingerprint: compiled.contentFingerprint,
    compositionFingerprint: compiled.compositionFingerprint,
    candidates: candidates.map(canonicalCandidate),
  };
}

export async function persistPptxAuthoredProject({
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
}) {
  const root = join(
    String(dataDir || ''),
    'office',
    'pptx-authored-projects',
    safeName(session?.id, 'session'),
    safeName(token, 'preview'),
  );
  await mkdir(root, { recursive: true });
  const project = canonicalPptxAuthoredProject(compiled, {
    token,
    target: session?.target,
    sessionId: session?.id,
    snapshotVersion: session?.snapshotVersion,
    round,
    parentToken,
    revision,
    critiqueHistory,
  });
  const renderReceipts = [];
  for (const entry of Array.isArray(candidateRenders) ? candidateRenders : []) {
    const data = imageBuffer(entry.image);
    const directory = join(root, 'candidates', safeName(entry.candidateId), 'renders');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `slide-${Number(entry.slide)}.png`);
    await writeFile(path, data);
    renderReceipts.push({
      candidateId: String(entry.candidateId),
      slide: Number(entry.slide),
      sha256: sha256(data),
      width: Number(entry.image?.width || 0),
      height: Number(entry.image?.height || 0),
      path,
      reviewMode: 'full-size',
    });
  }
  const comparisonReceipts = [];
  for (const entry of Array.isArray(comparisonImages) ? comparisonImages : []) {
    const data = imageBuffer(entry.image);
    const directory = join(root, 'candidates', safeName(entry.candidateId), 'comparisons');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `slide-${Number(entry.slide)}.png`);
    await writeFile(path, data);
    comparisonReceipts.push({
      candidateId: String(entry.candidateId),
      slide: Number(entry.slide),
      sha256: sha256(data),
      width: Number(entry.image?.width || 0),
      height: Number(entry.image?.height || 0),
      path,
    });
  }
  const baselineReceipts = [];
  if (baseline?.slides instanceof Map) {
    const directory = join(root, 'baseline', safeName(baseline.id, 'baseline'));
    await mkdir(directory, { recursive: true });
    for (const [slide, image] of baseline.slides) {
      const data = imageBuffer(image);
      const path = join(directory, `slide-${Number(slide)}.png`);
      await writeFile(path, data);
      baselineReceipts.push({
        baselineId: String(baseline.id || 'baseline'),
        slide: Number(slide),
        sha256: sha256(data),
        width: Number(image?.width || 0),
        height: Number(image?.height || 0),
        path,
        reviewMode: 'full-size',
      });
    }
  }
  const manifestPath = join(root, 'authored-project.json');
  const manifest = {
    ...project,
    renderReceipts,
    comparisonReceipts,
    baselineReceipts,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    contract: project.contract,
    root,
    manifestPath,
    renderReceipts,
    comparisonReceipts,
    baselineReceipts,
  };
}

export async function persistPptxAuthoredDecision(artifact, decision) {
  if (!artifact?.root) return null;
  const path = join(artifact.root, 'decision.json');
  await writeFile(path, `${JSON.stringify({
    version: 1,
    contract: 'authored-project-decision-v1',
    decidedAt: new Date().toISOString(),
    ...decision,
  }, null, 2)}\n`, 'utf8');
  return path;
}
