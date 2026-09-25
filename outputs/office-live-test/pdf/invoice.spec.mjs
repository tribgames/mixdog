// Stripe-invoice clone (sample document) through the working-tree PDF writer.
export default {
  path: 'outputs/office-live-test/pdf/invoice.v2.pdf',
  create: {
    format: 'pdf',
    properties: { title: 'Invoice MP-2026-0917', author: '모아페이', pageSize: 'a4', margin: 56, pageNumbers: true },
    blocks: [
      { type: 'heading', text: '청구서', level: 1, size: 26, after: 14 },
      { type: 'table', headers: false, rows: [['청구서 번호', 'MP-2026-0917'], ['발행일', '2026-09-23'], ['지급 기한', '2026-10-23']], columnWidths: [1, 3], columnAlignments: ['left', 'left'], fontSize: 9.5, rowHeight: 18, after: 18 },
      { type: 'table', headers: ['보내는 곳', '받는 곳'], headerFill: '', rows: [['모아페이 주식회사', '한빛상사'], ['서울시 강남구 테헤란로 123', '부산시 해운대구 센텀중앙로 45'], ['billing@moapay.example', 'ap@hanbit.example']], columnWidths: [1, 1], columnAlignments: ['left', 'left'], fontSize: 9.5, rowHeight: 18, after: 22 },
      { type: 'heading', text: '₩3,410,000 · 2026년 10월 23일까지 납부', level: 2, size: 17, after: 4 },
      { type: 'paragraph', text: '결제 링크 또는 아래 계좌로 납부해 주십시오.', size: 10, color: '6B7280', after: 16 },
      { type: 'table', headers: ['항목', '수량', '단가', '금액'], headerFill: '', rows: [['비즈니스 플랜 (2026-09-23 ~ 2026-10-22)', '1', '₩2,400,000', '₩2,400,000'], ['추가 사용자 시트', '12', '₩50,000', '₩600,000'], ['송금 API 호출 초과분 (10만 건 단위)', '2', '₩100,000', '₩200,000']], columnWidths: [5, 1, 2, 2], fontSize: 10, after: 0 },
      { type: 'table', headers: false, totalRow: true, rows: [['', '공급가액', '₩3,100,000'], ['', '부가세 (10%)', '₩310,000'], ['', '합계', '₩3,410,000']], columnWidths: [5, 3, 2], columnAlignments: ['left', 'left', 'right'], fontSize: 10, after: 22 },
      { type: 'callout', label: '납부 계좌', text: '모아은행 123-456-789012 · 예금주 모아페이 주식회사 · 입금자명에 청구서 번호를 적어 주십시오.' },
      { type: 'caption', text: '문의: billing@moapay.example · 이 청구서는 예시 문서입니다.' },
    ],
  },
  operations: undefined,
};
