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

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe">
    <img src="https://img.shields.io/badge/Download_for_Windows_x64-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Download Mixdog for Windows x64" height="56">
  </a>
</p>

The Windows installer is currently unsigned, so Windows SmartScreen may show a
security warning.

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
delivers the same results at the same speed — on a fraction of the context,
for far less cost.

### GPT-5.6 Sol xhigh — Mixdog vs Codex CLI

![Terminal-Bench 2.1: Mixdog with GPT-5.6 Sol xhigh versus Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- **39%** lower priced cost — $0.476 vs $0.782 per trial
- **46%** smaller median final context — 18.5k vs 34.3k tokens
- **86.5%** (385/445) vs Codex CLI's **86.1%** (383/445) — full `k=5` on both
  sides, pass@5 **96.6%** vs 95.5%
- Matched speed — 415s vs 437s wall time per trial

### Claude Opus 5 — Mixdog vs Claude Code

![Terminal-Bench 2.1: Mixdog with Claude Opus 5 versus Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

- **19%** lower priced cost — $104.29 vs $129.21 per run
- **28%** smaller median final context — 27.6k vs 38.2k tokens
- **79/89** vs Claude Code's **77/89**
- **1.16×** faster — 610s vs 708s wall time per trial

Every run uses the official Harbor verifier, fast mode off, and a 272k context
window; task failures and agent timeouts are never retried. The Sol comparison
follows the protocol the official Terminal-Bench leaderboard requires on both
sides — all 89 tasks repeated five times (`k=5`, 445 trials each); the
Opus-side runs are single passes (`k=1`, 89 trials each). Speed is the full
trial wall clock, and cost values both sides at the same current API list
rates.

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
- **Browser Use** — a logged-in Chromium pane the agent can drive: tabs,
  forms, downloads, and snapshots, with one-time Chrome profile import
  including cookies and passwords.
- **Computer Use** — agent control of the Windows desktop through screen
  capture, accessibility, OCR, and a strict guarded input contract.
- **Office documents** — author and edit Word, Excel, and PowerPoint files
  with model-authored design plans, charts, and assurance-checked output.
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
- Browser Use pane with agent control and Chromium profile import
- Computer Use on Windows with guarded native input
- Office document authoring with rendered previews
- Image and video generation Studio with a persistent local gallery
- Visual workflow, agent, schedule, and webhook editors
- Voice dictation with an optional local transcription runtime
- Extensions hub with guided setup for Git, Memory, Browser Use, Computer
  Use, Office, and voice
- Provider setup, usage, git identity, and remote pairing settings

The paired remote web app is installable on desktop and mobile browsers. It
uses an authenticated end-to-end encrypted connection before session state,
terminal data, files, or operation requests cross the relay, and adds mobile
share-target intake, push notifications, and remote Browser Use.

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
npm test                      # every *.test.mjs under src/ and scripts/
npm test -- src/runtime/memory  # one directory
npm run test:slow             # *.slow.test.mjs
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
