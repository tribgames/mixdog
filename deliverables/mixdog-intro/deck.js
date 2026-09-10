// BRIEF
// subject/audience/action: Mixdog / 처음 접하는 사용자와 협업 상대 / 제품의 역할과 활용 범위를 이해하고 설치한다
// reading mode: balanced · argument mode: briefing
// directions: A dark-tech, teal, weight, shared session outline · B swiss-minimal, teal, concord, typographic plane · selected: A · why: approved tech direction; a shared-session schematic explains the product without a fabricated screenshot
// style: dark-tech · palette: hue 195 · accent hue 195 · accent: 167D8A · type: MODE balanced → body 18pt · script: ko · pairing: weight · fonts: noto
// motif: Mixdog wordmark and shared-session outline; text-led cover because native typography and diagrams explain software more faithfully than generated UI · rhythm: anchor, breathing, dense, dense, dense, dense, anchor
// sources: C:/Project/mixdog/README.md §Highlights and §Benchmarks and §Get started
// facts: F1 trial cost 0.476 0.782 and reduction 39% — README.md:55-63
// F2 median final context 18.5k 34.3k and reduction 46% — README.md:59-61
// F3 success rate 86.5% 86.1% — README.md:61-62
// F4 benchmark Terminal-Bench 2.1, GPT-5.6 Sol xhigh, 89 tasks, 5 repetitions, 445 trials — README.md:50-80
// slide plan: 1 job: cover · relationship: focal claim · move: Mixdog is an efficiency-first coding tool · composition: large product name with concise value statement on dark field · carriers: statement · texture: keywords · rhythm: anchor
// 2 job: claim · relationship: contrast · move: efficiency and accessibility are product goals · composition: dominant goal at left and mechanisms on right · carriers: statement, prose · texture: prose · rhythm: breathing
// 3 job: structure · relationship: membership · move: model choice, parallel work and memory support execution · composition: separated labeled rows grouped by product role · carriers: diagram · texture: keywords · rhythm: dense
// 4 job: structure · relationship: link · move: terminal desktop and web share a live session · composition: shared session field linked to three peer access surfaces · carriers: diagram · texture: keywords · rhythm: dense
// 5 job: structure · relationship: membership · move: native tools act on web desktop and documents · composition: three scope columns with explicit target labels · carriers: diagram · texture: keywords · rhythm: dense
// 6 job: evidence · relationship: contrast · move: disclosed benchmark cuts priced cost while keeping success comparable · composition: native cost chart at left with context and success figures at right and conditions below · carriers: chart, hero · texture: keywords · rhythm: dense
// 7 job: closing · relationship: order · move: install then authenticate and select a model and workflow · composition: install command specimen beside onboarding path · carriers: specimen, diagram · texture: keywords · rhythm: anchor

