// A real-world Word file (calibre's demo.docx: lists, tables, images, footnotes, styles) opened and edited the way a
// user would: render the original, snapshot, normalize, tracked edits, a comment, render again.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => {
  const raw = await executeOfficeTool(args, { cwd });
  const text = raw.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};
const source = 'outputs/office-live-test/real/demo.docx';
const work = 'outputs/office-live-test/real/demo-edited.docx';
await copyFile(source, work);
const opened = await call({ action: 'open', path: work, mode: 'portable' });
console.log('open', opened.session, opened.error || '');
const before = await call({ action: 'render', session: opened.session });
console.log('before', before.pageCount, (before.images || []).map((i) => i.path).join('\n  '));
const snap = await call({ action: 'snapshot', session: opened.session });
const paragraphs = snap.document?.paragraphs || [];
console.log('paragraphs', paragraphs.length, 'tables', snap.document?.tables?.length, 'issues', JSON.stringify((snap.issues || []).slice(0, 6)));
for (const p of paragraphs.slice(0, 14)) console.log(' ', p.path, p.style, JSON.stringify(String(p.text).slice(0, 70)));
const batch = await call({
  action: 'batch',
  session: opened.session,
  operations: [
    { op: 'normalize_runs', allowNoChange: true },
    { op: 'track_changes', enabled: true },
    { op: 'replace_text', find: 'demonstration', replace: 'showcase', author: 'Mixdog 검토' },
    { op: 'add_comment', find: 'Tables', text: '표 서식이 원본 그대로인지 확인해 주세요.', author: 'Mixdog 검토' },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => ({ op: r.op, changed: r.changed, count: r.count ?? r.replaced, anchor: r.anchor }))));
console.log('audit', JSON.stringify(batch.audit?.top || batch.batch?.audit?.top || []).slice(0, 800));
const after = await call({ action: 'render', session: opened.session });
console.log('after', after.pageCount, after.error || '', (after.images || []).map((i) => i.path).join('\n  '));
const fin = await call({ action: 'finalize', session: opened.session, auditProfile: 'redlining', author: 'Mixdog 검토' });
console.log('finalize', JSON.stringify(fin).slice(0, 1200));

