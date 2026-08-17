---
name: setup
description: Use this skill only to inspect or modify a Mixdog user's persisted configuration and settings. Skip Mixdog source changes, builds, installs, releases, and development deployment.
---

# mixdog Setup Runbook

사용자 요청을 아래 레시피에 매칭하고 **확인 → 변경 → 검증** 순서로 진행한다.

> **METHOD·POINTER만 기록한다.** 모델명·토큰·URL·채널 ID 같은 라이브 값은 이 문서에 넣지 않고, 매번 config·런타임 status·환경변수에서 읽는다.

## 0. 기준과 저장 구조

### 공통 경로

- `<mixdogData>` 해석 순서: `MIXDOG_DATA_DIR` → `<MIXDOG_HOME|~/.mixdog>/data` (`src/runtime/shared/plugin-paths.mjs`)
- 통합 config: `<mixdogData>/mixdog-config.json`
- 프로젝트 config: `<cwd>/.mcp.json`, `<cwd>/.mixdog/skills/`, `<cwd>/.mixdog/hooks.json`
- TUI 명령 목록: `src/tui/app/slash-commands.mjs`
- TUI 설정 허브: `/setting` (별칭 `/settings`, `/config`) → `src/tui/app/settings-picker.mjs`
- Desktop 설정: `Ctrl+,` → General / Context / Output style / Providers / Git / Skills / MCP / Plugins / Hooks / Channels / Connection / System / Shortcuts / About
- Desktop rail: **Projects / Workflows / Schedules / Webhooks / Utilities**

사용자 경로와 지원 여부는 **현재 Desktop 구현을 최신 기준**으로 판정한다. TUI는 Desktop에 없는 고급 경로를 보완할 때만 사용하며, 저장만 왕복되고 실제 소비되지 않는 key는 사용자 옵션으로 설명하지 않는다.

### config 중첩 규칙

런타임 API는 agent 설정을 flat object처럼 다루지만, 디스크에서는 대부분 `agent` 섹션 아래에 저장한다.

| 영역 | 디스크 경로 |
|---|---|
| Lead 모델 | `agent.presets[id=workflow-lead]` + `agent.default` |
| 에이전트 라우트 | `agent.agents.<id>` |
| Search 모델 | `agent.searchRoute` |
| Provider·MCP·프로필·스킬·업데이트·셸·autoClear·compaction | `agent.*` |
| Web search 도구 | `agent.modules.search.enabled` |
| Channels messaging | `agent.modules.channels.enabled` |
| Recap(배경 사이클) | `agent.recap.enabled` |
| 출력 스타일 | 루트 `outputStyle` |
| Discord/Telegram provider·target·webhook server | `channels.*` (`channels.provider`) |
| 메모리 cycle interval | `memory.cycle1.interval`, `memory.cycle2.interval` |
| 음성 전사 | `voice.enabled` |
| TUI 테마 | `ui.theme` |

`agent.workflowRoutes`는 저장하지 않는다. 로드 시 레거시 값을 `agent.agents`로 이관한 뒤 제거한다.

API 키·토큰·OAuth 자격은 config에 쓰지 않는다.

### 공통 진단

- MCP: `/mcp`, Desktop **Settings → MCP**, 또는 `mcpStatus()`
- Skills: `/skills`, Desktop **Settings → Skills**, 또는 `skillsStatus()`
- Providers: `/providers`, Desktop **Settings → Providers**, 또는 `getProviderSetup()`
- Channels: `/channels`, Desktop **Settings → Channels**, 또는 `getChannelSetup()`
- 비밀 존재 여부: `hasStoredSecret(account)`만 사용하고 값은 출력하지 않는다.

---

## 1. 모델·라우팅·워크플로

### 메인 모델 변경

1. **확인**: 상태줄·세션 헤더, TUI `/setting → Model`, 디스크 `agent.presets[id=workflow-lead]` / `agent.default`.
2. **변경**: `/model` 또는 세션 헤더 모델 피커 → provider → model → effort/Fast → 저장 (`setRoute` → `persistLeadRoute`).
3. **검증**: 비어 있는 현재 세션은 즉시 반영된다. 대화 이력이 있으면 기존 세션 route는 유지되고 다음 세션부터 적용되므로 `/clear` 후 provider/model을 확인한다.