deck({hue:195, accentHue:195, mode:'balanced', script:'ko', pairing:'weight', fonts:'noto'});
pres.author='Mixdog';
pres.subject='Mixdog 프로젝트 소개';
pres.title='Mixdog — 더 적은 비용으로 더 많은 작업';
pres.lang='ko-KR';
const X=M, CW=W-2*M, BODY=Z.body.top;
const GRID={half:(CW-GUTTER)/2, third:(CW-2*GUTTER)/3};
const notes=(s,t)=>s.addNotes(t);
const p=(s,str,x,y,w,r='body',darkMode=false)=>text(s,str,x,y,w,r,darkMode?{color:r==='caption'?T.onDarkMuted:T.onDark}:{});
const labelBox=(s,str,x,y,w,h,darkMode=false)=>{
  outline(s,x,y,w,h,{color:darkMode?T.onDarkMuted:T.lineStrong});
  const c=inner({x,y,w,h});
  p(s,str,c.x,c.y,c.w,'strong',darkMode);
};
{
 const s=quiet();
 kicker(s,'프로젝트 소개',X,M,T.onDarkAccent);
 text(s,'Mixdog',X,1.8,CW,'poster',{color:T.onDark});
 const b=text(s,'더 적은 비용으로\n더 많은 작업',X,3.8,8.4,'cover',{color:T.onDark});
 text(s,'모델과 도구를 연결하는 효율성 중심 AI 코딩 도구',X,b+GAP.between,CW,'body',{color:T.onDarkMuted});
 notes(s,'출처: README.md:7–17. 비용·시간·context 효율을 높이도록 설계된 AI coding harness. 표지는 제품의 목표를 소개하며 모든 작업에서의 성능 향상을 보장하지 않는다. 합성 UI나 실제 화면을 사용하지 않은 타이포그래피 표지.');
}
{
 const s=light(); head(s,'프로젝트의 목표','같은 예산으로 더 많은 일을 끝낸다');
 const y=BODY+GAP.between;
 text(s,'효율성',X,y,GRID.half,'cover');
 text(s,'컨텍스트·시간·비용을 아껴\n작업에 쓸 여력을 늘린다',X,y+1.25,GRID.half,'lead');
 const rx=X+GRID.half+GUTTER;
 field(s,rx,y,GRID.half,3.8,T.paperAlt);
 const c=inner({x:rx,y,w:GRID.half,h:3.8},GAP.between);
 flow(s,c.x,c.y,c.w,[
  {text:'쉽게 시작하고',role:'section'},
  {text:'간단한 설정과 직관적인 사용 경험',role:'body',after:GAP.between},
  {text:'복잡한 작업까지',role:'section'},
  {text:'작업 조율과 병렬 실행',role:'body'}
 ],{bottom:y+3.8-PAD});
 source(s,'제품 목표 · README.md §Better results. Less cost. More work.');
 notes(s,'출처: README.md:7–17. 이 페이지는 제품의 설계 목표와 대상 사용자를 설명한다. 정량 측정 결과는 벤치마크 페이지와 구분한다.');
}
{
 const s=light();head(s,'핵심 기능','모델 선택부터 작업 기억까지 연결한다');
 const rows=[
  ['모델 선택','역할에 맞게 모델을 지정한다','서로 다른 provider와 모델을 역할별로 배정'],
  ['작업 분담','병렬 작업을 조율한다','작업 조율과 병렬 실행으로 복잡한 요청을 수행'],
  ['작업 기억','맥락을 보존하고 다시 찾는다','프로젝트별 기억 검색, 컨텍스트 압축, 세션 재개']
 ];
 const rowH=1.25, start=BODY;
 rows.forEach((r,i)=>{
  const y=start+i*(rowH+GAP.within);
  field(s,X,y,2.45,rowH,T.paperAlt);
  text(s,r[0],X+PAD,y+PAD,2.45-2*PAD,'section');
  const tx=X+2.45+GUTTER, tw=CW-2.45-GUTTER;
  const b=text(s,r[1],tx,y+GAP.within,tw,'lead',{bold:true});
  text(s,r[2],tx,b+GAP.within,tw,'body');
 });
 source(s,'README.md §Highlights');
 notes(s,'출처: README.md:13–15,90–98. 역할별 모델 배정은 제공되는 설정 기능이다. 이 도식은 기능 분류이며 모든 작업이 자동 병렬 처리된다는 뜻이 아니다.');
}
{
 const s=dark();head(s,'연결된 사용 경험','환경이 바뀌어도 같은 세션을 이어 쓴다',{color:T.onDark,kickerColor:T.onDarkAccent});
 const y=BODY, h=1.4;
 field(s,X,y,CW,h,T.darkAlt);
 text(s,'공유 실시간 세션',X+GAP.between,y+PAD,CW-2*GAP.between,'section',{color:T.onDark});
 text(s,'원격 접속은 인증과 종단간 암호화로 보호한다',X+GAP.between,y+PAD+0.65,CW-2*GAP.between,'body',{color:T.onDarkMuted});
 const by=y+h+GAP.between+GAP.between;
 const items=[['터미널','명령줄에서 작업'],['데스크톱','편집기·Git·터미널 통합'],['웹·모바일','Desktop과 연결해 원격 접속']];
 items.forEach((a,i)=>{
  const x=X+i*(GRID.third+GUTTER),cx=x+GRID.third/2;
  connector(s,cx,y+h,cx,by,{color:T.onDarkMuted,arrow:'none'});
  field(s,x,by,GRID.third,1.7,T.darkAlt);
  const b=text(s,a[0],x+PAD,by+PAD,GRID.third-2*PAD,'section',{color:T.onDark});
  text(s,a[1],x+PAD,b+GAP.within,GRID.third-2*PAD,'body',{color:T.onDarkMuted});
 });
 source(s,'README.md §Highlights',{color:T.onDarkMuted});
 notes(s,'출처: README.md:91–92,106–109. TUI·desktop windows·paired browsers 간 shared live sessions. 웹·휴대폰 사용은 Desktop과 연결하는 암호화 원격 접속이다. 도식은 논리적 관계이며 실제 UI 화면이 아니다.');
}
{
 const s=light();head(s,'코딩을 넘어 실행까지','웹·Windows 앱·문서를 직접 다룬다');
 const items=[
  {title:'Browser Use',sub:'로그인된 Chromium',body:'탭·폼·다운로드를 조작하고\n페이지 상태를 확인한다',icon:'globe'},
  {title:'Computer Use',sub:'Windows 데스크톱',body:'화면·접근성·OCR을 활용해\n앱을 조작한다',icon:'laptop'},
  {title:'Office',sub:'Word·Excel·PowerPoint',body:'문서와 차트를 만들고\n검사한 결과물을 저장한다',icon:'file-text'}
 ];
 for(let i=0;i<items.length;i++){
  const a=items[i],x=X+i*(GRID.third+GUTTER);
  await icon(s,x,BODY,'hero',a.icon);
  let b=text(s,a.title,x,BODY+1+GAP.between,GRID.third,'section');
  b=text(s,a.sub,x,b+GAP.within,GRID.third,'strong');
  text(s,a.body,x,b+GAP.between,GRID.third,'body');
 }
 source(s,'README.md §Highlights');
 notes(s,'출처: README.md:99–105. Browser Use는 로그인된 Chromium pane, Computer Use는 Windows 데스크톱과 입력 안전 규칙, Office는 Word·Excel·PowerPoint 작성과 편집. 모든 대상이나 임의 작업의 성공을 보장하지 않는다.');
}
{
 const s=light();head(s,'공개 벤치마크','비슷한 성공률에서 환산 비용을 줄였다');
 const leftW=7.15,rx=X+leftW+GUTTER,rw=CW-leftW-GUTTER;
 text(s,'시험당 API 정가 환산 비용',X,BODY,leftW,'strong');
 chart(s,X,BODY+0.65,leftW,2.65,{
  type:'bar',labels:['시험당 비용'],
  series:[{name:'Codex CLI',values:[0.782]},{name:'Mixdog',values:[0.476]}],
  colors:[T.muted,T.accent],format:'$0.000',max:0.95,legend:true,categoryLabels:false
 });
 const b=hero(s,rx,BODY,rw,'39%','시험당 환산 비용 절감');
 flow(s,rx,b+GAP.between,rw,[
  {text:'성공률',role:'strong'},
  {text:'86.5% / 86.1%',role:'section'},
  {text:'Mixdog / Codex CLI',role:'caption'}
 ]);
 text(s,'최종 컨텍스트 중앙값 46% 감소',X,BODY+3.45,CW,'strong');
 text(s,'GPT-5.6 Sol xhigh · Terminal-Bench 2.1 · 동일한 89개 작업을 각각 5회 측정',X,BODY+4.01,CW,'caption');
 source(s,'자체 공개 결과 · 공식 리더보드 등재 아님 · README.md §Benchmarks');
 notes(s,'출처: README.md:50–86. 비용은 Mixdog $0.476 대 Codex CLI $0.782/trial로 39% 낮다. 성공률 86.5%(385/445) 대 86.1%(383/445). 최종 context 중앙값 18.5k 대 34.3k tokens로 46% 작다. 양측 동일 GPT-5.6 Sol xhigh, 89 tasks × 5회 = 각 445 trials. 공식 Harbor verifier, fast mode off, 272k context window. 실패와 timeout은 재시도하지 않음. 양측 동일한 API 정가로 환산한 비용이며 실제 청구액이나 모든 사용 환경의 절감률을 뜻하지 않는다. 커뮤니티 leaderboard 접수 중단으로 자체 공개 artifacts를 제시한 결과이며 공식 등재가 아니다.');
}
{
 const s=quiet();kicker(s,'시작하기',X,M,T.onDarkAccent);
 text(s,'설치하고,\n첫 작업을 시작하세요',X,1.4,CW,'cover',{color:T.onDark});
 const y=3.55,lw=6.35,rx=X+lw+GUTTER,rw=CW-lw-GUTTER;
 field(s,X,y,lw,1.9,T.darkAlt);
 const cb=text(s,'CLI 설치와 실행',X+PAD,y+PAD,lw-2*PAD,'strong',{color:T.onDarkMuted});
 text(s,'npm install -g mixdog\nmixdog',X+PAD,cb+GAP.within,lw-2*PAD,'lead',{color:T.onDark,font:'Noto Sans'});
 text(s,'첫 실행 설정',rx,y,rw,'section',{color:T.onDark});
 text(s,'계정 인증 → 모델 선택\n→ 워크플로우 설정',rx,y+0.7,rw,'body',{color:T.onDarkMuted});
 text(s,'Windows 앱 다운로드',X,y+1.9+GAP.between,CW,'strong',{color:T.onDark});
 text(s,'github.com/tribgames/mixdog/releases/latest',X,6.5,CW,'caption',{color:T.onDarkMuted});
 notes(s,'출처: README.md:19–46. Windows x64 설치 파일: https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe . 현재 설치 파일은 서명되지 않아 SmartScreen 경고가 나타날 수 있다. CLI는 Node.js 22.19+(22.x) 또는 24+ 필요. 초기 실행 시 provider 인증, 모델 선택, workflow 설정 안내. 설치 명령과 실행 명령은 별도 줄로 실행한다.');
}
await pres.writeFile({fileName:OUTPUT});
