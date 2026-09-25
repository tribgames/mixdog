// A multi-page PDF report (reference: a McKinsey-style short brief): cover, stats, prose, a table long enough to
// cross a page, a heading that lands near a page foot, a picture, a quote, and a list. Stress-tests page flow.
const para = '야간 배송을 허용한 첫 달, 세 도시의 주간 정체 지수는 평균 6포인트 내려갔다. 기사들은 대기가 줄었다고 말했고, 사업자는 차량 한 대당 하루 두 건을 더 배송했다. 주민 민원은 소음 기준을 지키는 저소음 차량만 허용한 덕분에 늘지 않았다.';
const districts = ['강남', '서초', '송파', '마포', '영등포', '성동', '용산', '중구', '종로', '광진', '동작', '관악', '강서', '양천', '구로', '금천', '노원', '도봉', '강북', '성북', '은평', '서대문', '동대문', '중랑', '강동'];
export default {
  path: 'outputs/office-live-test/pdf/report.pdf',
  create: {
    format: 'pdf',
    properties: { title: '야간 배송 시범 운영 보고', author: '도시 물류 연구소', pageSize: 'a4', margin: 56, pageNumbers: true, footer: '도시 물류 연구소 · 예시 문서' },
    blocks: [
      { type: 'cover', eyebrow: 'CITY LOGISTICS BRIEF', title: '밤이 바뀌자 낮이 풀렸다', subtitle: '야간 배송 시범 운영 첫 달 보고', meta: ['2026년 9월', '도시 물류 연구소'] },
      { type: 'stats', items: [{ value: '−6p', label: '주간 정체 지수' }, { value: '+2건', label: '차량당 하루 배송' }, { value: '0건', label: '소음 민원 증가' }] },
      { type: 'heading', text: '요약', level: 1 },
      { type: 'paragraph', text: para },
      { type: 'paragraph', text: para },
      { type: 'heading', text: '구별 결과', level: 1 },
      { type: 'paragraph', text: '아래 표는 25개 구의 시범 전후 정체 지수와 야간 배송 건수를 보여 준다. 수치는 예시다.' },
      {
        type: 'table',
        headers: ['구', '시범 전 정체 지수', '시범 후 정체 지수', '변화', '야간 배송 (건/일)'],
        rows: districts.map((name, i) => [name, String(60 + (i * 7) % 23), String(54 + (i * 5) % 21), `${-1 - (i % 9)}p`, (1200 + i * 137).toLocaleString('en-US')]),
        columnWidths: [2, 3, 3, 2, 3],
        columnAlignments: ['left', 'right', 'right', 'right', 'right'],
        fontSize: 9.5,
      },
      { type: 'caption', text: '표 1. 구별 정체 지수와 야간 배송 건수 (예시 수치)' },
      { type: 'paragraph', text: para },
      { type: 'paragraph', text: para },
      { type: 'paragraph', text: para },
      { type: 'heading', text: '현장의 목소리', level: 1 },
      { type: 'quote', text: '밤에 나가면 한 시간이면 끝납니다. 낮에는 세 시간 걸리던 구간입니다.', attribution: '송파구 배송 기사' },
      { type: 'image', path: 'outputs/office-live-test/docx/assets/growth.png', width: 400 },
      { type: 'caption', text: '그림 1. 시범 뒤 하루 배송 건수 추이 (예시 그림)' },
      { type: 'heading', text: '다음 단계', level: 1 },
      { type: 'list', items: ['저소음 차량 인증 기준을 마련한다', '시범 구역을 25개 구 전체로 넓힌다', '주민 소음 측정을 분기마다 공개한다'] },
      { type: 'callout', label: '권고', text: '2027년 1분기까지 전 구역 확대를 결정하되, 소음 측정 공개를 조건으로 둔다.' },
    ],
  },
  operations: undefined,
};

