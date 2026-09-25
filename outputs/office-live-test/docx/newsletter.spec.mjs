// A two-column newsletter page with a picture and its caption (native-authoring: columns are a section property).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('outputs/office-live-test/docx/assets', { recursive: true });
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B5CAD"/><stop offset="1" stop-color="#12B886"/></linearGradient></defs>
  <rect width="1200" height="675" fill="url(#g)"/>
  <g fill="#FFFFFF" opacity="0.9">${[0, 1, 2, 3, 4].map((i) => `<rect x="${140 + i * 190}" y="${520 - [180, 240, 300, 360, 430][i]}" width="120" height="${[180, 240, 300, 360, 430][i]}" rx="12"/>`).join('')}</g>
</svg>`)).png().toFile('outputs/office-live-test/docx/assets/growth.png');

const F = { name: 'Noto Serif', nameEastAsia: 'Noto Serif KR' };
const S = { name: 'Noto Sans', nameEastAsia: 'Noto Sans KR' };
const INK = '14213D', BODY = '3A3F4B', MUTED = '6B7280', ACCENT = '0B5CAD';
const body = (text, extra = {}) => ({ op: 'append_text', text, properties: { ...F, size: 10.5, lineSpacing: 18, spacingAfter: 8, alignment: 'left', color: BODY, ...extra } });
const long = '야간 배송을 허용한 첫 달, 세 도시의 주간 정체 지수는 평균 6포인트 내려갔다. 기사들은 대기가 줄었다고 말했고, 사업자는 차량 한 대당 하루 두 건을 더 배송했다. 주민 민원은 소음 기준을 지키는 저소음 차량만 허용한 덕분에 늘지 않았다.';

export default {
  path: 'outputs/office-live-test/docx/newsletter.docx',
  operations: [
    { op: 'set_page', properties: { pageSize: 'a4', topMargin: 60, bottomMargin: 60, leftMargin: 60, rightMargin: 60 } },
    { op: 'append_text', text: 'CITY LOGISTICS WEEKLY · No. 38', properties: { ...S, size: 9, bold: true, color: ACCENT, spacingAfter: 4 } },
    { op: 'append_text', text: '밤이 바뀌자 낮이 풀렸다', style: 'Title', properties: { ...F, size: 30, bold: true, color: INK, alignment: 'left', spacingAfter: 6, lineSpacing: 38 } },
    { op: 'append_text', text: '야간 배송 시범 운영 첫 달 보고 · 2026년 9월', properties: { ...S, size: 10.5, color: MUTED, spacingAfter: 10, border: { side: 'bottom', size: 6, color: INK } } },
    { op: 'add_image', path: 'outputs/office-live-test/docx/assets/growth.png', altText: '다섯 달 동안 높아지는 막대 다섯 개로 그린 배송 건수 증가 그림', properties: { width: 475, height: 267 } },
    { op: 'append_text', text: '그림 1. 시범 운영 뒤 하루 배송 건수 추이 (예시 그림)', properties: { ...S, size: 9, color: MUTED, spacingBefore: 4, spacingAfter: 12 } },
    { op: 'insert_break', kind: 'section_continuous' },
    { op: 'set_page', properties: { columns: 2, columnSpacing: 24 } },
    { op: 'append_text', text: '정체가 먼저 반응했다', style: 'Heading 2', properties: { ...S, size: 13, bold: true, color: INK, spacingBefore: 0, spacingAfter: 4, keepWithNext: true } },
    body(long), body(long),
    { op: 'append_text', text: '기사의 하루가 짧아졌다', style: 'Heading 2', properties: { ...S, size: 13, bold: true, color: INK, spacingBefore: 10, spacingAfter: 4, keepWithNext: true } },
    body(long),
    { op: 'append_text', text: '“밤에 나가면 한 시간이면 끝납니다.”', properties: { ...F, size: 14, italic: true, color: ACCENT, indentLeft: 12, border: { side: 'left', size: 16, color: ACCENT }, spacingBefore: 6, spacingAfter: 8 } },
    body(long),
    { op: 'insert_break', kind: 'section_continuous' },
    { op: 'set_page', properties: { columns: 1 } },
    { op: 'append_text', text: '다음 호: 저소음 차량 인증 기준', properties: { ...S, size: 9, color: MUTED, spacingBefore: 12 } },
    { op: 'set_header_footer', kind: 'footer', text: '도시 물류 연구소 · citylogistics.example', properties: { ...S, size: 8, color: MUTED } },
  ],
};
