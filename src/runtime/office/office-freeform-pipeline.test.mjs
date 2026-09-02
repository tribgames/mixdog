import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  advancePptxFreeformRevision,
  compilePptxFreeformCandidateBoards,
} from './design/design-freeform-board.mjs';
import { reviewPptxFrontierQuality } from './quality/design-frontier-review.mjs';
import { expandOfficeDesignOperations } from './design/design-system.mjs';
import {
  compilePptxReferenceVisualCatalog,
  retrievePptxVisualReferences,
} from './design/design-reference-visual-catalog.mjs';
import { persistPptxAuthoredProject } from './design/pptx/design-pptx-authored-project.mjs';
import {
  evaluatePptxRevisionDecision,
  evaluatePptxVisualDecision,
} from './design/pptx/design-pptx-review-gate.mjs';
import { candidateBoards as executiveCandidateBoards } from './bench/freeform-live-benchmark.mjs';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { value } from './office-test-support.mjs';

function references() {
  return [
    {
      id: 'proof-editorial',
      imagePath: 'proof.png',
      semantic: {
        roles: ['proof'],
        visualTypes: ['annotated-chart'],
        densities: ['balanced'],
        domains: ['finance'],
        tags: ['editorial', 'asymmetric'],
      },
      quality: 0.95,
    },
    {
      id: 'proof-dashboard',
      imagePath: 'dashboard.png',
      semantic: {
        roles: ['proof'],
        visualTypes: ['scorecard'],
        densities: ['dense'],
        domains: ['finance'],
        tags: ['dashboard'],
      },
      quality: 0.9,
    },
    {
      id: 'decision-field',
      imagePath: 'decision.webp',
      semantic: {
        roles: ['choice'],
        visualTypes: ['allocation'],
        densities: ['light'],
        domains: ['strategy'],
        tags: ['field'],
      },
      quality: 0.92,
    },
  ];
}

function content() {
  return {
    kind: 'chart',
    title: 'Margin expansion funds the next decision',
    takeaway: 'Revenue and operating margin move together.',
    chart: {
      type: 'column',
      categories: ['Q1', 'Q2', 'Q3'],
      series: [{ name: 'Revenue', values: [12, 15, 19] }],
    },
    annotations: [{ label: 'Q3', value: '19' }],
    source: 'Board finance pack',
  };
}

function board(id, grammar, regions) {
  return {
    id,
    grammar,
    rationale: `Use the ${grammar} reading path for the same evidence.`,
    domain: 'finance',
    slides: [{
      background: { role: 'canvas' },
      grammar,
      semantic: {
        role: 'proof',
        visualType: 'annotated-chart',
        density: 'balanced',
        domain: 'finance',
      },
      layout: {
        units: 'percent',
        safeMargin: 4,
        visualType: 'annotated-chart',
        readingOrder: ['title', 'evidence', 'support'],
        regions,
      },
      content: content(),
    }],
  };
}

function candidates() {
  return [
    board('editorial-split', 'editorial-split', [
      { id: 'title', role: 'title', x: 6, y: 8, w: 42, h: 18 },
      { id: 'support', role: 'subtitle', x: 6, y: 34, w: 26, h: 20 },
      { id: 'evidence', role: 'annotated-chart', x: 38, y: 24, w: 56, h: 62 },
    ]),
    board('evidence-band', 'evidence-band', [
      { id: 'title', role: 'title', x: 7, y: 7, w: 86, h: 16 },
      { id: 'evidence', role: 'annotated-chart', x: 7, y: 29, w: 86, h: 48 },
      { id: 'support', role: 'subtitle', x: 58, y: 81, w: 35, h: 10 },
    ]),
    board('vertical-field', 'vertical-field', [
      { id: 'evidence', role: 'annotated-chart', x: 6, y: 12, w: 48, h: 78 },
      { id: 'title', role: 'title', x: 61, y: 15, w: 33, h: 24 },
      { id: 'support', role: 'subtitle', x: 61, y: 56, w: 30, h: 18 },
    ]),
  ];
}

