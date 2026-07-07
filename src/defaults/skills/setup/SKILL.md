---
name: setup
description: Use this skill to configure a mixdog installation — request-driven recipes for models, MCP, channels, output style, memory/recap, skills, and secrets. Triggers on "셋업", "세팅 도와줘", "setup", "환경 구성", "모델 바꿔줘", "MCP 추가", "출력 스타일", "디스코드 토큰". Skip for non-configuration tasks.
---

# mixdog Setup Runbook

사용자 요청 → 아래 **레시피**에서 매칭 → 확인 → 변경 → 검증 순서로 진행한다.

> **METHOD·POINTER만** 기록한다. 모델명·토큰·URL·채널 ID 등 **라이브 값은 문서에 넣지 않는다** — 항상 config·런타임 status·환경변수에서 그때 읽는다.

**공통 진단 (편집 전)**  
- Config: `<mixdogData>/mixdog-config.json` (`MIXDOG_DATA_DIR` / `MIXDOG_HOME`로 경로 변경 가능; 정의 `src/runtime/shared/config.mjs`)  
- MCP: TUI `/mcp` 목록 또는 런타임 `mcpStatus()`  
- Skills: `skillsStatus()` 또는 경로 스캔 (§부록)  
- 비밀 존재: `hasStoredSecret(account)` (값 미노출) 또는 `MIXDOG_*` / 표준 provider env

**TUI 진입 공통**  
- 슬래시 명령: `src/tui/app/slash-commands.mjs`  
- 설정 허브: `/setting` (별칭 `/settings`, `/config`) → `src/tui/app/settings-picker.mjs`

---

## 요청별 레시피

**인덱스 — 요청 키워드 → 레시피/명령**

| 요청 | 경로 |
|------|------|
| 메인 모델 변경 | `/model` (아래 레시피) |
| 특정 에이전트 모델 | `/agents` (아래 레시피) |
| 워크플로 슬롯 라우트 | 아래 레시피 표 |
| 웹서치 모델 | `/search` (아래 레시피) |
| reasoning effort | `/effort [level]` (아래 레시피) |
| Fast 모드 | `/fast [on\|off]` (아래 레시피) |
| Provider API 키 | `/providers` (아래 레시피) |
| Provider OAuth 로그인/해제 | `/providers` → Login/Forget (아래 레시피) |
| 로컬/커스텀 엔드포인트 | `/providers` → local (아래 레시피) |
| Usage 로그인 | `/providers` → Usage login (아래 레시피) |
| 출력 스타일 | `/OutputStyle`·`/style` (아래 레시피) |
| TUI 테마 | `/theme [id]` (아래 레시피) |
| 프로필(호칭·언어) | `/profile` (아래 레시피) |
| 음성(채널 보이스 전사) | `/channels` → **Voice** (아래 레시피) |
| autoclear | `/autoclear` (아래 레시피) |
| auto-compact | `/setting` → Auto-compact 토글 (compact type은 고정, 아래 레시피) |
| Recap/메모리 | `/memory` 토글 (아래 레시피) |
| memory interval | config 편집 (아래 레시피) |
| MCP 추가/삭제/재연결/진단 | `/mcp` + config (아래 레시피) |
| 채널/토큰/스케줄/웹훅 | `/channels`, `/schedules`, `/webhooks` (아래 레시피) |
| 원격 세션 클레임 | `/remote` (아래 레시피) |
| 채널 백엔드(Discord↔Telegram) | `/setting` → Channel (아래 레시피) |
| 시스템 셸 | config `shell` (아래 레시피) |
| before-tool hooks | `/hooks` (아래 레시피) |
| 플러그인 | `/plugins` (아래 레시피) |
| 스킬 생성 | 아래 레시피 |
| 워크플로 팩 | `/workflow` (아래 레시피) |
| 프로젝트(작업 디렉터리) | `/project` (아래 레시피) |
| 업데이트 | `/update` (아래 레시피) |
| 조회·세션 조작(레시피 없음) | `/context`(컨텍스트 표면) `/usage`(쿼터) `/resume`(이어하기) `/compact`(컨텍스트 압축) `/clear`(새 채팅) `/autoclear status` `/quit` |

