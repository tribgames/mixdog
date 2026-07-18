# OpenCode to Mixdog Desktop Feature Parity

Updated: 2026-07-18

The authoritative 96-group comparison, evidence, and deferred-product decisions live in
[`OPENCODE-FEATURE-AUDIT.md`](./OPENCODE-FEATURE-AUDIT.md). This checklist keeps the implementation-facing
summary and the exact public TUI inventory enforced by automated parity tests.

## A. Window chrome, tabs, and navigation

- [x] Window Controls Overlay-safe titlebar and drag regions.
- [x] Workspace tabs, close actions, keyboard navigation, and drag reorder.
- [x] Active-tab working state; per-tab unseen/notification state remains partial.
- [x] Responsive session sidebar with persisted pointer and keyboard resizing.
- [x] Session search across title, preview, project path, and working directory.
- [x] Inline session rename, guarded delete, and action menus.
- [x] Project switcher actions, stable avatars, pin/unpin, and pinned-first ordering.
- [x] Runtime-health popover and persistent webview zoom.
- [ ] Titlebar back/forward history.

## B. Conversation and long-session stability

- [x] Markdown/GFM, fenced code, tables, secure links, and copy controls.
- [x] Tool disclosures, count/status summaries, error states, output copy, and multi-file diffs.
- [x] Streaming/activity states and authoritative complete/failed/interrupted outcomes.
- [x] Context/token surface, tool approval, queued steering, and abort restoration.
- [x] Previous/next message navigation and Jump to latest.
- [x] Measured transcript virtualization above 80 items with bounded DOM rows and full scroll range.
- [x] Stable composer placeholder without an idle rerender timer.
- [ ] Structured question/todo docks, failed-turn retry, and transcript media preview.
- [ ] Explicit history paging controls, session handoff, and boundary-wheel navigation.
- [ ] File tabs, terminal panel, review workspace, line comments, and session fork are deferred product work.

## C. Composer and model routing

- [x] Text submit/stop, IME-safe keys, prompt history, and all public slash aliases.
- [x] Provider/model, reasoning effort, Fast, workflow, and per-agent routing.
- [x] Native attachment picker, drag/drop, clipboard image, large-text folding, and policy errors.
- [x] Cancellable fuzzy `@` project-file context.
- [x] Rich model tooltip with available provider, model ID, context, reasoning, Fast, latest, and release metadata.

## D. Settings and preferences

- [x] WCO-safe two-pane settings with 12 categories and canonical TUI row ordering.
- [x] Profile, lifecycle, theme, workflow, model, provider, MCP, plugin, hook, skill, memory, channel,
  update, and doctor controls.
- [x] Canonical System shell editor shared with the TUI; an empty value restores automatic selection.
- [x] First-run provider/model/workflow onboarding with explicit skip confirmation.
- [ ] Keybind editor, model visibility manager, release notes, native notification/sound preferences, and font settings.
- [ ] Desktop UI localization remains deferred.

## E. Desktop integration and diagnostics

- [x] Hardened preload/IPC sender checks, argument validation, CSP, and navigation denial.
- [x] Persistent window state, single-instance focus, native menus, updater controller, and installer contracts.
- [x] Privacy-safe bounded JSONL diagnostics for lifecycle, five-minute process memory, unresponsive/responsive, renderer exit, and child exit.
- [x] `mixdog://` registration; incoming URL parsing/routing remains partial.
- [ ] Installed editor/terminal discovery and login-shell environment inheritance.
- [ ] JavaScript stack sampling for an unresponsive renderer.
- [ ] Release signing/channel separation and complete macOS notarization.

## F. Verification gates

