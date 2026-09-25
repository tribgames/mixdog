// BRIEF
// subject/audience/action: 모아페이 앱 3.0 — 제품 리뷰 회의에서 출시를 승인하게 한다
// reading mode: balanced · argument mode: showcase
// directions: A soft-rounded, hue 215, concord, rings — 제품 화면 세 장을 나란히 · B swiss-minimal · selected: A · why: 제품 화면이 증거라 기기 프레임 줄이 중심이 된다
// style: soft-rounded · palette: hue 215 · accent hue 215 · accent: 3182F6 · type: MODE balanced → body 15pt · script: ko · pairing: concord · fonts: noto
// motif: rings · rhythm: anchor, dense, anchor
// facts: sample — 가상의 앱 화면 시안이며 수치는 예시
// slide plan: 1 job: cover · relationship: none · move: 3.0의 주제를 안다 · composition: 블루 필드 포스터 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: picture · relationship: evidence · move: 세 화면이 무엇을 바꾸는지 본다 · composition: 폰 프레임 세 개와 캡션 · carriers: picture · texture: prose · rhythm: dense
//   3 job: closing · relationship: none · move: 출시를 승인한다 · composition: 커버 필드 반복 · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'soft-rounded', hue: 215, accentHue: 215, mode: 'balanced', script: 'ko', pairing: 'concord', fonts: 'noto' });

const screen = async (title, lines, accent) => png(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="780" viewBox="0 0 360 780">
  <rect width="360" height="780" fill="#F7F8FA"/>
  <text x="24" y="96" font-family="Noto Sans KR" font-size="30" font-weight="700" fill="#191F28">${title}</text>
  ${lines.map((line, i) => `<rect x="24" y="${140 + i * 104}" width="312" height="88" rx="16" fill="${i === 0 ? accent : '#FFFFFF'}"/><text x="44" y="${192 + i * 104}" font-family="Noto Sans KR" font-size="22" fill="${i === 0 ? '#FFFFFF' : '#333D4B'}">${line}</text>`).join('')}
</svg>`);

{
  const s = quiet();
  field(s, 0, 0, W, H, T.accentLabel.fill);
  poster(s, '송금 세 번 탭이 한 번으로', { x: M, y: 2.3, w: 8, kicker: 'MOAPAY 3.0', color: T.accentLabel.color, kickerColor: T.accentLabel.color, line: '제품 리뷰 · 2026년 9월', lineColor: T.accentLabel.color });
}
{
  const s = light();
  const top = head(s, '제품', '세 화면이 송금을 한 번의 탭으로 줄인다');
  await tiles(s, Z.body.x, top, Z.body.w, [
    { data: await screen('홈', ['최근 보낸 사람', '계좌 3개', '카드 2장'], '#3182F6'), alt: '최근 보낸 사람이 맨 위에 있는 홈 화면', label: '홈', caption: '최근 보낸 사람을 맨 위에 둔다.' },
    { data: await screen('송금', ['김하늘 · 3만 원', '금액 키패드', '보내기'], '#3182F6'), alt: '금액이 미리 채워진 송금 화면', label: '송금', caption: '지난 금액을 미리 채운다.' },
    { data: await screen('완료', ['보냈어요', '영수증', '홈으로'], '#12B886'), alt: '송금 완료 화면', label: '완료', caption: '영수증을 바로 공유한다.' },
  ], { frame: 'phone', h: 3.7 });
  source(s, '앱 3.0 디자인 시안 (예시 화면)');
}
{
  const s = quiet();
  field(s, 0, 0, W, H, T.accentLabel.fill);
  poster(s, '10월 둘째 주 출시를 승인해 주십시오', { x: M, y: 2.4, w: 8.5, size: TYPE.cover, kicker: 'DECISION', color: T.accentLabel.color, kickerColor: T.accentLabel.color, line: 'product@moapay.example', lineColor: T.accentLabel.color });
}
await pres.writeFile({ fileName: OUTPUT });
