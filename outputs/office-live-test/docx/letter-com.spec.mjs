// Stripe-annual-letter clone (sample figures): native Word authoring through the working-tree runtime.
const F = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const INK = '0A2540', BODY = '425466', MUTED = '6B7280', ACCENT = '533AFD', FIELD = 'F1EEFF';
const body = (text, extra = {}) => ({ op: 'append_text', text, properties: { ...F, size: 10.5, lineSpacing: 18, spacingAfter: 8, alignment: 'left', color: BODY, ...extra } });
const h1 = (text) => ({ op: 'append_text', text, style: 'Heading 1', properties: { ...F, size: 15, bold: true, color: INK, spacingBefore: 22, spacingAfter: 6, keepWithNext: true } });
const h2 = (text) => ({ op: 'append_text', text, style: 'Heading 2', properties: { ...F, size: 12.5, bold: true, color: INK, spacingBefore: 12, spacingAfter: 4, keepWithNext: true } });
const caption = (text) => ({ op: 'append_text', text, properties: { ...F, size: 9, color: MUTED, spacingBefore: 4, spacingAfter: 14 } });
const table = (values, widths) => ({ op: 'add_table', values, properties: { fontName: 'Noto Sans', fontNameEastAsia: 'Noto Sans KR', fontSize: 9.5, color: INK, columnAlignments: ['left', 'right', 'right', 'right'], columnWidths: widths, keepWithNext: true } });
const callout = { ...F, shading: FIELD, indentLeft: 12, indentRight: 12, border: { side: 'left', size: 12, color: ACCENT } };