온보딩 일괄 설정은 `mixdog --onboarding` 또는 Desktop wizard **Main**.

### 특정 에이전트 모델 변경

고정 서비스는 **Maintainer**뿐이다. `worker` / `heavy-worker` / `reviewer`와 사용자 에이전트는 custom 정의다.

1. **확인**: Desktop rail **Workflows → Default agents / Agents**, 또는 TUI `/agents`. 저장 override는 `agent.agents.<id>`.
2. **변경**:
   - Desktop: **Workflows** → 해당 행 **Edit**
   - TUI: `/agents` → agent → model picker
   - API: `setAgentRoute(id, route)` (`src/session-runtime/workflow-agents-api.mjs`)
3. **저장 계약**: `agent.agents.<id>`만 갱신한다. `workflow-agent-*` preset과 `workflowRoutes`는 쓰지 않는다.
4. **검증**: 목록의 route와 `agent.agents.<id>`가 같은 provider/model/effort/Fast를 가리키는지 확인한다.

**Main 상속으로 복원**

- TUI `/agents`와 Desktop route editor에는 override 삭제 버튼이 없다.
- API: `setAgentRoute(id, { provider: '' })`가 `agent.agents.<id>`를 제거하고 inherited를 반환한다.
- 수동 복원 시 `agent.agents.<id>`만 제거한다.
- 온보딩 **Default**는 wizard draft만 비우며, 이미 저장된 override 삭제를 보장하지 않는다.

### 워크플로 슬롯

`WORKFLOW_ROUTE_SLOTS = ['lead','agent','memory']` (`src/session-runtime/workflow.mjs`). 온보딩 입력용이며 디스크에는 남기지 않는다.

| 슬롯 | 저장 | 사용자 경로 |
|---|---|---|
| `lead` | `agent.presets[id=workflow-lead]` + `agent.default` | `/model` / 세션 헤더 |
| `memory` | `agent.agents.maintainer` | Desktop **Workflows → Maintainer** 또는 `/agents → Maintainer` |
| `agent` | `agent.agents.worker` | 전용 행 없음. onboarding 또는 `setAgentRoute('worker', …)` |

`explorer` 슬롯은 없다. Desktop이 Explore 행을 그리는 것은 catalog에 `explore` id가 남아 있을 때만이다.

### 웹 검색 모델

1. **확인**: Desktop **Workflows → Default agents → Web Search**, TUI `/search`, `getSearchRoute()`, 디스크 `agent.searchRoute`.
2. **변경**: Desktop **Web Search → Edit** 또는 TUI `/search` → `setSearchRoute()`.
3. **검증**: 저장 route가 native-search 가능 provider/model인지 확인하고 다음 `search` 도구 호출에서 사용되는지 확인한다.

`/search` 인자는 route를 직접 지정하지 않으며 피커를 연다.

### Web search 도구 토글

모델과 별개다. 새 세션의 search/fetch 도구 노출을 제어한다.

1. **확인**: Desktop **Settings → General → Web search**, TUI `/setting → Web search`.
2. **변경**: toggle → `setWebSearchEnabled()`.
3. **저장**: `agent.modules.search.enabled`.
4. **검증**: 다음 세션의 tool surface.

### reasoning effort / Fast

- Effort: `/effort [level]` 또는 model picker의 ←/→ → 현재 Main route에 저장
- Fast: `/fast [on|off]` 또는 model picker의 Tab → 현재 Main route에 저장
- Desktop 세션 헤더에서도 같은 Main route를 바꾼다.
- 진행 중 turn은 시작 값을 유지하고 새 값은 다음 turn부터 적용된다.
- agent/search route의 effort/Fast는 각 route에 격리되며 Main의 `modelSettings`를 덮어쓰지 않는다.

### 워크플로 팩

1. **확인**: Desktop 세션 헤더 workflow 피커, TUI `/workflow`, 디스크 `agent.workflow.active`.
2. **변경**:
   - 활성 팩: Desktop 세션 헤더 피커 또는 TUI `/workflow` → `setWorkflow()`.
   - 팩·에이전트 정의: Desktop rail **Workflows**에서 생성·편집·삭제. 이 페이지에는 활성 팩 버튼이 없다.
   - Desktop `/workflow`·`/agents`는 Settings가 아니라 Workflows 페이지를 연다.