function sceneBoard(id, grammar, offset = 0) {
  return {
    id,
    grammar,
    rationale: `Use ${grammar} as a native authored scene.`,
    domain: 'finance',
    slides: [{
      background: { role: 'canvas' },
      grammar,
      semantic: {
        role: 'proof',
        visualType: 'annotated-chart',
        density: 'balanced',
        domain: 'finance',
      },
      scene: {
        units: 'percent',
        safeMargin: 4,
        readingOrder: ['title', 'rule', 'evidence', 'note'],
        elements: [
          { id: 'title', type: 'text', role: 'title', x: 6 + offset, y: 8, w: 56, h: 16, style: { display: true, fontSize: 32, bold: true } },
          { id: 'rule', type: 'line', x: 6 + offset, y: 28, w: 20, h: 0.5, style: { lineColor: 'accent', lineWidth: 2 } },
          { id: 'evidence', type: 'chart', role: 'evidence', x: 6 + offset, y: 34, w: 58, h: 54 },
          { id: 'note', type: 'text', role: 'body', x: 70, y: 38, w: 23 - offset, h: 30, style: { fontSize: 14 } },
        ],
      },
      content: {
        ...content(),
        elements: {
          title: { text: 'Margin expansion funds the next decision' },
          evidence: { chart: content().chart },
          note: { text: 'Revenue and operating margin move together.' },
        },
      },
    }],
  };
}

function sceneCandidates(offset = 0) {
  return [
    sceneBoard('scene-editorial', 'scene-editorial', offset),
    sceneBoard('scene-band', 'scene-band', offset + 2),
    sceneBoard('scene-field', 'scene-field', offset + 4),
  ];
}

test('visual reference catalog retrieves real slide images by semantic role and visual type', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const selected = retrievePptxVisualReferences(catalog, {
    role: 'proof',
    visualType: 'annotated-chart',
    density: 'balanced',
    domain: 'finance',
    tags: ['editorial'],
  });
  assert.equal(catalog.coordinatePolicy, 'inspiration-only');
  assert.equal(selected[0].id, 'proof-editorial');
  assert.ok(selected[0].matchScore > selected[1].matchScore);
});

test('free-form boards separate layers, preserve content, and compile distinct editable plans', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const compiled = compilePptxFreeformCandidateBoards(candidates(), catalog);
  assert.equal(compiled.candidates.length, 3);
  assert.equal(new Set(compiled.candidates.map((entry) => entry.grammar)).size, 3);
  for (const candidate of compiled.candidates) {
    const operation = candidate.operations[0];
    assert.equal(operation.op, 'compose_slide');
    assert.equal(operation.slideRole, 'content');
    assert.equal(operation.plan.sourceContract, 'freeform-board-v1');
    assert.deepEqual(operation.plan.freeform.layers, ['background', 'layout', 'content']);
    assert.equal(operation.plan.freeform.editableCompile, true);
    assert.equal(operation.plan.referenceSelection.coordinatePolicy, 'inspiration-only');
    assert.ok(operation.plan.referenceSelection.ids.length >= 1);
  }
});

test('authored scenes compile text, lines, and native evidence without the region renderer', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const compiled = compilePptxFreeformCandidateBoards(sceneCandidates(), catalog);
  assert.equal(compiled.version, 2);
  assert.equal(compiled.candidates.every((candidate) => candidate.expression === 'authored-scene-v1'), true);
  const operation = compiled.candidates[0].operations[0];
  assert.equal(operation.plan.sourceContract, 'authored-scene-v1');
  assert.equal(operation.plan.regions, undefined);
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [operation],
    design: { review: false },
  });
  assert.equal(expanded.semantic[0].renderMode, 'authored-scene');
  assert.ok(expanded.operations.some((entry) => entry.op === 'add_shape' && entry.shapeType === 'line'));
  assert.ok(expanded.operations.some((entry) => entry.op === 'add_chart'));
  assert.ok(expanded.operations.filter((entry) => entry.op === 'add_textbox').length >= 2);
});

test('authored scene revisions preserve content and require a real composition change', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const first = compilePptxFreeformCandidateBoards(sceneCandidates(), catalog);
  const second = compilePptxFreeformCandidateBoards(sceneCandidates(1), catalog);
  assert.deepEqual(advancePptxFreeformRevision(first, second, 1), {
    round: 2,
    fromComposition: first.compositionFingerprint,
    toComposition: second.compositionFingerprint,
    changedSlides: [1],
  });
  assert.throws(
    () => advancePptxFreeformRevision(first, first, 1),
    /must change authored composition/,
  );
  assert.throws(
    () => advancePptxFreeformRevision(first, second, 3),
    /at most three/,
  );
});

