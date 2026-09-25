// Live Excel parity: a bar chart lists its categories top-down.
import { mkdir } from 'node:fs/promises';
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
const created = value(
  await executeOfficeTool(
    {
      action: 'create',
      path: 'outputs/office-live-test/com/bars.xlsx',
      overwrite: true,
      mode: 'background',
      operations: [
        { op: 'set_range', range: 'A1:B4', values: [['사업부', '매출'], ['반도체', 52], ['모바일', 40], ['가전', 27]] },
        { op: 'add_chart', range: 'A1:B4', chartType: 'bar', cell: 'D2', width: 360, height: 220 },
        { op: 'set_range', range: 'A20:E21', values: [['항목', '2026', '2027', '2028', '2029'], ['매출', 8661, 10220, 12060, 14231]] },
        { op: 'add_chart', range: 'A20:E21', plotBy: 'rows', chartType: 'column', cell: 'D20', width: 360, height: 220 },
      ],
    },
    { cwd }
  )
);
try {
  const rendered = value(await executeOfficeTool({ action: 'render', session: created.session }, { cwd }));
  for (const image of rendered.images) console.log(image.path);
} finally {
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
}