### 메인 모델 변경 ("메인 모델 바꿔줘", "모델 변경")

1. **확인**: TUI 상태줄 또는 `/setting` → **Model** 메타; config `workflowRoutes.lead` / preset `workflow-lead` / 현재 `setRoute` 반영 여부는 `mixdog-config.json`에서 교차 확인.  
2. **변경 (사용자 경로)**  
   - `/model` → 모델 피커 (`openModelPicker` → `store.setModel` → `runtime.setRoute`)  
   - 또는 `/setting` → **Model**  
   - 온보딩 일괄: `mixdog --onboarding` Step 2 **Main** (`completeOnboarding` + `defaultRoute`)  
3. **검증**: 다음 턴부터 적용(진행 중 세션의 라이브 route는 유지). 새 채팅 `/clear` 후 provider/model 표시 확인.

### 특정 에이전트만 모델 변경 ("리뷰어만 다른 모델", "worker 모델")

1. **확인**: `/agents` 목록의 **Reviewer** 등 메타 = `config.agents[<id>]` override; 없으면 Main Model 동적 상속.  
2. **변경**: `/agents` → 에이전트 선택 → 모델 피커 → `store.setAgentRoute` (`src/mixdog-session-runtime.mjs`: `agents`, `presets` `agent-<id>`, workflow-backed면 `workflowRoutes` + `maintenance` 미러).  
3. **검증**: `/agents`에서 해당 에이전트 메타 갱신; config에 `agents.reviewer` (예) 및 일관된 preset 존재.

**Main으로 되돌리기**: TUI `/agents`에는 “Default” 행 없음 → config에서 `agents.<id>` 키 삭제 후 저장, 또는 `mixdog --onboarding` Step 2에서 해당 에이전트 **Default** (onboarding만 override 제거 UI 제공).

### 워크플로 슬롯 라우트 ("lead/agent/explorer/memory 슬롯", "에이전트 라우트")

슬롯 정의: `WORKFLOW_ROUTE_SLOTS = ['lead','agent','explorer','memory']` (`src/session-runtime/workflow.mjs`).

| 슬롯 | 사용자-facing 변경 |
|------|-------------------|
| **lead** | **메인 모델 변경** 레시피 (`/model`) |
| **explorer** | `/agents` → **Explore** |
| **memory** | `/agents` → **Maintainer** |
| **agent** | 전용 TUI 슬롯 피커 없음 → `mixdog --onboarding` Step 2 또는 config `workflowRoutes.agent` + preset `workflow-agent` 수동 일관 편집 |

1. **확인**: config `workflowRoutes`, `presets` (`workflow-<slot>`, `agent-<id>`), `maintenance.explore` / `maintenance.memory`.  
2. **변경**: 위 표 경로; 대량·최초 설정은 `mixdog --onboarding` → `completeOnboarding` → `saveConfigAndAdopt`.  
3. **검증**: **3키 일관성** — `workflowRoutes`, `agents`, `presets`가 서로 모순 없는지 (파일 직접 편집 시 필수).

### Provider API 키 ("API 키 설정", "OpenAI 키")

1. **확인**: `/providers` 또는 `/setting` → **Providers**; provider 행의 authenticated/env 상태.  
2. **변경**: `/providers` → API provider → **Add/Replace API key** → 마스크 입력 (`provider-setup-picker.mjs` → keychain `agent.<provider>.apiKey`). OAuth/local provider는 동일 피커 내 해당 액션.  
3. **검증**: `/providers`에서 authenticated; 필요 시 `/model` 목록 로드 성공.  
**대안**: 표준 env 최우선 (`OPENAI_API_KEY` 등 — §부록 secrets).

### Provider OAuth 로그인 ("클로드 로그인", "OAuth 인증", "구독 계정 연결")

1. **확인**: `/providers` — OAuth provider 행(예: anthropic-oauth, openai-oauth, grok-oauth)의 authenticated 상태.  
2. **변경**: `/providers` → OAuth provider 선택 → **Login** (`login-oauth` → `startOAuthLogin`, 브라우저 로그인 플로우) / 해제는 **Forget** (`forget-oauth`). 자격은 `<mixdogData>`의 provider별 credential 파일(예: `anthropic-oauth-credentials.json`)에 저장.  
3. **검증**: `/providers` authenticated 표시; `/model`에서 해당 provider 모델 목록 로드.

