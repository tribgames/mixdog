// BRIEF
// subject/audience/action: 모아페이 2026 상반기 IR — 기관투자자가 시리즈 D 참여 검토 미팅을 잡게 한다
// reading mode: balanced · argument mode: pyramid
// directions: A soft-rounded, hue 215 단일 블루, concord, rings — 토스 IR 클론(화이트 캔버스와 차콜 텍스트, 토스블루 한 색) · B data-journalism, hue 225 네이비와 코랄, bands 헤드 · selected: A · why: 레퍼런스(토스 디자인 시스템) 클론 요청, 화이트 캔버스 위 블루 한 색이 브랜드 인상과 일치
// style: soft-rounded · palette: hue 215 · accent hue 215 · accent: 3182F6 · type: MODE balanced → body 15pt · script: ko · pairing: concord · fonts: noto
// motif: rings · rhythm: anchor, dense, dense, dense, breathing, dense, dense, dense, anchor
// facts: sample — 가상의 핀테크 회사 IR 시안이며 모든 수치는 예시
// slide plan: 1 job: cover · relationship: none · move: 모아페이가 한 앱 금융 플랫폼임을 안다 · composition: 블루 전면 필드 위 포스터 제목, 우측 1/3 오브 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: claim · relationship: focal claim · move: 흑자 전환과 규모를 한눈에 잡는다 · composition: 좌측 디스플레이 헤드라인, 아래 네 개 숫자 스탯밴드 · carriers: statement, hero · texture: keywords · rhythm: dense
//   3 job: evidence · relationship: evidence · move: MAU 성장이 꺾이지 않았음을 본다 · composition: 좌측 7 칼럼 막대차트, 우측 3 칼럼 리딩 레일 · carriers: chart, prose · texture: prose · rhythm: dense
//   4 job: evidence · relationship: contrast · move: 매출과 이익이 함께 늘었음을 본다 · composition: 같은 베이스라인의 쌍 차트 두 개 · carriers: chart · texture: keywords · rhythm: dense
//   5 job: structure · relationship: parent · move: 송금이 모든 서비스의 입구임을 이해한다 · composition: 좌측 스테이지 위 허브와 위성, 우측 리딩 · carriers: diagram, prose · texture: prose · rhythm: breathing
//   6 job: comparison · relationship: contrast · move: 경쟁사 대비 차별점을 판단한다 · composition: 본문 폭 전체 비교 표, 판정 열 · carriers: table · texture: keywords · rhythm: dense
//   7 job: evidence · relationship: evidence · move: 단위 경제성이 건강함을 확인한다 · composition: KPI 카드 네 장 한 줄, 하나만 액센트 · carriers: hero · texture: keywords · rhythm: dense
//   8 job: process · relationship: order · move: 향후 18개월 로드맵을 안다 · composition: 스테이지 위 타임라인, 아래 세 칼럼 읽기 · carriers: diagram, prose · texture: list · rhythm: dense
//   9 job: closing · relationship: none · move: 미팅을 잡는다 · composition: 커버의 블루 필드 반복, 포스터 요청 문장, 오브 절반 크기 · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'soft-rounded', hue: 215, accentHue: 215, mode: 'balanced', script: 'ko', pairing: 'concord', fonts: 'noto' });

// 1 cover
{
  const s = quiet();
  field(s, 0, 0, W, H, T.accentLabel.fill);
  await orb(s, W - 3.2, H / 2, 4.2, { light: T.paper, shade: T.accentDeep, glowAlpha: 0.25 });
  poster(s, '모든 금융을 한 앱에서, 더 쉽게', { x: M, y: 2.2, w: 7.6, kicker: '2026 상반기 IR', color: T.accentLabel.color, kickerColor: T.accentLabel.color, line: '모아페이 · 2026년 9월 · 투자자 설명 자료', lineColor: T.accentLabel.color });
}

