import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { evaluatePowerPointCategorySpacing, extractPdfTextLayout } from './pdf-analysis.mjs';

function toolValue(result, label) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text || '';
  if (result?.isError) throw new Error(`${label}: ${text}`);
  return JSON.parse(text);
}

async function office(args, cwd, label = args.action) {
  const raw = await executeOfficeTool(args, { cwd });
  return { raw, value: toolValue(raw, label) };
}

async function persistRenderImages(raw, value, directory, prefix) {
  const imageParts = raw.content.filter((entry) => entry.type === 'image');
  const metadata = value?.preview?.images || value?.images || [];
  const files = [];
  for (let index = 0; index < imageParts.length; index += 1) {
    const pages = Array.isArray(metadata[index]?.pages) && metadata[index].pages.length
      ? `pages-${metadata[index].pages.join('-')}`
      : `page-${metadata[index]?.page || index + 1}`;
    const path = join(directory, `${prefix}-${pages}.png`);
    await writeFile(path, Buffer.from(imageParts[index].source.data, 'base64'));
    files.push(path);
  }
  return files;
}

async function reviewPersisted({
  path,
  format,
  directory,
  output,
  prefix,
  task,
  auditProfile = '',
  design: designRequest = {},
}) {
  const reviewPath = join(directory, `.mixdog-review-${prefix}.${format}`);
  const reopened = await office({
    action: 'open',
    path,
    output: reviewPath,
    mode: 'background',
    design: designRequest,
  }, directory, `reopen ${format} for review`);
  try {
    const qa = await office({
      action: 'qa',
      session: reopened.value.session,
      output,
      task,
      ...(auditProfile ? { auditProfile } : {}),
    }, directory, `review ${format}`);
    const images = await persistRenderImages(qa.raw, qa.value, directory, prefix);
    return { qa, images };
  } finally {
    await office({ action: 'close', session: reopened.value.session }, directory, `close ${format} review`);
    await rm(reviewPath, { force: true });
  }
}

function contentModel() {
  return {
    packageId: 'july-executive-review',
    audience: '7월 경영회의',
    objective: '실적을 검토하고 성장·고객 유지 투자를 결정',
    decision: '성장 가속 0.9억원과 고객 유지 0.9억원 승인',
    period: '2026-07',
    facts: [
      { id: 'revenue', label: '7월 매출', value: 5660, unit: '백만원', numberFormat: '#,##0', source: { document: '01-dashboard.xlsx', target: 'Source!B4' } },
      { id: 'operating-profit', label: '7월 영업이익', value: 802, unit: '백만원', numberFormat: '#,##0', source: { document: '01-dashboard.xlsx', target: 'Source!C4' } },
      { id: 'operating-margin', label: '영업이익률', value: 0.1417, unit: '%', numberFormat: '0.0%', source: { document: '01-dashboard.xlsx', target: 'Calculation!B4' } },
      { id: 'churn', label: '고객 이탈률', value: 0.026, unit: '%', numberFormat: '0.0%', source: { document: '01-dashboard.xlsx', target: 'Source!E4' } },
      { id: 'nps', label: 'NPS', value: 55, unit: '점', numberFormat: '0', source: { document: '01-dashboard.xlsx', target: 'Source!F4' } },
      { id: 'growth-investment', label: '성장 가속 투자', value: 90, unit: '백만원', numberFormat: '#,##0', source: { document: '01-dashboard.xlsx', target: 'Calculation!B7' } },
      { id: 'retention-investment', label: '고객 유지 투자', value: 90, unit: '백만원', numberFormat: '#,##0', source: { document: '01-dashboard.xlsx', target: 'Calculation!B8' } },
    ],
    claims: [
      {
        id: 'growth-case',
        text: '매출 5,660백만원과 영업이익 802백만원이 성장 투자의 여력을 만들었습니다',
        implication: '성장 가속 투자를 이번 달부터 집행할 수 있습니다',
        factIds: ['revenue', 'operating-profit', 'operating-margin'],
      },
      {
        id: 'retention-risk',
        text: '이탈률은 2.6%로 개선됐지만 고객 유지 투자는 계속 필요합니다',
        implication: 'NPS 55를 유지하면서 이탈률을 2.4% 아래로 낮춰야 합니다',
        factIds: ['churn', 'nps'],
      },
      {
        id: 'investment-decision',
        text: '성장 0.9억원과 고객 유지 0.9억원을 함께 승인해야 합니다',
        implication: '총 1.8억원을 두 트랙으로 즉시 배분합니다',
        factIds: ['growth-investment', 'retention-investment'],
      },
    ],
  };
}

