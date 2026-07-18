# OpenCode Feature Audit

## Baseline and method

- OpenCode reference: `C:\Project\refs\opencode` at `49593c1ec41deab3730861f1842e2835cd8dfe98` (`dev`, 2026-06-21).
- Mixdog baseline: `2bad5c1e1959cfed8092439bec90b4276af14223` plus the current desktop E2E worktree.
- Reference scope: `packages/app`, `packages/ui`, and `packages/desktop`.
- Mixdog scope: desktop renderer, main/preload IPC, the shared TUI engine, public slash commands, and public TUI settings.

Status meanings:

- **Matched**: an equivalent user-facing capability exists and is covered by implementation or interaction evidence.
- **Partial**: the capability exists but is narrower, uses a different workflow, or lacks part of the reference behavior.
- **Missing**: no equivalent user-facing implementation was found.
- **Deferred**: deliberately left for a later product wave.
- **N/A**: the reference capability depends on an engine or product model Mixdog does not use.

This is a behavior audit. Low-level visual primitives such as buttons, tags, cards, popovers, and icons are counted through their consuming features rather than as independent product capabilities.

## Result summary and evidence

The 96 OpenCode user-facing feature groups in sections 1-5 currently classify as:

| Status | Count |
|---|---:|
| Matched | 50 |
| Partial | 17 |
| Missing | 17 |
| Deferred | 5 |
| N/A | 7 |

Verification completed on 2026-07-18:

- Renderer, host, diagnostics, and DOM interactions: 141 of 141 tests passed without React act warnings. The DOM suite includes a 5,000-item synthetic transcript and asserts that fewer than 80 message rows are mounted.
- Settings behavior: 29 of 29 tests passed.
- Canonical TUI/desktop and audit-summary parity: 5 of 5 tests passed.
- Desktop typechecking, 10 packaging-contract tests, and 4 updater-controller tests passed. The root TUI smoke suite also passed its render check, 3 input-render tests, 9 streaming-window tests, and 43 queue/abort tests.
- Final post-fix source-mode direct E2E: 10 of 10 iterations passed in 317.370 seconds with 10-second pauses. Every iteration exercised all 30 public slash commands, all 20 canonical settings, 12 settings categories, 32 safe capability reads, and a stored 116-item transcript. The timeline stayed at 14 mounted rows, opened at the final index 115, and passed previous/next global-index navigation on every iteration. This run followed a reproduced delayed-row-measurement tail race and verifies its settle-until-stable fix. There were no input retries, console errors, renderer exceptions, renderer exits, or child-process failures. The report omits command lines, user-home paths, project paths, session IDs, titles, and transcript content. Report: `artifacts/direct-e2e-20260718T053315Z.json`.
- A continuous 20-minute, 15-iteration source soak also passed without a crash, unresponsive event, or capability failure. Aggregate RSS increased from 2,467.32 MB to 3,660.75 MB, almost entirely in the source-development renderer working set, while JavaScript heap ended at 25.07 MB, DOM nodes at 5,883, and listeners at 930. A separate forced-GC five-iteration diagnostic returned the DOM to exactly 4,600 nodes and 929 listeners on every iteration and JavaScript heap use to 20.63-22.61 MB. These results do not show accumulating live React DOM/listener retention; the renderer's native/CDP high-water memory still warrants a future packaged soak. Reports: `artifacts/direct-e2e-20260718T050302Z.json` and `artifacts/direct-e2e-20260718T042232Z.json`.
- Privacy-safe diagnostics recorded normal desktop start, window creation, window close, desktop stop, and a real five-minute process-memory snapshot. Process snapshots are capped at 32 entries and contain process identity/type and memory counters only. No unresponsive, render-process-gone, child-process-gone, or initialization-failure record occurred.
- The OpenCode polish pass covers session search, runtime health, project pinning and avatars, accessible sidebar resizing, per-message navigation, active-tab work state, richer model metadata, canonical System shell settings, bounded diagnostics, stable idle composer rendering, and long-transcript virtualization.
- Earlier packaged Windows acceptance remains valid for the pre-polish installer: 118,506,904 bytes, SHA-256 `C62764E11C03F119CB78FAB70A7051CA7983ECE614B0BA62A4CB9F47DA0C1F36`, report `dist/acceptance-c62764e11c03f119.json`. No new production build or deployment was run during this source-polish pass.

