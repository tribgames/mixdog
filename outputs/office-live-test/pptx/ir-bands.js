// BRIEF
// subject/audience/action: 한빛전자 2026년 2분기 실적 발표 — 애널리스트가 하반기 추정치를 올리게 한다
// reading mode: text · argument mode: briefing
// directions: A data-journalism, hue 225 네이비와 코랄, weight, dots — 삼성 IR 밴드 클론(다크 헤드 밴드, 사업부 표) · B editorial · selected: A · why: IR 표와 차트가 주인공이라 밴드 헤드와 표가 맞다
// style: data-journalism · palette: hue 225 · accent: E0663F · type: MODE text → body 13pt · script: ko · pairing: weight · fonts: noto
// motif: dots · rhythm: anchor, dense, dense, dense, dense, anchor
// facts: sample — 가상의 제조사 실적 발표 시안이며 모든 수치는 예시
// slide plan: 1 job: cover · relationship: none · move: 2분기 실적 발표임을 안다 · composition: 다크 필드 포스터 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 사업부별 실적을 한 표로 본다 · composition: 좌측 추이 차트, 우측 사업부 그룹 표 · carriers: chart, table · texture: keywords · rhythm: dense
//   3 job: evidence · relationship: evidence · move: 매출과 수치를 함께 읽는다 · composition: 위 차트 아래 표 · carriers: chart, table · texture: keywords · rhythm: dense
//   4 job: evidence · relationship: contrast · move: 목표 대비 달성을 본다 · composition: 불릿 차트와 레일 · carriers: chart, prose · texture: prose · rhythm: dense
//   5 job: evidence · relationship: evidence · move: 매출 구성을 본다 · composition: 도넛과 스탯 밴드, 테이크어웨이 · carriers: chart, hero · texture: keywords · rhythm: dense
//   6 job: closing · relationship: none · move: 질의응답으로 넘어간다 · composition: 커버 필드 반복 · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'data-journalism', hue: 225, mode: 'text', script: 'ko', pairing: 'weight', fonts: 'noto' });
const q = ['25.2Q', '25.3Q', '25.4Q', '26.1Q', '26.2Q'];

{
  const s = quiet();
  poster(s, '2026년 2분기 실적 발표', { x: M, y: 2.4, w: 9, kicker: 'HANBIT ELECTRONICS · IR', line: '2026년 7월 30일 · 잠정 실적' });
}
{
  const s = light();
  const top = head(s, '실적 요약', '반도체가 전사 영업이익의 61%를 벌었다', { sub: '연결 기준, 단위: 조 원' });
  const seam = splitAt(Z.body.x, Z.body.w, 1, 1);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'col', labels: q, series: [{ name: '영업이익', values: [6.2, 7.1, 6.8, 8.9, 10.4] }], format: '0.0' });
  table(s, seam.right.x, top, seam.right.w, ['사업부', '', '26.1Q', '26.2Q', 'QoQ'], [], {
    groups: [
      { name: '반도체', rows: [['매출', '24.1', '28.3', '17%'], ['영업이익', '5.2', '6.3', '21%']] },
      { name: '디스플레이', rows: [['매출', '7.4', '7.9', '7%'], ['영업이익', '0.9', '1.1', '22%']] },
      { name: '가전', rows: [['매출', '13.2', '13.8', '5%'], ['영업이익', '0.6', '0.7', '17%']] },
      { name: '모바일', rows: [['매출', '28.4', '26.1', '−8%'], ['영업이익', '2.2', '2.3', '5%']] },
    ],
    dense: true, highlightCol: 3, highlightStyle: 'filled',
  });
  source(s, '출처: 한빛전자 2026년 2분기 잠정 실적 (예시 수치)');
}
{
  const s = light();
  const top = head(s, '매출', '매출은 다섯 분기 연속 늘어 74조 원을 넘었다');
  const chartH = 2.4;
  chart(s, Z.body.x, top, Z.body.w, chartH, { type: 'col', labels: q, series: [{ name: '매출', values: [62.1, 65.4, 67.9, 71.3, 74.2] }], format: '0.0' });
  table(s, Z.body.x, top + chartH + GAP.between, Z.body.w, ['구분', ...q], [
    ['매출 (조 원)', '62.1', '65.4', '67.9', '71.3', '74.2'],
    ['영업이익 (조 원)', '6.2', '7.1', '6.8', '8.9', '10.4'],
    ['영업이익률', '10.0%', '10.9%', '10.0%', '12.5%', '14.0%'],
  ], { highlightCol: 5, dense: true });
  source(s, '출처: 한빛전자 분기 실적 (예시 수치)');
}
{
  const s = light();
  const top = head(s, '가이던스', '상반기 목표 대비 네 사업부 중 세 곳이 초과 달성했다');
  const seam = splitAt(Z.body.x, Z.body.w, 7, 3);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'bar', overlap: true, labels: ['반도체', '디스플레이', '가전', '모바일'], series: [{ name: '목표', values: [50, 14, 26, 58] }, { name: '실적', values: [52.4, 15.3, 27.0, 54.5] }], legend: true, format: '0.0' });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '초과', text: '반도체는 목표를 2.4조 원 넘었다.' },
    { label: '미달', text: '모바일은 신제품 출시가 7월로 밀려 3.5조 원 모자랐다.' },
  ]);
  source(s, '단위: 조 원, 상반기 누적 (예시 수치)');
}
{
  const s = light();
  const top = head(s, '구성', '반도체 비중이 처음으로 38%를 넘었다');
  const seam = splitAt(Z.body.x, Z.body.w, 5, 5);
  chart(s, seam.left.x, top, seam.left.w, avail(top) - 0.8, { type: 'doughnut', labels: ['반도체', '모바일', '가전', '디스플레이'], series: [{ name: '매출 비중', values: [38.1, 35.2, 18.6, 8.1] }], format: '0.0"%"' });
  statBand(s, seam.right.x, top, seam.right.w, [{ value: '38.1', unit: '%', label: '반도체 비중' }, { value: '+4.3', unit: '%p', label: '전년 대비' }], { scale: 'hero' });
  takeaway(s, '하반기 HBM 증설로 반도체 비중은 40%를 넘을 전망이다.');
  source(s, '2026년 2분기 매출 기준 (예시 수치)');
}
{
  const s = quiet();
  poster(s, '질의응답', { x: M, y: 2.6, w: 9, size: TYPE.cover, kicker: 'Q&A', line: 'ir@hanbit.example · 한빛전자 IR팀' });
}
await pres.writeFile({ fileName: OUTPUT });
