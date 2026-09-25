// BRIEF
// subject/audience/action: 이슈 트래커 "Orbit" 2026 제품 업데이트 — 엔지니어링 리더가 팀 전환 파일럿을 신청하게 한다
// reading mode: balanced · argument mode: narrative
// directions: A dark-tech, hue 235 인디고 단색, weight, rings — Linear 다크 덱 클론(오프블랙 캔버스와 소프트 화이트, 인디고 한 색) · B swiss-minimal, hue 220, rays · selected: A · why: 레퍼런스(Linear 디자인 시스템)가 다크 네이티브이고 인디고 한 색만 쓴다
// style: dark-tech · palette: hue 235 · accent hue 250 · accent: 5E6AD2 · type: MODE balanced → body 15pt · script: ko · pairing: weight · fonts: noto
// motif: rings · rhythm: anchor, dense, dense, anchor, dense, dense, dense, anchor
// facts: sample — 가상의 제품 업데이트 시안이며 모든 수치는 예시
// slide plan: 1 job: cover · relationship: none · move: Orbit이 빠른 이슈 트래커임을 안다 · composition: 다크 필드 포스터 제목, 우측 오브 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 사이클 타임이 줄었음을 본다 · composition: 좌측 영역 차트, 우측 리딩 레일 · carriers: chart, prose · texture: prose · rhythm: dense
//   3 job: comparison · relationship: contrast · move: 우선순위 판단 기준을 이해한다 · composition: 2x2 사분면에 기능 배치 · carriers: diagram · texture: keywords · rhythm: dense
//   4 job: section · relationship: focal claim · move: 두 번째 장으로 넘어간다 · composition: 거대한 섹션 숫자와 주장 · carriers: statement · texture: keywords · rhythm: anchor
//   5 job: process · relationship: order · move: 도입 단계를 안다 · composition: 계단식 세 단계 · carriers: diagram · texture: list · rhythm: dense
//   6 job: evidence · relationship: evidence · move: 팀별 성과를 비교한다 · composition: 촘촘한 표 열두 행 · carriers: table · texture: keywords · rhythm: dense
//   7 job: evidence · relationship: contrast · move: 속도와 품질이 같이 좋아졌음을 본다 · composition: 라인 차트 두 계열과 스탯 밴드 · carriers: chart, hero · texture: keywords · rhythm: dense
//   8 job: closing · relationship: none · move: 파일럿을 신청한다 · composition: 커버 필드 반복, 요청 포스터 · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'dark-tech', hue: 235, accentHue: 250, mode: 'balanced', script: 'ko', pairing: 'weight', fonts: 'noto' });

// 1 cover
{
  const s = quiet();
  await orb(s, W - 3.3, H / 2 + 0.2, 4.0);
  poster(s, '이슈는 줄이고, 흐름은 빠르게', { x: M, y: 2.3, w: 7.4, kicker: 'ORBIT · 2026 PRODUCT UPDATE', line: '엔지니어링 리더를 위한 제품 업데이트 · 2026년 9월' });
}

// 2 area chart + reading
{
  const s = light();
  const top = head(s, '속도', '사이클 타임이 9개월 만에 절반이 됐다');
  const seam = splitAt(Z.body.x, Z.body.w, 6, 4);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'area', labels: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월'], series: [{ name: '사이클 타임(일)', values: [8.4, 8.1, 7.5, 6.9, 6.2, 5.6, 5.0, 4.6, 4.2] }], format: '0.0' });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '원인', text: '자동 분류가 이슈의 62%를 담당자에게 바로 보낸다.' },
    { label: '효과', text: '대기 상태로 머무는 시간이 하루 평균 1.8일에서 0.6일로 줄었다.' },
  ]);
  source(s, '단위: 일, 팀 평균 · 출처: Orbit 사용 로그 (예시 수치)');
}

