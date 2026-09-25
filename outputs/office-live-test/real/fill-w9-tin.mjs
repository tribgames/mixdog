// The W-9's comb fields: the SSN in three boxed groups, each digit in its own box.
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
const work = 'outputs/office-live-test/real/fw9-tin.pdf';
await copyFile('outputs/office-live-test/real/fw9.pdf', work);
const { session } = await call({ action: 'open', path: work });
const snap = await call({ action: 'snapshot', session });
const field = (short) => snap.document.fields.find((f) => f.name.endsWith(short));
for (const short of ['f1_11[0]', 'f1_12[0]', 'f1_13[0]']) console.log(short, JSON.stringify({ maxLength: field(short).maxLength, width: field(short).widgets[0].width }));
const filled = await call({
  action: 'batch',
  session,
  operations: [{ op: 'fill_form', values: { [field('f1_11[0]').name]: '123', [field('f1_12[0]').name]: '45', [field('f1_13[0]').name]: '6789' } }],
});
console.log('fill', filled.error || JSON.stringify(filled.results?.[0]).slice(0, 300));
const rendered = await call({ action: 'render', session, pages: [1] });
console.log('render', rendered.error || rendered.images?.[0]?.path);
await call({ action: 'close', session });