3. **저장**: 사용자 pack은 `<mixdogData>/workflows/<id>/WORKFLOW.md`, agent는 `<mixdogData>/agents/<id>/AGENT.md`.
4. **검증**: `listWorkflows()` active 값과 pack agent 목록, `listAgents()` route를 확인한다.

---

## 2. Provider·인증·비밀

### Provider API 키

1. **확인**: `/providers`, `/setting → Providers`, 또는 Desktop **Settings → Providers**의 authenticated/env/stored 상태.
2. **변경**:
   - TUI: provider → **Add/Replace API key**
   - Desktop: unauthenticated API-key provider의 secret 입력. 저장 key 교체는 **Forget** 후 다시 저장한다.
   - env로 authenticated인 provider는 Desktop 입력란이 숨겨지므로 해당 env를 변경한다.
   - API: `saveProviderApiKey(provider, secret)`
3. **저장**: OS keychain account `agent.<provider>.apiKey`. 디스크 `agent.providers.<provider>`에는 enabled/baseURL 등 비밀이 아닌 값만 남는다.
4. **검증**: provider가 authenticated이고 `/model` catalog가 로드되는지 확인한다.

표준 provider env가 있으면 런타임에서 우선 사용할 수 있다. 실제 env 이름은 `src/runtime/shared/config.mjs`에서 읽는다.

### OAuth 로그인 / 해제

1. **확인**: Providers 화면의 OAuth provider authenticated 상태.
2. **변경**: provider → **Login/Re-login** (`beginOAuthProviderLogin`) 또는 **Forget login** (`forgetProviderAuth`).
3. **저장**: provider별 credential 파일 또는 provider auth 저장소. 경로·값을 문서에 복사하지 않는다.
4. **검증**: authenticated 상태와 model catalog를 확인한다.

### 로컬 Provider

1. **확인**: Providers의 local provider enabled/detected/baseURL.
2. **변경**: provider → **Enable / Set URL**, **Update Base URL**, **Disable** (`setLocalProvider`).
3. **저장**: `agent.providers.<id>.enabled/baseURL`.
4. **검증**: provider status와 model catalog를 확인한다.

### Usage 로그인

- OpenCode Go 등 지원 provider: Providers → **Usage login (browser)** (`loginOpenCodeGoUsage`).
- 자격은 OS keychain의 전용 account에 저장한다. `/usage` 새로고침으로 검증한다.

### Secrets 원칙

| account | 용도 |
|---|---|
| `agent.<provider>.apiKey` | Provider API key |
| `agent.openai.usageSessionKey` | OpenAI usage |
| `agent.opencode-go.authCookie` | OpenCode Go usage |
| `discord.token` | Discord bot |
| `telegram.token` | Telegram bot |

값은 출력하지 않고 `hasStoredSecret()`으로 존재만 확인한다. MCP `env`는 keychain이 아니라 자식 프로세스 환경이다.

---

## 3. 출력·프로필·세션·메모리·셸

### 출력 스타일

1. **확인**: `/OutputStyle status`, `/setting → Output style`, Desktop **Settings → Output style**, 디스크 루트 `outputStyle`.
2. **변경**: `/OutputStyle`, `/style`, `/OutputStyle <id>`, 또는 Desktop에서 선택 → `setOutputStyle()`.
3. **사용자 정의**: `<mixdogData>/output-styles/<id>.md`.
4. **검증**: 대화 이력이 있으면 현재 chat에는 적용되지 않으므로 `/clear` 후 확인한다.

`agent.outputStyle`은 읽기 호환용 레거시 경로다. 변경 시 루트 `outputStyle`에 저장하고 `agent.outputStyle`은 제거한다.

### 테마

- TUI: `/theme [id]` 또는 `/setting → Theme`; 즉시 적용, `ui.theme`에 저장.
- Desktop: **Settings → General → Theme**; Desktop `localStorage`에만 저장하며 TUI 테마와 독립적이다.

### 프로필 — 호칭·응답 언어