## 1. Titlebar, tabs, and sidebar

| Reference capability | Mixdog evidence or difference | Status |
|---|---|---|
| Window Controls Overlay titlebar and drag region | Custom 36 px titlebar, WCO safe-area checks, packaged acceptance | Matched |
| Workspace tabs and new-session action | Open tabs, close buttons, middle-click close, and New task | Matched |
| Drag-to-reorder tabs | Native drag/drop reorder in `navigation.tsx` | Matched |
| Tab keyboard navigation | New, close, numeric selection, and previous/next tab shortcuts | Matched |
| Working and notification tab indicators | The active workspace tab shows live work; per-tab unseen/notification state is not projected | Partial |
| Back/forward titlebar history | Tab switching exists, but no navigation-history stack | Missing |
| Windows titlebar app menu | Native File/Edit/View/Window menu exists; OpenCode's renderer titlebar menu does not | Partial |
| Updater action in titlebar | Download-ready action and restart confirmation | Matched |
| Collapsible responsive sidebar | Desktop rail and mobile backdrop behavior are tested | Matched |
| Session search | Title, preview, project path, and working-directory filtering with result count and clear action | Matched |
| Flat recent sessions | Newest-first task/project sessions | Matched |
| Inline session rename | Sidebar and workspace-header rename with validation and rollback | Matched |
| Session action menu and delete confirmation | Keyboard-aware menu with Rename/Delete and explicit confirmation | Matched |
| Project switcher and project actions | Add, enter, new task, rename, remove, and Open in Explorer | Matched |
| Project avatar | Stable path-colored initial avatar on every project-switcher row | Matched |
| Project pinning | Visible Pin/Unpin menu action, pinned state, and pinned-first ordering | Matched |
| Sidebar resize handle | Persisted 232-420 px pointer and keyboard resizing with accessible separator semantics | Matched |

## 2. Session transcript and docks

| Reference capability | Mixdog evidence or difference | Status |
|---|---|---|
| Markdown, GFM tables, fenced code, and external links | React Markdown/GFM, scrollable tables, language headers, copy, secure external open | Matched |
| Tool cards | Shared TUI vocabulary, disclosure, status, elapsed time, result copy, and diff actions | Matched |
| Tool count summary, status title, and error card | Dedicated data components and renderer tests | Matched |
| Streaming shimmer and activity state | Character shimmer plus canonical live activity labels | Matched |
| Diff viewer | Multi-file/multi-hunk preservation and add/delete normalization | Matched |
| User and assistant metadata | Per-item agent/model/time, message copy, response completion footer | Matched |
| Successful, failed, and interrupted turn status | Authoritative transcript-outcome projection | Matched |
| Context usage indicator and detail surface | Header ring, token tooltip, and full Context command surface | Matched |
| Permission dock | Modal tool approval with focus isolation, allow/deny, and Escape denial | Matched |
| Active-turn steering and queued prompts | Queue list, next-boundary state, edit/restore, and abort restoration | Matched |
| Suggested follow-up dock | Queued user follow-ups exist; generated follow-up suggestions do not | Partial |
| Todo/plan dock | No engine-to-desktop todo projection | Missing |
| Question dock | No OpenCode-style structured question request dock | Missing |
| Revert/checkpoint dock | Mixdog has no compatible message checkpoint/revert engine | N/A |
| Session retry | Failed state is shown, but a failed turn cannot be retried from the transcript | Missing |
| Per-message navigation | Previous/next buttons, Alt+Arrow shortcuts, and Jump to latest | Matched |
| Image and file media preview in transcript | Composer thumbnails exist, but transcript file/media preview does not | Missing |
| Timeline virtualization and history paging | Transcripts over 80 items use a measured TanStack virtual timeline with bounded DOM rows, full scroll range, and global message navigation; explicit history paging controls remain absent | Partial |
| Session handoff | No draft/session handoff workflow | Missing |
| Boundary wheel gesture | No OpenCode message-boundary wheel gesture | Missing |
| URL hash message scroll | Desktop navigation is not URL-router based | N/A |
| File tabs and session side panel | No file-tab surface | Deferred |
| Terminal panel | No interactive terminal panel | Deferred |
| Review tab and line comments | No review workspace or line-comment model | Deferred |
| Session fork | No compatible session fork action | Missing |

