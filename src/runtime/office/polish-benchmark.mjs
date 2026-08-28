import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';

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

function resultValue(result) {
  const text = result?.content?.[0]?.text || '';
  if (result?.isError) throw new Error(text);
  return JSON.parse(text);
}

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
  assertCreated,
  assertFinalized,
}) {
  const path = join(root, `optimized-${name}.${format}`);
  const finalized = resultValue(await executeOfficeTool({
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
  assert.equal(finalized.batch.changeSummary.noChange, 0);
  assert.equal(finalized.batch.changeSummary.changed, operations.length);
  assertCreated(finalized);
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.validation.ok, true);
  assert.equal(finalized.validation.native.documentSaved, true);
  assert.equal(finalized.closed, true);
  if (assertFinalized) assertFinalized(finalized);
  return {
    name,
    format,
    calls: 1,
    retries: 0,
    accurate: true,
    durationMs: duration(finalized),
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
        { op: 'set_slide_background', slide: 1, color: 'F4F7FB' },
        { op: 'add_textbox', slide: 1, text: 'Office Use 성능 개선', properties: { left: 54, top: 120, width: 620, height: 80, fontName: '맑은 고딕', fontSize: 32, bold: true, color: '17365D' } },
        { op: 'add_textbox', slide: 1, text: '속도 · 적은 호출 · 정확한 결과', properties: { left: 58, top: 220, width: 560, height: 44, fontName: '맑은 고딕', fontSize: 18, color: '4F6478' } },
        { op: 'add_shape', slide: 1, shapeType: 'rectangle', properties: { left: 58, top: 285, width: 120, height: 6, fillColor: '2F75B5', lineColor: '2F75B5' } },
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 2, color: 'FFFFFF' },
        { op: 'add_textbox', slide: 2, text: '개선 목표', properties: { left: 48, top: 32, width: 620, height: 52, fontName: '맑은 고딕', fontSize: 26, bold: true, color: '17365D' } },
        { op: 'add_shape', slide: 2, shapeType: 'rounded_rectangle', paragraphs: [{ text: '처리 시간', fontName: '맑은 고딕', fontSize: 15, color: '17365D' }, { text: '−30%', fontName: '맑은 고딕', fontSize: 28, bold: true, color: '17365D' }], properties: { left: 48, top: 130, width: 190, height: 150, fillColor: 'D9EAF7', lineColor: '9DC3E6' } },
        { op: 'add_shape', slide: 2, shapeType: 'rounded_rectangle', paragraphs: [{ text: 'Office 호출', fontName: '맑은 고딕', fontSize: 15, color: '17365D' }, { text: '−40%', fontName: '맑은 고딕', fontSize: 28, bold: true, color: '17365D' }], properties: { left: 265, top: 130, width: 190, height: 150, fillColor: 'E2F0D9', lineColor: 'A9D18E' } },
        { op: 'add_shape', slide: 2, shapeType: 'rounded_rectangle', paragraphs: [{ text: 'silent no-op', fontName: '맑은 고딕', fontSize: 15, color: '7F6000' }, { text: '0건', fontName: '맑은 고딕', fontSize: 28, bold: true, color: '7F6000' }], properties: { left: 482, top: 130, width: 190, height: 150, fillColor: 'FFF2CC', lineColor: 'FFD966' } },
        { op: 'set_notes', slide: 2, text: 'Source: Office Use polishing benchmark' },
      ],
      pages: [1, 2],
      auditProfile: 'model-backed-deck',
      assertCreated(created) {
        assert.equal(created.batch.changeSummary.changed, 12);
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