function design(content, profile = 'executive', purpose = 'explain') {
  return {
    profile,
    purpose,
    expressionMode: 'strong-fit',
    audience: content.audience,
    intent: content.objective,
    tone: 'editorial executive financial decision',
    density: 'balanced',
    signature: 'decision ledger with measured evidence windows',
    content,
  };
}

function persistedReviewDesign(created, fallback) {
  const batch = created?.batch || {};
  const resolved = batch.design || created?.design || fallback;
  const semantic = batch.semanticOperations || created?.semanticOperations || [];
  const slidePlans = semantic
    .filter((entry) => entry?.plan && Number(entry?.slide) > 0)
    .map((entry) => ({
      ...entry.plan,
      slide: Number(entry.slide),
      kind: entry.kind,
      slideRole: entry.slideRole,
      backgroundRole: entry.backgroundRole,
    }));
  return slidePlans.length ? { ...resolved, slidePlans } : resolved;
}

async function createWorkbook(directory, content) {
  const path = join(directory, '01-dashboard.xlsx');
  const designRequest = design(content, 'executive', 'monitor');
  const operations = [
    { op: 'rename_sheet', sheet: 'Sheet1', name: 'Source' },
    {
      op: 'set_range',
      sheet: 'Source',
      range: 'A1:F4',
      values: [
        ['월', '매출(백만원)', '영업이익(백만원)', '활성고객', '이탈률', 'NPS'],
        ['5월', 5000, 650, 1040, 0.031, 49],
        ['6월', 5300, 735, 1060, 0.029, 52],
        ['7월', 5660, 802, 1082, 0.026, 55],
      ],
    },
    ...['B2', 'C2', 'D2', 'E2', 'F2', 'B3', 'C3', 'D3', 'E3', 'F3', 'B4', 'C4', 'D4', 'E4', 'F4']
      .map((cell) => ({ op: 'add_note', sheet: 'Source', cell, text: 'Source: 2026년 7월 benchmark brief input' })),
    { op: 'set_style', sheet: 'Source', range: 'A1:F1', properties: { bold: true, color: 'FFFFFF', fillColor: '183028', horizontalAlignment: 'center' } },
    { op: 'set_style', sheet: 'Source', range: 'E2:E4', properties: { numberFormat: '0.0%' } },
    { op: 'autofit_range', sheet: 'Source', range: 'A:F' },
    { op: 'add_sheet', name: 'Calculation' },
    {
      op: 'set_range',
      sheet: 'Calculation',
      range: 'A1:B9',
      values: [
        ['지표', '값'],
        ['7월 매출', null],
        ['7월 영업이익', null],
        ['영업이익률', null],
        ['고객 이탈률', null],
        ['NPS', null],
        ['성장 가속 투자', 90],
        ['고객 유지 투자', 90],
        ['총 투자', null],
      ],
    },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B2', formula: '=Source!B4' },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B3', formula: '=Source!C4' },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B4', formula: '=B3/B2' },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B5', formula: '=Source!E4' },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B6', formula: '=Source!F4' },
    { op: 'set_formula', sheet: 'Calculation', cell: 'B9', formula: '=SUM(B7:B8)' },
    { op: 'add_note', sheet: 'Calculation', cell: 'B7', text: 'Source: 경영회의 투자 scenario input' },
    { op: 'add_note', sheet: 'Calculation', cell: 'B8', text: 'Source: 경영회의 투자 scenario input' },
    { op: 'set_style', sheet: 'Calculation', range: 'A1:B1', properties: { bold: true, color: 'FFFFFF', fillColor: '183028' } },
    { op: 'set_style', sheet: 'Calculation', range: 'B4:B5', properties: { numberFormat: '0.0%' } },
    { op: 'autofit_range', sheet: 'Calculation', range: 'A:B' },
    { op: 'add_sheet', name: 'Checks' },
    {
      op: 'set_range',
      sheet: 'Checks',
      range: 'A1:C4',
      values: [
        ['검사', '상태', '차이'],
        ['매출 원장 일치', null, null],
        ['이익률 계산 일치', null, null],
        ['투자 합계 1.8억원', null, null],
      ],
    },
    { op: 'set_formula', sheet: 'Checks', cell: 'B2', formula: '=IF(Calculation!B2=Source!B4,"PASS","FAIL")' },
    { op: 'set_formula', sheet: 'Checks', cell: 'C2', formula: '=Calculation!B2-Source!B4' },
    { op: 'set_formula', sheet: 'Checks', cell: 'B3', formula: '=IF(ABS(Calculation!B4-Source!C4/Source!B4)<0.000001,"PASS","FAIL")' },
    { op: 'set_formula', sheet: 'Checks', cell: 'C3', formula: '=Calculation!B4-Source!C4/Source!B4' },
    { op: 'set_formula', sheet: 'Checks', cell: 'B4', formula: '=IF(Calculation!B9=180,"PASS","FAIL")' },
    { op: 'set_formula', sheet: 'Checks', cell: 'C4', formula: '=Calculation!B9-180' },
    { op: 'set_style', sheet: 'Checks', range: 'A1:C1', properties: { bold: true, color: 'FFFFFF', fillColor: '183028' } },
    { op: 'autofit_range', sheet: 'Checks', range: 'A:C' },
    { op: 'add_sheet', name: 'Dashboard' },
    {
      op: 'compose_sheet',
      sheet: 'Dashboard',
      kind: 'dashboard',
      title: '7월 경영회의 실적 대시보드',
      subtitle: '성장 여력은 확보했습니다. 다음 결정은 성장 0.9억원 + 고객 유지 0.9억원입니다.',
      claimId: 'investment-decision',
      source: { document: '01-dashboard.xlsx', target: 'Source!A1:F4' },
      headers: ['월', '매출', '영업이익', '영업이익률', '이탈률', 'NPS'],
      rows: [
        ['5월', 5000, 650, 0.13, 0.031, 49],
        ['6월', 5300, 735, 0.1387, 0.029, 52],
        ['7월', 5660, 802, 0.1417, 0.026, 55],
        ['합계', 15960, 2187, 0.137, '', ''],
      ],
      metrics: [
        { factId: 'revenue', formula: '=Calculation!B2' },
        { factId: 'operating-profit', formula: '=Calculation!B3' },
        { factId: 'operating-margin', formula: '=Calculation!B4' },
        { factId: 'churn', formula: '=Calculation!B5' },
      ],
      insights: [
        '매출과 영업이익률이 3개월 연속 개선',
        'NPS 55 유지',
        '총 1.8억원을 성장과 고객 유지에 균등 배분',
      ],
      decision: '성장 가속 0.9억원과 고객 유지 0.9억원을 함께 승인하고 월말에 성과를 재판정합니다.',
      gates: [
        { track: '성장 가속', release: '영업이익률 13.5% 이상', stop: '13.5% 미만' },
        { track: '고객 유지', release: '이탈률 2.4% 이하 경로', stop: 'NPS 52 미만' },
      ],
      columnFormats: {
        매출: '#,##0',
        영업이익: '#,##0',
        영업이익률: '0.0%',
        이탈률: '0.0%',
        NPS: '0',
      },
      chart: { type: 'column', title: '월별 매출 추이', range: 'A11:B14' },
    },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'B12', formula: '=Source!B2' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'C12', formula: '=Source!C2' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'D12', formula: '=C12/B12' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'E12', formula: '=Source!E2' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'F12', formula: '=Source!F2' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'B13', formula: '=Source!B3' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'C13', formula: '=Source!C3' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'D13', formula: '=C13/B13' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'E13', formula: '=Source!E3' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'F13', formula: '=Source!F3' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'B14', formula: '=Source!B4' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'C14', formula: '=Source!C4' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'D14', formula: '=C14/B14' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'E14', formula: '=Source!E4' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'F14', formula: '=Source!F4' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'B15', formula: '=SUM(B12:B14)' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'C15', formula: '=SUM(C12:C14)' },
    { op: 'set_formula', sheet: 'Dashboard', cell: 'D15', formula: '=C15/B15' },
    { op: 'set_sheet_visibility', sheet: 'Source', visibility: 'hidden' },
    { op: 'set_sheet_visibility', sheet: 'Calculation', visibility: 'hidden' },
    { op: 'set_sheet_visibility', sheet: 'Checks', visibility: 'hidden' },
  ];
  const created = await office({
    action: 'create',
    path,
    format: 'xlsx',
    mode: 'background',
    design: designRequest,
    operations,
  }, directory, 'create workbook');
  const validation = await office({
    action: 'validate',
    session: created.value.session,
    auditProfile: 'financial-model',
    assertions: [
      { kind: 'cell-value', sheet: 'Dashboard', cell: 'B14', equals: 5660 },
      { kind: 'cell-value', sheet: 'Dashboard', cell: 'C14', equals: 802 },
      { kind: 'cell-value', sheet: 'Calculation', cell: 'B9', equals: 180 },
      { kind: 'no-errors' },
    ],
  }, directory, 'validate workbook');
  const persistedDashboard = validation.value.native?.snapshot?.sheets
    ?.find((sheet) => sheet.name === 'Dashboard');
  assert.deepEqual(persistedDashboard?.freezePanes, {
    frozen: true,
    splitRow: 12,
    splitColumn: 1,
  });
  await office({ action: 'close', session: created.value.session }, directory, 'close workbook');
  const { qa, images } = await reviewPersisted({
    path,
    format: 'xlsx',
    directory,
    output: join(directory, '01-dashboard-preview.pdf'),
    prefix: '01-dashboard-preview',
    task: '7월 경영회의 실적 대시보드',
    auditProfile: 'financial-model',
    design: persistedReviewDesign(created.value, designRequest),
  });
  return { path, created: created.value, qa: qa.value, validation: validation.value, images };
}

