# mixdog

[![npm](https://img.shields.io/npm/v/mixdog)](https://www.npmjs.com/package/mixdog)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**Mixdog Desktop:** [Download for Windows (x64)](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe)
· [macOS / Linux preview builds](https://github.com/tribgames/mixdog/releases/latest)

Windows is the primary manually tested desktop platform. macOS and Linux
packages are built on native CI runners and pass packaged-runtime smoke tests,
but remain preview builds. Desktop packages are currently unsigned, so Windows
SmartScreen or macOS Gatekeeper may show a security warning.

Standalone coding agent that runs an orchestrated, multi-provider agent
workflow from one terminal — or from a full desktop workbench — built to
get the same quality out of the same models with less time, cost, and
context.

Mixdog combines an Ink-based terminal UI, per-role model routing across
providers, workflow agents, MCP/plugin/skill/hook support, lightweight
memory, web search, channel integrations, and repo-native tools for reading,
editing, testing, and reviewing code. Mixdog Desktop wraps the same runtime
in an Electron workbench with editor, git, terminal, file-explorer, media,
and automation surfaces.

## Quick start

Requires Node.js >= 22.

```bash
npm install -g mixdog
mixdog
```

First run walks you through onboarding: provider auth, model pick, and
workflow setup.

## Terminal-Bench 2.1 — controlled full-run comparisons

**Same model, same quality — in a fraction of the time, context, and
cost.** On the same 89 tasks, mixdog scored on par with both native
harnesses — **78/89** vs Claude Code's **77/89** (within single-run noise)
and **75/89** matching Codex CLI — while finishing faster, ending leaner,
and costing less.

Each comparison matches the primary model and reasoning level on
both sides, comparing each product as shipped: mixdog routes scoped
read-only Explorer lookups to a smaller model, mirroring Claude Code's
built-in Explore subagent (Haiku 4.5 by default in the 2.1.x baseline).
Codex CLI ships no equivalent helper — the Sol-led mixdog run used GPT-5.6
Luna for that scoped Explorer work. Results are self-reported single runs
(`k=1`, 2026-08), not leaderboard submissions.

#### Claude Opus 5 vs Claude Code

![Terminal-Bench 2.1 comparison of mixdog with Claude Opus 5 and Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

#### GPT-5.6 Sol xhigh vs Codex CLI

![Terminal-Bench 2.1 comparison of mixdog with GPT-5.6 Sol xhigh and Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- Speed: **1.43×** vs Claude Code, **1.27×** vs Codex CLI
  (baseline elapsed agent time ÷ mixdog elapsed agent time)
- Final context: **40–47% smaller** at task end (median tokens, measured
  from both harnesses' session logs)
- Priced cost: **29% lower** vs Claude Code, **at least 39.7% lower** vs
  Codex CLI (mixdog $54.50–$58.84 vs Codex's recorded $97.54)

Both sides run their standard single-agent loop. Anthropic cost includes
measured cache writes; the archived OpenAI runs did not retain
`cache_write_tokens`, so the Codex cost delta is a lower bound. Raw
artifacts, the exact run commands, and the metric scripts that recompute
every number above live under `benchmarks/terminal-bench-2.1/`.

## Why mixdog

**Maximum performance at minimum cost**

- Orchestrated agent workflow that mixes providers and models per role, so
  each step runs on the cheapest model that can do the job well.
- Cache-aware prompt layout and aggressive context savings across turns.
- Lean output policy plus fine-grained session management: compaction,
  resumable sessions, and usage dashboards.
- A custom harness with tool-call routing tuned for the fewest, most
  effective calls (`code_graph`, batched `read`/`grep`, windowed reads).

**Any provider**

- Sign in with the subscriptions you already pay for: OAuth device flows for
  Claude and ChatGPT/Codex accounts work alongside plain API keys.
- Anthropic, OpenAI, Google/Gemini, xAI/Grok, DeepSeek, OpenCode Go,
  OpenAI-compatible APIs, Ollama, and LM Studio/local endpoints.
- Live model catalog from provider `/models` endpoints, enriched with
  LiteLLM/models.dev metadata for context windows, output limits, pricing,
  tool support, reasoning, and recency.
- Customizable web search and repo exploration tools.

**Any environment**

- Full-screen TUI with slash commands, provider setup, model/workflow
  pickers, statusline integration, and detailed tool cards — plus headless
  role mode for scripting.
- Mixdog Desktop: a full agent workbench for Windows/macOS/Linux (see
  below).
- Installable web app over relay pairing — scan a QR code to open your
  running sessions in a phone browser and keep going from any network.
- Optional Discord/Telegram channels, webhook endpoints, and cron schedules
  with quiet hours for remote/event-driven workflows; channel voice messages
  are transcribed locally with a managed Whisper server.
- First-class Windows support: ConPTY terminals, PowerShell-aware shell
  profiles, and a one-click desktop installer.

**Memory**

- Every session is ingested into a local memory store in the background, so
  prior work, decisions, and fixes stay recallable across sessions via the
  `recall` tool and `/memory`.
- Semantic + lexical recall with local embeddings, time-window queries, and
  project-scoped pools — multilingual, including Korean morphology.
- A multi-pass consolidation cycle promotes important memories into a
  compact core set — and demotes them when stale — so memory stays small
  and current instead of growing without bound.

**Agent-ecosystem compatible**

- Skills, MCP servers, hooks, and plugins load through standard-compatible
  interfaces.
- Built-in Web Search, Explorer, and Maintainer services, plus editable
  starter agents (`worker`, `heavy-worker`, `reviewer`) and user-authored
  custom roles.

## Run

For local development from this checkout:

```bash
npm install
npm start
```

```bash
# Start the TUI in the current project
mixdog

# Start with an explicit route
mixdog --provider anthropic-oauth --model claude-haiku-4-5-20251001

# Start with a specific workflow active
mixdog --workflow solo

# Read-only tool surface
mixdog --readonly

# Enable remote/channel mode for this session
mixdog --remote

# Re-run the first-run setup wizard
mixdog --onboarding
```

Headless role mode is also supported. It requires an explicit
provider/model pair and runs with ephemeral config — host behavioral config
and personal state are not loaded:

```bash
mixdog --provider anthropic-oauth --model claude-opus-5 worker "fix the failing test"
mixdog --provider openai-oauth --model gpt-5.6-sol reviewer "review the current diff"
```

Roles: `explore`, `worker`, `heavy-worker`, `reviewer`, `maintainer`,
`web-researcher`.

## TUI basics

Common slash commands:

```text
/providers         configure provider auth and local endpoints
/model             choose the main provider/model (/effort, /fast tune it)
/workflow          choose the active workflow
/agents            show workflow agents and per-agent model overrides
/project           switch working directory (project)
/resume            resume a saved chat
/usage             show total provider quota / balance
/context           show the current context surface
/memory            list and edit core memories
/setting           open the runtime settings hub
/mcp               manage MCP servers and tools
/skills            choose a skill for the next request
/channels          manage Discord, Telegram, and voice
/compact           compact older conversation context
/autoclear         reduce cache-miss cost after long idle gaps
/theme             change the TUI color theme
/clear             reset the conversation and screen
/OutputStyle       show or switch Lead output style
/update            check version and update mixdog
/doctor            diagnose installation health
```

Run `mixdog --help` for the full command and option reference.

Use `/providers` first if no model is configured, then `/model` to pick the
route. The model picker warms the provider catalog in the background and keeps
Claude families such as Opus, Sonnet, Haiku, and Fable separate when filtering
current Anthropic models.

Workflows and agents are Markdown definition packs (`WORKFLOW.md`,
`AGENT.md`). Built-ins ship with mixdog; custom packs live under the data
directory (`workflows/<id>/`, `agents/<id>/`) and are edited on the desktop
app's Workflows page. Schedules and webhooks are also managed in the desktop
app.

## Desktop app

Mixdog Desktop (Electron) runs the same runtime as the CLI inside a full
agent workbench. Installers are published on GitHub Releases (Windows
one-click NSIS, macOS dmg/zip, Linux AppImage), and a guided onboarding
wizard covers first-run setup. For development run `npm run dev` inside
`apps/desktop`.

- **Workbench shell** — VS Code-style activity rail and tab strip,
  drag-and-drop tabs across pane groups, and unlimited splits that run
  parallel agent sessions side by side — every pane hosts a live session
  surface with its own draft and model controls — plus a command surface,
  bottom panel, and problems view.
- **Sessions and projects** — project-scoped session lists, resumable
  sessions with per-pane route restore, live agent-activity indicators, and
  usage dashboards in the sidebar.
- **Editor and review** — Monaco editor pane with LSP integration, git and
  inline diff viewers, and turn-by-turn review of agent edits with approval
  cards.
- **Source control** — git dock for staging/commits/branches,
  auto-generated commit messages, GitHub CLI integration, pull-request
  browsing, and a dedicated review pane.
- **File explorer** — Windows-Explorer-grade folder pane: breadcrumbs and
  path box, ribbon toolbar, places/drives/tree sidebar, grouped grid and
  details views with shell icons and thumbnails, rubber-band selection,
  clipboard and OS drag-and-drop, preview pane, and file properties.
- **Terminal** — integrated terminal tabs on the native shell (ConPTY on
  Windows) with shell-profile detection, isolated in a worker process so a
  runaway shell never takes the app down.
- **Studio** — media studio for image and video generation over
  authenticated provider lanes, with a persistent local gallery, reference
  images, and per-model resolution/aspect/duration controls.
- **Automation** — visual editors for workflow and agent packs, cron
  schedules, webhooks, and channel integrations.
- **Settings hub** — provider auth, capability sweep, git identity, and
  QR device pairing for the installable web app, preloaded so every
  category opens instantly.

## Scripts

```bash
npm run smoke                # fast core feature smoke
npm run smoke:all            # feature-surface smoke suite
npm run smoke:tui            # TUI feature smoke
npm run test:tool-contracts  # optional tool contract suite
npm run build:tui            # build the bundled Ink TUI
npm run audit:models         # inspect model catalog metadata
```

Additional diagnostics and benchmarks live under `scripts/`.

## Data and configuration

Mixdog uses `~/.mixdog` as its home root. Runtime data lives in
`~/.mixdog/data` by default.

```bash
MIXDOG_HOME=/path/to/home mixdog
MIXDOG_DATA_DIR=/path/to/data mixdog
```

Useful environment toggles:

- `MIXDOG_TUI_MOUSE=0` — use terminal-native mouse behavior instead of the TUI
  mouse/selection layer.
- `MIXDOG_DISABLE_MODEL_PREFETCH=1` — disable background provider model prefetch.
- `MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS=<ms>` — tune model-catalog warmup delay.
- `MIXDOG_MODEL_STALE_MONTHS=<months>` — tune catalog staleness filtering.
- `MIXDOG_MODE=ship|dev` — explicit shipping/dev mode. Shipping disables
  best-effort diagnostic trace/log file IO (agent-trace.jsonl,
  tool-failures.jsonl) by default; dev/debug opts back in. Default is `dev`
  from a git checkout and `ship` for a published install.
- `MIXDOG_DIAGNOSTICS=1` — force diagnostic trace/log file IO on even under
  shipping mode.

## Project layout

```text
src/
  cli.mjs        # CLI entry point (bin: mixdog)
  app.mjs        # CLI/TUI/headless mode wiring
  help.mjs       # command help text
  runtime/       # providers, tools, memory, channels, session runtime
  session-runtime/
                 # model routing, catalog rows, workflow/session helpers
  tui/           # canonical Ink TUI
  agents/        # workflow agent definitions
  workflows/     # workflow definitions
  rules/         # Lead and agent instructions
apps/
  desktop/       # Mixdog Desktop — Electron workbench (main/preload/renderer)
  relay/         # relay server for remote web-app access
scripts/
  smoke*.mjs     # smoke checks
  *test.mjs      # focused node:test checks
  build-tui.mjs  # esbuild bundle for the React TUI
vendor/
  ink/           # Mixdog Ink renderer
```

## Published package contents

The npm tarball ships `README.md`, `src/`, `vendor/`, and runtime `scripts/`
only (`package.json#files`); tests, smokes, benches, and `docs/` stay in the
repository.

## License

MIT
