// compose_sheet preset (opt-in) on a Korean operating table: how the built-in dashboard reads.
export default {
  path: 'outputs/office-live-test/template/compose-sheet-com.xlsx',
  create: { mode: 'background',  format: 'xlsx' },
  operations: [
    {
      op: 'compose_sheet',
      title: '허브별 야간 출고 실적',
      subtitle: '2026년 9월 · 단위: 건',
      tableName: 'Hubs',
      columnFormats: { '정시율': '0.0%' },
      headers: ['허브', '처리량 (건)', '지연 (분)', '정시율'],
      rows: [
        ['대전', 128400, 38, 0.912],
        ['광주', 84200, 12, 0.968],
        ['부산', 97300, 9, 0.974],
        ['인천', 143900, 21, 0.941],
        ['대구', 76100, 7, 0.981],
      ],
      metrics: [
        { label: '총 처리량', formula: '=SUM(Hubs[처리량 (건)])', numberFormat: '#,##0' },
        { label: '최대 지연', formula: '=MAX(Hubs[지연 (분)])', numberFormat: '0"분"' },
      ],
    },
  ],
};
