# Mixdog 소개 PPT

대상: Mixdog를 처음 접하는 사용자와 협업 상대.
목표: 제품의 역할, 연결된 사용 경험, 실행 기능과 효율성 근거를 이해하고 설치 경로를 알게 한다.
승인 범위: 한국어 7장, 테크 스타일, 편집 가능한 PPTX와 미리보기.
디자인: 승인된 테크 방향. 청록 계열의 단일 강조색, 어두운 표지와 밝은 설명 페이지. 실제 화면으로 오인할 합성 UI 대신 편집 가능한 관계 도식과 타이포그래피를 사용한다.

## 원자료와 사실

- README.md:7–17 — 효율성 중심 AI coding harness. 같은 예산이나 구독 한도로 더 많은 작업을 수행하도록 설계.
- README.md:88–109 — 역할별 provider/model 선택, 공유 세션, context 관리, 프로젝트 기억, Browser Use, Computer Use, Office, 암호화 원격 접속.
- README.md:19–46 — Windows 설치 파일, CLI 설치 명령, 초기 인증·모델·workflow 설정. Windows 설치 파일은 서명되지 않아 SmartScreen 경고가 발생할 수 있음.
- README.md:55–63 — GPT-5.6 Sol xhigh 비교: trial당 비용 Mixdog $0.476 / Codex CLI $0.782; 39% 절감. 최종 context 중앙값 18.5k / 34.3k tokens; 46% 감소. 성공률 86.5% / 86.1%.
- README.md:74–86 — 동일 모델, 89 tasks, 공식 Harbor verifier, fast mode off, context window 272k. Sol 양측 k=5, 각 445 trials. 실패·timeout 재시도 없음. 동일 API 정가 환산. 자체 공개 결과이며 공식 leaderboard 등재 아님.

## 슬라이드별 독자 질문과 정답 기준

1. Mixdog는 무엇인가? 효율성 중심 AI 코딩 도구. 어떤 목표인가? 비용·context·시간의 효율. 이름이 중심인가? Mixdog가 표지의 가장 큰 텍스트.
2. 무엇을 개선하려는가? 같은 예산에서 더 많은 작업. 누가 쓸 수 있는가? 초보자부터 전문가. 목표와 실측은 구별되는가? 이 페이지는 제품 목표로 표기.
3. 어떻게 작업을 지원하는가? 역할별 모델 선택, 병렬 작업, 프로젝트 기억. 임의 자동 모델 선택을 약속하지 않는가? 사용자가 역할별로 지정하는 기능으로 기술.
4. 어디서 이어 쓸 수 있는가? 터미널·데스크톱·웹. 무엇이 공유되는가? 동일한 실시간 세션. 원격 조건은? Desktop 연결과 암호화.
5. 코딩 이외에 무엇을 하는가? Browser Use, Computer Use, Office. 각 실행 대상은? 로그인된 Chromium, Windows 앱, Word·Excel·PowerPoint.
6. 비용 차이는? $0.782 대비 $0.476, 39% 절감. 성공률은? 86.1% 대비 86.5%. 비교 범위는? GPT-5.6 Sol xhigh, 89 tasks × 5, 자체 공개 결과.
7. 시작 경로는? Windows 설치 파일 또는 npm CLI 설치. 첫 실행은? 인증·모델·workflow 설정. 실행 명령은? npm install -g mixdog, mixdog.

## 구성

1. 표지 — Mixdog와 가치 제안, typographic anchor.
2. 목표 — 효율성과 접근성을 나란히 놓은 설명, breathing.
3. 핵심 기능 — 역할별 모델 선택·작업 분담·기억을 구분하는 구조, dense.
4. 연결 경험 — 동일 세션을 공유하는 세 접속 표면의 관계 도식, dense.
5. 실행 범위 — Browser Use·Computer Use·Office의 대상별 분류, dense.
6. 측정 근거 — 편집 가능한 비용 비교 차트와 성공률·context 수치, dense.
7. 시작하기 — 설치 명령과 초기 설정 흐름, closing anchor.
