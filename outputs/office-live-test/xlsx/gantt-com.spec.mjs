// Gantt schedule (reference: Smartsheet / Vertex42 Gantt templates): a task table with start/end dates, a week grid
// across the top, and formula-based conditional formatting that fills each task's weeks. Landscape print, frozen
// task column.
const tasks = [
  ['요구사항 정리', '기획', '2026-10-05', '2026-10-16'],
  ['화면 설계', '디자인', '2026-10-12', '2026-10-30'],
  ['API 개발', '백엔드', '2026-10-19', '2026-11-20'],
  ['앱 개발', '모바일', '2026-10-26', '2026-11-27'],
  ['통합 테스트', 'QA', '2026-11-23', '2026-12-04'],
  ['베타 출시', '전체', '2026-12-07', '2026-12-11'],
];
const weeks = 10;
const col = (n) => String.fromCharCode(64 + n);
const firstWeek = 5; // column E
const lastCol = col(firstWeek + weeks - 1);
export default {
  path: 'outputs/office-live-test/xlsx/gantt-com.xlsx',
  create: { format: 'xlsx', mode: 'background' },
  operations: [
    { op: 'rename_sheet', name: '일정' },
    { op: 'set_range', range: 'A1:A2', values: [['모바일 앱 출시 일정'], ['주 단위 · 칠해진 칸이 작업 기간']] },
    { op: 'set_style', range: 'A1', properties: { fontSize: 15, bold: true, color: '1F2A44' } },
    { op: 'set_style', range: 'A2', properties: { fontSize: 9, color: '6B7280' } },
    { op: 'set_range', range: 'A4:D4', values: [['작업', '담당', '시작', '종료']] },
    { op: 'set_cell', cell: `${col(firstWeek)}4`, value: '2026-10-05' },
    ...Array.from({ length: weeks - 1 }, (_, i) => ({ op: 'set_formula', cell: `${col(firstWeek + i + 1)}4`, formula: `=${col(firstWeek + i)}4+7` })),
    { op: 'set_style', range: `A4:${lastCol}4`, properties: { bold: true, color: 'FFFFFF', fillColor: '1F2A44' } },
    { op: 'set_style', range: `${col(firstWeek)}4:${lastCol}4`, properties: { numberFormat: 'm/d', horizontalAlignment: 'center' } },
    { op: 'set_range', range: `A5:D${4 + tasks.length}`, values: tasks },
    { op: 'set_style', range: `C5:D${4 + tasks.length}`, properties: { numberFormat: 'm/d' } },
    { op: 'add_conditional_format', range: `${col(firstWeek)}5:${lastCol}${4 + tasks.length}`, formula: `AND(${col(firstWeek)}$4+6>=$C5,${col(firstWeek)}$4<=$D5)`, fillColor: '2E6BE6' },
    { op: 'set_style', range: `${col(firstWeek)}5:${lastCol}${4 + tasks.length}`, properties: { borders: { right: { style: 'thin', color: 'E5E7EB' }, bottom: { style: 'thin', color: 'E5E7EB' } } } },
    { op: 'set_column_width', column: 'A', width: 16 },
    { op: 'set_column_width', column: 'B', width: 9 },
    { op: 'set_column_width', column: 'C', width: 7, count: 2 },
    { op: 'set_column_width', column: col(firstWeek), width: 6, count: weeks },
    { op: 'freeze_panes', row: 4, column: 1 },
    { op: 'set_page_setup', orientation: 'landscape', printArea: `A1:${lastCol}${4 + tasks.length}`, fitToPagesWide: 1 },
  ],
};
