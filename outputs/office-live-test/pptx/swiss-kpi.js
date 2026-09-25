// BRIEF
// subject/audience/action: 2026 3분기 물류 운영 리뷰 — 운영 임원이 4분기 투자 우선순위를 정한다
// reading mode: text · argument mode: pyramid
// directions: A swiss-minimal, hue 210, concord — 그리드 고정, 하나의 큰 평면, 건축적 숫자 (Vignelli 그리드 클론) · B editorial, hue 30 · selected: A · why: 수치 비교가 많고 임원이 빠르게 훑는 문서라 그리드와 큰 숫자가 맞음
// style: swiss-minimal · palette: hue 210 · type: MODE text → body 13pt · script: ko · pairing: concord · fonts: noto
// motif: one plane · rhythm: anchor, dense, dense, dense
// facts: sample — 가상의 물류 회사 수치이며 모두 예시
// slide plan: 1 job: claim · relationship: focal claim · move: 3분기 핵심 결과를 안다 · composition: 좌측 평면 위 큰 숫자, 우측 주장과 세 개 스탯 · carriers: statement, hero · texture: keywords · rhythm: anchor
//   2 job: comparison · relationship: contrast · move: 허브별 성과를 비교한다 · composition: 본문 폭 표, 판정 열 · carriers: table · texture: keywords · rhythm: dense
//   3 job: structure · relationship: position · move: 투자 후보를 영향과 난이도로 본다 · composition: 사분면과 우측 읽기 · carriers: diagram, prose · texture: prose · rhythm: dense
//   4 job: evidence · relationship: evidence · move: 비용 구조 변화를 본다 · composition: 워터폴 차트, 아래 읽기 · carriers: chart, prose · texture: prose · rhythm: dense

deck({ style: 'swiss-minimal', hue: 210, mode: 'text', script: 'ko', pairing: 'concord', fonts: 'noto' });

// 1 claim with hero numeral
{
  const s = light();
  const b = display(s, '야간 출고율이 처음으로 90%를 넘었다', { kicker: '3분기 요약', emph: '90%를 넘었다', line: '세 허브 모두 목표를 넘겼고, 인천만 반품 처리 지연이 남았다.' });
  statBand(s, M, b + GAP.between * 1.5, (W - 2 * M) * 0.75, [
    { value: '92.8', unit: '%', label: '야간 출고율' },
    { value: '1.9', unit: '시간', label: '평균 출고 리드타임' },
    { value: '−4.1', unit: '%', label: '건당 물류비' },
  ]);
  source(s, '출처: 운영 대시보드, 2026년 7–9월 (예시 수치)');
}

// 2 table
{
  const s = light();
  const top = head(s, '허브', '평택과 대전은 모든 지표에서 목표를 넘었다');
  table(s, Z.body.x, top, Z.body.w, ['허브', '출고율', '리드타임', '반품 처리', '건당 비용', '판정'], [
    ['평택', '94.1%', '1.6시간', '1.2일', '2,840원', '초과'],
    ['대전', '93.0%', '1.8시간', '1.4일', '2,910원', '초과'],
    ['인천', '91.2%', '2.3시간', '3.1일', '3,120원', '보통'],
    ['목표', '90.0%', '2.0시간', '2.0일', '3,000원', '—'],
  ], { verdict: 5, tones: ['positive', 'positive', 'warning', 'neutral'] });
  reading(s, Z.body.x, top + 2.5, Z.body.w * 0.6, [
    { label: '인천', text: '출고율은 목표를 넘겼지만 반품 처리에 3.1일이 걸려 목표의 1.5배다. 반품 전용 라인이 없는 유일한 허브다.' },
  ]);
  source(s, '출처: 허브별 운영 로그, 2026년 3분기 (예시 수치)');
}

// 3 quadrants
{
  const s = light();
  const top = head(s, '투자', '자동 분류기가 영향은 가장 크고 난이도는 중간이다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  await quadrants(s, seam.left.x, top, seam.left.w, avail(top), {
    axes: { x: ['쉬움', '어려움'], y: ['영향 작음', '영향 큼'] },
    items: [
      { label: '자동 분류기', x: 0.55, y: 0.85, active: true },
      { label: '야간 인력 증원', x: 0.25, y: 0.55 },
      { label: '반품 전용 라인', x: 0.7, y: 0.6 },
      { label: 'WMS 교체', x: 0.9, y: 0.7 },
      { label: '라벨 프린터 교체', x: 0.15, y: 0.2 },
    ],
  });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '먼저', text: '자동 분류기는 인천의 반품 지연을 줄이고 세 허브 모두의 리드타임을 낮춘다.' },
    { label: '보류', text: 'WMS 교체는 영향이 크지만 18개월이 걸려 4분기 예산으로는 시작만 가능하다.' },
  ]);
  source(s, '영향과 난이도는 운영팀 평가, 2026년 9월 (예시)');
}

// 4 waterfall
{
  const s = light();
  const top = head(s, '비용', '건당 물류비가 120원 내린 이유는 대기 시간이다');
  const b = waterfall(s, Z.body.x, top, Z.body.w, avail(top) - 1.0, [
    { label: '2분기', value: 3060 },
    { label: '대기 단축', value: -150 },
    { label: '연료', value: 40 },
    { label: '인건비', value: 30 },
    { label: '포장재', value: -40 },
    { label: '3분기', total: true },
  ]);
  reading(s, Z.body.x, b + GAP.between, Z.body.w, ['출고 대기가 줄면서 차량 회전이 늘어 건당 150원이 내렸고, 연료와 인건비 상승 70원을 상쇄했다.']);
  source(s, '단위: 원/건 · 출처: 재무팀 원가 분석 (예시 수치)');
}

await pres.writeFile({ fileName: OUTPUT });