### 로컬/커스텀 엔드포인트 ("로컬 모델", "ollama 연결")

1. **확인**: `/providers` — local provider 행.  
2. **변경**: `/providers` → local provider 선택 → 로컬 엔드포인트 액션 피커(`openLocalProviderActions` — URL 등 설정).  
3. **검증**: `/providers` 상태; `/model` 목록에 로컬 모델 노출.

### Usage 로그인 (OpenCode Go 등) ("사용량 인증")

- `/providers` → 해당 provider → **Usage login (browser)** — 브라우저 로그인 후 auth cookie 자동 캡처(keychain `agent.opencode-go.authCookie`). `/usage`가 쿼터를 못 읽을 때 이 경로.

### 출력 스타일 변경 ("출력 스타일 바꿔", "minimal로")

1. **확인**: config 루트 `outputStyle` (레거시 `agent.outputStyle` 제거 권장); `outputStyleStatus()` / `/OutputStyle status`.  
2. **변경**: `/OutputStyle` 또는 `/style` (인자 없으면 피커); 직접 `/OutputStyle minimal` → `setOutputStyle` (`output-styles.mjs` id·별칭). 사용자 정의: `<mixdogData>/output-styles/<id>.md`.  
3. **검증**: notice의 label; 대화가 있으면 “Use /clear to apply” — 빈 세션은 자동 세션 재생성.

### Recap / 메모리 배경 주기 ("메모리 꺼줘", "recap off")

**구분**: 코어 메모리 도구는 상시; UI **Recap** = config `recap.enabled` (`setMemoryEnabled` → `setRecapEnabled`, `settings-api.mjs`). 전용 `/recap` 명령·`/setting` Recap 행은 **없음** — 진입점은 `/memory` 피커 토글뿐.

1. **확인**: `/memory` → 코어 메모리 피커 상단 토글 메타; config `recap.enabled`.  
2. **변경**: `/memory` 피커 상단 토글 (`core-memory-picker.mjs` → `store.setMemoryEnabled`); 또는 config `recap.enabled` 직접 편집.  
3. **검증**: 토글 후 피커 메타/notice; config `recap.enabled`.

### memory interval ("사이클 간격", "10m 간격")

TUI 전용 interval 피커 없음.

1. **확인**: config `memory.cycle1.interval`, `memory.cycle2.interval` (duration 문자열, 템플릿 `src/defaults/mixdog-config.template.json`).  
2. **변경**: `mixdog-config.json`의 `memory` 섹션 편집 (유효 JSON 유지).  
3. **검증**: 파일 재읽기; memory 데몬은 config 리로드 정책에 따름(변경 후 mixdog 재시작이 가장 확실).

### MCP 서버 추가 — stdio / http ("MCP 추가해줘", "stdio MCP")

**소스**: config `mcpServers` + 프로젝트 `.mcp.json` 병합; 이름 충돌 시 **프로젝트 승** (`mcp-glue.mjs`).

1. **확인**: `/mcp` 연결 수; 프로젝트 `<cwd>/.mcp.json` 존재 여부.  
2. **변경**  
   - **사용자 config**: `mixdog-config.json` → `mcpServers.<name>` 추가 (stdio: `type`,`command`,`args`,`cwd` 프로젝트 하위만; http: `type`,`url`,`headers`) 후 **mixdog TUI 재시작** (런타임 `addMcpServer` / `reconnectMcp`는 `engine.mjs`에 있으나 **TUI 메뉴에서 호출처 없음**; `App.jsx`의 `mcp-add` 텍스트 프롬프트 핸들러만 존재하고 진입 UI 미연결).  
   - **프로젝트 전용**: `<cwd>/.mcp.json` 편집 → 저장 후 TUI 재시작 또는 cwd 변경 시 자동 재연결.  
3. **검증**: `/mcp`에서 `connected`, `toolCount>0`, `source` (config vs project).

