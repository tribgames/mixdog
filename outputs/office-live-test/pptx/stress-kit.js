// BRIEF
// subject/audience/action: 물류 플랫폼 구조 — 신규 입사자가 조직과 일정 구조를 이해한다
// reading mode: balanced · argument mode: narrative
// directions: A soft-rounded, hue 160, concord · B editorial, hue 30 · selected: A · why: 온보딩 자료라 부드러운 카드형이 맞음
// style: soft-rounded · palette: hue 160 · type: MODE balanced → body 15pt · script: ko · pairing: concord · fonts: noto
// motif: rings · rhythm: dense, dense, dense
// facts: sample — 예시 조직과 일정
// slide plan: 1 job: structure · relationship: parent · move: 플랫폼의 일곱 팀을 안다 · composition: 허브와 위성 일곱 · carriers: diagram · texture: keywords · rhythm: dense
//   2 job: process · relationship: order · move: 입사 첫 90일을 안다 · composition: 일곱 단계 타임라인 · carriers: diagram · texture: keywords · rhythm: dense
//   3 job: structure · relationship: flow · move: 주문이 흐르는 네 레인을 본다 · composition: 레인 네 줄 · carriers: diagram · texture: keywords · rhythm: dense

deck({ style: 'soft-rounded', hue: 160, mode: 'balanced', script: 'ko', pairing: 'concord', fonts: 'noto' });

{
  const s = light();
  const top = head(s, '조직', '플랫폼은 일곱 팀이 한 허브를 둘러싼다');
  const st = stage(s, Z.body.x, top, Z.body.w, avail(top));
  await hub(s, st, { label: '플랫폼', icon: 'boxes' }, [
    { label: '주문', icon: 'shopping-cart' },
    { label: '배차', icon: 'truck', active: true },
    { label: '정산', icon: 'wallet' },
    { label: '고객 지원', icon: 'headphones' },
    { label: '데이터', icon: 'database' },
    { label: '보안', icon: 'shield' },
    { label: '인프라', icon: 'server' },
  ]);
  source(s, '2026년 9월 조직도 기준 (예시)');
}

{
  const s = light();
  const top = head(s, '온보딩', '첫 90일은 일곱 단계로 나뉜다');
  const st = stage(s, Z.body.x, top, Z.body.w, avail(top));
  timeline(s, st.x, st.y, st.w, [
    { when: '1일', label: '계정 발급' },
    { when: '1주', label: '도메인 교육' },
    { when: '2주', label: '첫 배포' },
    { when: '4주', label: '온콜 참관', active: true },
    { when: '6주', label: '온콜 투입' },
    { when: '8주', label: '프로젝트 리드' },
    { when: '90일', label: '회고' },
  ], { ground: st.ground, h: st.h });
  source(s, '온보딩 가이드 2026 (예시)');
}

{
  const s = light();
  const top = head(s, '흐름', '주문은 네 팀을 차례로 지난다');
  await lanes(s, Z.body.x, top, Z.body.w, avail(top), [
    { label: '주문', items: ['접수', '검증', '확정'] },
    { label: '배차', items: ['경로 계산', '기사 배정'] },
    { label: '배송', items: ['상차', '이동', '완료'] },
    { label: '정산', items: ['운임 계산', '지급'] },
  ]);
  source(s, '2026년 9월 프로세스 (예시)');
}

await pres.writeFile({ fileName: OUTPUT });