1. **확인**: `/profile`, `/setting → Profile`, Desktop **Settings → General → Profile**, 디스크 `agent.profile`.
2. **변경**: title/language → `setProfile()`. 미지원 language id는 `system`으로 정규화된다.
3. **검증**: `getProfile()`과 새 세션의 system prompt 반영을 확인한다.

응답 언어(`agent.profile.language`)와 Desktop **Display language**(chrome UI, `localStorage`)는 별개다.

### Auto-clear

1. **확인**: `/autoclear status`, `/setting → Auto-clear`, Desktop **Settings → Context**, 디스크 `agent.autoClear`.
2. **변경**:
   - `/autoclear [on|off|duration]`
   - TUI `/setting → Auto-clear → Advanced`에서 provider별 idle window
   - Desktop Context에서 toggle·provider별 duration·Reset
3. **검증**: `getAutoClear()`의 enabled/idleMs/providerDefaults. 최소 duration은 1분이다.

### Auto-compact

1. **확인**: `/setting → Auto-compact`, Desktop **Settings → Context**, 디스크 `agent.compaction`.
2. **변경**: Auto-compact toggle → `setCompactionSettings({ auto })`.
3. **고정 계약**: Compact type은 `Fast-track (fixed)`이며 UI 변경 불가. memory recap이 꺼져도 recall-fasttrack은 유지된다.

### Memory / Recap / Core Memory

**구분**

- Desktop **Settings → General → Memory**와 TUI **Memory**는 마스터다. `setMemoryToolsEnabled()`가 모델 memory/recall 도구·core-memory 주입·배경 recap을 함께 움직인다.
- TUI **Memory cycles**만 recap 단독 토글이다 (`setRecapEnabled()`). Desktop에는 이 행이 없다.
- 지속 저장은 `agent.recap.enabled`. `memoryTools` 디스크 키를 사용자 옵션으로 편집하지 않는다.

1. **확인**: Desktop General Memory, TUI `/setting → Memory` / **Memory cycles**, `/memory`.
2. **변경**: 마스터는 `setMemoryToolsEnabled()`, 사이클만은 TUI Memory cycles → `setRecapEnabled()`.
3. **Core Memory**: Desktop **Settings → Context → Core memories**, TUI `/memory` 또는 `/setting → Core memories`.
4. **검증**: `getToolModuleSettings().memory`, `getRecapSettings().enabled`. toggle은 재시작 없이 다음 세션/cycle부터 적용된다.

### Memory cycle interval

TUI·Desktop interval 편집 UI는 없다.

1. **확인/변경**: 디스크 `memory.cycle1.interval`, `memory.cycle2.interval` duration 문자열.
2. **검증**: config 재읽기. 재시작이 가장 확실한 적용 경계다.

### 시스템 셸

1. **확인**: `/setting → System shell`, `getSystemShell()`의 command/effective/source, 디스크 `agent.shell.command`.
2. **변경**: `/setting → System shell` → command 입력; 빈 값은 자동 선택 (`setSystemShell()`).
3. **적용**: 런타임 shell resolver가 즉시 갱신된다. `MIXDOG_SHELL`은 config가 비어 있을 때 env fallback이다.
4. **경계**: Desktop Settings에는 셸 override가 없다.

### Desktop 전용 로컬 설정

- **General → Display language**: Desktop chrome 언어. `localStorage`. 변경 시 창 reload.
- **General → Side panels**: Desktop local preference
- **Git**: GitHub CLI 로그인, commit format(Plain / Conventional / Custom), Auto commit message. mixdog-config가 아니다.
- **System → Keep system awake while working**: Electron desktop settings
- **Connection**: phone/browser pairing
- **Shortcuts / About**: 조회·링크 중심이며 runtime config 레시피가 아니다.
- **Utilities** rail: Studio / Terminal / Explorer 실행. 설정 저장이 아니다.

---

## 4. MCP·Skills·Plugins·Hooks

### MCP 추가

UI에는 서버 추가·삭제·전체 재연결 액션이 없다.

