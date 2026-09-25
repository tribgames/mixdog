// The IRS W-9 (a real fillable PDF with XFA-era field names) filled the way a user would: read its fields, fill the
// name, business, address and TIN, check a box, render page 1, and audit.
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
const work = 'outputs/office-live-test/real/fw9-filled.pdf';
await copyFile('outputs/office-live-test/real/fw9.pdf', work);
const opened = await call({ action: 'open', path: work });
console.log('open', opened.session, opened.error || '');
const snap = await call({ action: 'snapshot', session: opened.session });
const list = snap.document.fields.filter((f) => f.widgets?.[0]?.page === 1);
for (const f of list) console.log(' ', f.index, f.type, f.name.replace('topmostSubform[0].Page1[0].', ''), f.label || '', JSON.stringify(f.widgets[0]).slice(0, 80));
const F = (short) => list.find((f) => f.name.endsWith(short))?.name;
const filled = await call({
  action: 'batch',
  session: opened.session,
  operations: [
    {
      op: 'fill_form',
      values: {
        [F('f1_01[0]')]: 'Jaeyoung Kim',
        [F('f1_02[0]')]: 'Mixdog Labs LLC',
        [F('c1_1[5]')]: true,
        [F('f1_03[0]')]: 'C',
        [F('f1_07[0]')]: '123 Teheran-ro, Suite 400',
        [F('f1_08[0]')]: 'Seoul 06236, Republic of Korea',
      },
    },
  ],
});
console.log('fill', filled.error || JSON.stringify(filled.results).slice(0, 800));
const rendered = await call({ action: 'render', session: opened.session, pages: [1] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
const issues = await call({ action: 'issues', session: opened.session });
console.log('issues', JSON.stringify((issues.issues || []).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 1500));
console.log('save', JSON.stringify(await call({ action: 'save', session: opened.session })).slice(0, 200));
await call({ action: 'close', session: opened.session });
