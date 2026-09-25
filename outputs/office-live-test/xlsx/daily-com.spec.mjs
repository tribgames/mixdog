// A daily metric with dates down column A and a line chart over it (reference: a Google Analytics export sheet):
// the dates are ISO strings, so the chart's categories must read as dates, not as serial numbers.
const start = Date.UTC(2026, 8, 1);
const rows = Array.from({ length: 21 }, (_, i) => {
  const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
  return [day, 1200 + Math.round(300 * Math.sin(i / 3)) + i * 20];
});
export default {
  path: 'outputs/office-live-test/xlsx/daily-com.xlsx',
  create: { format: 'xlsx', mode: 'background' },
  operations: [
    { op: 'rename_sheet', name: '일별' },
    { op: 'set_range', range: 'A1:B1', values: [['날짜', '방문자']] },
    { op: 'set_style', range: 'A1:B1', properties: { bold: true, fillColor: 'EEF2F7' } },
    { op: 'set_range', range: `A2:B${rows.length + 1}`, values: rows },
    { op: 'set_style', range: `B2:B${rows.length + 1}`, properties: { numberFormat: '#,##0' } },
    { op: 'set_column_width', column: 'A', width: 12 },
    { op: 'add_chart', chartType: 'line', range: `A1:B${rows.length + 1}`, cell: 'D2', width: 520, height: 260, title: '9월 일별 방문자' },
    { op: 'set_page_setup', orientation: 'landscape', printArea: 'A1:O24', fitToPagesWide: 1 },
  ],
};
