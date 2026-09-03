---
name: setup
description: Use this skill only to inspect or modify a Mixdog user's persisted configuration and settings through the built-in `setup` tool — models and routes, workflow, output style, profile, auto-clear/compact, memory, built-in features, providers, MCP servers, skills, plugins, update. Skip Mixdog source changes, builds, installs, releases, and development deployment.
---

# mixdog Setup Runbook

사용자 요청을 아래 레시피에 매칭하고 **확인 → 변경 → 검증** 순서로 진행한다.

> **METHOD·POINTER만 기록한다.** 모델명·토큰·URL·채널 ID 같은 라이브 값은 이 문서에 넣지 않고, 매번 `setup status`·환경변수에서 읽는다.

## 0. 도구 계약

### `setup` 툴이 유일한 변경 경로다

- 모든 조회·변경은 `setup` 툴로 한다. `mixdog-config.json`을 `edit`으로 고치지 않는다 — 정규화·마이그레이션·MCP 재연결·빈 세션 툴 표면 재동기화를 전부 우회한다.
- 예외는 UI·툴 어디에도 없는 키(§3 memory cycle interval, §6 레거시 감사)만이며, 그때도 백업 후 편집한다.
- **비밀값은 툴이 받지 않는다.** API 키·OAuth·usage 로그인은 `setup open providers`로 화면을 열고 사용자가 입력한다. 값을 트랜스크립트에 쓰지도, 사용자에게 붙여넣으라고 요청하지도 않는다.
- 변경은 기본적으로 **다음 세션**부터 적용된다. 결과의 `appliedToCurrentSession`·`appliesTo`를 그대로 사용자에게 전달한다.

### 액션 지도

| 목적 | 액션 | 주요 인자 |
|---|---|---|
| 조회 | `status` | `domain`: summary(기본) · model · agents · workflow · websearch · output-style · profile · autoclear · compaction · memory · features · shell · providers · mcp · skills · plugins · update · onboarding |
| 화면 열기 | `open` | `target`: settings · providers · model · websearch · workflow · agents · outputstyle · theme · profile · autoclear · memory · mcp · skills · plugins · update · usage · doctor · context |
| 메인 모델 | `set_route` | `route {provider, model, effort, fast}` — 일부만 주면 나머지는 유지 |
| 에이전트 모델 | `set_agent_route` | `agent`, `route` — `provider: ""`이면 override 제거(Main 상속) |
| 웹 검색 모델 | `set_web_search_route` | `route` — provider 비우면 기본 route |
| 워크플로 팩 | `set_workflow` | `workflow` |
| 출력 스타일 | `set_output_style` | `style` |
| 프로필 | `set_profile` | `profile {title, language, experienceLevel}` |
| Auto-clear | `set_autoclear` | `autoclear {enabled, duration, provider}` |
| Auto-compact | `set_compaction` | `enabled` |
| Memory 마스터 | `set_memory_enabled` | `enabled` (툴·코어 주입·배경 사이클 함께) |
| 배경 사이클만 | `set_recap_enabled` | `enabled` |
| Web search 툴 | `set_web_search_enabled` | `enabled` |
| Git/Office 켜기·끄기 | `set_builtin_enabled` | `name` git\|office, `enabled` |
| 내장 기능 설치 | `install_builtin` | `name` git\|memory\|office |
| 시스템 셸 | `set_system_shell` | `command` (빈 값 = 자동) |
| 자동 업데이트 | `set_auto_update` | `enabled` |
| 로컬 provider | `set_local_provider` | `name`, `enabled`, `baseURL` |
| 인증 삭제 | `forget_provider_auth` | `name` |
| MCP | `add_mcp_server` · `save_mcp_server` · `remove_mcp_server` · `set_mcp_enabled` · `reconnect_mcp` | `server {...}` 또는 `name`, `enabled` |
| Skills 비활성 목록 | `set_disabled_skills` | `skills` (전체 목록으로 교체) |
| 적용 프로젝트 | `set_extension_scope` | `kind` skills\|mcp\|plugins, `name`, `projects` (프로젝트 루트 경로 목록; 빈 배열 = 모든 프로젝트) |
| Plugins | `add_plugin` · `update_plugin` · `set_plugin_enabled` · `remove_plugin` | `source` 또는 `name`, `enabled` |