async function createDocument(directory, content) {
  const path = join(directory, '02-decision-brief.docx');
  const designRequest = design(content, 'executive', 'decide');
  const created = await office({
    action: 'create',
    path,
    format: 'docx',
    mode: 'background',
    design: designRequest,
    operations: [{
      op: 'compose_document',
      title: '7월 경영회의 의사결정 브리프',
      subtitle: '성장 여력은 확보했습니다. 고객 유지와 함께 투자해야 합니다.',
      claimId: 'investment-decision',
      summary: '권고: 성장 가속 0.9억원과 고객 유지 0.9억원을 함께 승인합니다. 총 1.8억원을 30일 실행계획으로 관리합니다.',
      meta: ['2026년 7월', '경영회의용', '단위: 백만원'],
      sections: [
        {
          kind: 'decision',
          heading: '1. 결론과 요청사항',
          paragraphs: [
            '7월 매출은 5,660백만원, 영업이익은 802백만원으로 개선 흐름을 이어갔습니다. 영업이익률 14.2%는 성장 투자 여력을 뒷받침합니다.',
            '동시에 고객 이탈률 2.6%와 NPS 55를 고려하면 성장만 단독 집행하기보다 고객 유지 투자를 병행하는 편이 안전합니다.',
          ],
          bullets: [
            '승인 요청: 성장 가속 90백만원',
            '승인 요청: 고객 유지 90백만원',
            '운영 원칙: 월말에 성과 gate를 다시 판정',
          ],
        },
        {
          kind: 'metrics',
          heading: '2. 핵심 실적',
          table: [
            ['지표', '7월 실적', '판정'],
            ['매출', '5,660백만원', '성장 여력 확보'],
            ['영업이익', '802백만원', '수익성 개선'],
            ['영업이익률', '14.2%', '계획 상회'],
            ['고객 이탈률', '2.6%', '추가 개선 필요'],
            ['NPS', '55', '유지'],
          ],
        },
        {
          kind: 'decision-gates',
          heading: '3. 투자 release / stop gate',
          paragraphs: ['두 트랙 모두 승인하되, 다음 월말에 정량 기준으로 계속 집행 여부를 다시 결정합니다.'],
          table: [
            ['트랙', 'Release', 'Stop'],
            ['성장 가속 0.9억원', '매출 성장률 유지\n영업이익률 13.5% 이상', '영업이익률 13.5% 미만'],
            ['고객 유지 0.9억원', '이탈률 2.4% 이하 경로\nNPS 55 유지', '이탈률 반등\nNPS 52 미만'],
          ],
        },
        {
          kind: 'roadmap',
          heading: '4. 30일 실행계획',
          paragraphs: ['Owner 확정 → leading indicator 점검 → 집행 재배분 → gate 판정의 네 단계로 운영합니다.'],
          steps: [
            { label: '1주차', title: 'Owner·예산 확정', detail: '성장 채널과 유지 캠페인의 책임자와 예산을 확정' },
            { label: '2주차', title: 'Leading indicator', detail: 'cohort별 전환율·이탈률 조기 신호를 점검' },
            { label: '3주차', title: '집행 재배분', detail: '저효율 집행을 중단하고 고효율 채널로 이동' },
            { label: '4주차', title: 'Gate 재판정', detail: '월말 경영회의에 release / stop을 보고' },
          ],
          callout: '월말 경영회의에서 두 트랙의 release / stop을 정량 기준으로 다시 결정합니다.',
          calloutLabel: 'NEXT DECISION',
        },
      ],
      footer: 'Source: 01-dashboard.xlsx / Dashboard',
      pageNumbers: true,
    }],
  }, directory, 'create document');
  const validation = await office({ action: 'validate', session: created.value.session }, directory, 'validate document');
  await office({ action: 'close', session: created.value.session }, directory, 'close document');
  const { qa, images } = await reviewPersisted({
    path,
    format: 'docx',
    directory,
    output: join(directory, '02-decision-brief-preview.pdf'),
    prefix: '02-decision-brief-preview',
    task: '7월 경영회의 의사결정 브리프',
    design: persistedReviewDesign(created.value, designRequest),
  });
  return { path, created: created.value, qa: qa.value, validation: validation.value, images };
}

