// A native table added to an authored deck with only the deck's font named — what the default treatment looks like.
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
const work = `outputs/office-live-test/pptx/moapay-table-${mode}.pptx`;
await copyFile('outputs/office-live-test/pptx/moapay-ir.pptx', work);
const { session, error } = await call({ action: 'open', path: work, mode });
if (error) throw new Error(error);
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'add_slide', index: 9 },
    { op: 'add_textbox', slide: 9, text: '분기별 핵심 지표', left: 43, top: 63, width: 873, height: 42, properties: { fontName: 'Noto Sans KR', fontSize: 27, bold: true, color: '171F2B' } },
    {
      op: 'add_table',
      slide: 9,
      left: 43,
      top: 130,
      width: 873,
      values: [
        ['지표', '25.3Q', '25.4Q', '26.1Q', '26.2Q'],
        ['월 거래자 (만 명)', '1,180', '1,260', '1,340', '1,420'],
        ['거래액 (조 원)', '8.4', '9.1', '9.6', '10.2'],
        ['영업이익 (억 원)', '−96', '−41', '−12', '86'],
      ],
      properties: { fontName: 'Noto Sans KR', fontSize: 14 },
    },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => r.op)));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).filter((i) => /slide\[9]/.test(i.path || '')).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 1500));
const rendered = await call({ action: 'render', session, pages: [9] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session });
