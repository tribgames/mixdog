import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeOfficeTool, resetOfficeSessionsForTest } from '../index.mjs';
import { resultValue } from './bench-support.mjs';

const BASELINE = Object.freeze({
  capturedAt: '2026-08-28',
  modelFacingCalls: 22,
  durationMsLowerBound: 22_516.8,
  scenarios: {
    docx: { calls: 9, retries: 2, durationMsLowerBound: 7_634.23, accurate: false },
    xlsx: { calls: 6, retries: 1, durationMsLowerBound: 7_514.49, accurate: false },
    pptx: { calls: 7, retries: 0, durationMsLowerBound: 7_368.08, accurate: true },
  },
});

function duration(value) {
  return Number(value?.metrics?.durationMs || 0);
}

async function removeBenchmarkRoot(root) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function runScenario({
  root,
  name,
  format,
  operations,
  pages,
  auditProfile,
  visualCritique,
  assertCreated,
  assertFinalized,
}) {
  const path = join(root, `optimized-${name}.${format}`);
  const initial = resultValue(await executeOfficeTool({
    action: 'create',
    path,
    format,
    mode: 'background',
    overwrite: true,
    operations,
    finalize: true,
    failOn: 'warning',
    autoFix: true,
    ...(pages ? { pages } : {}),
    ...(auditProfile ? { auditProfile } : {}),
    maxWidth: 900,
  }, { cwd: root }));
  assert.equal(initial.batch.changeSummary.noChange, 0);
  assert.equal(initial.batch.changeSummary.changed, operations.length);
  assertCreated(initial);
  let finalized = initial;
  let calls = 1;
  if (Array.isArray(visualCritique) && visualCritique.length) {
    assert.equal(initial.reason, 'visual_review_required', JSON.stringify(initial));
    assert.ok(initial.reviewToken);
    finalized = resultValue(await executeOfficeTool({
      action: 'finalize',
      session: initial.session,
      failOn: 'warning',
      autoFix: true,
      ...(pages ? { pages } : {}),
      ...(auditProfile ? { auditProfile } : {}),
      maxWidth: 900,
      design: {
        reviewed: true,
        reviewToken: initial.reviewToken,
        critique: visualCritique,
      },
    }, { cwd: root }));
    calls += 1;
  }
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.validation.ok, true);
  assert.equal(finalized.validation.native.documentSaved, true);
  assert.equal(finalized.closed, true);
  if (assertFinalized) assertFinalized(finalized);
  return {
    name,
    format,
    calls,
    retries: 0,
    accurate: true,
    durationMs: duration(initial) + (calls > 1 ? duration(finalized) : 0),
    completionDurationMs: duration(finalized),
    issueCount: finalized.review?.issuesAfter?.length || 0,
    finalizeSteps: finalized.stepMetrics,
    path,
  };
}