async function createPresentation(directory, content) {
  const path = join(directory, '03-executive-deck.pptx');
  const designRequest = {
    ...design(content, 'executive', 'decide'),
    deck: {
      backgroundMode: 'sandwich',
      templateMode: 'scratch',
      compositionMode: 'model',
      requireSlidePlan: true,
    },
  };
  const operations = [
    {
      op: 'compose_slide',
      kind: 'cover',
      title: '7월 실적은 성장 투자의 여력을 증명했습니다',
      subtitle: '이제 성장과 고객 유지에 각각 0.9억원을 배분할 결정이 필요합니다',
      eyebrow: 'JULY EXECUTIVE REVIEW',
      meta: ['2026년 7월', '경영회의'],
      source: '01-dashboard.xlsx#Dashboard',
      plan: {
        name: 'decision-cover-asymmetric',
        rationale: 'Open with an editorial investment thesis and one numeric signal without repeating the close.',
        visualType: 'editorial-opening',
        regions: [
          { id: 'eyebrow', role: 'eyebrow', x: 6, y: 9, w: 42, h: 5 },
          { id: 'message', role: 'title', x: 6, y: 23, w: 60, h: 28 },
          { id: 'support', role: 'subtitle', x: 6, y: 62, w: 56, h: 12 },
          { id: 'signal', role: 'visual', x: 74, y: 24, w: 18, h: 32, text: '1.8억', label: 'DECISION SIZE', style: { align: 'center', fillRole: 'accent', colorRole: 'onAccent' } },
          { id: 'context', role: 'meta', x: 72, y: 76, w: 22, h: 6, style: { align: 'right' } },
        ],
        readingOrder: ['eyebrow', 'message', 'signal', 'support', 'context'],
      },
    },
    {
      op: 'compose_slide',
      kind: 'statement',
      claimId: 'growth-case',
      title: '매출 5,660백만원이 성장 투자의 여력을 만들었습니다',
      subtitle: '영업이익 802백만원 · 영업이익률 14.2%',
      metrics: [
        { factId: 'revenue' },
        { factId: 'operating-profit' },
        { factId: 'operating-margin' },
      ],
      plan: {
        name: 'asymmetric-growth-scorecard',
        rationale: 'Use revenue as the dominant proof and profit plus margin as supporting evidence.',
        visualType: 'scorecard',
        regions: [
          { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 17 },
          { id: 'support', role: 'subtitle', x: 6, y: 25.2, w: 64, h: 8 },
          { id: 'evidence', role: 'scorecard', x: 6, y: 36, w: 88, h: 51 },
        ],
        readingOrder: ['message', 'evidence', 'support'],
      },
    },
    {
      op: 'compose_slide',
      kind: 'chart',
      claimId: 'growth-case',
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
      plan: {
        name: 'native-chart-with-decision-rail',
        rationale: 'Use a native trend chart with direct labels and a decision-relevant annotation rail.',
        visualType: 'annotated-chart',
        regions: [
          { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 16 },
          { id: 'evidence', role: 'annotated-chart', x: 6, y: 27, w: 88, h: 62 },
        ],
        readingOrder: ['message', 'evidence'],
      },
    },
    {
      op: 'compose_slide',
      kind: 'table',
      claimId: 'retention-risk',
      title: '성장과 고객 유지 중 하나를 포기할 이유가 없습니다',
      subtitle: '두 트랙은 서로 다른 위험을 줄입니다',
      allocations: [
        { label: '성장 가속', value: 90, displayValue: '0.9억', numberFormat: '#,##0', detail: 'Release ≥ 영업이익률 13.5% · Stop < 13.5%' },
        { label: '고객 유지', value: 90, displayValue: '0.9억', numberFormat: '#,##0', detail: 'Release ≤ 이탈률 2.4% 경로 · Stop < NPS 52' },
      ],
      visualText: '1.8억',
      allocationLabel: 'TWO-TRACK INVESTMENT',
      plan: {
        name: 'two-track-allocation-field',
        rationale: 'Make the equal allocation and asymmetric release/stop logic visible without a raw table.',
        visualType: 'allocation',
        regions: [
          { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 16 },
          { id: 'support', role: 'subtitle', x: 6, y: 23, w: 70, h: 8 },
          { id: 'evidence', role: 'allocation', x: 6, y: 34, w: 88, h: 55 },
        ],
        readingOrder: ['message', 'support', 'evidence'],
      },
    },
    {
      op: 'compose_slide',
      kind: 'process',
      title: '30일 안에 두 트랙의 성과를 다시 판정합니다',
      steps: [
        { phase: 'D1', title: 'Owner 확정', detail: '채널·cohort별 책임 지정' },
        { phase: 'D7', title: 'Leading 지표', detail: '전환·이탈 조기 점검' },
        { phase: 'D14', title: '재배분', detail: '저효율 집행 중단' },
        { phase: 'D30', title: 'Gate 판정', detail: '월말 release / stop' },
      ],
      source: '02-decision-brief.docx#4. 30일 실행계획',
      plan: {
        name: 'thirty-day-operating-timeline',
        rationale: 'Turn the four actions into one continuous operating timeline with explicit checkpoints.',
        visualType: 'timeline',
        regions: [
          { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 16 },
          { id: 'evidence', role: 'timeline', x: 6, y: 28, w: 88, h: 59 },
        ],
        readingOrder: ['message', 'evidence'],
      },
    },
    {
      op: 'compose_slide',
      kind: 'closing',
      claimId: 'investment-decision',
      title: '오늘 두 트랙에 총 1.8억원 투자를 승인해 주십시오',
      subtitle: '성장 0.9억원 · 고객 유지 0.9억원 · 월말 gate 재판정',
      visualText: '1.8억',
      visualLabel: '승인 요청',
      allocations: [
        { label: '성장', value: 90, displayValue: '0.9억', numberFormat: '#,##0' },
        { label: '고객 유지', value: 90, displayValue: '0.9억', numberFormat: '#,##0' },
      ],
      plan: {
        name: 'decision-close-allocation-stamp',
        rationale: 'Close with a distinct approval stamp that preserves the two-track allocation.',
        visualType: 'allocation',
        regions: [
          { id: 'message', role: 'title', x: 7, y: 15, w: 55, h: 30 },
          { id: 'support', role: 'subtitle', x: 7, y: 56, w: 54, h: 13 },
          { id: 'decision', role: 'allocation', x: 66, y: 16, w: 27, h: 57, style: { compact: true } },
        ],
        readingOrder: ['message', 'decision', 'support'],
      },
    },
  ];
  const created = await office({
    action: 'create',
    path,
    format: 'pptx',
    mode: 'background',
    design: designRequest,
    operations,
  }, directory, 'create presentation');
  const validation = await office({
    action: 'validate',
    session: created.value.session,
    auditProfile: 'model-backed-deck',
  }, directory, 'validate presentation');
  await office({ action: 'close', session: created.value.session }, directory, 'close presentation');
  const { qa, images } = await reviewPersisted({
    path,
    format: 'pptx',
    directory,
    output: join(directory, '03-executive-deck-preview.pdf'),
    prefix: '03-executive-deck-preview',
    task: '7월 경영회의 6장 발표',
    auditProfile: 'model-backed-deck',
    design: persistedReviewDesign(created.value, designRequest),
  });
  const categorySpacing = evaluatePowerPointCategorySpacing(
    await extractPdfTextLayout(qa.value.preview.output, { pages: [3] }),
    ['5월', '6월', '7월'],
  );
  assert.equal(categorySpacing.ok, true, JSON.stringify(categorySpacing));
  return {
    path,
    created: created.value,
    qa: qa.value,
    validation: validation.value,
    images,
    categorySpacing,
  };
}

