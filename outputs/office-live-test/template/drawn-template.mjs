// A deck that was drawn (no placeholders) used as a template: snapshot its induced roles, then build a new
// three-page deck from it with use_template_page and render the result.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => JSON.parse(result.content[0].text);
const call = async (args) => value(await executeOfficeTool(args, { cwd }));
const template = 'outputs/office-live-test/pptx/moapay-ir.pptx';

const opened = await call({ action: 'open', path: template, mode: 'portable' });
const snap = await call({ action: 'snapshot', session: opened.session });
for (const slide of snap.document?.slides || snap.slides || []) {
  console.log(`slide ${slide.index ?? slide.slide} role=${slide.role} slots=${(slide.shapes || []).map((s) => s.slot).filter(Boolean).join(',')}`);
}
await call({ action: 'close', session: opened.session });

const out = 'outputs/office-live-test/template/from-drawn.pptx';
await copyFile(template, out);
const session = (await call({ action: 'open', path: out, mode: 'portable' })).session;
const built = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'use_template_page', path: template, after: 9, role: 'metrics', title: '3분기 가입자 2,000만 명 돌파', eyebrow: 'Q3 SUMMARY', body: '해외 송금 출시 한 달 만에 월 거래자가 2,000만 명을 넘었다.', source: '출처: 모아페이 3분기 집계 (예시 수치)', items: [{ value: '2,010', label: '월 거래자 (만 명)' }, { value: '41.5', label: '분기 거래액 (조 원)' }, { value: '4,610', label: '분기 매출 (억 원)' }] },
    { op: 'use_template_page', path: template, after: 10, role: 'cover', title: '다음 분기, 해외 송금을 연다', subtitle: '모아페이 · 2026년 12월' },
    { op: 'keep_slides', slides: [10, 11] },
  ],
  requireChanges: false,
});
console.log(JSON.stringify(built.results?.map((r) => ({ op: r.op, slide: r.slide, role: r.role, source: r.sourceSlide, filled: r.filled, emptied: r.emptied, error: r.error })) ?? built, null, 0).slice(0, 2500));
const rendered = await call({ action: 'render', session });
console.log(`rendered ${rendered.pageCount} pages`, (rendered.images || []).map((i) => i.path).join(' '));
const qa = await call({ action: 'qa', session, render: false });
console.log('qa', JSON.stringify((qa.issues || qa.audit?.top || []).slice(0, 8)).slice(0, 1500));
await call({ action: 'close', session });