test('executive authored pages preflight every candidate and revision before Office render', () => {
  const catalog = compilePptxReferenceVisualCatalog(Array.from({ length: 6 }, (_, index) => ({
    id: `reference-${index + 1}`,
    imagePath: `C:/reference-${index + 1}.png`,
    semantic: {
      roles: ['opening', 'proof', 'choice', 'execution', 'decision-close'],
      visualTypes: ['typography', 'scorecard', 'annotated-chart', 'allocation', 'timeline'],
      densities: ['light', 'balanced'],
      domains: ['executive-finance'],
      tags: ['editorial'],
    },
    quality: 0.9,
  })));
  let pageCount = 0;
  const rounds = [];
  const expectedSlideRoles = ['cover', 'content', 'content', 'content', 'content', 'closing'];
  const expectedBackgroundRoles = ['inverse', 'canvas', 'canvas', 'inverse', 'canvas', 'inverse'];
  for (const round of [1, 2]) {
    const compiled = compilePptxFreeformCandidateBoards(executiveCandidateBoards(round), catalog);
    rounds.push(compiled);
    for (const candidate of compiled.candidates) {
      assert.deepEqual(candidate.operations.map((operation) => operation.slideRole), expectedSlideRoles);
      const expanded = expandOfficeDesignOperations({
        format: 'pptx',
        backend: 'mixdog-ooxml',
        created: true,
        operations: candidate.operations,
        design: { review: false },
      });
      assert.deepEqual(expanded.semantic.map((entry) => entry.slideRole), expectedSlideRoles);
      assert.deepEqual(expanded.semantic.map((entry) => entry.backgroundRole), expectedBackgroundRoles);
      pageCount += expanded.semantic.length;
    }
  }
  assert.equal(pageCount, 36);
  assert.deepEqual(advancePptxFreeformRevision(rounds[0], rounds[1], 1).changedSlides, [1, 2, 3, 4, 5, 6]);
  for (const candidate of rounds[1].candidates) {
    const previous = rounds[0].candidates.find((entry) => entry.id === candidate.id);
    assert.ok(candidate.slideCompositionFingerprints.every((fingerprint, index) => (
      fingerprint !== previous.slideCompositionFingerprints[index]
    )));
  }
});