`open`은 세션에 붙은 앱(Desktop/TUI)이 있으면 그 화면으로 이동하고 `opened:true`를 돌려준다. 헤드리스(스케줄·웹훅·exec)면 `opened:false`와 안내 문구가 오므로 그 문구를 사용자에게 전달한다.

### 저장 구조(참고)

- `<mixdogData>`: `MIXDOG_DATA_DIR` → `<MIXDOG_HOME|~/.mixdog>/data`. 통합 config는 `<mixdogData>/mixdog-config.json`.
- 런타임은 flat, 디스크는 대부분 `agent.*` 아래. 출력 스타일만 루트 `outputStyle`, 음성은 `voice.enabled`, TUI 테마는 `ui.theme`, 메모리 주기는 `memory.cycle1/2.interval`.
- API 키·토큰·OAuth 자격은 OS keychain/provider 저장소에 있고 config에 없다.

### UI 지도 (Desktop 기준, TUI는 보조)

Desktop **Settings** (`Ctrl+,`) 카테고리와 그 안의 그룹:

| 카테고리 | 그룹(행) | 툴 액션 |
|---|---|---|
| General | Profile(Title·Language·Experience level) · Features(Web search 토글) · Notifications(웹앱 전용) · Display language · Theme · Side panels | `set_profile`, `set_web_search_enabled`. Display language·Theme·Side panels·Notifications는 Desktop 로컬(localStorage) — 툴 없음 |
| Context | Session lifecycle(Auto-compact · Auto-clear · provider별 idle window) | `set_compaction`, `set_autoclear` |
| Output style | 스타일 선택 | `set_output_style` |
| Providers | OAuth providers(Connect) · API-key providers(Get API key ↗ · 키 입력 · Save) · Local providers · Usage sign-in | `set_local_provider`, `forget_provider_auth`; 비밀값은 화면에서 |
| Git | GitHub(CLI Connect) · Commit messages | Desktop 로컬 — 툴 없음 |
| Connection | Web app(페어링 QR) · Linked devices | Desktop 전용 — 툴 없음 |
| System | Update · Power(Keep system awake, Desktop 로컬) · Doctor(Run doctor) | `set_auto_update`, `status update`; Doctor는 `open doctor` |
| Shortcuts / About | 키바인드 참조 · 커뮤니티 링크 | 읽기 전용 |

Desktop **레일**(사이드탭):

| 레일 | 내용 | 툴 액션 |
|---|---|---|
| Projects | Add project · 프로젝트별 Name·Instructions·**Memories**(코어 메모리) · **Common Instructions**(모든 프로젝트 공통) | 프로젝트·Instructions는 툴 없음(파일·UI). 코어 메모리는 `memory` 툴 |
| Workflows | Workflows(팩 목록·생성·편집) · Default agents(Main · Web Search) · Agents(정의·Edit) | `set_workflow`, `set_route`, `set_web_search_route`, `set_agent_route`. 팩·에이전트 정의 생성/편집은 UI/파일만 |
| Extensions → **Plugin** 탭 | **Built-in** 카드(Web search · Memory · Git · Office · Browser Use · Computer Use · Voice transcription) + **Plugins** | `set_builtin_enabled`, `install_builtin`, `set_memory_enabled`, `set_web_search_enabled`, plugin 액션들. Browser/Computer/Voice는 UI만 |
| Extensions → **Skill** 탭 | **Skills** + **MCP**(헤더 `+` = Add skill or MCP) | `set_disabled_skills`, MCP 액션들 |
| Schedules / Webhooks | 자동화(§5) | 툴 없음 |

- Memory 마스터 토글과 Voice는 **Settings에 없다** — Extensions → Plugin → Built-in 카드다. 코어 메모리 목록은 **Projects → 프로젝트 → Memories**.
- Desktop의 `/workflow`·`/websearch`·`/agents`는 **Workflows** 페이지로, `/mcp`·`/skills`는 Extensions **Skill** 탭으로, `/plugins`·`/memory`·`/voice`는 Extensions **Plugin** 탭으로 열린다. `/settings`는 Settings 다이얼로그.
- 웹앱(원격) 화면에서는 Providers 카테고리가 숨겨진다 — 인증은 Desktop에서만 안내한다.
- TUI 허브: `/setting` (별칭 `/settings`, `/config`). System shell·Memory cycles는 TUI에만 있다.

---

