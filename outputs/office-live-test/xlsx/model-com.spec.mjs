// Five-year revenue model (sample assumptions) built to model-conventions.md, then audited as a financial model.
const years = ['2026', '2027', '2028', '2029', '2030'];
const cols = ['C', 'D', 'E', 'F', 'G'];
const f = (sheet, cell, formula) => ({ op: 'set_formula', sheet, cell, formula });
const HEAD = { bold: true, fillColor: 'EEF2F7', borders: { bottom: { style: 'thin', color: 'C9CED6' } } };

export default {
  path: 'outputs/office-live-test/xlsx/revenue-model-com.xlsx',
  create: { format: 'xlsx', mode: 'background' },
  auditProfile: 'financial-model',
  operations: [
    { op: 'rename_sheet', name: 'Inputs' },
    { op: 'add_sheet', name: 'Model' },
    { op: 'add_sheet', name: 'Checks' },
    // Inputs with the legend where the reader lands
    { op: 'set_range', sheet: 'Inputs', range: 'A1:A3', values: [['파란 글자 = 입력값, 검은 글자 = 수식'], ['노란 칸 = 검토 후 채울 값'], ['단위: 억 원 (예시 가정)']] },
    { op: 'set_style', sheet: 'Inputs', range: 'A1:A3', properties: { fontSize: 9, color: '6B7280' } },
    { op: 'set_range', sheet: 'Inputs', range: 'A5:B9', values: [['가정', '값'], ['2025년 매출 (억 원)', 7340], ['연 매출 성장률', 0.18], ['매출총이익률', 0.62], ['판관비율', 0.47]] },
    { op: 'set_style', sheet: 'Inputs', range: 'A5:B5', properties: HEAD },
    { op: 'set_style', sheet: 'Inputs', range: 'B6:B9', properties: { color: '0000FF' } },
    { op: 'set_style', sheet: 'Inputs', cell: 'B6', properties: { numberFormat: '#,##0' } },
    { op: 'set_style', sheet: 'Inputs', range: 'B7:B9', properties: { numberFormat: '0.0%' } },
    { op: 'set_style', sheet: 'Inputs', cell: 'B9', properties: { fillColor: 'FFFF00' } },
    { op: 'add_provenance', sheet: 'Inputs', cell: 'B6', source: '모아페이 2025 감사보고서 p.12 손익계산서 (예시)' },
    { op: 'add_note', sheet: 'Inputs', cell: 'B7', text: '사용자 브리프 2026-09-23: 연 18% 성장 가정' },
    { op: 'add_note', sheet: 'Inputs', cell: 'B8', text: '사용자 브리프 2026-09-23: 2025년 실적 기준' },
    { op: 'add_note', sheet: 'Inputs', cell: 'B9', text: '재무팀 검토 전 임시값 2026-09-23' },
    { op: 'define_name', name: 'Growth', refersTo: 'Inputs!$B$7' },
    { op: 'autofit_range', sheet: 'Inputs', range: 'A5:B9', minWidth: 10 },
    // Model: one formula per row, copied across
    { op: 'set_range', sheet: 'Model', range: 'A1:G1', values: [['항목 (억 원)', '2025', ...years]] },
    { op: 'set_range', sheet: 'Model', range: 'A2:A6', values: [['매출'], ['매출총이익'], ['판관비'], ['영업이익'], ['영업이익률']] },
    f('Model', 'B2', '=Inputs!B6'),
    ...cols.map((col, i) => f('Model', `${col}2`, `=${String.fromCharCode(66 + i)}2*(1+Growth)`)),
    ...['B', ...cols].flatMap((col) => [
      f('Model', `${col}3`, `=${col}2*Inputs!$B$8`),
      f('Model', `${col}4`, `=${col}2*Inputs!$B$9`),
      f('Model', `${col}5`, `=${col}3-${col}4`),
      f('Model', `${col}6`, `=IFERROR(${col}5/${col}2,0)`),
    ]),
    { op: 'set_style', sheet: 'Model', range: 'A1:G1', properties: HEAD },
    { op: 'set_style', sheet: 'Model', range: 'B1:G1', properties: { horizontalAlignment: 'right' } },
    { op: 'set_style', sheet: 'Model', range: 'B2:G5', properties: { numberFormat: '#,##0;(#,##0);-' } },
    { op: 'set_style', sheet: 'Model', cell: 'B2', properties: { color: '008000' } },
    { op: 'set_style', sheet: 'Model', range: 'B6:G6', properties: { numberFormat: '0.0%;(0.0%);-' } },
    { op: 'set_style', sheet: 'Model', range: 'A5:G5', properties: { bold: true, borders: { top: { style: 'thin', color: '0A2540' } } } },
    { op: 'freeze_panes', sheet: 'Model', row: 1, column: 1 },
    { op: 'autofit_range', sheet: 'Model', range: 'A1:G6', minWidth: 10 },
    // Checks
    { op: 'set_range', sheet: 'Checks', range: 'A1:B1', values: [['모든 검증 통과', '']] },
    f('Checks', 'B1', '=AND(B3:B4)'),
    { op: 'set_range', sheet: 'Checks', range: 'A3:A4', values: [['영업이익 = 매출총이익 − 판관비 (2030)'], ['2030 매출 = 2025 매출 × (1+성장률)^5']] },
    f('Checks', 'B3', '=ROUND(Model!G5-(Model!G3-Model!G4),2)=0'),
    f('Checks', 'B4', '=ROUND(Model!G2-Model!B2*(1+Growth)^5,2)=0'),
    { op: 'set_style', sheet: 'Checks', range: 'A1:B1', properties: { bold: true } },
    { op: 'autofit_range', sheet: 'Checks', range: 'A1:B4', minWidth: 10 },
    { op: 'add_chart', sheet: 'Model', range: 'A1:G2', plotBy: 'rows', chartType: 'column', cell: 'A9', title: '매출 전망 (억 원)', showValues: true, showLegend: false, zeroBaseline: true, width: 460, height: 240 },
    { op: 'set_page_setup', sheet: 'Model', printArea: 'A1:I26', fitToPagesWide: 1, orientation: 'landscape' },
  ],
};
