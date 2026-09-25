// Review marks on a real PDF (the IRS W-9): a Korean watermark, highlights on a phrase, and a page stamp line.
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
const work = 'outputs/office-live-test/real/fw9-marked.pdf';
await copyFile('outputs/office-live-test/real/fw9.pdf', work);
const { session, error } = await call({ action: 'open', path: work });
if (error) throw new Error(error);
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'watermark', text: '검토용 사본', pages: [1] },
    { op: 'highlight', find: 'Taxpayer Identification Number', pages: [1] },
    { op: 'add_text', text: '검토 {page} / {pages} · 도시 물류 연구소', pages: [1, 2], align: 'right', y: 18, size: 8, color: '6B7280' },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => ({ op: r.op, changed: r.changed, count: r.count ?? r.matches }))));
const rendered = await call({ action: 'render', session, pages: [1] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session });