test('authored projects persist full-size receipts and reject compile without slide-by-slide evidence', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-authored-project-'));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  const catalog = compilePptxReferenceVisualCatalog(references());
  const compiled = compilePptxFreeformCandidateBoards(sceneCandidates(), catalog);
  const candidateRenders = compiled.candidates.map((candidate) => ({
    candidateId: candidate.id,
    slide: 1,
    image: {
      width: 1600,
      height: 900,
      data: Buffer.from(`render:${candidate.id}`),
    },
  }));
  const baseline = {
    id: 'v9',
    slides: new Map([[
      1,
      { width: 1600, height: 900, data: Buffer.from('baseline:v9') },
    ]]),
  };
  const artifact = await persistPptxAuthoredProject({
    dataDir: join(cwd, 'data'),
    token: 'preview-token',
    session: { id: 'session-1', target: 'deck.pptx', snapshotVersion: 2 },
    compiled,
    round: 2,
    parentToken: 'round-1',
    revision: { changedSlides: [1] },
    critiqueHistory: [],
    candidateRenders,
    comparisonImages: [],
    baseline,
  });
  await access(artifact.manifestPath);
  assert.equal(artifact.renderReceipts.length, 3);
  assert.equal(artifact.baselineReceipts.length, 1);
  const record = {
    compiled,
    renderReceipts: artifact.renderReceipts,
    baselineReceipts: artifact.baselineReceipts,
  };
  const selectedCandidate = compiled.candidates[0].id;
  const render = artifact.renderReceipts.find((entry) => entry.candidateId === selectedCandidate);
  const baselineReceipt = artifact.baselineReceipts[0];
  const critique = {
    selectedCandidate,
    comparedCandidates: compiled.candidates.map((candidate) => candidate.id),
    note: '세 후보의 full-size persisted render를 baseline과 직접 비교했고, 선택안만 제목과 근거의 시선 흐름이 끊기지 않으며 모든 화면에서 기준본보다 명확했습니다.',
    comparisons: compiled.candidates.slice(1).map((candidate) => ({
      rejectedCandidate: candidate.id,
      note: `${candidate.id}는 같은 내용을 보존하지만 full-size 화면에서 위계와 여백의 연결이 선택안보다 명확하지 않았습니다.`,
    })),
    slides: [{
      slide: 1,
      verdict: 'selected',
      reviewMode: 'full-size',
      renderSha256: render.sha256,
      baselineSha256: baselineReceipt.sha256,
      baselineVerdict: 'better',
      note: '1장은 persisted full-size candidate와 v9 baseline을 직접 비교했으며 제목, chart, 근거 문장의 읽기 순서와 공간 밀도가 모두 기준본보다 명확합니다.',
      strengths: ['clear hierarchy'],
      risks: [],
    }],
  };
  assert.throws(
    () => evaluatePptxVisualDecision(record, {
      selectedCandidate,
      selectionCritique: {
        ...critique,
        slides: critique.slides.map((entry) => ({ ...entry, reviewMode: 'contact-sheet' })),
      },
    }),
    /persisted full-size render/,
  );
  const accepted = evaluatePptxVisualDecision(record, { selectedCandidate, selectionCritique: critique });
  assert.equal(accepted.kind, 'accept');
  assert.equal(accepted.critique.slides[0].baselineVerdict, 'better');
  const rejectionDecision = {
    decision: 'reject-all',
    rejectionCritique: {
      comparedCandidates: compiled.candidates.map((candidate) => candidate.id),
      note: '세 후보를 full-size로 검토했지만 모두 baseline보다 위계, 밀도, 시각적 고유성이 낮아 어떤 후보도 문서로 컴파일하거나 전달할 수 없습니다.',
      slides: [{
        slide: 1,
        verdict: 'reject-all',
        reviewMode: 'full-size',
        baselineSha256: baselineReceipt.sha256,
        note: '1장은 모든 candidate가 v9 baseline보다 정보 위계와 공간 사용이 약하며, 선택 가능한 우수 후보가 없으므로 전체를 거부합니다.',
        candidateVerdicts: compiled.candidates.map((candidate) => ({
          candidateId: candidate.id,
          renderSha256: artifact.renderReceipts.find((entry) => entry.candidateId === candidate.id).sha256,
          verdict: 'not-better',
        })),
      }],
    },
  };
  const rejected = evaluatePptxVisualDecision(record, rejectionDecision);
  assert.equal(rejected.kind, 'reject-all');
  const revisionReview = evaluatePptxRevisionDecision(record, {
    revisionDecision: rejectionDecision,
  });
  assert.equal(revisionReview.decision.kind, 'reject-all');
  assert.equal(revisionReview.historyEntry.slides[0].candidateVerdicts.length, 3);
  assert.throws(
    () => evaluatePptxVisualDecision(record, {
      ...rejectionDecision,
      rejectionCritique: {
        ...rejectionDecision.rejectionCritique,
        slides: rejectionDecision.rejectionCritique.slides.map((slide) => ({
          ...slide,
          candidateVerdicts: slide.candidateVerdicts.map((entry) => ({
            ...entry,
            verdict: entry.candidateId === selectedCandidate ? 'better' : entry.verdict,
          })),
        })),
      },
    }),
    /better than the baseline on every slide/,
  );
});

test('authored scenes reject unreadable text before PowerPoint render', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const bad = sceneCandidates();
  bad[0].slides[0].scene.elements[0].style.fontSize = 10;
  const compiled = compilePptxFreeformCandidateBoards(bad, catalog);
  assert.throws(
    () => expandOfficeDesignOperations({
      format: 'pptx',
      backend: 'mixdog-ooxml',
      created: true,
      operations: [compiled.candidates[0].operations[0]],
      design: { review: false },
    }),
    /AUTHORED_SCENE_SMALL_FONT/,
  );
});

test('free-form boards reject equal-card generic motifs and coordinate-only variants', () => {
  const catalog = compilePptxReferenceVisualCatalog(references());
  const bad = candidates();
  bad[0].slides[0].layout.regions = [
    { id: 'title', role: 'title', x: 6, y: 7, w: 88, h: 15 },
    { id: 'a', role: 'metric', x: 6, y: 30, w: 25, h: 30 },
    { id: 'b', role: 'metric', x: 37, y: 30, w: 25, h: 30 },
    { id: 'c', role: 'metric', x: 68, y: 30, w: 25, h: 30 },
  ];
  assert.throws(
    () => compilePptxFreeformCandidateBoards(bad, catalog),
    /equal-card-grid/,
  );
  const duplicate = candidates();
  duplicate[1].grammar = duplicate[0].grammar;
  duplicate[1].slides[0].grammar = duplicate[0].grammar;
  assert.throws(
    () => compilePptxFreeformCandidateBoards(duplicate, catalog),
    /visibly distinct composition grammars/,
  );
});

