// Live PowerPoint parity: replace_text across an authored eojeol wrap keeps the runs around it.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};
const deck = 'outputs/office-live-test/com/moapay-com.pptx';
await copyFile('outputs/office-live-test/pptx/moapay-ir.pptx', deck);
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path: deck,
      mode: 'background',
      operations: [{ op: 'replace_text', find: '올해 상반기에도 12.7% 증가했다.', replace: '3분기까지 19.8% 증가했다.' }],
    },
    { cwd }
  )
);
console.log(opened.backend, JSON.stringify(opened.batch?.results));
try {
  const snap = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, pages: [3] }, { cwd }));
  for (const slide of snap.document.slides || []) {
    for (const shape of slide.shapes || []) if (String(shape.text || '').includes('분기')) console.log(slide.index, shape.index, JSON.stringify(shape.text), JSON.stringify(shape.runs || shape.font || '').slice(0, 300));
  }
} finally {
  await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
}