// 2 claim
{
  const s = light();
  const b = display(s, '월 거래자 1,420만 명, 첫 분기 흑자', { kicker: 'SUMMARY', emph: '첫 분기 흑자', line: '송금으로 들어온 사용자가 결제와 대출로 이어지며 2026년 2분기 처음으로 영업이익을 냈다.' });
  dateline(s, '2026-09 · IR');
  statBand(s, M, b + GAP.between * 1.5, W - 2 * M, [
    { value: '1,420', unit: '만', label: '월간 활성 사용자' },
    { value: '38.2', unit: '조', label: '연간 거래액' },
    { value: '4,120', unit: '억', label: '상반기 매출' },
    { value: '86', unit: '억', label: '2분기 영업이익' },
  ]);
  source(s, '출처: 모아페이 내부 집계 (예시 수치)');
}

// 3 MAU chart + reading
{
  const s = light();
  const top = head(s, '성장', 'MAU는 5년 연속 두 자릿수로 늘었다');
  const seam = splitAt(M, W - 2 * M, 7, 3);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'col', labels: ['2021', '2022', '2023', '2024', '2025', '2026 상반기'], series: [{ name: 'MAU(만 명)', values: [410, 620, 830, 1040, 1260, 1420] }] });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '성장률', text: '2021년 410만 명에서 3.5배로 늘었고, 올해 상반기에도 12.7% 증가했다.' },
    { label: '유입 경로', text: '신규 사용자의 64%가 지인 송금 링크로 들어온다. 광고비 없이 퍼지는 구조다.' },
  ]);
  source(s, '단위: 만 명, 월평균 · 출처: 모아페이 내부 집계 (예시 수치)');
}

// 4 paired charts
{
  const s = light();
  const top = head(s, '실적', '매출이 늘면서 영업손실이 이익으로 바뀌었다', { sub: '2025년 1분기부터 2026년 2분기까지 여섯 분기 추이' });
  const cols = spans(M, W - 2 * M, [1, 1]);
  const q = ['25.1Q', '25.2Q', '25.3Q', '25.4Q', '26.1Q', '26.2Q'];
  text(s, '분기 매출 (억 원)', cols[0].x, top, cols[0].w, 'strong');
  chart(s, cols[0].x, top + 0.45, cols[0].w, avail(top + 0.45), { type: 'col', labels: q, series: [{ name: '매출', values: [1480, 1560, 1690, 1820, 1970, 2150] }] });
  text(s, '분기 영업이익 (억 원)', cols[1].x, top, cols[1].w, 'strong');
  chart(s, cols[1].x, top + 0.45, cols[1].w, avail(top + 0.45), { type: 'col', labels: q, min: -200, series: [{ name: '영업이익', values: [-182, -140, -96, -41, -12, 86] }] });
  source(s, '출처: 모아페이 분기 실적 (예시 수치)');
}

// 5 hub
{
  const s = light();
  const top = head(s, '플랫폼', '송금이 모든 금융 서비스의 입구다');
  const seam = splitAt(M, W - 2 * M, 6, 4);
  const st = stage(s, seam.left.x, top, seam.left.w, avail(top));
  await hub(s, st, { label: '송금', icon: 'banknote' }, [
    { label: '결제', icon: 'credit-card', active: true },
    { label: '대출', icon: 'landmark' },
    { label: '투자', icon: 'trending-up' },
    { label: '보험', icon: 'shield' },
    { label: '신용관리', icon: 'gauge' },
  ]);
  reading(s, seam.right.x, st.y, seam.right.w, [
    { label: '교차 사용', text: '송금 사용자의 48%가 90일 안에 두 번째 서비스를 쓴다.' },
    { label: '결제가 다음 축', text: '결제 거래액은 전년 대비 71% 늘어 매출 기여 1위가 됐다.' },
    { label: '비용 구조', text: '추가 서비스 획득 비용은 신규 가입의 5분의 1이다.' },
  ]);
  source(s, '출처: 모아페이 코호트 분석, 2026년 6월 기준 (예시 수치)');
}

