// A token template (contract letter) filled with fill_template strict, then rendered.
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};
const F = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const body = (text, extra = {}) => ({ op: 'append_text', text, properties: { ...F, size: 10.5, lineSpacing: 18, spacingAfter: 8, alignment: 'left', color: '374151', ...extra } });
const template = 'outputs/office-live-test/template/offer-template.docx';
const made = value(
  await executeOfficeTool(
    {
      action: 'create',
      path: template,
      overwrite: true,
      mode: 'portable',
      operations: [
        { op: 'append_text', text: '채용 제안서', style: 'Title', properties: { ...F, size: 24, bold: true, color: '0A2540', alignment: 'left', spacingAfter: 12 } },
        body('{{candidate}} 님께'),
        body('{{company}}은 {{candidate}} 님께 {{role}} 직무를 제안드립니다. 입사 예정일은 {{start}}이며, 연봉은 {{salary}}입니다.'),
        { op: 'add_table', values: [['항목', '내용'], ['직무', '{{role}}'], ['근무지', '{{office}}'], ['연봉', '{{salary}}']], properties: { fontName: 'Noto Sans', fontNameEastAsia: 'Noto Sans KR', fontSize: 10, columnWidths: [120, 331] } },
        body('{{signer}} 드림', { bold: true, spacingBefore: 12 }),
        { op: 'set_header_footer', kind: 'footer', text: '{{company}} 인사팀', properties: { ...F, size: 8.5, color: '6B7280' } },
      ],
    },
    { cwd }
  )
);
await executeOfficeTool({ action: 'close', session: made.session }, { cwd });
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path: template,
      output: 'outputs/office-live-test/template/offer-filled.docx',
      mode: 'portable',
      operations: [
        { op: 'fill_template', strict: true, tokens: { candidate: '이서연', company: '모아페이', role: '프로덕트 디자이너', start: '2026년 11월 2일', salary: '6,800만 원', office: '서울 강남', signer: '인사팀장 박도윤' } },
      ],
    },
    { cwd }
  )
);
console.log(JSON.stringify(opened.batch?.results));
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session }, { cwd }));
for (const image of rendered.images) console.log(image.path);
const snap = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
console.log(JSON.stringify(snap.document?.paragraphs?.map?.((p) => p.text) ?? '').slice(0, 800));
await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
