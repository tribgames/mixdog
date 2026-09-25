// BRIEF
// subject/audience/action: 도시 물류 연구소 2026 연례 리포트 — 시 의회 위원이 야간 배송 규제 완화안을 검토하게 한다
// reading mode: text · argument mode: narrative
// directions: A editorial, hue 25 테라코타와 틸, serif, waves — 연례 보고서 에디토리얼(좌측 레일, 세리프 제목) · B swiss-minimal, hue 210 · selected: A · why: 텍스트로 읽는 리포트라 레일과 세리프가 긴 문단을 받쳐 준다
// style: editorial · palette: hue 25 · accent hue 190 · accent: 1F7A8C · type: MODE text → body 13pt · script: ko · pairing: serif · fonts: noto
// motif: waves · rhythm: anchor, dense, dense, dense, anchor, dense, dense, dense, dense, anchor
// facts: sample — 가상의 연구소 연례 리포트 시안이며 모든 수치는 예시
// slide plan: 1 job: cover · relationship: none · move: 리포트의 주장을 안다 · composition: 종이 위 디스플레이 제목과 날짜선 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 비용이 어디서 늘었는지 본다 · composition: 워터폴 차트와 레일 · carriers: chart, prose · texture: prose · rhythm: dense
//   3 job: comparison · relationship: contrast · move: 규제 전후 배송 시간을 비교한다 · composition: 덤벨 네 줄과 행별 읽기 · carriers: diagram, prose · texture: prose · rhythm: dense
//   4 job: structure · relationship: order · move: 순환 구조를 이해한다 · composition: 스테이지 위 루프와 레일 · carriers: diagram, prose · texture: prose · rhythm: dense
//   5 job: section · relationship: focal claim · move: 두 번째 장으로 넘어간다 · composition: 어젠다와 현재 장 강조 · carriers: statement · texture: keywords · rhythm: anchor
//   6 job: process · relationship: membership · move: 누가 언제 무엇을 하는지 안다 · composition: 세 레인 스윔레인 · carriers: diagram · texture: keywords · rhythm: dense
//   7 job: structure · relationship: overlap · move: 공통 이익을 본다 · composition: 세 원 벤 다이어그램과 레일 · carriers: diagram, prose · texture: prose · rhythm: dense
//   8 job: evidence · relationship: evidence · move: 도시별 추이를 한눈에 본다 · composition: 작은 다중 차트 세 개 · carriers: chart · texture: keywords · rhythm: dense
//   9 job: claim · relationship: focal claim · move: 현장의 목소리를 듣는다 · composition: 큰 인용과 출처 · carriers: quote · texture: prose · rhythm: dense
//   10 job: closing · relationship: none · move: 검토 일정을 잡는다 · composition: 커버 필드 반복과 요청 · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'editorial', hue: 25, accentHue: 190, mode: 'text', script: 'ko', pairing: 'serif', fonts: 'noto' });

// 1 cover
{
  const s = light();
  const b = display(s, '야간 배송을 막는 규제가 도시 비용을 키운다', { kicker: 'ANNUAL REPORT 2026', emph: '도시 비용', line: '도시 물류 연구소는 2026년 한 해 동안 세 도시의 야간 배송 데이터를 모아, 규제가 교통과 비용에 주는 영향을 추적했다.' });
  dateline(s, '2026-09 · No. 12');
  ruledList(s, M, b + GAP.between, W - 2 * M, '이 리포트의 결론', ['야간 배송 제한이 주간 정체를 14% 키웠다', '제한을 풀면 도시 물류비가 연 1,280억 원 줄어든다', '소음 기준을 지키는 차량만 허용하면 민원은 늘지 않는다'], { size: TYPE.body });
  source(s, '도시 물류 연구소 · 예시 데이터');
}

// 2 waterfall
{
  const s = light();
  const top = head(s, '비용', '물류비 증가의 절반이 대기와 우회에서 나왔다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  waterfall(s, seam.left.x, top, seam.left.w, avail(top), [
    { label: '2024 물류비', value: 4200 }, { label: '대기', value: 380 }, { label: '우회', value: 260 }, { label: '인건비', value: 310 }, { label: '연료 절감', value: -120 }, { label: '2026 물류비', total: true },
  ]);
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '대기와 우회', text: '두 항목이 늘어난 비용 830억 원 가운데 640억 원을 차지했다.' },
    { label: '연료', text: '전기 트럭 전환으로 연료비는 120억 원 줄었다.' },
  ]);
  source(s, '단위: 억 원 · 세 도시 합산 (예시)');
}