function compactResult(entry) {
  const issues = entry.qa.issuesAfter || [];
  const postSaveBlocking = Array.isArray(entry.validation.postSaveGate?.blocking)
    ? entry.validation.postSaveGate.blocking
    : [];
  const criticalIssues = [
    ...issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    ...postSaveBlocking.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
  ];
  return {
    path: entry.path,
    images: entry.images,
    pageCount: entry.qa.preview?.pageCount || 0,
    qaOk: entry.qa.ok,
    aestheticOk: entry.qa.review?.render?.aesthetics?.ok !== false,
    aestheticScore: entry.qa.review?.render?.aesthetics?.score ?? null,
    aestheticDimensions: entry.qa.review?.render?.aesthetics?.dimensions ?? null,
    aestheticRhythm: entry.qa.review?.render?.aesthetics?.rhythm ?? null,
    qualityScore: entry.qa.review?.quality?.score ?? null,
    qualityDimensions: entry.qa.review?.quality?.dimensions ?? null,
    qualityConfidence: entry.qa.review?.quality?.confidence ?? null,
    validationOk: entry.validation.ok,
    issueCodes: issues.map((issue) => issue.code),
    criticalIssues: [...new Set(criticalIssues)],
    contentFingerprint: entry.created.batch?.content?.fingerprint
      || entry.created.batch?.design?.content?.fingerprint
      || entry.created.design?.content?.fingerprint
      || '',
    backgroundIsolation: entry.created.batch?.backgroundIsolation
      || entry.created.backgroundIsolation
      || null,
    postSaveGate: entry.validation.postSaveGate,
    ...(entry.categorySpacing ? { categorySpacing: entry.categorySpacing } : {}),
  };
}

