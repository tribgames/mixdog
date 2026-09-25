// Adding a page to an authored deck with native operations only (no script), the way an agent edits a client's deck:
// a slide, a title and kicker matched to the deck, a native chart, a source line. Then audit and render the page.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => {
  const text = (await executeOfficeTool(args, { cwd })).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};
const mode = process.argv[2] || 'portable';
const work = `outputs/office-live-test/pptx/moapay-native-${mode}.pptx`;
await copyFile('outputs/office-live-test/pptx/moapay-ir.pptx', work);
const { session, error } = await call({ action: 'open', path: work, mode });
if (error) throw new Error(error);
const snap = await call({ action: 'snapshot', session, pages: [3] });
const page3 = snap.document.slides[0];
for (const s of page3.shapes) console.log(' ', s.index, s.slot || '', s.type, JSON.stringify(String(s.text || '').slice(0, 24)), Math.round(s.left), Math.round(s.top), Math.round(s.width), Math.round(s.height), s.font?.name, s.font?.size, s.font?.color);
const title = page3.shapes.find((s) => s.slot === 'title');
const kicker = page3.shapes.find((s) => String(s.text) === '성장');
const source = page3.shapes.find((s) => /^단위|^출처/.test(String(s.text)));
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'add_slide', index: 9 },
    { op: 'add_textbox', slide: 9, text: '지역', left: kicker.left, top: kicker.top, width: kicker.width, height: kicker.height, properties: { fontName: kicker.font?.name, fontSize: kicker.font?.size, bold: true, color: kicker.font?.color } },
    { op: 'add_textbox', slide: 9, text: '수도권 밖 사용자가 처음으로 절반을 넘었다', left: title.left, top: title.top, width: title.width, height: title.height, properties: { fontName: title.font?.name, fontSize: title.font?.size, bold: true, color: title.font?.color, verticalAlignment: 'bottom' } },
    { op: 'add_chart', slide: 9, chartType: 'bar', categories: ['서울', '경기', '부산', '대구', '광주', '기타'], series: [{ name: '사용자 비중(%)', values: [28, 21, 12, 9, 7, 23] }], left: title.left, top: title.top + title.height + 24, width: 560, height: 300, showValues: true, valueNumberFormat: '0"%"' },
    { op: 'add_textbox', slide: 9, text: '출처: 모아페이 내부 집계, 2026년 6월 (예시 수치)', left: source.left, top: source.top, width: source.width, height: source.height, properties: { fontName: source.font?.name, fontSize: source.font?.size, color: source.font?.color } },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => ({ op: r.op, changed: r.changed }))));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).filter((i) => /slide\[9]/.test(i.path || '')).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 2000));
const rendered = await call({ action: 'render', session, pages: [9] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session });
