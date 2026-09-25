// One-page résumé (reference: a clean two-column CV template — name header, rule, dated experience rows with the
// dates in a right-aligned column, bulleted achievements, a skills strip). Stresses borderless layout tables,
// tab-free alignment, lists, and keeping everything on one A4 page.
const S = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const INK = '111827', BODY = '374151', MUTED = '6B7280', ACCENT = '1D4ED8';
const NONE = { enabled: false };
const layout = { borders: { top: NONE, left: NONE, right: NONE, bottom: NONE, insideV: NONE, insideH: NONE }, headerBold: false, fontSize: 10, fontName: S.name, fontNameEastAsia: S.nameEastAsia, color: INK };
const section = (text) => ({ op: 'append_text', text, properties: { ...S, size: 10, bold: true, color: ACCENT, spacingBefore: 14, spacingAfter: 6, keepWithNext: true, border: { side: 'bottom', size: 4, color: 'D1D5DB' } } });
const role = (title, org, dates) => ({ op: 'add_table', values: [[`${title} · ${org}`, dates]], properties: { ...layout, columnWidths: [380, 100], columnAlignments: ['left', 'right'], keepWithNext: true } });
const bullet = (text) => ({ op: 'append_text', text, properties: { ...S, size: 9.5, color: BODY, lineSpacing: 14, spacingAfter: 2, listKind: 'bullet' } });

export default {
  path: 'outputs/office-live-test/docx/resume-com.docx',
  create: { mode: 'background' },
  operations: [
    { op: 'set_page', properties: { pageSize: 'a4', topMargin: 48, bottomMargin: 48, leftMargin: 56, rightMargin: 56 } },
    { op: 'append_text', text: '김재영', style: 'Title', properties: { ...S, size: 24, bold: true, color: INK, spacingAfter: 2 } },
    { op: 'append_text', text: '프로덕트 엔지니어 · 서울 · jaeyoung@example.com · github.com/jaeyoung', properties: { ...S, size: 9.5, color: MUTED, spacingAfter: 4 } },
    section('경력'),
    role('시니어 프로덕트 엔지니어', '모아페이', '2023 – 현재'),
    bullet('송금 화면을 다시 설계해 완료율을 71%에서 84%로 올렸다'),
    bullet('결제 API 응답 시간을 p95 420ms에서 180ms로 줄였다'),
    bullet('엔지니어 6명의 온보딩 과정을 만들어 첫 배포까지 걸리는 시간을 3주에서 5일로 줄였다'),
    role('프로덕트 엔지니어', '도시물류', '2020 – 2023'),
    bullet('야간 배송 배차 도구를 만들어 기사당 하루 배송을 2건 늘렸다'),
    bullet('Postgres 파티셔닝으로 월 1억 건 로그 조회를 12초에서 0.8초로 줄였다'),
    role('소프트웨어 엔지니어', '스타트업 A', '2018 – 2020'),
    bullet('React Native 앱 출시, 첫해 다운로드 40만'),
    section('학력'),
    role('컴퓨터공학 학사', '한국대학교', '2014 – 2018'),
    section('기술'),
    { op: 'add_table', values: [['언어', 'TypeScript, Go, Python, SQL'], ['인프라', 'AWS, Kubernetes, Terraform, Postgres'], ['제품', '결제, 실험 설계, 접근성']], properties: { ...layout, columnWidths: [70, 410], columnAlignments: ['left', 'left'] } },
  ],
};