## 1. 모델·라우팅·워크플로

### 메인 모델
1. `status model` — provider/model/effort/fast/effortOptions.
2. `set_route`. provider만 주면 그 provider의 기본 모델, model만 주면 현재 provider에서 찾는다.
3. 빈 세션이면 즉시, 대화가 있으면 다음 세션부터. `/clear` 뒤 확인을 안내한다.
- UI: Desktop 세션 헤더 모델 피커 · TUI `/model`, `/effort`, `/fast`. `open model`.

### 에이전트 모델
- 고정 서비스는 **Maintainer**만이고 `worker`/`heavy-worker`/`reviewer`·사용자 에이전트는 custom 정의다. 두 상태만 있다: 모델 지정 또는 off. 지정이 없으면 Main을 따른다.
1. `status agents` — id·route·disabled·userOverride.
2. `set_agent_route {agent, route}`. 상속 복원은 `route: {provider: ""}`.
- UI: Desktop **Workflows → Agents → Edit** · TUI `/agents`. `open agents`.

### 웹 검색 모델·툴
- 모델(`set_web_search_route`)과 툴 노출(`set_web_search_enabled`)은 별개다. 모델은 native web-search 가능 provider/model만 허용된다(툴이 검증).
- UI: Desktop **Workflows → Web Search** / **Settings → General → Web search** · TUI `/websearch`, `/setting → Web search`.

### 워크플로 팩
1. `status workflow` — 팩 목록과 active.
2. `set_workflow`. 팩 정의 생성·편집은 Desktop **Workflows**에서만(툴 없음).
- 사용자 pack은 `<mixdogData>/workflows/<id>/WORKFLOW.md`, agent는 `<mixdogData>/agents/<id>/AGENT.md`.

---

## 2. Provider·인증

1. `status providers` — api/oauth/local 행의 authenticated·source(env/keychain/none)·`keyUrl`. 비밀값은 절대 오지 않는다.
2. **API 키가 없는 provider**: `open providers` → 사용자가 해당 행의 **Get API key ↗**로 콘솔에서 키를 발급받아 입력란에 붙여넣고 Save. TUI는 `/providers` → provider → **Get API key (browser)** / **Add API key**. env 변수로 인증된 provider는 입력란이 숨겨지므로 env를 바꾸라고 안내한다.
3. **OAuth**: `open providers` → 행의 **Connect**가 브라우저를 열고 대화상자가 상태를 폴링한다(Anthropic은 코드 붙여넣기 방식). 툴이 대신 시작하지 않는다.
4. **해제**: `forget_provider_auth {name}` — 사용자 확인 후에만.
5. **로컬 provider**(Ollama·LM Studio): `set_local_provider {name, enabled, baseURL}`.
6. **Usage 로그인**(OpenCode Go 등): Providers 화면의 **Usage sign-in**. `/usage`로 검증.
- 검증: `status providers`에서 authenticated, 그리고 `status model`의 catalog 로드.

---

## 3. 출력·프로필·세션·메모리·셸

### 출력 스타일
- `status output-style` → `set_output_style`. 사용자 정의는 `<mixdogData>/output-styles/<id>.md`(기본은 `common.md` 상속, 전면 교체는 frontmatter `keep-shared-format: false`).
- 대화 중이면 현재 채팅에 적용되지 않는다.

### 프로필
- `set_profile {title, language, experienceLevel}`. 미지원 language는 `system`으로 정규화. 응답 언어와 Desktop **Display language**(chrome, localStorage)는 별개다.

### 테마
- TUI `/theme`은 `ui.theme`. Desktop 테마는 localStorage라 툴 범위 밖이다 — `open theme`(TUI) 또는 Desktop **Settings → General → Theme** 안내.

### Auto-clear / Auto-compact
- `set_autoclear {enabled, duration, provider}` — provider를 주면 provider별 idle window. 최소 1분.
- `set_compaction {enabled}` — 하나의 fresh-context Compact 계약, 타입 선택 없음.
- UI: Desktop **Settings → Context** · TUI `/autoclear`, `/setting → Auto-compact`.