export default {
  path: 'outputs/office-live-test/docx/moapay-annual-letter.v2-com.docx',
  create: { mode: 'background' },
  operations: [
    { op: 'set_page', properties: { pageSize: 'a4', topMargin: 72, bottomMargin: 72, leftMargin: 72, rightMargin: 72 } },
    { op: 'append_text', text: 'ANNUAL LETTER · 2026', properties: { ...F, size: 9.5, bold: true, color: ACCENT, spacingAfter: 6 } },
    { op: 'append_text', text: '더 쉬운 금융이 더 많은 사람에게 닿았다', style: 'Title', properties: { ...F, size: 26, bold: true, color: INK, alignment: 'left', spacingAfter: 8, lineSpacing: 34 } },
    { op: 'append_text', text: '모아페이 주주와 사용자에게 보내는 2026년 상반기 편지', properties: { ...F, size: 13, color: '374151', spacingAfter: 8 } },
    { op: 'append_text', text: '2026년 9월 · 대표 김하늘', properties: { ...F, size: 9.5, color: MUTED, spacingAfter: 0 } },
    { op: 'append_text', text: '', properties: { border: { side: 'bottom', size: 8, color: ACCENT }, spacingAfter: 18 } },
    { op: 'add_table', values: [['1,420만', '38.2조', '86억'], ['월간 활성 사용자', '연간 거래액', '2분기 영업이익']], properties: { fontName: 'Arial', fontNameEastAsia: 'Noto Sans KR', fontSize: 22, color: ACCENT, columnAlignments: ['left', 'left', 'left'], repeatHeader: false, borders: { top: { enabled: false }, left: { enabled: false }, right: { enabled: false }, insideV: { enabled: false }, insideH: { enabled: false }, bottom: { style: 'single', size: 4, color: 'C9CED6' } } } },
    ...[1, 2, 3].map((col) => ({ op: 'set_table_cell_style', table: 1, row: 2, col, properties: { fontSize: 9, color: MUTED, bold: false } })),
    h1('1. 요약'),
    body('올해 상반기 모아페이는 처음으로 분기 영업이익을 냈습니다. 2분기 영업이익은 86억 원으로, 1년 전 182억 원의 손실에서 돌아섰습니다. 새로운 사업을 더한 결과가 아니라, 송금으로 들어온 사용자가 결제와 대출로 자연스럽게 이어진 결과입니다.'),
    body('우리는 광고로 사용자를 사지 않았습니다. 신규 사용자의 64%는 지인이 보낸 송금 링크로 들어왔고, 사용자 획득 비용은 전년보다 22% 낮아졌습니다.'),
    { op: 'append_text', text: '핵심', properties: { ...callout, bold: true, size: 8.5, color: ACCENT, spacingBefore: 6, spacingAfter: 2 } },
    { op: 'append_text', text: '사용자 한 명이 벌어 오는 가치가 획득 비용의 4.2배에 이르렀습니다. 다음 18개월은 이 구조를 결제와 대출로 넓히는 데 씁니다.', properties: { ...callout, size: 10.5, lineSpacing: 18, color: INK, spacingAfter: 12 } },
    h1('2. 사용자'),
    body('월간 활성 사용자는 5년 연속 두 자릿수로 늘었습니다. 2021년 410만 명이던 사용자는 올해 상반기 1,420만 명이 되었습니다.'),
    table([['연도', 'MAU (만 명)', '증가율', '신규 유입 중 송금 링크'], ['2021', '410', '—', '41%'], ['2022', '620', '51.2%', '47%'], ['2023', '830', '33.9%', '53%'], ['2024', '1,040', '25.3%', '58%'], ['2025', '1,260', '21.2%', '61%'], ['2026 상반기', '1,420', '12.7%', '64%']], [130, 100, 100, 121]),
    caption('표 1. 연도별 월간 활성 사용자. 출처: 모아페이 내부 집계 (예시 수치)'),
    h2('2.1 왜 송금인가'),
    body('송금은 두 사람을 동시에 부릅니다. 받는 사람은 앱이 없어도 돈을 받을 수 있고, 그 순간이 첫 경험이 됩니다. 송금 사용자의 48%가 90일 안에 두 번째 서비스를 씁니다.'),
    { op: 'append_text', text: '송금 버튼을 누르는 순간이 금융을 처음 믿게 되는 순간입니다.', properties: { ...F, size: 12.5, lineSpacing: 20, color: '1F2937', indentLeft: 16, border: { side: 'left', size: 16, color: ACCENT }, spacingBefore: 6, spacingAfter: 2 } },
    { op: 'append_text', text: '— 사용자 인터뷰, 2026년 5월', properties: { ...F, size: 9, color: MUTED, indentLeft: 16, spacingAfter: 12 } },
    h1('3. 수익성'),
    body('매출은 여섯 분기 동안 1,480억 원에서 2,150억 원으로 늘었고, 같은 기간 영업손익은 182억 원 손실에서 86억 원 이익으로 바뀌었습니다.'),
    table([['분기', '매출 (억 원)', '영업손익 (억 원)', '영업이익률'], ['2025년 1분기', '1,480', '-182', '-12.3%'], ['2025년 2분기', '1,560', '-140', '-9.0%'], ['2025년 3분기', '1,690', '-96', '-5.7%'], ['2025년 4분기', '1,820', '-41', '-2.3%'], ['2026년 1분기', '1,970', '-12', '-0.6%'], ['2026년 2분기', '2,150', '86', '4.0%']], [130, 100, 121, 100]),
    caption('표 2. 분기 실적. 출처: 모아페이 분기 실적 (예시 수치)'),
    h1('4. 다음 18개월'),
    body('오프라인 가맹점 30만 곳으로 결제를 넓힙니다.', { listKind: 'number', spacingAfter: 4 }),
    body('대환대출 자동 비교와 중금리 자체 심사 모델을 내놓습니다.', { listKind: 'number', spacingAfter: 4 }),
    body('일본과 베트남으로 송금을 엽니다.', { listKind: 'number', spacingAfter: 12 }),
    body('우리가 처음 약속한 것은 금융을 쉽게 만드는 일이었습니다. 그 약속이 이제 숫자로도 증명되기 시작했습니다. 늘 믿어 주셔서 감사합니다.'),
    { op: 'append_text', text: '김하늘 드림', properties: { ...F, size: 10.5, bold: true, color: INK, spacingBefore: 8 } },
    { op: 'set_header_footer', kind: 'header', text: '모아페이 · 2026 상반기 주주서한', properties: { ...F, size: 8.5, color: MUTED } },
    { op: 'add_page_numbers' },
  ],
};