// 3 dumbbell
{
  const s = light();
  const top = head(s, '시간', '규제 뒤 평균 배송 시간이 네 권역 모두에서 늘었다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  const st = stage(s, seam.left.x, top, seam.left.w, avail(top));
  const rows = [{ label: '도심', a: 42, b: 61 }, { label: '부도심', a: 38, b: 49 }, { label: '주거지', a: 33, b: 41 }, { label: '산업단지', a: 29, b: 31 }];
  const rowH = st.h / rows.length;
  dumbbell(s, st.x, st.y, st.w, rows, { rowH, format: (v) => `${v}분` });
  const readings = ['도심은 19분이 늘어 가장 크게 나빠졌다.', '부도심은 11분 늘었다.', '주거지는 8분 늘었다.', '산업단지는 거의 그대로다.'];
  readings.forEach((textLine, i) => { const h = readingH(seam.right.w, [textLine]); reading(s, seam.right.x, st.y + i * rowH + (rowH - h) / 2, seam.right.w, [textLine]); });
  source(s, '규제 전 2024년 3월, 규제 뒤 2025년 3월 평균 (예시)');
}

// 4 loop
{
  const s = light();
  const top = head(s, '구조', '정체와 비용이 서로를 키우는 고리가 생겼다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  const st = stage(s, seam.left.x, top, seam.left.w, avail(top));
  loop(s, st, [{ label: '주간 몰림', active: true }, '정체 증가', '배송 지연', '차량 추가'], { center: '악순환' });
  reading(s, seam.right.x, st.y, seam.right.w, [
    { label: '고리', text: '야간에 못 나간 물량이 주간으로 몰리고, 정체가 지연을 부르며, 지연을 메우려 차량을 더 넣는다.' },
    { label: '끊는 지점', text: '야간 허용은 첫 고리인 주간 몰림을 줄인다.' },
  ]);
  source(s, '연구소 분석 (예시)');
}

// 5 section agenda
{
  const s = dark();
  agenda(s, ['문제', '해법', '실행'], 1);
}

// 6 lanes
{
  const s = light();
  const top = head(s, '실행', '시와 사업자, 주민이 석 달씩 나눠 맡는다');
  await lanes(s, Z.body.x, top, Z.body.w, avail(top), [
    { name: '시', items: [{ label: '조례 개정', at: 0, span: 0.3, icon: 'landmark' }, { label: '소음 측정', at: 0.35, span: 0.3, icon: 'activity' }] },
    { name: '사업자', items: [{ label: '저소음 차량', at: 0.2, span: 0.35, icon: 'truck', active: true }, { label: '야간 배차', at: 0.6, span: 0.35, icon: 'clock' }] },
    { name: '주민', items: [{ label: '의견 수렴', at: 0.1, span: 0.3, icon: 'users' }, { label: '민원 창구', at: 0.65, span: 0.3, icon: 'message-circle' }] },
  ]);
  source(s, '실행안 초안 (예시)');
}

// 7 venn
{
  const s = light();
  const top = head(s, '이익', '세 주체의 이익이 겹치는 곳은 저소음 야간 배송이다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  const st = stage(s, seam.left.x, top, seam.left.w, avail(top));
  venn(s, st.cx, st.cy, ['시', '사업자', '주민'], { d: 2.4, overlap: 0.9, shared: '저소음 야간' });
  reading(s, seam.right.x, st.y, seam.right.w, [
    { label: '시', text: '주간 정체가 줄어든다.' },
    { label: '사업자', text: '배송 비용이 내려간다.' },
    { label: '주민', text: '소음 기준 안에서 배송이 빨라진다.' },
  ]);
  source(s, '연구소 분석 (예시)');
}

// 8 small multiples
{
  const s = light();
  const top = head(s, '도시별', '세 도시 모두 규제 뒤 주간 정체 지수가 올랐다');
  smallMultiples(s, Z.body.x, top, Z.body.w, avail(top), [
    { label: '서울', series: [{ name: '정체 지수', values: [62, 64, 71, 73] }], accent: 3 },
    { label: '부산', series: [{ name: '정체 지수', values: [48, 49, 55, 57] }], accent: 3 },
    { label: '대구', series: [{ name: '정체 지수', values: [41, 42, 46, 47] }], accent: 3 },
  ], { labels: ['23년', '24년', '25년', '26년'], max: 90 });
  source(s, '정체 지수 = 평균 통행 속도 대비 지연 비율 × 100 (예시)');
}

// 9 quote
{
  const s = light();
  const top = head(s, '현장', '기사들은 규제보다 대기가 더 힘들다고 말한다');
  quote(s, Z.body.x, top + 0.3, Z.body.w, '밤에 나가면 한 시간이면 끝날 일이 낮에는 세 시간 걸립니다. 기다리는 시간이 제일 깁니다.', '택배 기사 인터뷰, 2026년 5월');
  source(s, '인터뷰 12건 가운데 발췌 (예시)');
}

// 10 closing
{
  const s = quiet();
  await motif(s, 'waves', 0, H * 0.55, W, H * 0.45);
  poster(s, '10월 교통위원회 안건으로 올려 주십시오', { x: M, y: 2.2, w: 9, size: TYPE.cover, kicker: 'NEXT STEP', line: 'research@citylogistics.example · 도시 물류 연구소' });
}

await pres.writeFile({ fileName: OUTPUT });