1. **확인**: `/mcp` 또는 Desktop **Settings → MCP**, `mcpStatus()`, `<cwd>/.mcp.json`.
2. **변경**:
   - 전역: 디스크 `agent.mcpServers.<name>` 편집
   - 프로젝트: `<cwd>/.mcp.json`의 `mcpServers` wrapper 또는 bare name map 편집
   - API 자동화: `addMcpServer()`, `removeMcpServer()`, `reconnectMcp()`
3. **transport**:
   - stdio: `type`, `command`, `args`, `cwd`, `env`
   - URL: `http`, `sse`, `ws`와 `url`, 선택 `headers`
4. **제약**: API로 stdio를 추가할 때 `cwd`는 현재 프로젝트 아래여야 한다.
5. **검증**: `connected`, `toolCount`, `source`, `transport`, `error`.

파일을 직접 편집했다면 mixdog 재시작이 기본 적용 경로다.

### MCP enable / disable

TUI `/mcp`와 Desktop MCP 모두 서버별 toggle을 지원하며 live connection과 세션 tool surface를 재동기화한다.

- `source: project`: `<cwd>/.mcp.json` 항목의 `enabled`를 직접 저장
- `source: config`: 서버 정의는 유지하고 현재 프로젝트용 override를 `agent.mcpProjectOverrides[normalizedCwd][name].enabled`에 저장
- 즉, 전역 config 서버를 toggle해도 전역 `agent.mcpServers.<name>.enabled`를 바꾸지 않는다.
- turn 실행 중 toggle은 turn 종료 경계에서 세션을 재생성한다.

### MCP 진단

1. `/mcp`의 source/transport/error를 먼저 읽는다.
2. 프로젝트와 전역 이름 충돌 시 `<cwd>/.mcp.json`이 우선한다.
3. stdio는 command·args·cwd·자식 env, URL transport는 scheme·endpoint·headers·방화벽을 확인한다.
4. `connected:true`와 기대 tool 노출로 검증한다.

### Skills enable / disable

1. **확인**: `/skills` 또는 Desktop **Settings → Skills**.
2. **변경**: Enable/Disable → `setDisabledSkills()`.
3. **저장**: 디스크 `agent.skills.disabled`.
4. **적용**: prompt/tool surface는 다음 세션부터 갱신되므로 `/clear` 후 검증한다.

Desktop Skills는 enable/disable만 한다. TUI `/skills`는 같은 토글에 더해 활성 skill을 다음 요청에 붙이는 **use** 액션이 있다.

### Skill 생성

UI 생성 액션은 없다.

- 프로젝트: `<cwd>/.mixdog/skills/<name>/SKILL.md`
- 글로벌: `<mixdogData>/skills/<name>/SKILL.md`
- API `addSkill()`은 프로젝트 skill skeleton만 생성한다.
- 우선순위: 프로젝트 → 글로벌 → plugin; frontmatter `name`이 같으면 먼저 발견된 항목이 이긴다.
- frontmatter에 `name`, `description`을 넣고 `/skills`에서 검증한다.

### Plugins

1. **확인**: `/plugins` 또는 Desktop **Settings → Plugins**.
2. **추가**: Git URL, `owner/repo`, 기존 local path → `addPlugin()`.
3. **관리**: update/metadata refresh, plugin MCP enable/reconfigure, root/MCP name 복사, uninstall.
4. **저장**: `<mixdogData>/plugins/registry.json`; managed Git checkout은 `<mixdogData>/plugins/installed/`.
5. **검증**: `pluginsStatus()`, plugin skill 수, MCP server 노출.

Plugins 화면에는 일반적인 “plugin 활성/비활성” toggle이 없다. MCP와 skill 활성 상태는 각각 MCP/Skills 화면에서 관리한다.

### Hooks

1. **확인**: `/hooks` 또는 Desktop **Settings → Hooks**, `hooksStatus()`.
2. **UI 범위**: 기존 rule의 Enable/Disable만 지원한다. UI에서 add/delete/edit은 하지 않는다.
3. **추가·수정·삭제**: hook config 파일을 편집하거나 runtime `addHookRule()` / `deleteHookRule()`을 사용한다.
4. **검색 경로**: `MIXDOG_HOOKS_FILE` → 프로젝트 `.mixdog/hooks.json`·`.mixdog/hooks/hooks.json` → 글로벌 `<mixdogData>/hooks.json`·`hooks/hooks.json` → plugin hooks.
5. **형식**: 표준 `{ "hooks": { "<Event>": [{ "matcher": "...", "hooks": [...] }] } }`; 레거시 before-tool 배열도 읽는다.
6. **검증**: mtime 기반 자동 reload 후 Hooks 목록과 대상 event 발동을 확인한다.