## 3. Composer and routing

| Reference capability | Mixdog evidence or difference | Status |
|---|---|---|
| Text submit, stop, and IME-safe keyboard handling | Implemented and covered by renderer interaction tests | Matched |
| Slash command palette | All 30 public TUI commands and aliases are sourced from the canonical registry | Matched |
| Model, effort, and Fast controls | Current/next-session routing with capability validation | Matched |
| Agent and workflow selection | Workflow settings and per-agent route controls | Matched |
| Attachment chips, image thumbnails, remove, and policy errors | Text/image attachment model with size/count guards | Matched |
| Drag-and-drop attachments | Drop overlay and file ingestion | Matched |
| Clipboard image and large-text paste | DataTransfer images and folded pasted-text tokens | Matched |
| Prompt history | Project/session-scoped persisted history with caret-aware Up/Down navigation | Matched |
| `@` project-file context | Cancellable fuzzy search, keyboard selection, and submitted path | Matched |
| Queue editing and abort restoration | Engine-owned queued text and attachments can be restored | Matched |
| Rotating placeholder | Stable placeholder is an explicit Mixdog UX decision; the obsolete idle rotation timer was removed to avoid periodic rerenders | N/A |
| Native attachment button/file picker | Multiple image/text selection, policy validation, chips, removal, drop, and paste | Matched |
| Native directory/file dialogs | Project directory chooser exists; general file/directory dialogs do not | Partial |
| Model detail tooltip | Hover/focus metadata shows provider, exact model ID, context, effort options, Fast, latest, and release date when available; input-modality metadata is not in the Mixdog catalog | Partial |

## 4. Settings and user preferences

| Reference capability | Mixdog evidence or difference | Status |
|---|---|---|
| Two-pane settings dialog | Twelve categories, focus trap, nested dialogs, responsive rail, WCO safety | Matched |
| Language | Response-language profile exists; the desktop UI itself remains English | Partial |
| Color scheme | System, White, and Dark preference | Matched |
| Theme palette | Slash commands can select TUI themes; desktop settings expose only the three desktop schemes | Partial |
| Main/search/workflow/agent model routes | Provider/model/effort/Fast editors | Matched |
| Model visibility management | No provider/model show-hide management dialog | Missing |
| Provider API key, OAuth, and local endpoint setup | Settings and onboarding support fixed providers and local endpoints | Matched |
| Arbitrary custom provider creation | Fixed provider catalog/local endpoint support, but no arbitrary custom-provider builder | Partial |
| Server and MCP management | Mixdog manages MCP servers; OpenCode's broader multi-server model is different | Partial |
| Keybind editor | No searchable edit/reset/conflict settings surface | Missing |
| Runtime status popover | Sidebar trigger reports bridge, engine, workflow, channel worker, and PID health | Matched |
| Persistent webview zoom | Ctrl/Cmd zoom shortcuts, native menu actions, and persisted factor | Matched |
| Keybind chips in tooltips | Tooltip layer renders parsed key chips where supplied | Matched |
| First-run onboarding | Provider, model, workflow, and explicit skip confirmation | Matched |
| Update settings and install action | Check, auto-update, stage/install, and desktop restart flow | Matched |
| Release notes dialog and preference | No release-notes UI or preference | Missing |
| OS notification preferences | Toasts exist, but native completion/permission/error notification settings do not | Missing |
| Notification click focus | No notification-click routing | Missing |
| Sound cues and selection | No sound runtime or settings | Missing |
| UI, code, and terminal font settings | Fonts are bundled/fixed | Missing |
| System shell selection | TUI and Desktop settings share the canonical validated `get/setSystemShell` capability; empty restores automatic selection | Matched |
| Feed display preferences | Tool expansion, reasoning-summary, progress, navigation, and search toggles are fixed rather than configurable | Partial |
| Permission auto-accept preference | Mixdog uses approval dialogs and hook-policy rules instead of a broad auto-accept switch | N/A |
| UI localization | No desktop i18n resource layer | Deferred |
| Pinch-zoom preference | Keyboard/menu zoom exists; pinch enable/disable does not | Partial |

