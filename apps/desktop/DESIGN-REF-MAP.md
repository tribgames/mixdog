# Desktop UI — Reference Correspondence Map

Goal: align mixdog desktop layouts/readability with well-regarded open-source
coding-agent desktops. Base chrome stays OpenCode v2 (already pixel-aligned);
this map records where each surface stands against the reference consensus.

## References (C:\Project\refs)

| Repo | Kind | What it's authoritative for |
|---|---|---|
| `opencode` | coding agent desktop | base chrome, colors, elevation (already aligned) |
| `goose` (block) | coding agent desktop (Electron) | tool-call cards, inline approvals, token registry (`ui/desktop/src/styles/main.css`) |
| `opcode` (ex-Claudia) | Claude Code GUI (Tauri) | session layout (`src/components/ClaudeCodeSession.tsx:1352` max-w-6xl px-6), per-tool widgets (`ToolWidgets.tsx`) |
| `crystal` | multi-session CC manager | project/session sidebar, panel tabs (terminal/diff/editor) |
| `claudecodeui` | CC/Codex web+desktop UI | chat interface baseline (`src/components/chat/view/ChatInterface.tsx`) |
| `cline` | agent chat UI (VS Code webview) | flat tool rows, diff/command output rows (`ChatRow.tsx`, header `gap-2.5 mb-3`) |
| `aider-desk`, `openhands` | agent GUIs | secondary comparison |
| `cherry-studio` | AI desktop client | **DESIGN.md**: text/border 3-tier hierarchy, icon-anchor rule, sidebar metrics |
| `jan` | AI desktop client (Tauri) | markdown reading rhythm (`web-app/src/styles/markdown.css`) |
| `lobe-chat`, `chatbox` | AI chat UIs | chat metadata scale (14 body / 12 meta) |

## Surface map — consensus vs mixdog

Legend: OK = already matches consensus · GAP = polish target

| # | Surface | Reference consensus | mixdog now | Verdict |
|---|---|---|---|---|
| 1 | Shell | sidebar + centered chat column (opcode `max-w-6xl mx-auto px-6`; goose shadcn sidebar; crystal sidebar+panels) | opencode band/sheet + 260px session sidebar | OK — keep opencode chrome |
| 2 | Assistant message | flat, no bubble, ~90% width (goose `GooseMessage.tsx:123`), user in bubble | flat assistant + 3% surface user bubble | OK |
| 3 | Markdown headings | real scale, 600 weight, 1em/0.5em margins (jan `markdown.css:15-48`; goose heading token scale xs→3xl; cherry 20→60px scale) | h1–h6 all flat `14px/500` (`opencode-v2.css:3601`) | **GAP-A** |
| 4 | Strong/emphasis | 600 everywhere (jan `:59`, cherry weight tokens 400/500/700) | `strong` 500, one notch above body 400 | **GAP-A** |
| 5 | Markdown rhythm | p/list lh 1.6, li 0.5em, blockquote accent border (jan) | body 14/21 OK; li fixed 8px, blockquote grey `border-strong` | **GAP-B** |
| 6 | Text hierarchy | 3 tiers + "one anchor per icon cluster, rest muted" (cherry DESIGN.md §4 icon rules) | `--oc-text`/`muted`/`faint` exist; faint #808080 used broadly for labels; icon clusters uniform | **GAP-C** |
| 7 | Tool-call card | bordered rounded-lg card, one-line header (status icon + name + args summary), expandable Output/Logs, `text-sm` (goose `ToolCallWithResponse.tsx:250`); cline flat rows + CodeAccordian | opencode-style tool cards, header+detail blocks | OK-ish — apply GAP-C muting to header meta |
| 8 | Approvals | inline in tool card, amber border highlight + approve/deny buttons (goose `:253` `border-amber-500/50`); cline inline OptionsButtons | inline transcript card + `--oc-approval-ring` (was overlay) | OK — done |
| 9 | Composer | bottom card, model picker + attach + mic (goose ChatInput; opcode floating input `max-w-3xl`) | opencode composer, same anatomy | OK |
| 10 | Sidebar rhythm | 32px rows, 12px inset, 4px in-group gap, 10px radius, 12px muted section labels (cherry DESIGN.md sidebar table) | session rows looser, section labels same tone as items | **GAP-C** |
| 11 | Empty state | compact wordmark + starter hints (goose SessionInsights, crystal EmptyState) | oversized raw "mixdog" watermark | **GAP-E** |
| 12 | Elevation | surfaces stack via color, shadows only for floating (cherry §1; goose single `--shadow-default`) | v2 elevation already aligned | OK |
| 13 | Status/usage | tokens+cost visible per session (opcode usage dashboard; goose bottom bar) | context gauge in composer | OK |
| 14 | Titlebar/session tabs | tabs carry live status (crystal `PanelTabBar` StatusDot per tab; opcode Topbar keeps a green/red engine status chip) | active-tab working dot only | GAP-F **deferred**: desktop runs one engine session at a time (`engine-host.ts` resumes in place), so background tabs can never be busy; per-tab dots need multi-session concurrency — architecture work, not polish |
| 15 | Context gauge detail | progress bar + hover breakdown (in/out/cache) + inline compact confirm (cline `task-header/ContextWindow.tsx`) | hover popover: usage % + tokens with `(est.)` marker | OK — done |
| 16 | Empty state anatomy | icon-in-circle + title + one-line description + primary CTA (crystal `EmptyState.tsx:18-28`) | oversized watermark, hidden `<p>`, starters disabled (`opencode-v2.css:1079-1080`) | folds into **GAP-E** |
| 17 | Toasts | sonner-style bottom-right (jan), 320px cards | top-right 320px `.oc-toast` — documented intentional choice, tests pin it | OK — keep |
| 18 | Scrollbars | thin translucent, transparent track, hover raise (jan `index.css:200-224`) | 8px thin translucent + hairline inset, same philosophy | OK |
| 19 | Settings dialog | two-column rail+pane, centered, neutral chrome (cherry §5 settings layout) | 980/240 two-pane centered, capture-asserted | OK |
| 20 | Model picker | grouped list, hidden scrollbar, provider groups (goose/opcode selectors) | `.model-list` same anatomy | OK |
| 21 | Diff / command output | collapsible accordion rows with path header + copy (cline `CodeAccordian`, `DiffEditRow`; crystal diff panel) | DiffView.lazy + tool detail blocks — not yet deep-compared | audit later with GAP-D |

## Polish plan (derived)

- **A. Reading typography** (highest leverage): heading scale h1 20/28 · h2 17/24 · h3 15.5/22 · h4+ 14/21, weight 600, margins 1em/0.5em; `strong` 600. Korean-friendly: keep 14px body, lh 21px.
- **B. Markdown rhythm**: li spacing 0.5em-relative; blockquote accent border + muted text; inline-code contrast bump.
- **C. Hierarchy discipline**: audit `--oc-text-faint` usages on labels → promote to `muted` where informational; icon clusters follow cherry anchor rule; sidebar section labels 11-12px muted, rows 32px/4px/10px grid.
- **D. Inline approvals** (structural, separate approval): move approval UI into the tool card with warning border, keep overlay for destructive ops.
- **E. Empty state**: shrink wordmark, add muted starter hints.
- **F. Optional/US-later**: per-tab activity dot (crystal), context-gauge hover breakdown + inline compact (cline), diff-row deep audit.

Constraints: opencode v2 chrome tokens (band/sheet colors, elevation, focus
ring, switches) stay untouched; renderer tests + capture assertions updated in
the same change as any metric they pin.
