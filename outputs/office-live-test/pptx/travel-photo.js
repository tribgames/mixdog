// BRIEF
// subject/audience/action: 북미 자연 여행 상품 소개 — 여행사 VIP 고객이 가을 출발 상품을 예약한다
// reading mode: presentation · argument mode: narrative
// directions: A photo-editorial, hue 200, serif — 여행 매거진 클론(전면 사진, 방향 스크림, 한 줄 대형 타이포) · B soft-rounded, hue 190 · selected: A · why: 사진이 상품 그 자체이며 매거진 레지스터가 VIP 고객에 맞음
// style: photo-editorial · palette: hue 200 · type: MODE presentation → body 20pt · script: ko · pairing: serif · fonts: noto
// motif: picture edges · rhythm: anchor, breathing, dense, anchor
// facts: sample — 가상의 여행 상품이며 가격과 일정은 예시
// slide plan: 1 job: cover · relationship: none · move: 가을 호수 여행을 떠올린다 · composition: 전면 사진, 왼쪽 스크림 위 대형 제목 · carriers: picture, statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 요세미티 일정을 본다 · composition: 오른쪽 2/3 사진, 왼쪽 레일에 일정 읽기 · carriers: picture, prose · texture: prose · rhythm: breathing
//   3 job: comparison · relationship: contrast · move: 세 도시 코스를 비교한다 · composition: 사진 타일 세 장과 캡션 · carriers: picture · texture: keywords · rhythm: dense
//   4 job: closing · relationship: none · move: 예약한다 · composition: 전면 도시 사진, 하단 스크림 위 예약 문장 · carriers: picture, statement · texture: keywords · rhythm: anchor

deck({ style: 'photo-editorial', hue: 200, mode: 'presentation', script: 'ko', pairing: 'serif', fonts: 'noto' });
const P = (id) => `outputs/office-live-test/pptx/photos/p${id}.jpg`;

// 1 cover
{
  const s = quiet();
  await picture(s, P(1011), 0, 0, W, H, { alt: '청록색 호수 위 카누에서 노를 젓는 여행자, 뒤로 침엽수 숲과 해 질 녘 하늘' });
  await scrim(s, 0, 0, W * 0.62, H, 'left');
  poster(s, '가을, 호수 위에서\n하루를 시작한다', { x: M, y: 2.3, w: 6.2, size: TYPE.cover, kicker: '2026 가을 출발', line: '캐나다 로키 · 요세미티 · 시카고 11박 12일' });
}

// 2 picture + rail
{
  const s = light();
  const top = head(s, '일정', '요세미티에서 사흘, 걷는 속도로 본다');
  const seam = splitAt(Z.body.x, Z.body.w, 4, 6);
  reading(s, seam.left.x, top, seam.left.w, [
    { label: '1일차', text: '밸리 산책과 강변 피크닉' },
    { label: '2일차', text: '글레이셔 포인트 일출' },
    { label: '3일차', text: '세쿼이아 숲 걷기' },
  ]);
  await picture(s, P(1043), seam.right.x, top, seam.right.w, avail(top), { alt: '요세미티 밸리의 화강암 절벽과 강에 비친 침엽수 숲' });
  source(s, '일정은 현지 기상에 따라 바뀔 수 있다 (예시 일정)');
}

// 3 tiles
{
  const s = light();
  const top = head(s, '코스', '세 곳, 세 가지 속도');
  await tiles(s, Z.body.x, top, Z.body.w, [
    { path: P(1011), alt: '카누를 타는 여행자와 청록 호수', caption: '로키 · 호수에서 쉬는 나흘' },
    { path: P(1043), alt: '요세미티 절벽과 강', caption: '요세미티 · 걷는 사흘' },
    { path: P(1067), alt: '해 질 녘 시카고 도심과 호수', caption: '시카고 · 도시에서 사흘' },
  ], { h: avail(top) - 1.15 });
}

// 4 closing
{
  const s = quiet();
  await picture(s, P(1067), 0, 0, W, H, { alt: '해 질 녘 호숫가로 이어지는 시카고 도심의 고층 빌딩' });
  await scrim(s, 0, H * 0.45, W, H * 0.55, 'bottom');
  poster(s, '9월 30일까지 예약하면 20% 할인', { x: M, y: H - 2.3, w: W - 2 * M, size: TYPE.title, maxLines: 1, kicker: 'VIP 조기 예약', line: 'travel@example.com · 02-1234-5678' });
}

await pres.writeFile({ fileName: OUTPUT });
