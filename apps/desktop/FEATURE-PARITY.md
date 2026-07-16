# OpenCode → Mixdog Desktop 기능 패리티 체크리스트

기준: C:\Project\refs\opencode (packages/app, packages/ui, packages/desktop).
규칙: 모든 항목은 refs 파일을 직접 읽고 구현/검증한다. 상태 = done / partial / missing / deferred / n-a(Mixdog 미해당).
워커는 자기 영역 항목을 갱신하고, 새로 발견한 refs 기능은 반드시 추가한다.

## A. 타이틀바 / 탭
- [x] 커스텀 타이틀바 + WCO 드래그 영역 (desktop titlebar.tsx) — done
- [x] 워크스페이스 탭 + "+" 새 탭 흐름 배치 — done
- [ ] 탭 드래그 정렬 (session-sortable-tab.tsx) — in progress (2차)
- [ ] 탭 상태 인디케이터: working/notification 점 (tab-state-indicator.tsx) — missing
- [ ] 타이틀바 히스토리 뒤/앞 네비 (titlebar-history.ts) — missing
- [ ] Windows 앱 메뉴 (windows-app-menu.tsx) — missing (현재 autoHideMenuBar)

## B. 사이드바
- [x] 세션 검색 입력 (sidebar-shell) — 동작 검증 필요 partial
- [x] Projects/Tasks 구조 (Mixdog 고유 유지) — done
- [ ] 프로젝트 아바타 (project-avatar-v2) — in progress (2차)
- [x] 인라인 rename (inline-editor.tsx) — done
- [ ] 행 hover/active/컨텍스트 액션 정합 (sidebar-project/workspace) — in progress (2차)
- [ ] 세션 삭제/우클릭 컨텍스트 메뉴 (context-menu.tsx) — missing
- [ ] 사이드바 리사이즈 핸들 (resize-handle.tsx) — missing

## C. 대화 / 트랜스크립트
- [x] 마크다운(GFM)·코드블록·표 오버플로 — done(1차)
- [x] 도구 카드 접기/펼치기·상태·ARIA — done(1차)
- [ ] 도구 카운트 요약/상태 타이틀/에러 카드 (tool-count-*, tool-status-title, tool-error-card) — in progress (2차)
- [ ] 스트리밍 shimmer (text-shimmer) — in progress (2차)
- [ ] todo/plan 독 (session-todo-dock) — in progress (2차, 데이터 없으면 skip 보고)
- [ ] 메시지 네비게이션 (message-nav) — in progress (2차)
- [ ] 컨텍스트/토큰 사용량 (session-context-usage/-metrics) — in progress (2차)
- [x] 승인(permission) 독 — Mixdog 방식 유지 done
- [ ] 질문 독 (session-question-dock) — Mixdog ask 이벤트 매핑 확인 missing
- [x] revert/체크포인트 독 (session-revert-dock) — n-a (Mixdog 엔진에 메시지 revert/체크포인트 기능 없음)
- [x] 사용자 메시지 hover 메타/Copy 행 + 응답 시각 표시 — done (엔진 per-item agent·model·at 사용, 레거시 세션은 누락 세그먼트 생략)
- [ ] 세션 회차(turn) 재시도 (session-retry) — missing
- [x] 디프 뷰어 — done(1차, 헝크 유실 픽스 라운드 중)
- [ ] 이미지/미디어 파일 미리보기 (file-media, image-preview) — missing

## D. 컴포저
- [x] 첨부 칩·이미지 프리뷰·제거·오류 — done(1차)
- [x] 드래그&드롭 오버레이 — done(1차)
- [ ] 붙여넣기 첨부 (paste.ts) — in progress (2차)
- [ ] 프롬프트 히스토리 ↑/↓ (history.ts) — in progress (2차)
- [x] @파일 컨텍스트 참조 (context-items, file-search) — done
- [ ] 플레이스홀더 로테이션 (placeholder.ts) — in progress (2차)
- [x] 슬래시 팝오버/커맨드 팔레트 — done(1차, CommandSurface)
- [x] 모델/effort/Fast 라우트 컨트롤 (Mixdog 고유) — done
- [ ] 에이전트 선택 (dialog-select-model 계열의 agent 변형) — Mixdog agent/workflow 선택 GUI 확인 partial

