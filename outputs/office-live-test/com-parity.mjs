// Live Microsoft Office parity for the COM changes: Word header properties + table keepWithNext + fill_template
// particles, Excel set_row_height / set_column_width. Background mode; every session is closed.
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
const dir = 'outputs/office-live-test/com';
await mkdir(dir, { recursive: true });
const word = value(
  await executeOfficeTool(
    {
      action: 'create',
      path: `${dir}/letter.docx`,
      overwrite: true,
      mode: 'background',
      operations: [
        { op: 'append_text', text: '{{company}}은 {{city}}으로 옮긴다.' },
        { op: 'add_table', values: [['연도', 'MAU'], ['2025', '1,260']], properties: { keepWithNext: true } },
        { op: 'append_text', text: '표 1. 연도별 사용자' },
        { op: 'set_header_footer', kind: 'header', text: '모아페이 · 주주서한', properties: { name: 'Arial', size: 8.5, color: '6B7280', alignment: 'right' } },
        { op: 'fill_template', tokens: { company: '모아페이', city: '서울' } },
      ],
    },
    { cwd }
  )
);
console.log('word backend', word.backend, JSON.stringify(word.batch?.results?.map((r) => [r.op, r.changed, r.filled]).slice(-2)));
const snap = value(await executeOfficeTool({ action: 'snapshot', session: word.session }, { cwd }));
console.log('word text', JSON.stringify(snap.document?.paragraphs?.map((p) => p.text).slice(0, 3)));
console.log('word header', JSON.stringify(snap.document?.headers ?? snap.document?.headerFooter ?? '').slice(0, 300));
await executeOfficeTool({ action: 'close', session: word.session, save: true }, { cwd });

const excel = value(
  await executeOfficeTool(
    {
      action: 'create',
      path: `${dir}/sized.xlsx`,
      overwrite: true,
      mode: 'background',
      operations: [
        { op: 'set_range', range: 'B1:C2', values: [['Hub', 'Volume'], ['Daejeon', 128400]] },
        { op: 'set_column_width', column: 'A', width: 3 },
        { op: 'set_column_width', column: 'B', width: 24, count: 2 },
        { op: 'set_row_height', row: 1, height: 42 },
      ],
    },
    { cwd }
  )
);
console.log('excel backend', excel.backend, JSON.stringify(excel.batch?.results?.slice(-3)));
await executeOfficeTool({ action: 'close', session: excel.session, save: true }, { cwd });