### MCP 비활성화 / 삭제 / 재연결

1. **확인**: `/mcp` 서버 행 status·error.  
2. **변경**  
   - **비활성화 (config `mcpServers`만)**: `/mcp` → 서버 선택/←→ → `setMcpServerEnabled` (config 항목). 프로젝트 `.mcp.json` 항목은 파일에서 `enabled:false` 또는 항목 제거.  
   - **삭제**: config면 `mcpServers`에서 키 제거 (`removeMcpServer` — TUI 미노출 → 파일 편집); 프로젝트면 `.mcp.json`에서 제거.  
   - **재연결**: 파일 직접 편집 후 **mixdog 재시작** (`reconnectMcp` TUI 미연결).  
3. **검증**: `/mcp` connected 비율; 실패 시 error 문자열.

### MCP 연결 안 됨 — Unity MCP 등 ("유니티 MCP 연결 안 돼")

1. **확인**: `/mcp`에서 서버명·`source:project`·`transport`·`error`; `<cwd>/.mcp.json` url/command; config 동일 이름 덮어쓰기 여부.  
2. **조치**: HTTP면 URL·방화벽·Unity 쪽 MCP 프로세스 기동; stdio면 `cwd`가 **프로젝트 하위**인지 (`normalizeMcpServerInput`); 충돌 시 프로젝트 정의가 우선인지 확인; `env`는 서버 프로세스용(민감값은 호스트 env 참조).  
3. **검증**: `connected:true`, 기대 tool 노출.

### Discord / Telegram 토큰 ("디스코드 토큰 설정", "채널 설정")

1. **확인**: `/channels` 또는 `/setting` → **Setting** / **Channel**; `getChannelSetup()` authenticated·main target.  
2. **변경**: `/channels` → **Discord** 또는 **Telegram** → **Bot token** → 붙여넣기 (keychain `discord.token` / `telegram.token`, `channel-pickers.mjs`). Main channel/chat ID는 동 피커 **Main channel/chat**.  
3. **검증**: 피커 description “Ready”; `hasStoredSecret('discord.token')` 등 (값 미노출).  
**참고**: `/setting` → **Channels enabled** = 채널 모듈 on/off (`channels` 섹션).

### 스킬 만들기 ("스킬 만들어줘")

1. **확인**: `/skills` 목록; 우선순위 프로젝트 vs 글로벌 (§부록).  
2. **변경**  
   - **프로젝트**: `<cwd>/.mixdog/skills/<name>/SKILL.md` 생성 (frontmatter `name`, `description`).  
   - **글로벌**: `<mixdogData>/skills/<name>/SKILL.md` (이 setup 스킬과 동일 트리).  
   - 런타임 `addSkill` / TUI `skill-add` 프롬프트: **핸들러만 존재, 메뉴 진입 없음** → 파일 생성이 기본 사용자 경로.  
3. **검증**: `/skills`에 표시; 트리거 문구를 `description`에 포함.

### 워크플로 팩 변경 ("워크플로 바꿔")

1. **확인**: `/workflow` 또는 `/setting` → **Workflow** active 표시.  
2. **변경**: `/workflow` → 팩 선택 → `setWorkflow` (`config.workflow.active`).  
3. **검증**: notice + active ✓.

### 웹서치 모델 ("서치 모델 바꿔", "search provider")

1. **확인**: config `searchRoute` (`{ provider, model, effort? }`); 상태줄/`/setting`.  
2. **변경**: `/search` → 모델 피커 → `store.setSearchRoute` (`route-pickers.mjs` `openSearchPicker`). 인자 없이 피커만 지원.  
3. **검증**: config `searchRoute` 갱신; search 툴 호출 시 해당 모델 사용.

### reasoning effort ("effort 올려", "high로")

1. **확인**: 상태줄 effort 표시.  
2. **변경**: `/effort [level]` → `store.setEffort` (현재 라우트/preset에 `effort` 기록). busy 중에는 거부됨.  
3. **검증**: notice "Effort set to <level>"; config 해당 route의 `effort`.

### Fast 모드 ("fast 켜줘")

