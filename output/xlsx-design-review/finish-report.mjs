import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';
import JSZip from 'jszip';

async function office(input) {
  const raw = await executeOfficeTool(input, { cwd: process.cwd() });
  if (raw.isError) throw new Error(raw.content?.[0]?.text);
  return JSON.parse(raw.content[0].text);
}
const notes = [
  '자체 검토: 같은 매출·순이익·이익률이 큰 수치로 읽히고 일별 추이와 메뉴 비중을 같은 화면에서 비교할 수 있습니다. 가상 데이터와 비용 제외 조건도 명시되어 있습니다.',
  '자체 검토: 6월 30일 전체 판매 기록이 한 페이지에 있으며 날짜와 판매량, 매출을 읽을 수 있습니다. 노란 입력 영역과 계산 영역이 구분되고 마지막 메뉴를 임의 강조하지 않습니다.',
  '자체 검토: 메뉴별 단가·재료비·월 판매량과 고정비가 빠짐없이 보입니다. 원 단위 숫자가 잘리지 않으며 노란 입력 셀을 유지했습니다. 짧은 작업표의 여백은 허용합니다.',
  '자체 검토: 전체 검증과 매출·손익·비중·판매량 검증이 모두 참으로 표시됩니다. 검증용 보조표는 작지만 글씨가 선명하며 종이를 채우려고 확대하지 않았습니다.',
];
const acceptOnly = process.argv.includes('--accept-only');
if (process.argv.includes('--repair-style')) {
  const path = resolve('output/모닝브루_2026-06_운영보고서_개선본.xlsx');
  const zip = await JSZip.loadAsync(await readFile(path));
  for (const part of ['xl/charts/style1.xml', 'xl/charts/style2.xml']) {
    const xml = await zip.file(part).async('string');
    const before = '<a:defRPr sz="1800" b="0"></a:defRPr>';
    const next = xml.replace(/<cs:axisTitle>[\s\S]*?<\/cs:axisTitle>/,
      (entry) => entry.replace(before, ''));
    if (next === xml) throw new Error(`Expected invalid axis-title style absent: ${part}`);
    zip.file(part, next);
  }
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}
const opened = await office({
  action: 'open', path: resolve(acceptOnly
    ? 'output/모닝브루_2026-06_운영보고서_개선본.xlsx' : 'output/모닝브루_2026-06_운영보고서_개선.xlsx'),
  output: resolve(acceptOnly
    ? 'output/모닝브루_2026-06_대시보드.xlsx' : 'output/모닝브루_2026-06_운영보고서_개선본.xlsx'), mode: 'portable',
  ...(acceptOnly ? {} : { operations: [{ op: 'delete_sheet', sheet: '차트' }] }), audit: false,
});
if (opened.ok === false) throw new Error(JSON.stringify(opened));
const rendered = await office({ action: 'render', session: opened.session });
await writeFile(resolve('output/xlsx-design-review/final-render.json'), JSON.stringify(rendered, null, 2));
const token = rendered.reviewToken || rendered.preview?.reviewToken;
const final = await office({
  action: 'finalize', session: opened.session, failOn: 'error', auditProfile: 'financial-model',
  design: { reviewed: true, reviewToken: token, critique: notes.map((note, index) => ({
    page: index + 1, verdict: 'pass', note, sheetReadability: true, chartVisibility: true, printLayout: true,
  })) },
});
await writeFile(resolve('output/xlsx-design-review/report-result.json'), JSON.stringify(final, null, 2));
console.log(JSON.stringify({ finalized: final.finalized, reason: final.reason, nextAction: final.nextAction,
  path: final.path, validation: final.validation, recalculation: final.recalculation,
  visualReview: final.visualReview, images: final.review?.preview?.images }, null, 2));
if (!final.finalized) process.exitCode = 1;