// 6 comparison table
{
  const s = light();
  const top = head(s, '경쟁', '수수료와 속도 모두에서 앞선다');
  table(s, M, top, W - 2 * M, ['항목', '모아페이', 'A사', 'B사', '판정'], [
    ['송금 수수료', '무료', '500원', '무료 (월 5회)', '우위'],
    ['평균 송금 시간', '1.2초', '3.8초', '2.4초', '우위'],
    ['가맹점 결제 수수료', '1.6%', '2.1%', '1.8%', '우위'],
    ['대출 비교 금융사 수', '62곳', '48곳', '71곳', '보통'],
    ['투자 상품 수', '1,200개', '3,400개', '900개', '열위'],
    ['해외 송금 국가 수', '18개국', '42개국', '11개국', '열위'],
    ['고객 문의 응답 시간', '2분', '11분', '6분', '우위'],
    ['앱 평점', '4.8', '4.5', '4.6', '우위'],
  ], { verdict: 4, tones: ['positive', 'positive', 'positive', 'warning', 'critical', 'critical', 'positive', 'positive'], colW: [3.2, 2.2, 2.0, 2.2, 2.53] });
  source(s, '출처: 각사 앱 공시 비교, 2026년 8월 (예시 수치)');
}

// 7 KPI cards
{
  const s = light();
  const top = head(s, '단위 경제성', '사용자 한 명이 비용의 4.2배를 벌어온다', { sub: 'LTV와 CAC는 2025년 가입 코호트 기준' });
  const b = await cards(s, M, top, W - 2 * M, [
    { value: '4.2', unit: '배', label: 'LTV / CAC', detail: '업계 평균 3배를 넘는다', icon: 'scale', accent: true },
    { value: '8,400', unit: '원', label: '사용자 획득 비용', detail: '전년 대비 22% 낮아졌다', icon: 'user-plus' },
    { value: '14', unit: '개월', label: '회수 기간', detail: '가입 후 비용 회수까지', icon: 'clock' },
    { value: '81', unit: '%', label: '12개월 유지율', detail: '가입 코호트 기준', icon: 'repeat' },
  ], { columns: 4, h: 2.6 });
  reading(s, M, b + GAP.between, W - 2 * M, ['획득 비용이 낮아진 것은 지인 송금 유입 비중이 64%로 올라갔기 때문이다. 유지율이 80%를 넘으면서 회수 기간도 18개월에서 14개월로 줄었다.']);
  source(s, '출처: 모아페이 코호트 분석 (예시 수치)');
}

// 8 roadmap
{
  const s = light();
  const top = head(s, '로드맵', '18개월 안에 결제와 대출을 두 번째 축으로 세운다');
  const colsSpec = [
    { title: '결제', items: ['오프라인 가맹점 30만 곳', 'QR 결제 전국 확대'] },
    { title: '대출', items: ['대환대출 자동 비교', '중금리 자체 심사 모델'] },
    { title: '해외', items: ['일본과 베트남 송금', '현지 파트너 2곳 계약'] },
  ];
  const sh = shareDown(top, columnsH(M, W - 2 * M, colsSpec));
  const st = stage(s, M, sh.stage.y, W - 2 * M, sh.stage.h);
  timeline(s, st.x, st.y, st.w, [
    { when: '26.4Q', label: '오프라인 결제' },
    { when: '27.1Q', label: '대환대출 비교' },
    { when: '27.2Q', label: '해외 송금', active: true },
    { when: '27.4Q', label: '자체 심사 모델' },
    { when: '28.1Q', label: '흑자 연간화' },
  ], { ground: st.ground, h: st.h });
  columns(s, M, sh.under.y, W - 2 * M, colsSpec);
  source(s, '계획은 2026년 9월 기준이며 변경될 수 있다');
}

// 9 closing
{
  const s = quiet();
  field(s, 0, 0, W, H, T.accentLabel.fill);
  await orb(s, W - 2.6, H / 2, 2.4, { light: T.paper, shade: T.accentDeep, glowAlpha: 0.25 });
  poster(s, '다음 1,000만 명을 함께 만들어 주십시오', { x: M, y: 2.4, w: 7.8, size: TYPE.cover, kicker: '시리즈 D', color: T.accentLabel.color, kickerColor: T.accentLabel.color, line: 'ir@moapay.example · 모아페이 IR팀', lineColor: T.accentLabel.color });
}

await pres.writeFile({ fileName: OUTPUT });
