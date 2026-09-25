// Editing an existing deck (pptx skill §6): snapshot → structural batch → content batch → render the edited pages.
import { copyFile } from 'node:fs/promises';
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
const deck = 'outputs/office-live-test/pptx/moapay-edit.pptx';
await copyFile('outputs/office-live-test/pptx/moapay-ir.pptx', deck);
const opened = value(await executeOfficeTool({ action: 'open', path: deck, mode: 'portable' }, { cwd }));
const s = opened.session;
const snap = value(await executeOfficeTool({ action: 'snapshot', session: s, pages: [3, 4] }, { cwd }));
for (const slide of snap.document.slides) {
  console.log(`slide ${slide.index} role ${slide.role}`);
  for (const shape of slide.shapes) console.log(`  ${shape.index} ${shape.slot || ''} ${shape.chart ? 'CHART' : ''} ${String(shape.text || '').slice(0, 40)}`);
}
// A quarter later: the MAU chart gains a point, the revenue chart takes new numbers, the title follows.
const chartShape = (index) => snap.document.slides.find((slide) => slide.index === index).shapes.find((shape) => shape.chart)?.index;
const edited = value(
  await executeOfficeTool(
    {
      action: 'batch',
      session: s,
      operations: [
        { op: 'set_chart_data', slide: 3, shape: chartShape(3), categories: ['2021', '2022', '2023', '2024', '2025', '2026 3분기'], series: [{ name: 'MAU(만 명)', values: [410, 620, 830, 1040, 1260, 1510] }] },
        { op: 'replace_text', find: 'MAU는 5년 연속 두 자릿수로 늘었다', replace: 'MAU가 1,500만 명을 넘었다' },
        { op: 'replace_text', find: '올해 상반기에도 12.7% 증가했다.', replace: '3분기까지 19.8% 증가했다.' },
        { op: 'duplicate_slide', slide: 4 },
      ],
    },
    { cwd }
  )
);
console.log(JSON.stringify(edited.results?.map((r) => [r.op, r.changed, r.preserved ?? r.ownParts ?? ''])));
console.log(`audit ${edited.audit?.status} ${JSON.stringify(edited.audit?.top ?? [])}`.slice(0, 1500));
const rendered = value(await executeOfficeTool({ action: 'render', session: s, pages: [3, 5] }, { cwd }));
for (const image of rendered.images) console.log(`page ${image.page}: ${image.path}`);
await executeOfficeTool({ action: 'close', session: s }, { cwd });