export async function runOfficeQualityLiveBenchmark({ output = '' } = {}) {
  if (process.platform !== 'win32') throw new Error('Office quality live benchmark requires Windows and Microsoft Office');
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const directory = resolve(output || join(tmpdir(), `mixdog-office-quality-${timestamp}`));
  await mkdir(directory, { recursive: true });
  const content = contentModel();
  const results = {};
  try {
    results.xlsx = compactResult(await createWorkbook(directory, content));
    results.docx = compactResult(await createDocument(directory, content));
    results.pptx = compactResult(await createPresentation(directory, content));
  } finally {
    resetOfficeSessionsForTest();
  }
  const fingerprints = Object.values(results).map((entry) => entry.contentFingerprint).filter(Boolean);
  const crossAppConsistent = fingerprints.length === 3 && new Set(fingerprints).size === 1;
  const criticalCount = Object.values(results).reduce((total, entry) => total + entry.criticalIssues.length, 0);
  const pptxQualityTarget = {
    aestheticMinimum: 0.78,
    qualityMinimum: 0.84,
    met: Number(results.pptx?.aestheticScore) >= 0.78
      && Number(results.pptx?.qualityScore) >= 0.84,
  };
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    directory,
    request: '7월 경영회의용 Excel 대시보드, Word 의사결정 브리프, PowerPoint 6장을 같은 데이터에서 생성',
    content: {
      packageId: content.packageId,
      decision: content.decision,
      facts: Object.fromEntries(content.facts.map((fact) => [fact.id, fact.value])),
    },
    crossAppConsistent,
    criticalCount,
    qualityTargets: {
      pptx: pptxQualityTarget,
    },
    automatedPass: crossAppConsistent
      && criticalCount === 0
      && pptxQualityTarget.met
      && Object.values(results).every((entry) => (
        entry.qaOk
        && entry.aestheticOk
        && entry.validationOk
        && entry.categorySpacing?.ok !== false
      )),
    results,
    nextAction: 'Inspect every PNG, score content/design/layout/form/request fidelity, then apply one targeted polish batch per failing file.',
  };
  await writeFile(join(directory, 'quality-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : '';
  const report = await runOfficeQualityLiveBenchmark({ output });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.automatedPass) process.exit(1);
}