---

## 5. Channels·Voice·Automation·Remote

### Discord / Telegram

1. **확인**: `/channels`, `/setting → Channel / Setting`, Desktop **Settings → Channels**, `getChannelSetup()`.
2. **변경**:
   - provider: Discord/Telegram 선택 → `setChannelProvider()`
   - token: Bot token → OS keychain
   - main target: Discord channel ID / Telegram chat ID → `setChannel({ provider, channelId })`
3. **저장**: provider·target은 `channels.provider`, `channels.channel.discordChannelId` / `telegramChatId`. token은 `discord.token` / `telegram.token`.
4. **검증**: active provider, authenticated, main target의 Ready 상태.

`Channels enabled`는 messaging만 제어하며 디스크 경로는 `agent.modules.channels.enabled`다. schedules/webhooks는 이 toggle과 독립적으로 계속 실행된다.

`channels.backend`와 `channels.channel.channelId`는 쓰지 않는다. canonicalize가 제거하고 `provider` / per-provider id만 남긴다.

### Voice transcription

1. **확인**: `/channels → Voice` 또는 Desktop **Settings → Channels → Voice transcription**, 디스크 `voice.enabled`.
2. **변경**: toggle → managed Whisper/model/ffmpeg가 없으면 설치 후 활성화.
3. **검증**: voice status와 실제 channel voice message 전사.

### Schedules / Webhooks

관리 UI는 **Desktop rail 전용**이다.

- Desktop **Schedules**: 생성·편집·pause/resume·run now·삭제
- Desktop **Webhooks**: 생성·편집·pause/resume·secret regenerate·URL/secret 복사·삭제
- TUI palette에는 `/schedules`, `/webhooks`가 없고 직접 입력하면 Desktop에서 관리하라는 notice만 표시한다.

**Schedules**

- 저장소: PG `scheduler.schedules` (`schedules-db.mjs`)
- 반복: `time` 5/6-field cron, 선택 `days`; 1회: `at`; 둘은 XOR
- UI frequency: Hourly / Daily / Weekdays / Weekly / One-shot
- model·effort·Fast, workflow, project cwd, attachments, instructions, enabled
- delivery: `app` / `channel` / `both`

**Webhooks**

- 저장소: PG `webhooks.endpoints` (`webhooks-db.mjs`)
- parser: `generic` / `github` / `stripe` / `sentry`
- model·effort·Fast, workflow, project cwd, attachments, instructions, enabled, delivery
- 새 endpoint는 signing secret을 생성한다. 일반 edit에서 빈 secret은 기존 값을 보존하고, rotate는 명시적 regenerate로 한다.
- list/status 경로는 plaintext secret을 내보내지 않고 `secretSet`만 제공한다.

기존 파일형 schedules는 최초 DB init 때 import 후 `schedules.migrated`로 보존한다. 기존 webhook 디렉터리는 성공적으로 모두 import된 경우 삭제한다.

활성 schedule/webhook이 있으면 automation worker가 messaging·remote와 독립적으로 자동 시작한다.

### Remote session

1. **강제 claim**: TUI `/remote`는 항상 현재 세션을 ON으로 만들고 기존 owner를 넘겨받는다.
2. **TUI toggle**: `/channels → Remote Runtime` 또는 `/setting → Remote Runtime`.
3. **Desktop**: Settings에 Remote 행이 없다. session header의 remote toggle만 사용한다. draft의 New-task remote는 일회성이며 설정 기본값이 아니다.
4. **시작 시 ON**: CLI `mixdog --remote`.
5. **중요**: config `remote.autoStart`는 사용하지 않는다. 자동화 worker의 자동 시작과 remote session claim은 별개다.
6. **검증**: `isRemoteEnabled()`, owner session ID, channel worker status.

---

## 6. Project·업데이트·진단

### 프로젝트 전환

