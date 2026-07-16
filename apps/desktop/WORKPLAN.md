# Mixdog Desktop — OpenCode 정합 작업 계획

목표: OpenCode(refs/opencode/packages/desktop) 기준으로 GUI 기능·디자인·설치를 맞추고,
Mixdog TUI의 모든 옵션/기능을 데스크탑에 이식한다.
유지 원칙: Projects/Tasks 구조, 승인 UI, 모델·effort·fast 선택은 Mixdog 방식 유지.

진행 상태는 이 문서에서 갱신된다.

## Phase 0 — 레거시 정리 ✅ 완료
- [x] 레거시 설치본 언인스톨 (`C:\Program Files\Mixdog`, HKLM 등록 제거)
- [x] 바탕화면 설치파일 삭제 (`Mixdog-0.1.0-setup-x64.exe`)
- [x] 빌드 원본 삭제 (`apps/desktop/dist`)
- [x] 스모크 테스트 잔재 삭제 (`%LOCALAPPDATA%\Programs\MixdogSmoke2`)
- [ ] 잔여: `C:\Program Files\Mixdog` 빈 폴더 — 관리자 권한 수동 삭제 필요

## Phase 1 — 성능 병목 해소 ✅ 완료
- [x] 시작·세션 전환 타이밍 계측(개발 모드)
- [x] 스냅샷 발행 코얼레싱 — 엔진 이벤트마다 전체 transcript structuredClone+IPC 전송 제거 (engine-host.ts publishNow)
- [x] TranscriptRow 메모이제이션 — 긴 세션 전체 리스트 재렌더 제거 (App.tsx)
- [x] 세션 전환 시 중복 디스크 재스캔 제거 (resumeSession listSessions refreshFromStorage)
- [x] 무거운 렌더러 모듈 lazy 분할 (SettingsView, OnboardingWizard, CommandSurface, DiffView)

## 성능 최적화 요약 — 회귀 고정
### 고정 완료
- [x] 엔진 이벤트 snapshot 발행은 50ms 코얼레싱하고 구독자가 없으면 transcript 복제를 생략
- [x] `TranscriptRow`는 item/completion signature 비교로 안정된 행의 재렌더를 생략
- [x] `resumeSession`은 캐시된 세션 목록에 대상이 있으면 디스크 refresh를 하지 않음
- [x] Settings, Onboarding, Command Surface, Diff View는 renderer 초기 번들에서 lazy 분할
- [x] native menu 생성은 첫 renderer load 뒤로 지연하고 Electron 39 renderer bundle은 native module preload를 사용
### 남은 항목
- [ ] 실제 장기 transcript/대형 diff 프로파일로 코얼레싱 간격과 lazy chunk 크기 측정
- [ ] Phase 2 GUI 기능 이식 후 세션 전환 및 설정 화면의 end-to-end 성능 기준선 추가

## Phase 1 — 설치 OpenCode 스타일 ✅ 완료
- [x] refs/opencode electron-builder.config.ts 기준 설치 구성 정합 (per-user, 아이콘, 산출물 네이밍)
- [x] `mixdog://` 딥링크 프로토콜 등록
- [x] NSIS 최소 구성 정합 (one-click, per-user, 바탕화면 바로가기 유지)
- [x] packaging 테스트 및 데스크탑 빌드 검증

## Phase 2 — TUI 기능 전체 이식 ✅ 완료
- [x] TUI 옵션/명령/기능 인벤토리 작성 (slash 명령, 설정, 모델/agent/workflow/memory/channels/훅/스킬/플러그인/MCP 등)
- [x] 데스크탑 미노출 기능 GUI 이식 (capability 브리지 + Settings/CommandSurface)
- [x] 회귀 테스트

## Phase 3 — OpenCode 디자인 전 영역 정합 ✅ 완료
- [x] refs/opencode 사이드바·대화·도구 카드·입력창·설정 디자인 대조
- [x] 테마/타이포/간격/아이콘 정합
- [x] 최종 스크린샷 비교 검증 — capture:ui 통과 (artifacts/mixdog-desktop-window-1113x687.{png,json}, 사이드바 286px 기하·테마 픽셀·라이브 어서션 확인)

## Phase 4 — 최종 검증 ✅ 완료
- [x] 전체 테스트 — parity 3/3, settings 16/16, packaging 9/9, updater 3/3, typecheck 통과 (renderer 5건 실패는 HEAD 기존 결함: 21/50/59/63/64)
- [x] 시작 크래시 수리 — electron-updater CJS named import가 패키징 ESM 메인 번들에서 SyntaxError → default import로 교체 (src/main/updater.ts)
- [x] acceptance smoke 갱신 — Windows titleBarOverlay 기하(titlebar 영역 폭) 기준으로 topbar 어서션 수정 (scripts/cdp-smoke.mjs)
- [x] 설치본 실검증 — install/native-resolution/project-chat-approval-routing/app-exit/uninstall 전 단계 통과, ACCEPTED=true (dist/acceptance-8117beccc788740c.json)

## Phase 5 — 영역별 완제품 폴리시 + refs 갭 이식 🔄 진행 중
영역별 팬아웃: 각 영역 = 1차 폴리시 → 리뷰 → refs(C:\Project\refs\opencode packages/app+ui) 갭 2차.
- [x] 타이틀바·탭·사이드바 1차 (드래그, + 버튼, 침범, 타이포, 폴더 아이콘) — 리뷰 클린
- [x] 설정 모달 복구+센터링, set-fast 프리스틴 오류 수리 — 픽스 라운드 진행(pendingFast 덮어쓰기, @layer 캐스케이드)
- [x] 대화 영역 1차 (마크다운/도구 카드/디프/승인 15건) — 픽스 라운드 대기(디프 선두 헝크 유실, 외부 링크, pre 줄바꿈)
- [x] 컴포저·OpenSelect·CommandSurface 1차 — 리뷰 진행
- [x] 온보딩·토스트·테마·스크롤바 1차 — 리뷰 진행
- [ ] refs 갭 2차: 프로젝트 아바타·인라인 rename·탭 정렬 / 도구 카드 요약·shimmer·todo 독·메시지 네비·사용량 / 붙여넣기 첨부·히스토리·@파일·플레이스홀더 / 줌·키바인드 칩·상태 팝오버
- [ ] 전 영역 리뷰 클린 → 전체 테스트+capture 교차 검증 → 재빌드 → 커밋

## 보류 백로그 (다음 웨이브)
- [ ] 터미널 패널, 파일 트리/파일 탭, 리뷰(diff) 탭 — 대형 기능, 사용자 결정 대기
- [ ] 세션 우클릭 컨텍스트 메뉴·삭제, Search sessions 실동작 점검
- [ ] 네이티브 메뉴/단축키 전반, mixdog:// 딥링크 수신, 업데이터 UX
- [ ] i18n (오픈코드 다국어 대비 영문 고정)
