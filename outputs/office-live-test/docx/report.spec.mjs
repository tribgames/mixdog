// McKinsey-style long report (sample figures): TOC, footnotes, a landscape section for a wide table, page numbers.
const F = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const INK = '10233F', BODY = '374151', MUTED = '6B7280', ACCENT = '0B5CAD';
const body = (text, extra = {}) => ({ op: 'append_text', text, properties: { ...F, size: 10.5, lineSpacing: 18, spacingAfter: 8, alignment: 'left', color: BODY, ...extra } });
const h1 = (text, extra = {}) => ({ op: 'append_text', text, style: 'Heading 1', properties: { ...F, size: 16, bold: true, color: INK, spacingBefore: 18, spacingAfter: 6, keepWithNext: true, ...extra } });
const h2 = (text) => ({ op: 'append_text', text, style: 'Heading 2', properties: { ...F, size: 12.5, bold: true, color: INK, spacingBefore: 12, spacingAfter: 4, keepWithNext: true } });
const caption = (text) => ({ op: 'append_text', text, properties: { ...F, size: 9, color: MUTED, spacingBefore: 4, spacingAfter: 14 } });
const para = (n) => body(`${n}. 야간 물류는 주간 대비 처리량이 38% 많지만 인력은 22% 적다. 이 차이는 도크 대기와 재작업으로 이어지고, 결국 출고 마감 지연으로 나타난다. 이 장은 원인과 영향을 차례로 본다.`);

export default {
  path: 'outputs/office-live-test/docx/night-logistics-report.docx',
  operations: [
    { op: 'set_page', properties: { pageSize: 'a4', topMargin: 72, bottomMargin: 72, leftMargin: 72, rightMargin: 72 } },
    { op: 'append_text', text: 'OPERATIONS REVIEW · 2026', properties: { ...F, size: 9.5, bold: true, color: ACCENT, spacingAfter: 6 } },
    { op: 'append_text', text: '야간 출고 지연의 절반은 도크 한 곳에서 생긴다', style: 'Title', properties: { ...F, size: 24, bold: true, color: INK, alignment: 'left', spacingAfter: 8, lineSpacing: 32 } },
    { op: 'append_text', text: '물류센터 운영위원회 보고서 · 2026년 9월 · 예시 수치', properties: { ...F, size: 11, color: MUTED, spacingAfter: 18 } },
    { op: 'append_text', text: '목차', properties: { ...F, size: 15, bold: true, color: INK, keepWithNext: true, spacingAfter: 6 } },
    h1('1. 요약'),
    body('22시 이후 3번 도크의 적재 대기가 평균 38분이다. 이 대기가 야간 지연의 51%를 차지한다.'),
    body('도크를 방향별로 나누면 추가 인력 없이 대기를 없앨 수 있다.'),
    h1('2. 원인'),
    h2('2.1 물량 쏠림'),
    para(1), para(2),
    h2('2.2 셔틀 배차'),
    para(3), para(4),
    h1('3. 허브별 실적'),
    body('아래 표는 다섯 허브의 월별 야간 처리량과 지연을 보여 준다. 표가 넓어 가로 페이지에 둔다.'),
    { op: 'insert_break', kind: 'section_next' },
    { op: 'set_page', properties: { orientation: 'landscape' } },
    { op: 'add_table', values: [['허브', '4월', '5월', '6월', '7월', '8월', '9월', '평균 지연 (분)', '정시율'], ['대전', '118,200', '121,400', '124,900', '126,300', '127,800', '128,400', '38', '91.2%'], ['광주', '80,100', '81,300', '82,000', '83,100', '83,900', '84,200', '12', '96.8%'], ['부산', '91,200', '92,800', '94,100', '95,600', '96,800', '97,300', '9', '97.4%'], ['인천', '136,400', '138,100', '140,200', '141,800', '143,100', '143,900', '21', '94.1%'], ['대구', '71,800', '72,900', '74,100', '74,900', '75,600', '76,100', '7', '98.1%']], properties: { fontName: 'Noto Sans', fontNameEastAsia: 'Noto Sans KR', fontSize: 10, color: INK, columnAlignments: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'], keepWithNext: true } },
    caption('표 1. 허브별 야간 처리량 (건)과 지연. 출처: 물류센터 WMS 2026년 4–9월 (예시 수치)'),
    { op: 'insert_break', kind: 'section_next' },
    { op: 'set_page', properties: { orientation: 'portrait' } },
    h1('4. 권고'),
    body('10월 첫 주부터 3번 도크를 수도권과 영남 방향으로 나누어 시범 운영한다.'),
    body('효과는 3주 뒤 대기 시간과 정시율로 측정한다.'),
    { op: 'add_note', find: '51%', text: '2026년 7–9월 야간 지연 건수 기준 (WMS 로그, 예시)' },
    { op: 'insert_toc', paragraph: 4 },
    { op: 'set_header_footer', kind: 'header', text: '야간 물류 운영 보고서', properties: { ...F, size: 8.5, color: MUTED } },
    { op: 'add_page_numbers' },
  ],
};