### Memory
- 마스터 `set_memory_enabled`는 모델 memory/recall 툴·코어 메모리 주입·배경 사이클을 함께 움직인다. 켜면 installed로도 표시된다.
- 사이클만 끄려면 `set_recap_enabled false`(TUI **Memory cycles**와 동일; Desktop에는 행이 없음).
- Core memory 편집은 `memory` 툴. 화면은 TUI `/memory`, Desktop **Projects → 프로젝트 → Memories**(`open memory`는 Desktop에서 Extensions → Plugin의 Memory 카드를 연다).
- cycle interval(`memory.cycle1/2.interval`)만 UI·툴이 없다 — 백업 후 config 편집, 재시작이 적용 경계.

### 시스템 셸 (TUI 전용)
- `set_system_shell {command}`; 빈 값은 자동 선택. `MIXDOG_SHELL`은 config가 비었을 때 fallback.

---

## 4. 내장 기능·Extensions

### 내장 기능 (Extensions → Built-in)
- `status features` — webSearch/memory/git/office의 enabled·installed, browser/computer의 active.
- Git·Memory·Office는 **install-first**: `install_builtin`이 준비(모델 다운로드·구성요소 확인) → installed+enabled. 이후 켜고 끄기는 `set_builtin_enabled`(git/office) · `set_memory_enabled`.
- Browser Use / Computer Use는 Desktop 로컬 설정(install 마커 + control 토글)이고 브리지가 살아 있을 때만 활성이다. Desktop **Extensions → Plugin → Built-in**에서 Install/토글하며 툴 액션이 없다. Computer Use는 Windows 전용.
- Voice transcription도 같은 Built-in 카드(managed Whisper 설치·토글). 툴 액션 없음 — `open plugins`로 화면을 열고 사용자에게.
- Git 카드의 Install은 시스템 Git 설치까지, Office 카드의 Install은 LibreOffice 의존성까지 UI가 안내한다. 툴 `install_builtin`은 런타임 준비만 하므로 의존성이 없으면 UI Install을 안내한다.
- `MIXDOG_FEATURE_*` env 오버라이드(WEB_SEARCH/MEMORY/GIT/OFFICE/BROWSER/COMPUTER)는 headless/bench용이며 설정을 이긴다.

### MCP
1. `status mcp` — name·enabled·connected·transport·toolCount·error.
2. `add_mcp_server {server}` — stdio: `{name, type:"stdio", command, args, cwd, env}`; URL: `{name, type:"http"|"sse"|"ws", url, headers}`. 수정은 `save_mcp_server`(이름 변경은 `originalName` 포함), 삭제는 `remove_mcp_server`, 토글은 `set_mcp_enabled`, 재연결은 `reconnect_mcp`. 전부 즉시 재연결·세션 툴 표면 재동기화까지 수행한다.
3. 진단: error를 먼저 읽고, stdio는 command·args·cwd·env, URL은 scheme·endpoint·headers·방화벽 순으로.
- Project `.mcp.json`은 읽지 않는다. 전역 `agent.mcpServers`만.
- UI: Desktop **Extensions → Skill 탭 → MCP** · TUI `/mcp`. `open mcp`.

### Skills
- `status skills` → `set_disabled_skills [..]`(전체 목록 교체). 다음 세션부터 반영.
- 생성은 파일: 글로벌 `<mixdogData>/skills/<name>/SKILL.md`, 프로젝트 `<cwd>/.mixdog/skills/<name>/SKILL.md`. 우선순위 프로젝트 → 글로벌 → plugin. frontmatter `name`·`description` 필수.
- UI: Desktop **Extensions → Skill 탭 → Skills** · TUI `/skills`(use 액션 포함). `open skills`.

### 적용 프로젝트 (scope)
- Skill·MCP·Plugin은 전부 머신 전역으로 설치·연결되지만, `set_extension_scope {kind, name, projects}`로 특정 프로젝트 루트에서만 보이게 제한할 수 있다. `projects`가 비면 전역. 세션 cwd가 루트 자체이거나 그 하위면 해당 프로젝트로 본다.
- Plugin의 scope는 그 플러그인이 가져온 Skills·MCP에 그대로 상속된다. status 응답의 `scope`(자기 목록)·`inheritedScope`(플러그인 목록)·`activeHere`(현재 cwd에서 보이는지)로 확인한다.
- 저장: `agent.extensionScopes.{skills|mcp|plugins}[name] = [root, …]`. 연결·파일은 건드리지 않고 다음 세션(또는 빈 세션 즉시)부터 반영.
- UI: 각 항목 상세 다이얼로그의 **적용 범위**(모든 프로젝트 / 선택한 프로젝트).

