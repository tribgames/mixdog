// An issue log (reference: a Jira CSV export tidied into a sheet): a long wrapped description column, status
// dropdown, a date column, and a filter. Checks that wrapped rows grow to show their text on both backends.
const rows = [
  ['OPS-101', '야간 출고 라벨이 두 번 출력된다', '평택 허브의 3번 프린터가 같은 송장을 두 번 출력한다. 드라이버 재설치 후에도 재현되며 오전 2시에서 4시 사이에만 발생한다.', '진행 중', '2026-09-18'],
  ['OPS-102', '반품 스캔 지연', '인천 허브 반품 라인의 스캐너 응답이 평균 4초 걸린다.', '대기', '2026-09-19'],
  ['OPS-103', '대시보드 출고율 계산 오류', '취소된 주문이 분모에 포함되어 출고율이 1.2%포인트 낮게 표시된다. 9월 1일 배포 이후 발생했다.', '완료', '2026-09-20'],
];
export default {
  path: 'outputs/office-live-test/xlsx/issues-log.xlsx',
  create: { format: 'xlsx' },
  operations: [
    { op: 'rename_sheet', name: '이슈' },
    { op: 'set_range', range: 'A1:E1', values: [['키', '제목', '설명', '상태', '등록일']] },
    { op: 'set_style', range: 'A1:E1', properties: { bold: true, color: 'FFFFFF', fillColor: '1F2A44' } },
    { op: 'set_range', range: 'A2:E4', values: rows },
    { op: 'set_style', range: 'A2:E4', properties: { verticalAlignment: 'top' } },
    { op: 'set_style', range: 'B2:C4', properties: { wrapText: true } },
    { op: 'set_column_width', column: 'A', width: 10 },
    { op: 'set_column_width', column: 'B', width: 24 },
    { op: 'set_column_width', column: 'C', width: 48 },
    { op: 'set_column_width', column: 'D', width: 10 },
    { op: 'set_column_width', column: 'E', width: 12 },
    { op: 'add_validation', range: 'D2:D50', formula1: '"대기,진행 중,완료"' },
    { op: 'set_autofilter', range: 'A1:E4' },
    { op: 'freeze_panes', row: 1 },
    { op: 'set_page_setup', orientation: 'landscape', printArea: 'A1:E4', fitToPagesWide: 1 },
  ],
};