1. **확인**: 상태줄 fast 표시.  
2. **변경**: `/fast [on|off]` (인자 없으면 토글). busy 중 거부.  
3. **검증**: notice; 다음 턴부터 적용.

### TUI 테마 ("테마 바꿔", "다크 테마")

1. **확인**: `store.getTheme()` / `/theme` 피커의 ✓ 표시.  
2. **변경**: `/theme` (피커) 또는 `/theme <id>` → `setThemeSetting` — **TUI 로컬 설정**, config `ui.theme`에 persist (`src/tui/theme.mjs`). 런타임 왕복 없음, 즉시 적용.  
3. **검증**: 화면 팔레트 즉시 변경 + notice "Theme set to ...".

### 프로필 — 호칭·응답 언어 ("이름 불러줘", "영어로 답해")

1. **확인**: `/setting` → **Profile** 메타.  
2. **변경**: `/profile` (또는 `/setting` → Profile) → title 입력 / 언어 선택 → `setProfile` (`settings-api.mjs`) — config `profile` 섹션 (`title`, `language`; 미지원 언어 id는 `system`으로 정규화, 목록 `PROFILE_LANGUAGES`).  
3. **검증**: config `profile`; 프롬프트 주입은 `composeSystemPrompt` 경유 — 새 세션부터 반영.

### 음성 — 채널 보이스 메시지 전사 ("보이스 켜줘")

전용 `/voice` 명령 **없음** — `/channels` 허브의 **Voice** 행.

1. **확인**: `/channels` → **Voice** 행 meta (On/Off); config `voice.enabled`.  
2. **변경**: **Voice** 행 ←/→ 또는 Enter → `toggleVoice` (`src/tui/lib/voice-setup.mjs`) — config `voice.enabled` persist + 미설치 whisper/ffmpeg 자동 설치 시퀀스 (진행/실패 notice 자체 출력, 설치 중 재토글 거부).  
3. **검증**: Voice 행 meta 갱신; 켜지면 채널로 온 음성 메시지가 전사되어 처리됨.

### autoclear ("자동 클리어", "idle 정리")

1. **확인**: `/autoclear status` 또는 `/setting` → **Auto-clear**.  
2. **변경**: `/autoclear [on|off|<duration>]` (예 `90m`, `1h`) 또는 피커 — `setAutoClear` (`settings-api.mjs`) → config `autoClear` (`enabled`, `idleMs`, provider별 `providerIdleMs`; 최소 1분, 빈 값 리셋=provider 기본).  
3. **검증**: notice "autoclear on · idle <duration>"; idle 초과 시 제출 전 자동 클리어 동작.

### auto-compact ("자동 압축", "컴팩트 방식")

1. **확인**: `/setting` → **Auto-compact** (On/Off); **Compact type** 행은 `Fast-track (fixed)` 고정 표시 — 토글 불가(`_action:null`, `settings-picker.mjs`).  
2. **변경**: `/setting` **Auto-compact** 행에서 ←/→ 또는 Enter 토글 — `applyCompaction({ auto })` → config `compaction.auto`. compact type은 UI에서 변경 불가(Fast-track 고정).  
3. **검증**: `/setting` Auto-compact 메타 갱신; 컨텍스트 높을 때 자동 압축 발동 여부.

### 채널 백엔드 전환 ("텔레그램으로 바꿔", "디스코드로")

1. **확인**: `/setting` → **Channel** 메타 (Discord/Telegram).  
2. **변경**: `/setting` → **Channel** 행에서 ←/→ 순환(`cycleChannelBackend`) → 활성 백엔드 전환; 자격/메인 대상은 바로 아래 **Setting** 행(=`/channels` 딥링크).  
3. **검증**: 메타 표시; 해당 백엔드 토큰이 있으면 remote에서 그 채널로 응답.

### 시스템 셸 ("셸 바꿔", "bash로")

TUI 피커 없음 (settings-api `setSystemShell`만 존재).

1. **확인**: 상태줄/`state.systemShell` (`source: auto|config`, `command`).  
2. **변경**: config `shell` 키 편집 (`normalizeSystemShellConfig`) 후 재시작 — 셸 명령 경로 지정; 비우면 auto 감지.  
3. **검증**: shell 툴 실행 시 해당 셸 사용.