// 3 quadrants
{
  const s = light();
  const top = head(s, '우선순위', '영향이 크고 비용이 낮은 두 기능부터 연다');
  const seam = splitAt(Z.body.x, Z.body.w, 7, 3);
  await quadrants(s, seam.left.x, top, seam.left.w, avail(top), {
    axes: { x: ['구현 비용 낮음', '구현 비용 높음'], y: ['영향 작음', '영향 큼'] },
    names: ['먼저', '계획', '보류', '재검토'],
    items: [
      { label: '자동 분류', x: 0.2, y: 0.85, icon: 'sparkles', active: true },
      { label: '주간 리포트', x: 0.35, y: 0.7, icon: 'file-bar-chart' },
      { label: '로드맵 뷰', x: 0.75, y: 0.8, icon: 'map' },
      { label: '다크 모드', x: 0.3, y: 0.25, icon: 'moon' },
      { label: '오프라인', x: 0.8, y: 0.3, icon: 'cloud' },
    ],
  });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '먼저', text: '자동 분류와 주간 리포트는 한 분기 안에 연다.' },
    { label: '계획', text: '로드맵 뷰는 데이터 모델 정리 뒤로 미룬다.' },
  ]);
  source(s, '평가: 제품팀 워크숍, 2026년 8월 (예시)');
}

// 4 section
{
  const s = dark();
  numeralBeat(s, '02', '도입은 세 단계, 여섯 주면 끝난다', { line: '파일럿 팀의 실제 일정 기준' });
}

// 5 steps
{
  const s = light();
  const top = head(s, '도입', '가져오기부터 전환까지 여섯 주가 걸린다');
  await steps(s, Z.body.x, top, Z.body.w, avail(top), [
    { label: '가져오기', detail: '기존 이슈와 라벨을 옮기고 분류 규칙 스무 개로 시작한다' },
    { label: '병행 운영', detail: '두 주 동안 두 도구를 함께 쓴다' },
    { label: '전환', detail: '기존 도구를 읽기 전용으로 돌린다', active: true },
  ]);
  source(s, '파일럿 세 팀의 평균 일정 (예시)');
}

// 6 dense table
{
  const s = light();
  const top = head(s, '팀별 결과', '열두 팀 중 열 팀이 사이클 타임을 30% 넘게 줄였다');
  const rows = [
    ['결제', '8.1', '3.9', '−52%'], ['정산', '7.4', '4.1', '−45%'], ['인증', '6.9', '4.4', '−36%'], ['검색', '9.2', '5.1', '−45%'],
    ['추천', '8.8', '5.6', '−36%'], ['알림', '5.9', '4.8', '−19%'], ['관리자', '7.7', '4.9', '−36%'], ['모바일', '10.4', '6.2', '−40%'],
    ['웹', '8.3', '5.2', '−37%'], ['데이터', '9.9', '6.1', '−38%'], ['인프라', '6.2', '5.3', '−15%'], ['보안', '7.1', '4.6', '−35%'],
  ];
  table(s, Z.body.x, top, Z.body.w, ['팀', '도입 전 (일)', '도입 후 (일)', '변화'], rows, { dense: true, highlightCol: 3, highlightStyle: 'filled' });
  source(s, '사이클 타임 = 착수부터 배포까지 평균 일수 · 출처: Orbit 사용 로그 (예시 수치)');
}

// 7 line chart two series + stat band
{
  const s = light();
  const top = head(s, '품질', '속도가 빨라져도 재오픈율은 오히려 내려갔다');
  const room = avail(top);
  const bandH = 1.6;
  chart(s, Z.body.x, top, Z.body.w, room - bandH - GAP.between, { type: 'line', labels: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월'], series: [{ name: '재오픈율 전년(%)', values: [11.2, 11.0, 11.4, 10.9, 11.1, 10.8, 11.0, 10.7, 10.9] }, { name: '재오픈율 올해(%)', values: [10.8, 10.1, 9.6, 8.9, 8.1, 7.4, 6.9, 6.3, 5.8] }], format: '0.0', legend: true });
  statBand(s, Z.body.x, top + room - bandH + 0.1, Z.body.w, [
    { value: '5.8', unit: '%', label: '9월 재오픈율' },
    { value: '−5.1', unit: '%p', label: '전년 같은 달 대비' },
    { value: '4.2', unit: '일', label: '9월 사이클 타임' },
  ], { ruled: false });
  source(s, '출처: Orbit 사용 로그 (예시 수치)');
}

// 8 closing
{
  const s = quiet();
  await orb(s, W - 2.4, H / 2, 2.2);
  poster(s, '다음 분기 파일럿에 팀을 올려 주십시오', { x: M, y: 2.5, w: 8, size: TYPE.cover, kicker: 'PILOT · Q4', line: 'pilot@orbit.example · 파일럿 신청은 10월 17일까지' });
}

await pres.writeFile({ fileName: OUTPUT });
