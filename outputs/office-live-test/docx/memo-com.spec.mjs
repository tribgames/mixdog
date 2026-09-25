// A Korean policy memo (reference: a KDI 정책 메모 layout): title block, footnoted sources, a link, a comment,
// and two headings — the footnote marks and the page foot are what is checked.
const F = { name: 'Noto Serif', nameEastAsia: 'Noto Serif KR' };
const S = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const body = (text) => ({ op: 'append_text', text, properties: { ...F, size: 10.5, lineSpacing: 18, spacingAfter: 8, color: '1F2937' } });
export default {
  path: 'outputs/office-live-test/docx/memo-com.docx',
  create: { mode: 'background' },
  operations: [
    { op: 'set_page', properties: { pageSize: 'a4', topMargin: 64, bottomMargin: 64, leftMargin: 72, rightMargin: 72 } },
    { op: 'append_text', text: '정책 메모 2026-09', properties: { ...S, size: 9, bold: true, color: '1D4ED8', spacingAfter: 4 } },
    { op: 'append_text', text: '야간 배송 확대의 조건', style: 'Title', properties: { ...F, size: 24, bold: true, color: '111827', spacingAfter: 6 } },
    { op: 'append_text', text: '도시 물류 연구소 · 2026년 9월 23일', properties: { ...S, size: 9.5, color: '6B7280', spacingAfter: 18, border: { side: 'bottom', size: 6, color: '111827' } } },
    { op: 'append_text', text: '요약', style: 'Heading 1', properties: { ...S, size: 14, bold: true, color: '111827', spacingBefore: 6, spacingAfter: 6, keepWithNext: true } },
    body('시범 구역의 주간 정체 지수는 6주 동안 평균 6포인트 내려갔다. 소음 민원은 늘지 않았다. 확대의 조건은 저소음 차량 인증과 분기별 소음 공개다.'),
    body('정체 지수 하락은 시범 구역 밖에서는 나타나지 않아 계절 요인으로 보기 어렵다.'),
    { op: 'append_text', text: '근거', style: 'Heading 1', properties: { ...S, size: 14, bold: true, color: '111827', spacingBefore: 12, spacingAfter: 6, keepWithNext: true } },
    body('배송 기사는 야간 운행이 같은 구간을 한 시간 안에 마친다고 답했다. 사업자는 차량당 하루 두 건을 더 배송했다. 자세한 수치는 교통국 자료실에 있다.'),
    { op: 'add_note', find: '평균 6포인트', text: '시 교통국, 「주간 정체 지수 주보」 2026년 8–9월호. 평일 07–19시 평균 (예시 자료).' },
    { op: 'add_note', find: '두 건을 더', text: '참여 사업자 12곳의 배차 기록 집계 (예시 자료).' },
    { op: 'add_hyperlink', find: '교통국 자료실', address: 'https://example.org/traffic' },
    { op: 'add_comment', find: '계절 요인', text: '작년 같은 기간 수치를 함께 넣을까요?', author: '검토자' },
  ],
};
