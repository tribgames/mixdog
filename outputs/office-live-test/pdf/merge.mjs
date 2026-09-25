// Merge the invoice, the filled form, and the report's preview into one pack with an outline, then page numbers.
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
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path: 'outputs/office-live-test/pdf/invoice.v2.pdf',
      output: 'outputs/office-live-test/pdf/pack.pdf',
      operations: [
        { op: 'add_bookmark', title: '청구서', page: 1 },
        {
          op: 'merge_pdf',
          bookmarks: true,
          sources: [
            { path: 'outputs/office-live-test/pdf/pilot-form.filled.pdf', title: '파일럿 신청서' },
            { path: 'outputs/office-live-test/docx/night-logistics-report.mixdog-preview.pdf', title: '야간 물류 보고서' },
          ],
        },
        { op: 'add_text', text: '{page} / {pages}', align: 'center', y: 24, size: 9, color: '6B7280' },
      ],
    },
    { cwd }
  )
);
console.log(JSON.stringify(opened.batch?.results?.map((r) => [r.op, r.changed, r.pagesAdded ?? r.pages?.length ?? ''])));
const snap = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, pages: [1] }, { cwd }));
console.log(`pages ${snap.document.pageCount} outline ${JSON.stringify(snap.document.outline)} fields ${snap.document.fieldCount}`);
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session, pages: [1, 2, 3] }, { cwd }));
for (const image of rendered.images) console.log(image.path);
await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