1. **확인**: 상태줄 cwd, `/project`, Desktop rail **Projects**.
2. **변경**: `/project [path]` 또는 picker. TUI picker는 등록·생성·rename도 지원한다.
3. **적용**: cwd 변경 시 프로젝트 `.mcp.json`과 skills를 다시 읽고 MCP를 재연결한다.
4. **검증**: cwd, `/mcp` source, `/skills` project 항목.

### Git (Desktop 전용)

1. **확인**: Desktop **Settings → Git**.
2. **변경**: GitHub CLI Connect/Disconnect, commit Format, Auto commit message. identity는 연결된 GitHub 계정에서 비어 있을 때 자동 동기화한다.
3. **저장**: Desktop local preference + git global config. mixdog-config 레시피가 아니다.
4. **검증**: Git panel의 authenticated/account와 다음 수동 commit 힌트.

### 업데이트

- TUI: `/update` 또는 `/setting → Update`
- Desktop: **Settings → System → Update**
- 지원 동작: check, auto-update toggle, update install; 설치 후 재시작 필요
- 저장: `agent.update.auto`

### Doctor

- TUI `/doctor`
- Desktop **Settings → System → Doctor**
- runtime, providers, integrations, local installation 결과를 확인한다.

### 레거시 config 감사

Desktop과 현재 runtime에서 소비되지 않는 아래 key는 사용자 옵션이 아니다. 발견하면 config 백업 후 제거하고, writer가 다시 생성하지 않는지 재시작 뒤 확인한다.

| 레거시 key | 처리 |
|---|---|
| `agent.workflowRoutes` | `agent.agents`로 이관된 뒤 제거. 수동 편집 금지 |
| `agent.fastModels` | 제거 (이관 없음; `modelSettings.<provider/model>.fast`만 유효) |
| `agent.agentMaintenance`, `agent.runtime` | 제거 |
| `remote.autoStart` | 제거; Remote는 session header에서 수동 claim |
| `ui.mouseMode` | 제거; `ui.theme`은 TUI 현행 설정 |
| `channels.backend` | 제거 (이관 없음; `channels.provider`만 유효) |
| `channels.channel.channelId` | 제거; `discordChannelId` / `telegramChatId`만 유지 |
| `channels.quiet`, `channels.schedules` | 제거; schedule은 PG가 단일 저장소 |
| `channels.webhook.ngrokDomain`, `channels.webhook.respectQuiet` | 제거; endpoint URL은 Desktop Webhooks가 발급 |
| `agent.outputStyle` | 제거 (이관 없음; 루트 `outputStyle`만 유효) |

다음 항목은 레거시처럼 보여도 현행이므로 유지한다: 루트 `outputStyle`, `agent.shell`, `agent.modules`, `channels.channel.discordChannelId/telegramChatId`, compaction의 `type/compactType`과 recall tuning fields.

---

## 부록 — 핵심 스키마

### MCP

```json
{
  "agent": {
    "mcpServers": {
      "<name>": {
        "type": "stdio",
        "command": "...",
        "args": [],
        "cwd": "<project-subdir>",
        "env": {}
      }
    },
    "mcpProjectOverrides": {
      "<normalized-cwd>": {
        "<name>": { "enabled": false }
      }
    }
  }
}
```

URL transport는 `type` + `url` + 선택 `headers`를 사용한다.

### Channels

```json
{
  "channels": {
    "provider": "discord",
    "channel": {
      "discordChannelId": "",
      "telegramChatId": ""
    },
    "webhook": {
      "enabled": true,
      "port": 3333
    }
  },
  "agent": {
    "modules": {
      "channels": { "enabled": true }
    }
  },
  "voice": { "enabled": false }
}
```

### 우선순위와 금지

- MCP 이름 충돌: project `.mcp.json` > `agent.mcpServers`
- Skill 이름 충돌: project > global > plugin
- `Mixdog.md` 자동 프롬프트 로드는 없다. skill/core memory를 사용한다.
- 확인되지 않은 key는 추측하지 말고 TODO로 남긴다.
- UI에 없는 runtime API를 사용자 UI처럼 설명하지 않는다.
- config 수동 편집 전 백업하고 JSON 유효성을 유지한다.