### Plugins
- `add_plugin {source}`(Git URL · owner/repo · 로컬 경로) → `set_plugin_enabled` · `update_plugin` · `remove_plugin`. 토글은 그 플러그인의 Skills·MCP를 함께 움직인다.
- 저장: `<mixdogData>/plugins/registry.json`, checkout은 `<mixdogData>/plugins/installed/`.
- UI: Desktop **Extensions → Plugin 탭 → Plugins** · TUI `/plugins`. `open plugins`. 상세 대화상자에 Update·Enable MCP·Remove가 있다.

### Hooks (사용자 UI 없음)
- plugin·내부 연동 전용. 검색 경로 `MIXDOG_HOOKS_FILE` → `.mixdog/hooks.json` → `<mixdogData>/hooks.json` → plugin hooks. 사용자 옵션으로 안내하지 않는다.

---

## 5. Automation (Desktop 전용)

- **Schedules**·**Webhooks**는 Desktop rail에서만 관리한다(툴 액션·TUI 명령 없음). 저장소는 PG(`scheduler.schedules`, `webhooks.endpoints`).
- Schedules: cron `time`(+`days`) 또는 1회 `at`(XOR), model/effort/Fast, workflow, cwd, attachments, instructions, delivery(app/channel/both).
- Webhooks: parser generic/github/stripe/sentry, signing secret은 생성 시 1회 노출·`secretSet`만 조회 가능, rotate는 명시적 regenerate.
- 활성 항목이 있으면 automation worker가 자동 시작한다.

---

## 6. 업데이트·진단·레거시

### 업데이트
- `status update` — autoUpdate·currentVersion·latestVersion. `set_auto_update`. 설치 실행은 UI(Desktop **Settings → System → Update** · TUI `/update`)에서. `open update`.

### Doctor
- `open doctor`(TUI `/doctor`, Desktop 컴포저 `/doctor` 또는 **Settings → System → Doctor → Run doctor**). runtime·providers·integrations·local installation 결과.

### Desktop 로컬 설정 (툴 범위 밖 — 화면 안내만)
- **Settings → General**: Display language(UI 언어, 응답 언어와 별개) · Theme · Side panels · Notifications(웹앱).
- **Settings → System → Power**: Keep system awake while working.
- **Settings → Git**: GitHub CLI Connect, Commit messages(형식·자동 메시지). git global config 포함.
- **Settings → Connection**: 웹앱 페어링 QR, Linked devices 해제.
- **Projects**: 프로젝트 추가·이름·Instructions, Common Instructions. 코어 메모리만 `memory` 툴로 다룬다.

### 레거시 config 감사 (직접 편집 허용 유일 구간)
발견하면 백업 후 제거하고, 재시작 뒤 writer가 다시 만들지 않는지 확인한다.

| 레거시 key | 처리 |
|---|---|
| `agent.workflowRoutes` | 로드 시 `agent.agents`로 이관되고 제거됨. 수동 편집 금지 |
| `agent.fastModels` | 제거 (`modelSettings.<provider/model>.fast`만 유효) |
| `agent.agentMaintenance`, `agent.runtime` | 제거 |
| `remote.autoStart` | 제거 |
| `ui.mouseMode` | 제거 (`ui.theme`은 현행) |
| `channels.backend/provider/channel.*`, `channels.quiet`, `channels.schedules`, `channels.webhook.ngrokDomain/respectQuiet` | 제거 — 메시징 은퇴, schedule은 PG 단일 저장소 |
| `agent.outputStyle` | 제거 (루트 `outputStyle`만 유효) |

현행이므로 유지: 루트 `outputStyle`, `agent.shell`, `agent.modules`, `agent.builtins`, compaction의 `auto`·`summaryModel`·`timeoutMs`·buffer/target 필드.

---

## 금지·우선순위

- UI에 없는 내부 API를 사용자 옵션처럼 설명하지 않는다. 툴 액션 표와 UI 지도가 기준이다.
- 확인되지 않은 key는 추측하지 말고 TODO로 남긴다.
- `Mixdog.md` 자동 프롬프트 로드는 없다. skill/core memory를 쓴다.
- 배포·재시작이 필요한 변경(memory cycle interval 등)은 반드시 사용자 승인 뒤 진행한다.