### before-tool hooks ("툴 훅 규칙", "hook 추가")

1. **확인**: `/hooks` → 규칙 목록·최근 이벤트 (`hooksStatus`).  
2. **변경**: `/hooks` 피커에서 규칙 관리 — 저장소: `<mixdogData>/hooks.json` — 표준 형태 `{ "hooks": { <Event>: [{ matcher, hooks:[...] }] } }`(우선) 또는 레거시 `{ "toolBefore":[...] }` 배열도 읽음 (`normalizeRules`/`isStandardConfig`, `src/standalone/hook-bus/config.mjs`). 파일 직접 편집도 가능(mtime 감지로 자동 리로드).  
3. **검증**: `/hooks` 목록 반영; 대상 툴 호출 시 규칙 발동.

### 플러그인 ("플러그인 관리")

1. **확인**: `/plugins` 목록 (manifest·MCP script·skills 감지).  
2. **변경**: `/plugins` 피커에서 활성/비활성 — 플러그인 루트의 `.mcp.json`/`skills/`가 자동 인식됨 (`plugin-mcp.mjs`).  
3. **검증**: `/plugins` 상태 + 해당 플러그인 MCP/스킬 노출 여부.

### 스케줄 / 웹훅 ("스케줄 추가", "웹훅")

1. **확인**: `/schedules` / `/webhooks` (둘 다 `/channels` 허브의 섹션 딥링크).  
2. **변경**: 해당 피커에서 추가/편집.  
   - **스케줄 저장소 = PG 테이블 `scheduler.schedules`** (더 이상 `<mixdogData>/schedules/<n>/SCHEDULE.md` 파일 아님). 관리 API `saveSchedule/deleteSchedule/setScheduleEnabled/listSchedules` (`channel-admin.mjs`) → 스토어 `schedules-db.mjs`.  
   - **필드**: 반복형은 `time`(5·6필드 cron) + 선택 `days`(cron 요일필드로 접힘: daily→`*`, weekday→`1-5`, weekend→`0,6`, `mon,wed,fri`/`1,3,5`→숫자; 못 매핑하면 에러) → `when_cron`. 1회성은 `at`(datetime) → `when_at`. `time`·`at`은 **택1**(스토어 XOR). `channel` 지정 시 `target=channel`+`channel_id`(이때 `model` 필수), 없으면 `target=session`. 본문(instructions)=`prompt`.  
   - **레거시 마이그레이션**: 기존 `schedules/` 디렉터리는 스토어 첫 init 시 SCHEDULE.md들을 테이블로 1회 자동 임포트(같은 days→cron 접힘) 후 디렉터리를 `schedules.migrated`로 rename(삭제 안 함). 한 줄 요약 로그.  
   - **웹훅 저장소 = PG 테이블 `webhooks.endpoints`** (더 이상 `<mixdogData>/webhooks/<n>/WEBHOOK.md` + `secret` 파일 아님). 관리 API `saveWebhook/deleteWebhook/setWebhookEnabled/listWebhooks` (`channel-admin.mjs`) → 스토어 `webhooks-db.mjs`(`upsertEndpoint/deleteEndpoint/setEndpointEnabled/listEndpoints`). 필드: `parser`(github·generic·stripe·sentry), 선택 `channel`(지정 시 `model` 필수)→`channel_id`, `secret`(미지정 시 랜덤 생성, 컬럼에 저장), 본문(instructions), `enabled`.  
   - **웹훅 레거시 마이그레이션**: 기존 `webhooks/` 디렉터리는 스토어 첫 init 시 각 `WEBHOOK.md`+`secret`을 `upsertEndpoint`로 1회 자동 임포트 후 디렉터리를 **삭제**(rename 아님 — 사용자 선택). 부분 실패 시 디렉터리 보존·로그·다음 부팅 재시도. 옛 per-endpoint deliveries(중복제거 이력)는 임포트 안 함(리셋 허용).  
3. **검증**: 피커 목록 반영; 스케줄은 다음 발동 시각 표시.