test('frontier review treats the coordinate tournament as fallback when free-form is required', () => {
  const document = {
    slideWidth: 960,
    slideHeight: 540,
    slides: [1, 2, 3].map((index) => ({
      index,
      shapes: [
        { text: `Slide ${index}`, left: 40, top: 40, width: 500, height: 80 },
        { text: 'Evidence', left: 80, top: 160, width: 760, height: 260 },
      ],
    })),
  };
  const issues = reviewPptxFrontierQuality({
    document,
    design: {
      review: { frontier: true },
      freeform: { required: true },
      creative: {
        standard: 'frontier-office-v1',
        version: 2,
        layoutSearch: 'adaptive-top-k',
        narrativeArc: ['opening', 'proof', 'decision-close'],
      },
      slidePlans: [1, 2, 3].map((slide) => ({
        slide,
        visualType: slide === 2 ? 'scorecard' : 'typography',
        sourceContract: 'adaptive-tournament-fallback',
        tournament: {
          method: 'verifiable-layout-v1',
          candidateCount: 3,
          selected: 'fallback-band',
          metrics: {
            capacity: 1,
            whitespaceFit: 1,
            balance: 1,
            motifSafety: 1,
          },
        },
        referenceGenome: { id: 'fallback', coordinatePolicy: 'constraints-only' },
      })),
    },
  });
  assert.equal(issues.filter((issue) => issue.code === 'freeform_compile_missing').length, 3);
});

test('compact free-form timelines keep action detail clear of redundant cadence footers', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [{
      op: 'compose_slide',
      kind: 'process',
      title: '30일 실행계획',
      steps: [
        { phase: 'D1', title: 'Owner 확정', detail: '채널·cohort별 책임 지정' },
        { phase: 'D7', title: 'Leading 지표', detail: '전환·이탈 조기 점검' },
        { phase: 'D14', title: '재배분', detail: '저효율 집행 중단' },
        { phase: 'D30', title: 'Gate 판정', detail: '월말 release / stop' },
      ],
      plan: {
        units: 'percent',
        visualType: 'timeline',
        sourceContract: 'freeform-board-v1',
        referenceSelection: {
          contract: 'reference-visual-catalog-v1',
          coordinatePolicy: 'inspiration-only',
          ids: ['execution-reference'],
        },
        freeform: {
          editableCompile: true,
          layers: ['background', 'layout', 'content'],
          genericMotifs: [],
        },
        regions: [
          { id: 'title', role: 'title', x: 6, y: 80, w: 72, h: 12 },
          { id: 'evidence', role: 'timeline', x: 6, y: 14, w: 88, h: 58 },
        ],
      },
    }],
    design: { review: false },
  });
  const cadenceFooters = expanded.operations.filter((operation) => (
    operation.op === 'add_textbox'
    && /^CADENCE D/u.test(String(operation.text || ''))
  ));
  assert.equal(cadenceFooters.length, 0);
  for (const detail of ['채널·cohort별 책임 지정', '전환·이탈 조기 점검', '저효율 집행 중단', '월말 release / stop']) {
    const operation = expanded.operations.find((entry) => entry.op === 'add_textbox' && entry.text === detail);
    assert.ok(operation, detail);
    assert.ok(operation.properties.height >= 18, JSON.stringify(operation));
  }
});

test('finalize blocks a required free-form deck until a preview winner is compiled', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-freeform-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(cwd, 'data');
  t.after(async () => {
    resetOfficeSessionsForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'freeform-required.pptx'),
    mode: 'portable',
    design: {
      review: false,
      freeform: { required: true },
    },
  }, { cwd }));
  const finalized = value(await executeOfficeTool({
    action: 'finalize',
    session: created.session,
    review: false,
  }, { cwd }));
  assert.equal(finalized.finalized, false);
  assert.equal(finalized.reason, 'freeform_compile_required');
});
