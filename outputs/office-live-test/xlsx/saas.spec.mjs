// SaaS metrics dashboard (sample figures): Report / Data / Inputs, native styles and chart.
const ACCENT = '533AFD', INK = '0A2540', MUTED = '6B7280', HEAD = 'EEF2F7', LINE = 'C9CED6';
const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const neu = [62, 58, 65, 71, 68, 74, 80, 77, 85, 88, 92, 96];
const exp = [18, 20, 19, 23, 25, 24, 28, 30, 29, 33, 35, 38];
const churn = [21, 24, 22, 20, 23, 21, 19, 22, 20, 18, 19, 17];
const customers = [1210, 1236, 1265, 1298, 1327, 1359, 1394, 1426, 1463, 1499, 1538, 1580];
const dataRows = months.map((m, i) => [m, neu[i], exp[i], churn[i], null, null, customers[i]]);
const f = (sheet, cell, formula) => ({ op: 'set_formula', sheet, cell, formula });

export default {
  path: 'outputs/office-live-test/xlsx/saas-metrics.xlsx',
  create: { format: 'xlsx' },
  operations: [
    { op: 'rename_sheet', name: 'Report' },
    { op: 'add_sheet', name: 'Data' },
    { op: 'add_sheet', name: 'Inputs' },
    // Inputs
    { op: 'set_range', sheet: 'Inputs', range: 'A1:B3', values: [['항목', '값'], ['기준 월', '2025-09'], ['기초 MRR (백만 원)', 820]] },
    { op: 'set_style', sheet: 'Inputs', range: 'A1:B1', properties: { bold: true, fillColor: HEAD, borders: { bottom: { style: 'thin', color: LINE } } } },
    { op: 'set_style', sheet: 'Inputs', cell: 'B3', properties: { color: '0000FF', numberFormat: '#,##0' } },
    { op: 'add_note', sheet: 'Inputs', cell: 'B3', text: '2025-09 말 MRR, 재무팀 월 마감 (예시 수치)' },
    { op: 'autofit_range', sheet: 'Inputs', range: 'A1:B3', minWidth: 12 },
    // Data
    { op: 'set_range', sheet: 'Data', range: 'A1:G13', values: [['월', '신규 MRR', '확장 MRR', '이탈 MRR', '순증 MRR', '기말 MRR', '고객 수'], ...dataRows.map((r) => r.map((v) => v ?? ''))] },
    ...months.map((_, i) => f('Data', `E${i + 2}`, `=B${i + 2}+C${i + 2}-D${i + 2}`)),
    f('Data', 'F2', '=Inputs!B3+E2'),
    ...months.slice(1).map((_, i) => f('Data', `F${i + 3}`, `=F${i + 2}+E${i + 3}`)),
    { op: 'set_style', sheet: 'Data', range: 'A1:G1', properties: { bold: true, fillColor: HEAD, borders: { bottom: { style: 'thin', color: LINE } }, verticalAlignment: 'center' } },
    { op: 'set_style', sheet: 'Data', range: 'B1:G1', properties: { horizontalAlignment: 'right' } },
    { op: 'set_style', sheet: 'Data', range: 'B2:G13', properties: { numberFormat: '#,##0' } },
    { op: 'set_style', sheet: 'Data', range: 'B2:D13', properties: { color: '0000FF' } },
    { op: 'freeze_panes', sheet: 'Data', row: 1 },
    { op: 'add_note', sheet: 'Data', cell: 'B1', text: '신규·확장·이탈 MRR과 고객 수: 재무팀 월 마감 (예시 수치), 단위 백만 원' },
    { op: 'autofit_range', sheet: 'Data', range: 'A1:G13', minWidth: 10 },
    // Report
    { op: 'set_cell', sheet: 'Report', cell: 'A1', value: 'SAAS METRICS · 2026-09' },
    { op: 'set_cell', sheet: 'Report', cell: 'A2', value: '확장이 이탈을 앞서며 MRR이 1년 만에 두 배를 넘었다' },
    { op: 'set_cell', sheet: 'Report', cell: 'A3', value: '2025-10 ~ 2026-09 · 단위: 백만 원 · 예시 수치' },
    { op: 'set_style', sheet: 'Report', cell: 'A1', properties: { fontSize: 9, bold: true, color: ACCENT } },
    { op: 'set_style', sheet: 'Report', cell: 'A2', properties: { fontSize: 16, bold: true, color: INK } },
    { op: 'set_style', sheet: 'Report', cell: 'A3', properties: { fontSize: 10, color: MUTED } },
    { op: 'set_range', sheet: 'Report', range: 'A5:D5', values: [['기말 MRR', '12개월 순증', '순 매출 유지율', '고객 수']] },
    f('Report', 'A6', '=Data!F13'),
    f('Report', 'B6', '=SUM(Data!E2:E13)'),
    f('Report', 'C6', '=(Inputs!B3+SUM(Data!C2:C13)-SUM(Data!D2:D13))/Inputs!B3'),
    f('Report', 'D6', '=Data!G13'),
    { op: 'set_range', sheet: 'Report', range: 'A7:D7', values: [['2026-09 말', '2025-10 ~ 2026-09', '기초 고객 기준', '2026-09 말']] },
    { op: 'set_style', sheet: 'Report', range: 'A5:D5', properties: { fontSize: 9, color: MUTED } },
    { op: 'set_style', sheet: 'Report', range: 'A6:D6', properties: { fontSize: 20, bold: true, color: INK, numberFormat: '#,##0', horizontalAlignment: 'left' } },
    { op: 'set_style', sheet: 'Report', cell: 'C6', properties: { numberFormat: '0.0%', color: ACCENT } },
    { op: 'set_style', sheet: 'Report', range: 'A7:D7', properties: { fontSize: 9, color: MUTED, borders: { bottom: { style: 'thin', color: LINE } } } },
    { op: 'set_range', sheet: 'Report', range: 'A9:C9', values: [['월', '기말 MRR', '순증 MRR']] },
    ...months.flatMap((_, i) => [f('Report', `A${i + 10}`, `=Data!A${i + 2}`), f('Report', `B${i + 10}`, `=Data!F${i + 2}`), f('Report', `C${i + 10}`, `=Data!E${i + 2}`)]),
    { op: 'set_style', sheet: 'Report', range: 'A9:C9', properties: { bold: true, fillColor: HEAD, borders: { bottom: { style: 'thin', color: LINE } } } },
    { op: 'set_style', sheet: 'Report', range: 'B9:C9', properties: { horizontalAlignment: 'right' } },
    { op: 'set_style', sheet: 'Report', range: 'B10:C21', properties: { numberFormat: '#,##0' } },
    { op: 'add_chart', sheet: 'Report', range: 'A9:B21', chartType: 'column', cell: 'E9', title: '기말 MRR (백만 원)', seriesColors: [ACCENT], showValues: false, showLegend: false, zeroBaseline: true, width: 460, height: 250 },
    { op: 'autofit_range', sheet: 'Report', range: 'A5:D21', minWidth: 14 },
    { op: 'set_page_setup', sheet: 'Report', printArea: 'A1:M26', fitToPagesWide: 1, orientation: 'landscape' },
  ],
};
