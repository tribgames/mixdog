// A submission pack: the report, then the application form, merged with bookmarks and a page stamp; the form stays
// fillable in the pack.
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
const opened = await call({
  action: 'open',
  path: 'outputs/office-live-test/pdf/report.pdf',
  output: 'outputs/office-live-test/pdf/pack.pdf',
  operations: [
    { op: 'merge_pdf', sources: ['outputs/office-live-test/pdf/korean-form.pdf'] },
    { op: 'add_bookmark', title: '보고서', page: 1 },
    { op: 'add_bookmark', title: '참여 신청서', page: 4 },
    { op: 'add_text', text: '제출 묶음 · {page} / {pages}', pages: [1, 2, 3, 4], align: 'right', y: 18, size: 8, color: '6B7280' },
    { op: 'fill_form', values: { company: '모아물류', owner: '김재영', fleet: '10–49대', consent: true } },
  ],
});
console.log('open', opened.error || JSON.stringify(opened.batch?.results?.map((r) => ({ op: r.op, changed: r.changed, fields: r.formFields ?? r.filled }))).slice(0, 800));
const snap = await call({ action: 'snapshot', session: opened.session });
console.log('pages', snap.document?.pageCount, 'fields', snap.document?.fieldCount, 'outline', JSON.stringify(snap.document?.outline).slice(0, 300));
const rendered = await call({ action: 'render', session: opened.session, pages: [3, 4] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session: opened.session });
