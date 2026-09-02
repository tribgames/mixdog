import assert from 'node:assert/strict';
import { watch as watchFileSystem } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { executeOfficeTool, resetOfficeSessionsForTest } from '../index.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';
import {
  createExecutiveSceneElements,
  EXECUTIVE_SCENE_GRAMMARS,
} from '../design/pptx/design-pptx-executive-scenes.mjs';
import { office } from './bench-support.mjs';

async function persistImages(raw, metadata, directory, prefix) {
  const parts = raw.content.filter((entry) => entry.type === 'image');
  const files = [];
  for (const [index, part] of parts.entries()) {
    const candidate = metadata[index]?.candidate ? `-${metadata[index].candidate}` : '';
    const slide = Number(metadata[index]?.slide || metadata[index]?.page || index + 1);
    const path = join(directory, `${prefix}${candidate}-slide-${slide}.png`);
    await writeFile(path, Buffer.from(part.source.data, 'base64'));
    files.push(path);
  }
  return files;
}

async function readJsonIfReady(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForVisualDecision(path, timeoutMs = 4 * 60 * 60 * 1_000) {
  const existing = await readJsonIfReady(path);
  if (existing) return existing;
  await mkdir(dirname(path), { recursive: true });
  return await new Promise((resolveDecision, rejectDecision) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      callback(value);
    };
    const load = async () => {
      try {
        const decision = await readJsonIfReady(path);
        if (decision) finish(resolveDecision, decision);
      } catch (error) {
        finish(rejectDecision, error);
      }
    };
    const watcher = watchFileSystem(dirname(path), (event, filename) => {
      if (!filename || String(filename) === basename(path)) void load();
    });
    const timer = setTimeout(() => {
      finish(rejectDecision, new Error(`Timed out waiting for visual decision: ${path}`));
    }, timeoutMs);
    void load();
  });
}

