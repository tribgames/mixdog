# Mixdog

[![npm](https://img.shields.io/npm/v/mixdog)](https://www.npmjs.com/package/mixdog)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## Better results. Less cost. More work.

Mixdog is an efficiency-first AI coding harness designed to deliver equal or
better performance with less context, time, and cost—so you can complete more
work within the same API budget or subscription quota.

With simple setup and an intuitive UX, Mixdog makes powerful orchestration,
parallel tasks, and seamless work across terminal, desktop, and web accessible
to everyone—from beginners to experts.

**The easiest way to get more out of every coding model.**

## Get started

### Desktop

| Platform | Download |
| --- | --- |
| Windows x64 | [Installer](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe) |
| macOS Apple silicon | [DMG](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-mac-arm64.dmg) |
| macOS Intel | [DMG](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-mac-x64.dmg) |
| Linux x86_64 | [AppImage](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-linux-x86_64.AppImage) |
| Linux arm64 | [AppImage](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-linux-arm64.AppImage) |

Desktop packages are currently unsigned, so Windows SmartScreen or macOS
Gatekeeper may show a security warning.

### CLI

Requires Node.js >= 22.

```bash
npm install -g mixdog
mixdog
```

First run guides you through provider authentication, model selection, and
workflow setup.

## Benchmarks

Terminal-Bench 2.1 — same model, same 89 tasks, same official verifier, with
only the harness changed. Against the native CLI of each model family, Mixdog
scores higher while spending less to get there.

### GPT-5.6 Sol xhigh — Mixdog vs Codex CLI

![Terminal-Bench 2.1: Mixdog with GPT-5.6 Sol xhigh versus Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- **86.5%** (385/445) vs Codex CLI's **84.3%** (75/89)
- **42%** lower priced cost — $0.641 vs $1.096 per trial
- **45%** smaller median final context — 18.5k vs 33.5k tokens
- **1.11×** faster — 339s vs 378s per trial

### Claude Opus 5 — Mixdog vs Claude Code

![Terminal-Bench 2.1: Mixdog with Claude Opus 5 versus Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

- **79/89** vs Claude Code's **77/89**
- **19%** lower priced cost — $104.29 vs $129.21 per run
- **28%** smaller median final context — 27.6k vs 38.2k tokens
- **1.15×** faster

Every run uses the official Harbor verifier, fast mode off, a 272k context
window, and zero retries. The Mixdog Sol run follows the protocol the official
Terminal-Bench leaderboard requires — all 89 tasks repeated five times (`k=5`,
445 trials); the Codex CLI baseline and both Opus-side runs are single passes
(`k=1`, 89 trials each).

The leaderboard is not accepting community submissions, so every run here ships
its raw artifacts instead — Harbor verdicts, official verifier output, pinned
task checksums, and the usage snapshots behind every cost figure — alongside
the harness, presets, and metric scripts that recompute each number above:
[`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/).

## Highlights

- **Multi-provider routing** — assign different providers and models by role.
- **Shared live sessions** — move between the TUI, desktop windows, and paired
  browsers without starting a second copy of the session.
- **Efficient context** — cache-aware prompts, compaction, resumable sessions,
  and focused repo-native tools.
- **Complete coding surface** — read, search, edit, test, review, web search,
  MCP, skills, hooks, and plugins.
- **Local memory** — semantic and lexical recall with project-scoped context
  and multilingual retrieval.
- **Encrypted remote access** — pair the installable web app with Desktop and
  use Mixdog from a browser or phone over authenticated E2EE.
- **Desktop coding app** — agent panes, Monaco editor, Git, terminals, file
  explorer, Studio, automation, voice input, and settings in one app.

## Providers

Mixdog supports subscription OAuth and API-key routes, including:

- Anthropic API keys and Claude account OAuth
- OpenAI API keys and ChatGPT/Codex account OAuth
- Google Gemini and Antigravity OAuth
- xAI API keys and Grok account OAuth
- OpenRouter API keys and its unified model catalog
- Experimental Cursor account OAuth
- DeepSeek and OpenCode Go
- OpenAI-compatible APIs
- Ollama and LM Studio

The model picker combines live provider catalogs with model metadata for
context limits, pricing, tool support, reasoning, and recency.

## Run

```bash
# Start in the current project
mixdog

# Select a provider and model
mixdog --provider anthropic-oauth --model claude-haiku-4-5-20251001

# Select a workflow
mixdog --workflow solo

# Use read-only tools
mixdog --readonly

# Enable remote and channel features
mixdog --remote

# Run onboarding again
mixdog --onboarding
```

Run `mixdog --help` for the complete option reference.

## Headless exec

`mixdog exec` runs one non-interactive, single-model session with ephemeral
configuration. It requires an explicit provider and model:

```bash
mixdog exec --provider anthropic-oauth --model claude-opus-5 "fix the failing test"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --effort xhigh --fast "review the current diff"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --json "fix the failing test"
```

Web search and memory are disabled by default in headless runs. Enable them
per run when needed:

```bash
mixdog exec --provider openai-oauth --model gpt-5.6-sol --web-search "research this issue"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --memory "continue the previous work"
```

Without `--web-search`, shell child processes use an offline network policy
while loopback remains available. `--json` emits timestamped JSONL events to
stdout; diagnostics remain on stderr.

## TUI commands

```text
/clear        start a fresh chat
/project      switch the current project
/resume       resume a saved chat
/compact      compact older conversation context
/autoclear    manage idle-time context clearing
/context      inspect the current context surface
/usage        show provider quota and balance
/providers    configure authentication and local endpoints
/model        choose the main provider and model
/websearch    choose the web search route
/workflow     choose the active workflow
/agents       inspect agents and model overrides
/effort       set reasoning effort
/fast         toggle supported model fast mode
/OutputStyle  choose the Lead response style
/theme        change the TUI color theme
/memory       inspect and edit core memory
/mcp          manage MCP servers and tools
/skills       choose a skill for the next request
/plugins      manage local plugin integrations
/hooks        manage before-tool hooks and events
/setting      open runtime settings
/profile      set your title and response language
/update       check for updates
/doctor       diagnose installation health
/quit         quit the TUI
```

Workflows and agents are Markdown definition packs (`WORKFLOW.md`, `AGENT.md`).
Built-in packs ship with Mixdog; custom packs live under the Mixdog data
directory.

## Desktop app

Mixdog Desktop runs the same agent runtime as the CLI:

- Split panes for parallel, independently routed agent sessions
- Live session handoff between the TUI, desktop windows, and paired browsers
- Monaco editor, LSP integration, diffs, and turn-by-turn edit review
- Git staging, commits, branches, and generated commit messages
- File explorer with previews, thumbnails, search, and drag-and-drop
- Integrated terminal tabs using the local system shell
- Image and video generation Studio with a persistent local gallery
- Visual workflow, agent, schedule, and webhook editors
- Voice dictation with an optional local transcription runtime
- Provider setup, usage, git identity, and remote pairing settings

The paired remote web app is installable on desktop and mobile browsers. It
uses an authenticated end-to-end encrypted connection before session state,
terminal data, files, or operation requests cross the relay.

For desktop development:

```bash
cd apps/desktop
npm run dev
```

## Data and configuration

Mixdog uses `~/.mixdog` as its home root and `~/.mixdog/data` for runtime data
by default.

```bash
MIXDOG_HOME=/path/to/home mixdog
MIXDOG_DATA_DIR=/path/to/data mixdog
```

Useful environment variables:

- `MIXDOG_TUI_MOUSE=0` — use terminal-native mouse behavior.
- `MIXDOG_DISABLE_MODEL_PREFETCH=1` — disable provider model prefetch.
- `MIXDOG_MODE=ship|dev` — select shipping or development diagnostics.
- `MIXDOG_DIAGNOSTICS=1` — force diagnostic trace and log output.

## Development

```bash
npm install
npm start

npm run smoke
npm run smoke:all
npm run test:tool-contracts
npm run build:tui
npm run audit:models
```

Main directories:

```text
src/            CLI, TUI, runtime, workflows, agents, and rules
apps/desktop/   cross-platform desktop app
apps/relay/     remote web app and relay
native/         native process, search, patch, and support binaries
scripts/        tests, diagnostics, benchmarks, and build scripts
benchmarks/     reproducible benchmark harnesses, results, and raw artifacts
vendor/         vendored runtime components
```

## License

MIT