export async function runOfficePolishBenchmark({ keep = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-office-polish-'));
  try {
    const results = [];
    results.push(await runScenario({
      root,
      name: 'report',
      format: 'docx',
      operations: [
        { op: 'append_text', text: 'Office Use 운영 효율 보고서', style: 'Title' },
        { op: 'append_text', text: '요약', style: 'Heading 1' },
        { op: 'append_text', text: '처리 속도와 모델-facing Office 호출 수를 줄이면서 실제 산출물 정확도를 유지합니다.' },
        { op: 'append_text', text: '검증 원칙', style: 'Heading 1' },
        { op: 'append_text', text: '실제 Microsoft Office 재열기, 구조 검사, 시각 QA와 no-op 검사를 모두 통과해야 합니다.' },
        { op: 'set_header_footer', section: 1, kind: 'primary', header: true, text: 'Mixdog · Office Use' },
        { op: 'add_page_numbers', section: 1, includeTotal: true },
      ],
      pages: [1],
      assertCreated(created) {
        assert.equal(created.batch.changeSummary.changed, 7);
      },
    }));
    results.push(await runScenario({
      root,
      name: 'analysis',
      format: 'xlsx',
      operations: [
        { op: 'set_range', sheet: 'Sheet1', range: 'A1:D5', values: [['분기', '매출', '비용', '영업이익'], ['1분기', 120000, 85000, 35000], ['2분기', 145000, 93000, 52000], ['3분기', 138000, 91000, 47000], ['4분기', 162000, 104000, 58000]] },
        { op: 'set_style', sheet: 'Sheet1', range: 'A1:D1', properties: { bold: true, color: 'FFFFFF', fillColor: '1F4E78' } },
        { op: 'set_style', sheet: 'Sheet1', range: 'B2:D5', properties: { numberFormat: '#,##0' } },
        { op: 'add_table', sheet: 'Sheet1', range: 'A1:D5', name: 'QuarterlyPerformance', style: 'TableStyleMedium2' },
        { op: 'add_chart', sheet: 'Sheet1', range: 'A1:D5', chartType: 'column', title: '분기별 실적', left: 360, top: 20, width: 420, height: 260 },
        { op: 'freeze_panes', sheet: 'Sheet1', row: 2, column: 1 },
        { op: 'autofit_range', sheet: 'Sheet1', range: 'A:D' },
        { op: 'set_page_setup', sheet: 'Sheet1', printArea: 'A1:Q20', orientation: 'landscape', fitToPagesWide: 1, fitToPagesTall: 1, centerHorizontally: true, centerVertically: true },
      ],
      assertCreated(created) {
        const chart = created.batch.results.find((entry) => entry.op === 'add_chart');
        assert.equal(chart.series, 3);
        assert.equal(chart.categories, 4);
      },
      assertFinalized(finalized) {
        assert.equal(finalized.review.preview.pageCount, 1);
        assert.equal(finalized.review.preview.visualCoverage.complete, true);
      },
    }));
    results.push(await runScenario({
      root,
      name: 'deck',
      format: 'pptx',
      operations: [
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 1, color: '151515' },
        { op: 'add_textbox', slide: 1, text: 'Office Use 성능 개선', properties: { left: 54, top: 120, width: 620, height: 80, fontName: '맑은 고딕', fontSize: 32, bold: true, color: 'FFFFFF' } },
        { op: 'add_textbox', slide: 1, text: '속도 · 적은 호출 · 정확한 결과', properties: { left: 58, top: 220, width: 560, height: 44, fontName: '맑은 고딕', fontSize: 18, color: 'E7E9EC' } },
        { op: 'add_shape', slide: 1, shapeType: 'rectangle', properties: { left: 58, top: 285, width: 120, height: 6, fillColor: 'C43E2F', lineColor: 'C43E2F' } },
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 2, color: 'FFFFFF' },
        { op: 'add_textbox', slide: 2, text: '개선 후 남는 작업량', properties: { left: 48, top: 32, width: 620, height: 52, fontName: '맑은 고딕', fontSize: 26, bold: true, color: '171717' } },
        { op: 'add_chart', slide: 2, chartType: 'bar', title: '기준선 대비 잔여 지수', categories: ['처리 시간', 'Office 호출', 'silent no-op'], series: [{ name: '잔여 지수', values: [70, 60, 0] }], left: 72, top: 112, width: 570, height: 250 },
        { op: 'set_notes', slide: 2, text: 'Source: Office Use polishing benchmark' },
      ],
      pages: [1, 2],
      auditProfile: 'model-backed-deck',
      visualCritique: [
        {
          slide: 1,
          verdict: 'pass',
          hierarchy: 5,
          balance: 4,
          legibility: 5,
          cohesion: 5,
          evidence: 4,
          note: '표지의 제목과 부제가 명확한 우선순위를 이루며 어두운 배경과 강조선이 전체 덱의 편집 방향을 일관되게 제시합니다.',
          fixes: [],
        },
        {
          slide: 2,
          verdict: 'pass',
          hierarchy: 4,
          balance: 4,
          legibility: 4,
          cohesion: 5,
          evidence: 5,
          note: '잔여 작업량 chart가 세 개선 지표를 직접 비교하며 제목, plot, source notes가 한 장 안에서 근거 흐름을 완성합니다.',
          fixes: [],
        },
      ],
      assertCreated(created) {
        assert.equal(created.batch.changeSummary.changed, 10);
        const chart = created.batch.results.find((entry) => entry.op === 'add_chart');
        assert.equal(chart.categories, 3);
        assert.equal(chart.series, 1);
      },
    }));

    const modelFacingCalls = results.reduce((sum, entry) => sum + entry.calls, 0);
    const durationMs = Number(results.reduce((sum, entry) => sum + entry.durationMs, 0).toFixed(2));
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      baseline: BASELINE,
      optimized: {
        modelFacingCalls,
        durationMs,
        accurate: results.every((entry) => entry.accurate),
        retries: results.reduce((sum, entry) => sum + entry.retries, 0),
        results,
      },
      improvement: {
        callReductionPercent: Number(((1 - (modelFacingCalls / BASELINE.modelFacingCalls)) * 100).toFixed(2)),
        durationReductionPercent: Number(((1 - (durationMs / BASELINE.durationMsLowerBound)) * 100).toFixed(2)),
      },
    };
  } finally {
    resetOfficeSessionsForTest();
    if (!keep) await removeBenchmarkRoot(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runOfficePolishBenchmark({ keep: process.argv.includes('--keep') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