## 5. Desktop integration and distribution

| Reference capability | Mixdog evidence or difference | Status |
|---|---|---|
| Hardened preload/IPC boundary | Sender/frame checks, argument validation, navigation denial, and CSP | Matched |
| Window state and single-instance focus | Persisted geometry/maximize state and second-instance focus | Matched |
| Deep-link registration and receive routing | `mixdog://` is registered; incoming URLs are not parsed or routed | Partial |
| Native application menu | File/Edit/View/Window plus persistent zoom; fewer OpenCode-specific actions | Partial |
| Open project in installed editor/terminal | Explorer only; no app discovery or path resolution | Missing |
| Login-shell environment inheritance | Engine launch does not import the user's login-shell PATH/environment | Missing |
| Renderer-unresponsive diagnostics | Bounded structured diagnostics record unresponsive/responsive, renderer/child-process exits, failure-time process memory, and five-minute memory snapshots; no JavaScript call-stack sampler | Partial |
| File logging | Privacy-safe lifecycle and bounded process-memory JSONL rotates at 512 KiB under `userData/logs`; general console output is not mirrored | Partial |
| Updater controller | Download state, renderer subscription, and quit/install coordination | Matched |
| Windows installer | One-click per-user NSIS, protocol registration, icon, and runtime archive | Matched |
| macOS runtime hardening | Hardened runtime is enabled; entitlements and notarization remain incomplete | Partial |
| Release signing and channel separation | Windows signing and dev/beta/prod channel separation are not configured | Deferred |
| WSL connection manager | Mixdog does not use OpenCode's multi-server/WSL placement model | N/A |
| Linux desktop packages | Product scope currently targets Windows and macOS | N/A |
| Desktop CLI installer | Mixdog is already distributed as a standalone CLI/TUI | N/A |

## 6. Mixdog TUI-to-desktop coverage

The OpenCode comparison is separate from Mixdog's own TUI parity. The current desktop audit verifies:

| Mixdog surface | Coverage | Result |
|---|---|---|
| Public slash registry | 30 TUI commands vs. 30 desktop commands, including aliases and GUI targets | Matched |
| TUI settings registry | 20 canonical rows mapped into 12 desktop categories | Matched |
| Safe direct-environment reads | 32 capability reads per E2E iteration | Matched |
| Command surfaces | Agents, Memory, Schedules, Webhooks, Channels, Context, Usage, Doctor, Effort | Matched |
| Safe local mutations | Idempotent Fast plus Compact and Clear with composer recovery | Matched |
| External side effects | Channel/webhook sends, OAuth, update installation, and remote claim against another live CLI | Guarded |

## 7. Priority gaps

Highest-value parity gaps that do not require a new backend product model:

1. Per-tab unseen/notification markers plus titlebar back/forward history.
2. Failed-turn retry, structured question dock, todo/plan projection, and transcript media preview.
3. Keybind settings, model visibility management, notification/sound preferences, release notes, and font settings.
4. Deep-link receive routing, external editor/terminal discovery, login-shell environment inheritance, and richer unresponsive stack diagnostics.

Large product features remain separate decisions: terminal panel, file tree/tabs, review workspace/line comments, session fork/checkpoints, WSL/multi-server placement, and UI localization.