- Renderer/host/DOM/diagnostics: 141 tests, including a bounded-DOM assertion over 5,000 transcript items and delayed virtual-measurement tail restoration.
- Settings: 29 tests.
- Canonical TUI/Desktop and audit-summary parity: 5 tests.
- Packaging contracts: 10 tests.
- Updater controller: 4 tests.
- TUI smoke: render check, 3 input tests, 9 streaming-window tests, and 43 queue/abort tests.
- Direct source E2E: 10/10 post-fix passes across 30 commands, 20 settings, 12 categories, 32 safe capability reads,
  and a stored 116-item transcript held to 14 virtual rows with delayed-measurement tail restoration and global message navigation verified.
- Continuous source soak: 15/15 iterations over 20 minutes without crash, unresponsive, console-error, or renderer-exception evidence.

## I. TUI Option Parity

The tables below intentionally use the canonical labels and command usage strings. Automated tests compare them
directly with `src/tui/app/slash-commands.mjs` and `src/tui/app/settings-picker.mjs`.

### Public slash commands

| Command | Desktop control | Status |
|---|---|---|
| `/clear` | Clear/new-task composer action | done |
| `/project` | Project switcher or path argument | done |
| `/compact` | Compact composer action | done |
| `/autoclear` | General lifecycle settings and arguments | done |
| `/resume` | Session switcher or session ID | done |
| `/context` | Context command surface | done |
| `/usage` | Provider usage surface and refresh | done |
| `/model` | Main model route settings | done |
| `/search` | Search model route settings | done |
| `/workflow` | Workflow settings or ID argument | done |
| `/OutputStyle` | Output-style settings or name argument | done |
| `/theme` | Theme settings or ID argument | done |
| `/agents` | Per-agent model/effort/Fast routes | done |
| `/effort` | Reasoning-effort surface or level | done |
| `/fast` | Idempotent Fast action | done |
| `/mcp` | MCP server settings | done |
| `/skills` | Skill settings | done |
| `/memory` | Memory surface and argument passthrough | done |
| `/plugins` | Plugin settings | done |
| `/hooks` | Hook-policy settings | done |
| `/providers` | Provider settings | done |
| `/channels` | Channel/runtime/voice surface | done |
| `/remote` | Claim remote runtime for this session | done |
| `/schedules` | Schedule status/toggles | done |
| `/webhooks` | Webhook status/toggles | done |
| `/setting` | Settings root and aliases | done |
| `/profile` | Profile settings | done |
| `/update` | Update settings/action | done |
| `/doctor` | Diagnostics surface | done |
| `/quit` | Desktop quit action and aliases | done |

### Canonical TUI setting rows

| Setting | Desktop control | Status |
|---|---|---|
| `Profile` | Title and response language | done |
| `Auto-clear` | Toggle and provider idle windows | done |
| `Auto-compact` | Compaction toggle | done |
| `Compact type` | Fixed Fast-track behavior | n-a |
| `Channels enabled` | Channel runtime toggle | done |
| `Remote Runtime` | Remote runtime toggle and claim action | done |
| `Channel` | Discord/Telegram backend selection | done |
| `Setting` | Tokens and primary targets | done |
| `Output style` | Persisted output-style selection | done |
| `Theme` | Preview, choose, and restore | done |
| `Workflow` | Active workflow selection | done |
| `Model` | Provider/model/effort/Fast route | done |
| `Search model` | Search provider/model/effort/Fast route | done |
| `Providers` | API key, OAuth, and local endpoints | done |
| `MCP servers` | Status and enable/disable | done |
| `Plugins` | Install, update, remove, and plugin MCP | done |
| `Hooks` | Approval-policy rule toggles | done |
| `Skills` | Per-skill enable/disable | done |
| `System shell` | Validated shell command; empty selects automatic | done |
| `Update` | Check, auto-update, stage, and install | done |

### Public-surface boundaries

- Runtime-only legacy dispatches such as `/cwd`, `/auth`, `/tools`, and `/recall` are not public TUI commands.
- Tool mode and approval timeout/queue behavior remain engine-owned rather than user-tunable.
- External side effects such as channel/webhook sends, OAuth, update installation, and claiming another live CLI
  remain guarded in direct E2E.
