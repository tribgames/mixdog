// Project tracker (reference: Smartsheet / Notion project dashboards): a status table with data bars on progress,
// a colour scale on the risk score, a stacked column of hours by team, and a printed landscape page.
const HEAD = { bold: true, color: 'FFFFFF', fillColor: '1F2A44', horizontalAlignment: 'left' };
const rows = [
  ['결제 리뉴얼', '결제팀', '2026-07-01', '2026-09-30', 0.82, 3, 120, 40],
  ['대출 비교 2.0', '대출팀', '2026-07-15', '2026-10-31', 0.55, 6, 90, 70],
  ['해외 송금 확장', '송금팀', '2026-08-01', '2026-12-15', 0.31, 8, 60, 110],
  ['앱 온보딩 개선', '그로스팀', '2026-06-01', '2026-08-31', 1, 1, 80, 0],
  ['사기 탐지 모델', '리스크팀', '2026-07-01', '2026-11-30', 0.47, 7, 70, 95],
  ['고객센터 챗봇', 'CX팀', '2026-08-15', '2026-10-15', 0.64, 4, 50, 30],
  ['투자 상품 추가', '투자팀', '2026-09-01', '2027-01-31', 0.12, 5, 30, 140],
];
export default {
  path: 'outputs/office-live-test/xlsx/tracker-com.xlsx',
  create: { format: 'xlsx', mode: 'background' },
  operations: [
    { op: 'rename_sheet', name: '프로젝트 현황' },
    { op: 'set_range', range: 'A1:A2', values: [['2026년 3분기 프로젝트 현황'], ['2026-09-22 기준 · 진행률은 완료된 작업 비율, 위험도는 1(낮음)~10(높음)']] },
    { op: 'set_style', range: 'A1', properties: { fontSize: 16, bold: true, color: '1F2A44' } },
    { op: 'set_style', range: 'A2', properties: { fontSize: 9, color: '6B7280' } },
    { op: 'set_range', range: 'A4:J4', values: [['프로젝트', '담당', '시작', '마감', '진행률', '위험도', '완료 시간', '남은 시간', '총 시간', '남은 일수']] },
    { op: 'set_style', range: 'A4:J4', properties: HEAD },
    { op: 'set_style', range: 'E4:J4', properties: { horizontalAlignment: 'right' } },
    { op: 'set_range', range: 'A5:H11', values: rows },
    ...rows.flatMap((_, i) => [
      { op: 'set_formula', cell: `I${i + 5}`, formula: `=G${i + 5}+H${i + 5}` },
      { op: 'set_formula', cell: `J${i + 5}`, formula: `=MAX(0,D${i + 5}-DATE(2026,9,22))` },
    ]),
    { op: 'set_style', range: 'E5:E11', properties: { numberFormat: '0%' } },
    { op: 'set_style', range: 'G5:J11', properties: { numberFormat: '#,##0' } },
    { op: 'add_conditional_format', range: 'E5:E11', type: 'dataBar', color: '2E6BE6' },
    { op: 'add_conditional_format', range: 'F5:F11', type: 'colorScale', minColor: 'E3F1E8', midColor: 'FFF4D6', maxColor: 'F6D3CF' },
    { op: 'set_range', range: 'A12:A12', values: [['합계']] },
    { op: 'set_formula', cell: 'G12', formula: '=SUM(G5:G11)' },
    { op: 'set_formula', cell: 'H12', formula: '=SUM(H5:H11)' },
    { op: 'set_formula', cell: 'I12', formula: '=SUM(I5:I11)' },
    { op: 'set_style', range: 'A12:J12', properties: { bold: true, borders: { top: { style: 'medium', color: '1F2A44' } } } },
    { op: 'set_style', range: 'G12:I12', properties: { numberFormat: '#,##0' } },
    { op: 'set_column_width', column: 'A', width: 18 },
    { op: 'set_column_width', column: 'B', width: 10 },
    { op: 'set_column_width', column: 'C', width: 12, count: 2 },
    { op: 'set_column_width', column: 'E', width: 10, count: 6 },
    { op: 'freeze_panes', row: 4 },
    { op: 'add_chart', chartType: 'stacked_column', range: 'A4:A11,G4:H11', cell: 'A15', width: 620, height: 230, title: '프로젝트별 시간: 완료 대 남은 시간' },
    { op: 'add_note', cell: 'G4', text: '출처: 팀별 주간 타임시트 합계 (예시 수치)' },
    { op: 'set_page_setup', orientation: 'landscape', printArea: 'A1:J33', fitToPagesWide: 1 },
  ],
};



