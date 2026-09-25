// Real Microsoft Office renders of the portable-authored files: Excel for the dashboard, Word for the report with
// its numbered contents. Background mode on copies; sessions closed.
import { copyFile, mkdir } from 'node:fs/promises';
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
await mkdir('outputs/office-live-test/com', { recursive: true });
for (const [source, copy] of [
  ['outputs/office-live-test/xlsx/saas-metrics.xlsx', 'outputs/office-live-test/com/saas-excel.xlsx'],
  ['outputs/office-live-test/docx/night-logistics-report.docx', 'outputs/office-live-test/com/report-word.docx'],
  ['outputs/office-live-test/pptx/editorial-tour.pptx', 'outputs/office-live-test/com/editorial-powerpoint.pptx'],
]) {
  await copyFile(source, copy);
  const opened = value(await executeOfficeTool({ action: 'open', path: copy, mode: 'background' }, { cwd }));
  try {
    const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session, pages: copy.endsWith('.pptx') ? [2, 3, 6] : undefined }, { cwd }));
    console.log(`${copy} ${rendered.renderer} ${rendered.pageCount}`);
    for (const image of rendered.images) console.log(`  ${image.path}`);
  } finally {
    await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
  }
}