async function requestVisualDecision(directory, name, preview, comparisonImages) {
  const requestPath = join(directory, `${name}-review-request.json`);
  const decisionPath = join(directory, `${name}-review-decision.json`);
  await writeFile(requestPath, `${JSON.stringify({
    version: 1,
    contract: 'full-size-pptx-review-request-v2',
    previewToken: preview.previewToken,
    previewRound: preview.previewRound,
    authoredProject: preview.authoredProject,
    candidates: preview.boards.candidates,
    fullSizeRenders: preview.fullSizeRenders,
    baselineRenders: preview.baselineRenders,
    comparisonImages,
    decisionPath,
    acceptedDecisions: ['accept', 'reject-all'],
  }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: 'awaiting-full-size-visual-decision',
    stage: name,
    requestPath,
    decisionPath,
  }));
  return await waitForVisualDecision(decisionPath);
}

function designRequest() {
  return {
    profile: 'executive',
    purpose: 'decide',
    expressionMode: 'strong-fit',
    audience: '7월 경영회의',
    intent: '실적을 검토하고 성장·고객 유지 투자를 결정',
    tone: 'editorial executive financial decision',
    density: 'balanced',
    signature: 'decision evidence field',
    review: true,
    freeform: {
      required: true,
      protocol: 'reference-assisted-freeform-v2',
    },
    deck: {
      backgroundMode: 'sandwich',
      templateMode: 'scratch',
      compositionMode: 'model',
      requireSlidePlan: true,
    },
  };
}

function slideContent() {
  return [
    {
      kind: 'cover',
      title: '7월 실적은 성장 투자의 여력을 증명했습니다',
      subtitle: '이제 성장과 고객 유지에 각각 0.9억원을 배분할 결정이 필요합니다',
      eyebrow: 'JULY EXECUTIVE REVIEW',
      meta: ['2026년 7월', '경영회의'],
      visualText: '1.8억',
      visualLabel: 'DECISION SIZE',
      source: '01-dashboard.xlsx#Dashboard',
    },
    {
      kind: 'statement',
      title: '매출 5,660백만원이 성장 투자의 여력을 만들었습니다',
      subtitle: '영업이익 802백만원 · 영업이익률 14.2%',
      metrics: [
        { label: '7월 매출', value: 5660, unit: '백만원', numberFormat: '#,##0' },
        { label: '7월 영업이익', value: 802, unit: '백만원', numberFormat: '#,##0' },
        { label: '영업이익률', value: 0.1417, unit: '%', numberFormat: '0.0%' },
      ],
      source: '01-dashboard.xlsx#Source!B4:C4',
    },
    {
      kind: 'chart',
      title: '매출과 수익성이 3개월 연속 함께 개선됐습니다',
      body: ['7월 매출 5,660백만원', '7월 영업이익 802백만원', '영업이익률 14.2%'],
      chart: {
        type: 'column',
        title: '월별 매출(백만원)',
        categories: ['5월', '6월', '7월'],
        series: [{ name: '매출', values: [5000, 5300, 5660] }],
        showValues: true,
        showLegend: false,
        valueNumberFormat: '#,##0',
      },
      annotations: [
        { label: '7월 매출', value: 5660, numberFormat: '#,##0', note: '전월 대비 +6.8%' },
        { label: '영업이익', value: 802, numberFormat: '#,##0', note: '3개월 연속 개선' },
        { label: '영업이익률', value: '14.2%', note: '투자 gate 13.5% 상회' },
      ],
      source: '01-dashboard.xlsx#Source!A2:C4',
    },
    {
      kind: 'table',
      title: '성장과 고객 유지 중 하나를 포기할 이유가 없습니다',
      subtitle: '두 트랙은 서로 다른 위험을 줄입니다',
      allocations: [
        { label: '성장 가속', value: 90, displayValue: '0.9억', numberFormat: '#,##0', detail: 'Release ≥ 13.5% · Stop < 13.5%' },
        { label: '고객 유지', value: 90, displayValue: '0.9억', numberFormat: '#,##0', detail: 'Release ≤ 2.4% · Stop < NPS 52' },
      ],
      visualText: '1.8억',
      allocationLabel: 'TWO-TRACK INVESTMENT',
      source: '02-decision-brief.docx#투자안',
    },
    {
      kind: 'process',
      title: '30일 안에 두 트랙의 성과를 다시 판정합니다',
      steps: [
        { phase: 'D1', title: 'Owner 확정', detail: '채널·cohort별 책임 지정' },
        { phase: 'D7', title: 'Leading 지표', detail: '전환·이탈 조기 점검' },
        { phase: 'D14', title: '재배분', detail: '저효율 집행 중단' },
        { phase: 'D30', title: 'Gate 판정', detail: '월말 release / stop' },
      ],
      source: '02-decision-brief.docx#30일 실행계획',
    },
    {
      kind: 'closing',
      title: '오늘 두 트랙에 총 1.8억원 투자를 승인해 주십시오',
      subtitle: '성장 0.9억원 · 고객 유지 0.9억원 · 월말 gate 재판정',
      visualText: '1.8억',
      visualLabel: '승인 요청',
      allocations: [
        { label: '성장', value: 90, displayValue: '0.9억', numberFormat: '#,##0' },
        { label: '고객 유지', value: 90, displayValue: '0.9억', numberFormat: '#,##0' },
      ],
      source: '02-decision-brief.docx#승인 요청',
    },
  ];
}

const SEMANTICS = [
  { role: 'opening', visualType: 'typography', density: 'light' },
  { role: 'proof', visualType: 'scorecard', density: 'balanced' },
  { role: 'proof', visualType: 'annotated-chart', density: 'balanced' },
  { role: 'choice', visualType: 'allocation', density: 'balanced' },
  { role: 'execution', visualType: 'timeline', density: 'balanced' },
  { role: 'decision-close', visualType: 'allocation', density: 'light' },
];

function referenceCatalog(paths) {
  if (!Array.isArray(paths) || paths.length < 6) {
    throw new Error('freeform live benchmark requires six rendered reference slide images');
  }
  return paths.slice(0, 6).map((imagePath, index) => ({
    id: `reference-slide-${index + 1}`,
    imagePath,
    source: 'user-supplied rendered slide reference',
    slide: index + 1,
    semantic: {
      ...SEMANTICS[index],
      domain: 'executive-finance',
      tags: ['editorial', index % 2 ? 'evidence-field' : 'asymmetric'],
    },
    quality: 0.9,
    provenance: 'benchmark input; inspiration only',
  }));
}

function baselineCatalog(paths) {
  if (!Array.isArray(paths) || !paths.length) return undefined;
  if (paths.length !== SEMANTICS.length) {
    throw new Error(`The full-size baseline requires exactly ${SEMANTICS.length} slide images.`);
  }
  return {
    id: 'v9',
    slides: paths.map((imagePath, index) => ({
      slide: index + 1,
      imagePath,
    })),
  };
}

const REGION_GRAMMARS_FALLBACK = Object.freeze({
  'editorial-split': [
    [
      { id: 'eyebrow', role: 'eyebrow', x: 6, y: 8, w: 40, h: 5 },
      { id: 'title', role: 'title', x: 6, y: 18, w: 53, h: 27 },
      { id: 'support', role: 'subtitle', x: 6, y: 55, w: 43, h: 16 },
      { id: 'signal', role: 'visual', x: 70, y: 20, w: 21, h: 50, style: { fillRole: 'accent', colorRole: 'onAccent', align: 'center' } },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 10, w: 44, h: 24 },
      { id: 'support', role: 'subtitle', x: 6, y: 52, w: 35, h: 14 },
      { id: 'evidence', role: 'scorecard', x: 52, y: 18, w: 42, h: 64 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 8, w: 88, h: 17 },
      { id: 'evidence', role: 'annotated-chart', x: 6, y: 31, w: 65, h: 58 },
      { id: 'support', role: 'body', x: 77, y: 34, w: 17, h: 45 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 10, w: 44, h: 24 },
      { id: 'support', role: 'subtitle', x: 6, y: 55, w: 36, h: 12 },
      { id: 'evidence', role: 'allocation', x: 52, y: 19, w: 42, h: 63 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 8, w: 88, h: 18 },
      { id: 'evidence', role: 'timeline', x: 6, y: 35, w: 88, h: 47 },
      { id: 'source', role: 'source', x: 6, y: 89, w: 88, h: 3 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 15, w: 53, h: 27 },
      { id: 'support', role: 'subtitle', x: 6, y: 57, w: 47, h: 13 },
      { id: 'evidence', role: 'allocation', x: 64, y: 18, w: 30, h: 57, style: { compact: true } },
    ],
  ],
  'evidence-band': [
    [
      { id: 'signal', role: 'visual', x: 6, y: 17, w: 26, h: 55, style: { fillRole: 'accent', colorRole: 'onAccent', align: 'center' } },
      { id: 'eyebrow', role: 'eyebrow', x: 39, y: 12, w: 44, h: 5 },
      { id: 'title', role: 'title', x: 39, y: 23, w: 55, h: 24 },
      { id: 'support', role: 'subtitle', x: 39, y: 60, w: 49, h: 14 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 8, w: 88, h: 17 },
      { id: 'evidence', role: 'scorecard', x: 6, y: 34, w: 88, h: 46, style: { compact: true } },
      { id: 'support', role: 'subtitle', x: 59, y: 85, w: 35, h: 7 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 8, w: 88, h: 16 },
      { id: 'support', role: 'body', x: 6, y: 33, w: 22, h: 48 },
      { id: 'evidence', role: 'annotated-chart', x: 34, y: 30, w: 60, h: 59 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 8, w: 88, h: 17 },
      { id: 'evidence', role: 'allocation', x: 6, y: 33, w: 88, h: 46, style: { compact: true } },
      { id: 'support', role: 'subtitle', x: 6, y: 85, w: 59, h: 7 },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 11, w: 34, h: 23 },
      { id: 'source', role: 'source', x: 6, y: 84, w: 34, h: 4 },
      { id: 'evidence', role: 'timeline', x: 45, y: 18, w: 49, h: 65, style: { compact: true } },
    ],
    [
      { id: 'evidence', role: 'allocation', x: 6, y: 18, w: 34, h: 58, style: { compact: true } },
      { id: 'title', role: 'title', x: 47, y: 18, w: 47, h: 26 },
      { id: 'support', role: 'subtitle', x: 47, y: 59, w: 44, h: 14 },
    ],
  ],
  'evidence-first-field': [
    [
      { id: 'signal', role: 'visual', x: 6, y: 13, w: 88, h: 30, style: { fillRole: 'inverse', colorRole: 'onInverse', align: 'center' } },
      { id: 'eyebrow', role: 'eyebrow', x: 6, y: 50, w: 33, h: 5 },
      { id: 'title', role: 'title', x: 6, y: 59, w: 60, h: 25 },
      { id: 'support', role: 'subtitle', x: 70, y: 58, w: 24, h: 20 },
    ],
    [
      { id: 'evidence', role: 'scorecard', x: 6, y: 14, w: 51, h: 72 },
      { id: 'title', role: 'title', x: 64, y: 17, w: 30, h: 27 },
      { id: 'support', role: 'subtitle', x: 64, y: 61, w: 28, h: 15 },
    ],
    [
      { id: 'evidence', role: 'annotated-chart', x: 6, y: 13, w: 88, h: 62 },
      { id: 'title', role: 'title', x: 6, y: 81, w: 64, h: 11 },
      { id: 'support', role: 'body', x: 74, y: 80, w: 20, h: 12 },
    ],
    [
      { id: 'evidence', role: 'allocation', x: 6, y: 13, w: 44, h: 72 },
      { id: 'title', role: 'title', x: 52, y: 17, w: 42, h: 34, style: { fontSize: 32 } },
      { id: 'support', role: 'subtitle', x: 52, y: 66, w: 42, h: 13 },
    ],
    [
      { id: 'evidence', role: 'timeline', x: 6, y: 14, w: 88, h: 58 },
      { id: 'title', role: 'title', x: 6, y: 80, w: 72, h: 12, style: { fontSize: 34 } },
    ],
    [
      { id: 'title', role: 'title', x: 6, y: 10, w: 88, h: 20 },
      { id: 'evidence', role: 'allocation', x: 6, y: 38, w: 88, h: 50, style: { compact: true } },
    ],
  ],
});

function regionCandidateBoards() {
  const content = slideContent();
  return Object.entries(REGION_GRAMMARS_FALLBACK).map(([grammar, layouts]) => ({
    id: grammar,
    grammar,
    rationale: `${grammar} uses a complete-screen reading path rather than a coordinate variant of another board.`,
    domain: 'executive-finance',
    tags: [grammar, 'editorial'],
    slides: layouts.map((regions, index) => ({
      background: {
        role: [0, 3, 5].includes(index) ? 'inverse' : 'canvas',
      },
      grammar,
      semantic: {
        ...SEMANTICS[index],
        domain: 'executive-finance',
        tags: [grammar],
      },
      layout: {
        units: 'percent',
        safeMargin: 4,
        visualType: SEMANTICS[index].visualType,
        readingOrder: regions.map((region) => region.id),
        hierarchy: regions.map((region) => region.id),
        regions,
      },
      content: content[index],
    })),
  }));
}

function sceneContent(index) {
  const base = slideContent()[index];
  const payloads = [
    () => ({
      eyebrow: { text: base.eyebrow },
      title: { text: base.title },
      subtitle: { text: base.subtitle },
      hero: { text: base.visualText },
      'hero-label': { text: base.visualLabel },
      meta: { text: base.meta.join(' · ') },
      source: { text: `SOURCE · ${base.source}` },
    }),
    () => ({
      title: { text: base.title },
      subtitle: { text: base.subtitle },
      'metric-a-label': { text: base.metrics[0].label },
      'metric-a': { text: '5,660' },
      'metric-a-unit': { text: '백만원' },
      'metric-b-label': { text: base.metrics[1].label },
      'metric-b': { text: '802' },
      'metric-b-unit': { text: '백만원' },
      'metric-c-label': { text: base.metrics[2].label },
      'metric-c': { text: '14.2%' },
      'metric-c-unit': { text: '투자 gate 상회' },
      source: { text: `SOURCE · ${base.source}` },
    }),
    () => ({
      title: { text: base.title },
      chart: {
        chart: {
          ...base.chart,
          series: base.chart.series.map((series, seriesIndex) => ({
            ...series,
            ...(seriesIndex === 0 ? { pointColors: ['2BB3B5', '2BB3B5', '2D66D5'] } : {}),
          })),
        },
      },
      'note-kicker': { text: 'DECISION SIGNALS' },
      'note-a': { text: '7월 매출\n5,660백만원\n전월 대비 +6.8%' },
      'note-b': { text: '영업이익\n802백만원\n3개월 연속 개선' },
      'note-c': { text: '영업이익률\n14.2%\ngate 13.5% 상회' },
      source: { text: `SOURCE · ${base.source}` },
    }),
    () => ({
      title: { text: base.title },
      subtitle: { text: base.subtitle },
      'total-label': { text: base.allocationLabel },
      total: { text: base.visualText },
      'track-a-label': { text: base.allocations[0].label },
      'track-a-value': { text: base.allocations[0].displayValue },
      'track-a-detail': { text: base.allocations[0].detail },
      'track-b-label': { text: base.allocations[1].label },
      'track-b-value': { text: base.allocations[1].displayValue },
      'track-b-detail': { text: base.allocations[1].detail },
      source: { text: `SOURCE · ${base.source}` },
    }),
    () => ({
      title: { text: base.title },
      'timeline-kicker': { text: '30 DAYS · 4 CHECKPOINTS' },
      ...Object.fromEntries(base.steps.flatMap((step, stepIndex) => ([
        [`phase-${stepIndex + 1}`, { text: step.phase }],
        [`step-${stepIndex + 1}`, { text: step.title }],
        [`detail-${stepIndex + 1}`, { text: step.detail }],
      ]))),
      source: { text: `SOURCE · ${base.source}` },
    }),
    () => ({
      eyebrow: { text: 'DECISION REQUEST' },
      title: { text: base.title },
      subtitle: { text: base.subtitle },
      total: { text: base.visualText },
      'approval-label': { text: base.visualLabel },
      split: { text: `${base.allocations[0].label} ${base.allocations[0].displayValue}  ·  ${base.allocations[1].label} ${base.allocations[1].displayValue}` },
      'track-a-label': { text: base.allocations[0].label },
      'track-a-value': { text: base.allocations[0].displayValue },
      'track-b-label': { text: base.allocations[1].label },
      'track-b-value': { text: base.allocations[1].displayValue },
      source: { text: `SOURCE · ${base.source}` },
    }),
  ];
  return {
    ...base,
    elements: payloads[index](),
  };
}

function adjustedSceneElements(elements, grammar, slide, adjustments) {
  const entries = (Array.isArray(adjustments) ? adjustments : []).filter((entry) => (
    String(entry?.candidateId || '') === grammar
    && Number(entry?.slide) === slide
  ));
  if (!entries.length) return elements;
  const allowed = new Set(['x', 'y', 'w', 'h', 'style']);
  return elements.map((element) => {
    const entry = entries.find((candidate) => String(candidate?.elementId || '') === element.id);
    if (!entry) return element;
    const patch = Object.fromEntries(Object.entries(entry.patch || {}).filter(([key]) => allowed.has(key)));
    return {
      ...element,
      ...patch,
      style: {
        ...(element.style || {}),
        ...(patch.style || {}),
      },
    };
  });
}

export function candidateBoards(round = 1, adjustments = []) {
  return EXECUTIVE_SCENE_GRAMMARS.map((grammar) => ({
    id: grammar,
    grammar,
    rationale: `${grammar} authors a complete native scene rather than placing one semantic primitive inside a region.`,
    domain: 'executive-finance',
    tags: [grammar, 'editorial', 'native-scene'],
    slides: SEMANTICS.map((semantic, index) => {
      const elements = adjustedSceneElements(
        createExecutiveSceneElements(grammar, index, round),
        grammar,
        index + 1,
        adjustments,
      );
      return {
        background: { role: [1, 2, 4].includes(index) ? 'canvas' : 'inverse' },
        grammar,
        semantic: {
          ...semantic,
          domain: 'executive-finance',
          tags: [grammar, 'native-scene'],
        },
        scene: {
          units: 'percent',
          safeMargin: 4,
          readingOrder: elements.map((element) => element.id),
          hierarchy: elements.map((element) => element.id),
          elements,
        },
        content: sceneContent(index),
      };
    }),
  }));
}

function finalCritique() {
  return SEMANTICS.map((semantic, index) => ({
    slide: index + 1,
    verdict: 'pass',
    hierarchy: 4,
    balance: 4,
    legibility: 4,
    cohesion: 4,
    evidence: 4,
    note: `${index + 1}장 ${semantic.role} 화면은 최종 PowerPoint render에서 제목, dominant ${semantic.visualType}, 보조 근거의 순서가 분명하고 reference 대비 generic card 반복 없이 읽힙니다.`,
    fixes: [],
  }));
}

function cleanIsolation(value) {
  const isolation = value?.backgroundIsolation || value?.batch?.backgroundIsolation || null;
  if (!isolation) return false;
  return (isolation.observedVisibleWindows || []).length === 0
    && Number(isolation.visibleOwnedWindows || 0) === 0
    && Number(isolation.focusRestorations || 0) === 0;
}

export async function runPptxFreeformLiveBenchmark({
  output = '',
  references = [],
  baseline = [],
  selectedCandidate = 'editorial-native',
} = {}) {
  if (process.platform !== 'win32') throw new Error('PPTX free-form live benchmark requires Windows and Microsoft Office');
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const directory = resolve(output || join(tmpdir(), `mixdog-office-freeform-${timestamp}`));
  await mkdir(directory, { recursive: true });
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(directory, '.mixdog-data');
  const path = join(directory, 'freeform-executive-deck.pptx');
  const request = designRequest();
  let session = '';
  try {
    const created = await office({
      action: 'create',
      path,
      format: 'pptx',
      mode: 'background',
      overwrite: true,
      design: request,
    }, directory, 'create empty free-form presentation');
    session = created.value.session;
    const previewRound1 = await office({
      action: 'preview',
      session,
      maxWidth: 1200,
      design: {
        referenceCatalog: referenceCatalog(references),
        ...(baselineCatalog(baseline) ? { baseline: baselineCatalog(baseline) } : {}),
        candidateBoards: candidateBoards(1),
      },
    }, directory, 'preview authored-scene candidates round 1');
    assert.equal(previewRound1.value.snapshotVersion, 0);
    assert.equal(previewRound1.value.readOnly, true);
    assert.equal(previewRound1.value.previewRound, 1);
    assert.equal(previewRound1.value.comparisonImages.length, 18);
    const comparisonImagesRound1 = await persistImages(
      previewRound1.raw,
      previewRound1.value.comparisonImages,
      directory,
      'comparison-r1',
    );
    const round1Decision = await requestVisualDecision(
      directory,
      'round-1',
      previewRound1.value,
      comparisonImagesRound1,
    );
    const preview = await office({
      action: 'preview',
      session,
      maxWidth: 1200,
      design: {
        parentPreviewToken: previewRound1.value.previewToken,
        revisionDecision: round1Decision,
        referenceCatalog: referenceCatalog(references),
        ...(baselineCatalog(baseline) ? { baseline: baselineCatalog(baseline) } : {}),
        candidateBoards: candidateBoards(2, round1Decision.adjustments),
      },
    }, directory, 'preview authored-scene candidates round 2');
    assert.equal(preview.value.previewRound, 2);
    assert.equal(preview.value.comparisonImages.length, 18);
    const comparisonImagesRound2 = await persistImages(
      preview.raw,
      preview.value.comparisonImages,
      directory,
      'comparison-r2',
    );
    const finalDecision = await requestVisualDecision(
      directory,
      'final',
      preview.value,
      comparisonImagesRound2,
    );
    const compiled = await office({
      action: 'compile',
      session,
      design: {
        previewToken: preview.value.previewToken,
        ...finalDecision,
      },
      save: true,
    }, directory, 'compile selected free-form candidate');
    if (compiled.value.rejected === true) {
      const report = {
        version: 3,
        createdAt: new Date().toISOString(),
        directory,
        path,
        protocol: preview.value.protocol,
        rejected: true,
        rejection: compiled.value,
        authoredProject: preview.value.authoredProject,
        comparisonImagesRound1,
        comparisonImagesRound2,
        automatedPass: false,
      };
      await writeFile(join(directory, 'freeform-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await executeOfficeTool({ action: 'close', session }).catch(() => {});
      session = '';
      return report;
    }
    const reviewedCandidate = compiled.value.selectedCandidate;
    const semantic = compiled.value.batch.semanticOperations || [];
    assert.equal(semantic.length, 6);
    assert.equal(compiled.value.previewRound, 2);
    assert.ok(semantic.every((entry) => entry.renderMode === 'authored-scene'));
    assert.ok(semantic.every((entry) => entry.plan?.sourceContract === 'authored-scene-v1'));
    const editableDocument = await snapshotPortableOoxml(path, 'pptx');
    assert.equal(editableDocument.slides.length, 6);
    assert.ok(editableDocument.slides.every((slide) => slide.shapes.length >= 3));
    assert.ok(editableDocument.slides.some((slide) => slide.shapes.some((shape) => shape.chart)));
    const rendered = await office({
      action: 'render',
      session,
      output: join(directory, 'freeform-executive-deck-preview.pdf'),
      maxWidth: 1400,
    }, directory, 'render compiled free-form presentation');
    const qa = await office({
      action: 'qa',
      session,
      output: join(directory, 'freeform-executive-deck-qa.pdf'),
      auditProfile: 'model-backed-deck',
      task: '7월 경영회의 6장 발표',
      autoFix: true,
    }, directory, 'qa compiled free-form presentation');
    let currentRender = rendered;
    if (Number(qa.value.fixes?.length || 0) > 0) {
      currentRender = await office({
        action: 'render',
        session,
        output: join(directory, 'freeform-executive-deck-repaired.pdf'),
        maxWidth: 1400,
      }, directory, 'render repaired free-form presentation');
    }
    const finalImages = await persistImages(
      currentRender.raw,
      currentRender.value.images,
      directory,
      'final',
    );
    const validation = await office({
      action: 'validate',
      session,
      auditProfile: 'model-backed-deck',
    }, directory, 'validate compiled free-form presentation');
    const finalized = await office({
      action: 'finalize',
      session,
      failOn: 'error',
      design: {
        reviewed: true,
        reviewToken: currentRender.value.reviewToken,
        critique: finalCritique(),
      },
    }, directory, 'finalize compiled free-form presentation');
    session = '';
    const issueCodes = (qa.value.issuesAfter || []).map((issue) => issue.code);
    const report = {
      version: 3,
      createdAt: new Date().toISOString(),
      directory,
      path,
      protocol: preview.value.protocol,
      referenceCount: preview.value.referenceCatalog.entryCount,
      candidateCount: preview.value.boards.candidates.length,
      previewRounds: 2,
      authoredProject: preview.value.authoredProject,
      fullSizeRenderCount: preview.value.fullSizeRenders.length,
      baselineRenderCount: preview.value.baselineRenders.length,
      comparisonImageCount: comparisonImagesRound1.length + comparisonImagesRound2.length,
      comparisonImagesRound1,
      comparisonImagesRound2,
      selectedCandidate: reviewedCandidate,
      selectionCritique: compiled.value.selectionCritique,
      authoredScenePlanCount: semantic.filter((entry) => entry.plan?.sourceContract === 'authored-scene-v1').length,
      nativeSceneElementCounts: semantic.map((entry) => Number(entry.plan?.authoredScene?.nativeElementCount || 0)),
      editable: compiled.value.editable === true,
      editableShapeCounts: editableDocument.slides.map((slide) => slide.shapes.length),
      nativeChartCount: editableDocument.slides.reduce(
        (total, slide) => total + slide.shapes.filter((shape) => shape.chart).length,
        0,
      ),
      finalImages,
      qa: {
        ok: qa.value.ok,
        issueCodes,
        issues: qa.value.issuesAfter || [],
        fixesApplied: qa.value.fixes?.length || 0,
        aestheticScore: qa.value.review?.render?.aesthetics?.score ?? null,
        qualityScore: qa.value.review?.quality?.score ?? null,
      },
      validationOk: validation.value.ok,
      finalized: finalized.value.finalized === true,
      backgroundIsolation: compiled.value.batch.backgroundIsolation || created.value.backgroundIsolation || null,
      isolationClean: cleanIsolation(compiled.value.batch) || cleanIsolation(created.value),
    };
    report.automatedPass = report.referenceCount >= 6
      && report.candidateCount >= 3
      && report.previewRounds >= 2
      && report.fullSizeRenderCount === 18
      && report.baselineRenderCount === 6
      && report.comparisonImageCount === 36
      && report.authoredScenePlanCount === 6
      && report.nativeSceneElementCounts.every((count) => count >= 6)
      && report.editable
      && report.editableShapeCounts.every((count) => count >= 3)
      && report.nativeChartCount >= 1
      && report.qa.ok
      && Number(report.qa.aestheticScore) >= 0.78
      && Number(report.qa.qualityScore) >= 0.84
      && report.validationOk
      && report.finalized
      && report.isolationClean;
    await writeFile(join(directory, 'freeform-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    if (session) {
      await executeOfficeTool({ action: 'close', session }).catch(() => {});
    }
    resetOfficeSessionsForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
  }
}

function cliArguments(argv) {
  const outputIndex = argv.indexOf('--output');
  const selectedIndex = argv.indexOf('--selected');
  const references = [];
  const baseline = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--reference' && argv[index + 1]) references.push(resolve(argv[index + 1]));
    if (argv[index] === '--baseline' && argv[index + 1]) baseline.push(resolve(argv[index + 1]));
  }
  return {
    output: outputIndex >= 0 ? argv[outputIndex + 1] : '',
    selectedCandidate: selectedIndex >= 0 ? argv[selectedIndex + 1] : 'editorial-native',
    references,
    baseline,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPptxFreeformLiveBenchmark(cliArguments(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.automatedPass) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