## E. 설정
- [x] 설정 다이얼로그 프레임·센터링·스크롤 — done
- [x] capability 설정 전체 (Mixdog 고유) — done
- [ ] 설정 구조 정합: General/Models/Providers/Keybinds 탭 구조 (settings-v2/*) — partial(단일 리스트)
- [ ] 키바인드 설정 화면 (settings-keybinds.tsx) — missing
- [ ] 모델 관리 다이얼로그 (dialog-manage-models) — missing
- [ ] 프로바이더 연결/커스텀 프로바이더 (dialog-connect-provider, dialog-custom-provider) — Mixdog 온보딩과 중복 여부 판단 partial

## F. 셸 크롬
- [x] 토스트 스택·역할·해제 — done(1차, 에러 자동만료 High 픽스 라운드 예정)
- [x] 라이트/다크 전면 정합·스크롤바·캐럿 — done(1차)
- [ ] 웹뷰 줌 Ctrl+=/-/0 (webview-zoom.ts) — in progress (2차)
- [ ] 키바인드 칩 툴팁 (keybind.tsx) — in progress (2차)
- [ ] 상태 팝오버(런타임 헬스) (status-popover.tsx) — in progress (2차)
- [ ] 릴리스 노트 다이얼로그 (dialog-release-notes) — deferred (업데이터 UX 웨이브)
- [ ] 사운드 큐 (utils/sound.ts) — missing
- [x] 온보딩 위저드 — done(1차, Escape High 픽스 라운드 예정)

## G. 시스템 통합 (다음 웨이브)
- [ ] mixdog:// 딥링크 수신 라우팅 (deep-links.ts) — 등록만 됨, 수신 동작 missing
- [ ] 업데이터 UX: 업데이트 배지/재시작 액션 (updater-action.ts) — missing
- [ ] 네이티브 메뉴·단축키 전체표 (menu.ts, desktop-menu-actions.ts) — partial
- [ ] 알림 클릭 포커싱 (notification-click.ts) — missing
- [ ] 첨부 파일 피커 (attachment-picker.ts main) — partial(renderer input만)
- [ ] 외부 앱에서 열기: 설치된 에디터/터미널 감지 + 프로젝트 열기 (main/apps.ts, resolveWindowsAppPath) — missing (Lead 직접 대조 발견)
- [ ] 로그인 셸 env 상속: 패키징 앱이 유저 셸 PATH/env로 엔진 스폰 (main/shell-env.ts) — missing, macOS 품질에 특히 중요
- [ ] 렌더러 무응답 진단 샘플러 (main/unresponsive.ts, collectJavaScriptCallStack) — missing, low priority
- 참고: main/markdown.ts는 marked 렌더러 구성 — react-markdown 사용 중이므로 n-a

## H. 대형 기능 (사용자 결정 대기)
- [ ] 터미널 패널 (terminal-panel, terminal.tsx) — deferred
- [ ] 파일 트리/파일 탭 (file-tree, file-tabs) — deferred
- [ ] 리뷰 탭/라인 코멘트 (review-tab, line-comment*) — deferred
- [ ] i18n 다국어 (i18n/*) — deferred

## 부록: refs 전수 대조표 (Lead 직접 건바이건 판정)
판정: done(구현) / partial / missing / deferred / n-a(Mixdog 미해당·오픈코드 전용) / prim(디자인 프리미티브 — 사용처 정합으로 커버).

### packages/app/src/pages
- layout.tsx, sidebar-shell/-project/-workspace/-items — done(사이드바 정합·아바타·접기·rename)
- layout/inline-editor — done · layout/project-avatar-state — done · layout/deep-links — missing(G)
- home.tsx, new-session.tsx — partial(빈 상태 done; worktree/sandbox 선택은 deferred)
- session.tsx, session-layout, new-session-layout — done(워크스페이스 뷰)
- session/timeline (message-timeline, rows, projection, measure, model) — done(트랜스크립트+가상화는 Mixdog 방식)
- session/composer: region/state — done · permission-dock — done(승인 독) · question-dock — missing(C, ask 이벤트 매핑 확인) · todo-dock — skipped(엔진 todo 데이터 없음) · revert-dock — n-a(엔진 체크포인트 미지원) · followup-dock — missing(C, 후속 제안) · request-tree — n-a
- session/file-tabs, file-tab-scroll, review-tab, terminal-panel, session-side-panel, terminal-label — deferred(H)
- session/handoff — missing(low, 세션 간 드래프트 인계) · message-gesture — missing(low, 휠 경계 제스처) · message-id-from-hash, use-session-hash-scroll — n-a(라우터 해시)
- session/usage-exceeded-dialogs — n-a(과금) · session-model-helpers, use-session-commands, helpers — 내부 로직 n-a
- directory-layout.tsx, error.tsx, error-description — partial(에러 화면 단순형 존재)

### packages/app/src/components
- prompt-input.tsx + attachments/paste/history/placeholder/slash-popover/drag-overlay/image-attachments/context-items/files — done(전부 이식; @파일 포함)
- prompt-input/build-request-parts, editor-dom, submit — n-a(내부 구현)
- session/session-header — done(워크스페이스 헤더) · session-sortable-tab — done(탭 드래그) · session-sortable-terminal-tab — deferred(H)
- session/session-context-tab/-metrics/-format/-breakdown, session-context-usage — done(컨텍스트 사용량 인디케이터)
- session/session-new-design-view — partial(위 new-session과 동일)
- settings-v2 전체(general/models/providers/servers/dialog) + settings-general/-models/-providers/-servers/-list/-server-picker — partial(E, Mixdog 단일 리스트 구조 유지 결정)
- settings-keybinds — missing(E)
- dialog-select-model/-provider/-directory(v2)/-file/-mcp/-server, directory-picker* — partial(Mixdog식 픽커 존재; 파일/디렉토리 네이티브 픽커는 G 첨부 피커와 연동)
- dialog-manage-models — missing(E) · dialog-connect-provider/-custom-provider — partial(온보딩이 담당)
- dialog-fork — missing(H 후보, 엔진 fork 지원 필요) · dialog-edit-project — partial(rename만) · dialog-release-notes — deferred(F)
- dialog-select-model-unpaid, dialog-usage-exceeded — n-a(과금) · dialog-settings — done(설정 모달)
- file-tree — deferred(H) · terminal — deferred(H) · debug-bar — n-a(dev 전용) · help-button — n-a(dev 채널 전용)
- model-tooltip — missing(low, 모델 hover 상세) · status-popover(+body) — done(런타임 상태 팝오버)
- titlebar.tsx — done · titlebar-history — missing(G) · titlebar-session-events — partial(탭 상태 인디케이터 missing과 연동)
- windows-app-menu — missing(G) · updater-action — missing(G) · server-row(-menu) — n-a(멀티서버)
- link.tsx — done(외부 링크 openExternal)

### packages/app/src/context·utils (동작 계약)
- command/prompt/tabs/layout/settings/notification/permission(-auto-respond)/models/model-variant — done(Mixdog 대응 구조 존재)
- file/highlights/comments/terminal(-title)/mcp — deferred(H 연동) · sdk/server*/sync/global-sync — n-a(Mixdog 브리지 방식)
- utils: toast — done · sound — missing(F) · worktree — n-a(엔진 미지원) · notification-click — missing(G) · session-title — done · persist — done(창 상태/설정) · 나머지(id/base64/time/refcount 등) — n-a(유틸)

### packages/ui/src/components (+v2)
- markdown, message-part, session-turn, basic-tool, tool-count-label/-summary, tool-status-title, tool-error-card, text-shimmer, spinner, diff-changes, message-nav — done(대화 영역 이식)
- toast, dialog, select, switch, checkbox, radio-group, tabs, text-field, textarea, button, icon-button, tooltip, keybind, popover, dropdown-menu, menu-v2, list, card, tag, badge, accordion, collapsible, segmented-control, field, inline-input, avatar, project-avatar, progress(-circle), scroll-view, hover-card, motion-spring, text-reveal/-strikethrough, typewriter, animated-number, wordmark, logo, app-icon, favicon, font, icon — prim(각 영역 정합으로 커버; 개별 도입 불필요 판정)
- context-menu — missing(B, 세션 우클릭) · resize-handle — deferred(H 사이드패널) · image-preview, file-media, file-icon, file(-ssr), file-search — partial(@파일 검색 done; 미디어 프리뷰 C missing)
- session-review, line-comment(-annotations), sticky-accordion-header — deferred(H 리뷰 탭) · session-retry — missing(C) · dock-prompt/-surface — prim(독 구현에 흡수) · message-part 세부(tool-count-summary 등) — done · provider-icon — done(프로바이더 표시) · progress — prim · file-ssr — n-a(웹)
- theme/* (다중 테마 로더) — partial(라이트/다크만; 다중 테마 deferred) · pierre/* — deferred(H 디프 엔진; @git-diff-view 사용 중)

### packages/desktop/src
- main: windows/window-state/store — done · menu/desktop-menu-actions — partial(G 메뉴 전체표) · ipc/preload — done(Mixdog 계약) · updater* — partial(컨트롤러 done, UX G) · sidecar/server — n-a(엔진 상주 방식 상이) · migrate — done(레거시 마이그레이션 자체 구현) · logging — missing(low, 파일 로그) · apps.ts — missing(G 외부 앱 열기) · shell-env — missing(G) · unresponsive — missing(low) · attachment-picker — partial(G) · markdown.ts — n-a · store-keys/constants/initialization — n-a(내부)
- renderer: webview-zoom — done · cli.ts(installCli) — n-a(mixdog 자체가 CLI) · i18n — deferred(H) · wsl/* — n-a · initialization/html — n-a(부트스트랩 상이)
- electron-builder.config — done(Phase 1 정합) · icons/resources — done(브랜딩)

## I. TUI 옵션 패리티

기준: `src/tui/app/slash-commands.mjs`의 공개 명령 30개, `settings-picker.mjs`의 19개 행,
각 행/명령이 여는 중첩 피커, 그리고 `src/session-runtime/settings-api.mjs`의 해당 읽기/쓰기 경로.
`done`은 현재값 읽기와 동일 의미의 변경/영속화(세션 전용 값은 세션 반영)를 모두 확인한 상태다.

### 공개 슬래시 명령

| 옵션 | Desktop control | 상태 |
|---|---|---|
| `/clear` (`/new`) | Composer command → clear current chat / create new task | done |
| `/project` | Project switcher or path argument | done |
| `/compact` | Composer command → `compact` | done |
| `/autoclear` | Settings → Auto-clear; on/off/status/duration arguments | done |
| `/resume` | Session switcher or session-id argument | done |
| `/context` | CommandSurface → Context | done |
| `/usage [refresh]` | CommandSurface → Provider usage + refresh | done |
| `/model` | Settings → Model (provider/model/effort/Fast) | done |
| `/search` | Settings → Search model (provider/model/effort/Fast) | done |
| `/workflow` | Settings → Workflow or id argument | done |
| `/OutputStyle [name]` | Settings → Output style or name argument | done |
| `/theme [id]` | Settings → Theme preview/choose or id argument | done |
| `/agents` | CommandSurface → Agents (model/effort/Fast per route) | done |
| `/effort [level]` | CommandSurface → Reasoning effort or level argument | done |
| `/fast [on\|off]` | Composer command + Model Fast mode switch | done |
| `/mcp` | Settings → MCP servers enable/disable/status | done |
| `/skills` | Settings → Skills enable/disable | done |
| `/memory` | CommandSurface → Memory toggle + core-memory CRUD; argument passthrough | done |
| `/plugins` | Settings → Plugins add/update/remove/plugin MCP | done |
| `/hooks` | Settings → Hooks policy-rule enable/disable | done |
| `/providers` | Settings → Providers API key/OAuth/local endpoint | done |
| `/channels` | CommandSurface → Channels/runtime/backend/voice/auth/target/endpoint | done |
| `/remote` | Composer command → claim remote for this session | done |
| `/schedules` | CommandSurface → schedule status/enable/disable | done |
| `/webhooks` | CommandSurface → webhook status/enable/disable | done |
| `/setting` (`/settings`, `/config`) | Settings root | done |
| `/profile` | Settings → Profile title/language | done |
| `/update` | Settings → Update check/auto-update/install | done |
| `/doctor` | CommandSurface → diagnostics | done |
| `/quit` (`/exit`, `/q`) | Desktop quit action | done |

### Settings 행과 중첩 옵션

| 옵션 | Desktop control | 상태 |
|---|---|---|
| `Profile` | Profile → Title + Language; `getProfile`/`setProfile` | done |
| `Auto-clear` | Inline toggle + provider idle-window editor/reset | done |
| `Auto-compact` | Inline toggle; `get/setCompactionSettings.auto` | done |
| `Compact type` | Fixed “Fast-track”; no selectable TUI value | n-a |
| `Channels enabled` | Inline toggle; `get/setChannelSettings` | done |
| `Remote Runtime` | Inline toggle plus `/remote` claim action | done |
| `Channel` | Discord/Telegram selector; `getChannelSetup`/`setBackend` | done |
| `Setting` | Discord/Telegram token and main target editors | done |
| `Output style` | Current style list + persisted selection | done |
| `Theme` | Current theme, non-persistent preview, persisted choose, cancel restore | done |
| `Workflow` | Active workflow list + persisted selection | done |
| `Model` | Current model + model-aware Effort + Fast round-trip | done |
| `Search model` | Current search route + model-aware Effort + Fast round-trip | done |
| `Providers` | API-key replace/forget, OAuth login/forget, local URL/enable | done |
| `MCP servers` | Status and per-server enable/disable | done |
| `Plugins` | Install/list/update/remove/copy metadata/enable MCP | done |
| `Hooks` | Existing before-tool approval-policy rule status/toggle | done |
| `Skills` | Current disabled set + per-skill enable/disable | done |
| `Update` | Current/latest, check, auto-update, install/stage | done |
| `Memory / recap` | Background-cycle toggle and core-memory add/edit/delete | done |
| `Agents` | Every workflow agent route: provider/model/Effort/Fast | done |
| `Voice` | Channels CommandSurface → install/enable/disable/status | done |
| `Webhook endpoint` | Channels CommandSurface → ngrok domain/authtoken | done |
| `Schedules / Webhooks` | Dedicated CommandSurface status/toggles | done |
| `Approvals policy` | Hooks rule toggles; per-request Allow once/Deny approval dialog | done |

### 런타임 API지만 공개 TUI 옵션이 아닌 항목

| 옵션 | Desktop control | 상태 |
|---|---|---|
| `/cwd`, `/auth`, `/auth-forget` legacy dispatch | Project / Providers public controls supersede them | n-a |
| `/tools`, `/recall` internal dispatch | Not present in the public TUI command registry | n-a |
| `Tool mode` (`full`/`readonly`/`lead`) | Runtime API only; no TUI settings/command surface | n-a |
| `System shell` | Runtime API/config only; no TUI settings/command surface | n-a |
| Approval timeout/queue | Engine-owned safety behavior, not user-tunable | n-a |

## Mixdog 고유기능 반영 검증 (Lead 직접 대조, 2026-07-16)
- 트랜스크립트: 엔진 방출 kind 6종(user/assistant/tool/notice/statusdone/turndone) 전부 데스크탑 TranscriptRow 처리 — 유실 없음 (App.tsx:1580-1592 분기 확인)
- 슬래시 명령 31종: TUI 레지스트리(src/tui/app/slash-commands.mjs)와 1:1, 데스크탑 가드 테스트가 TUI 원본을 직접 import (리뷰 클린)
- 설정 19행: TUI settings-picker와 1:1, 값 라운드트립 검증 완료 — 에이전트 라우트 model/effort/fast 갭은 수리됨
- TUI 전용 인터랙티브 프롬프트(픽커 kind들: api-key, channel-add, mcp-add 등)는 데스크탑 Settings/CommandSurface 폼으로 대응 — 파리티 테이블 참조
- 고유 구조 유지 확인: Projects/Tasks 사이드바, 승인 독, model/effort/Fast 라우트 컨트롤, 원격 런타임 토글, 메모리/채널/스케줄/웹훅/doctor/usage/context 서피스

## 인스톨/배포 방식 대조 (Lead 직접 대조, refs electron-builder.config.ts ↔ apps/desktop/electron-builder.yml)
- 일치: 원클릭 per-user NSIS(oneClick+perMachine:false), 설치자 아이콘, artifactName 패턴(${os}-${arch}), 딥링크 프로토콜(mixdog://), win verifyUpdateCodeSignature:false, mac category/hardenedRuntime/gatekeeperAssess/dmg+zip 타깃, GitHub publish provider 구조
- Mixdog 고유(의도): runtime.asar 사이드카(엔진 런타임 단일 파일 설치), createDesktopShortcut always
- [ ] mac 배포 품질 갭: entitlements.plist, notarize:true, dmg sign — mac 릴리스 전 필수
- [ ] 채널 분리 갭: refs는 dev/beta/prod appId·productName·publish repo 분리 — 릴리스 인프라 확정 시 도입
- [ ] win 코드사이닝: refs는 CI 전용 sign 스크립트 — 인증서 확보 시 도입
- [ ] publish owner/repo 플레이스홀더 — 릴리스 repo 미정 (기존 TODO)
- n-a: linux 타깃(AppImage/deb/rpm), 레거시 .desktop 엔트리 보존 — 제품 결정상 미지원