### 원격 세션 ("리모트 가져와")

1. **확인**: 상태줄 remote 표시.  
2. **변경**: `/remote` = **강제 클레임(항상 ON)** — 다른 세션 좌석을 뺏어옴(그쪽은 자동 OFF). 끄기는 `/channels`에서.  
   **시작 시 자동 클레임**: config `remote.autoStart: true` → 모든 세션이 부팅 때 자동으로 remote 클레임 (`mixdog --remote`와 동일 의미, 마지막에 뜬 세션이 좌석 소유).  
   **토글형**: `/setting` → **Remote Runtime** ←/→ (`applyRemoteRuntime`) — 이 세션의 remote ON/OFF 토글(클레임과 달리 OFF도 가능).  
3. **검증**: notice "Remote mode ON — this session owns remote now."

### 프로젝트 전환 ("프로젝트 바꿔", "cwd 변경")

1. **확인**: 상태줄 cwd; `/project` 피커 목록.  
2. **변경**: `/project [경로]` (인자 없으면 피커) → cwd 전환 — 프로젝트별 `.mcp.json`/skills 자동 재로드·MCP 재연결, 마지막 cwd persist.  
3. **검증**: 상태줄 cwd; `/mcp`에서 프로젝트 서버 반영.

### 업데이트 ("업데이트 확인")

1. **확인/변경**: `/update` → 버전 확인·업데이트 피커 (`openUpdatePicker`; 자동 체크 설정은 update settings).  
2. **검증**: 피커에 현재/최신 버전 표시.

---

## 부록 — 경로·스키마 (압축)

| 항목 | 위치 |
|------|------|
| Config | `<mixdogData>/mixdog-config.json` |
| 템플릿 | `src/defaults/mixdog-config.template.json` |
| Skills | `<cwd>/.mixdog/skills/<n>/SKILL.md` → `<mixdogData>/skills/<n>/SKILL.md` (프로젝트 우선) |
| 프로젝트 MCP | `<cwd>/.mcp.json` |
| Mixdog.md | 자동 프롬프트 로드 **없음** — skill/core memory로 대체 |

**outputStyle** — 루트 문자열; id: `default`, `simple`, `minimal`, `extreme-minimal` (+ 별칭 `output-styles.mjs`).

**memory** — `{ enabled, user, cycle1: { interval }, cycle2: { interval } }` (interval은 duration 문자열).

**channels** — `{ promptInjection: { mode, targetPath } }`; 식별·백엔드는 `channel`, `channelsConfig`, `discord.applicationId` 등 (진단 로직 참조).

**MCP config 예시 (shape만)**  
- stdio: `{ "type":"stdio", "command":"...", "args":[], "cwd":"<프로젝트 하위>", "env":{} }`  
- http: `{ "type":"http", "url":"https://...", "headers":{} }`  
- 비활성: `"enabled": false`

**라우트 스키마** — `{ provider, model, effort? }`; 키: `workflowRoutes`, `agents`, `presets`, `maintenance`, `searchRoute`.

**Secrets / env (`SECRET_ACCOUNTS`)** — config에 비밀 저장 금지; OS keychain.

| account | env (예) |
|---------|----------|
| `discord.token` | `MIXDOG_DISCORD_TOKEN` |
| `telegram.token` | `MIXDOG_TELEGRAM_TOKEN` |
| `webhook.authtoken` | `MIXDOG_WEBHOOK_AUTHTOKEN` |
| `agent.<provider>.apiKey` | provider별 표준 env 우선 (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY` / `GROK_API_KEY`, `OPENCODE_API_KEY` 등 — `config.mjs`) |
| `agent.openai.usageSessionKey`, `agent.opencode-go.authCookie` | (provider 피커 전용) |

MCP 항목 `env` = 서버 자식 프로세스 환경 (keychain 아님).

---

## 규칙

METHOD·POINTER만 유지. 확인되지 않은 키는 추측하지 말고 TODO. TUI에 없는 런타임 API(`addMcpServer`, `removeMcpServer`, `reconnectMcp`)는 **config 편집 + mixdog 재시작**으로 문서화한다.
