# mixdog

[![npm](https://img.shields.io/npm/v/mixdog)](https://www.npmjs.com/package/mixdog)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

Mixdog is a standalone coding agent for orchestrated, multi-provider workflows.
Use it from a full-screen terminal UI or the Windows desktop app.

## Get started

### Windows desktop

[Download Mixdog Desktop for Windows (x64)](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe)

The desktop package is currently unsigned, so Windows SmartScreen may show a
security warning during installation.

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
- **Efficient context** — cache-aware prompts, compaction, resumable sessions,
  and focused repo-native tools.
- **Complete coding surface** — read, search, edit, test, review, web search,
  MCP, skills, hooks, and plugins.
- **Local memory** — semantic and lexical recall with project-scoped context
  and multilingual retrieval.
- **Remote workflows** — optional web relay, Discord, Telegram, voice, and cron
  schedules.
- **Windows desktop app** — agent panes, Monaco editor, git, terminal, file
  explorer, Studio, automation, and settings in one workbench.

## Providers

Mixdog supports subscription OAuth and API-key routes, including:

- Anthropic and Claude accounts
- OpenAI and ChatGPT/Codex accounts
- Google Gemini
- xAI Grok
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
/providers   configure provider authentication and local endpoints
/model       choose the main provider and model
/workflow    choose the active workflow
/agents      inspect agents and model overrides
/project     switch the current project
/resume      resume a saved session
/memory      inspect and edit core memory
/mcp         manage MCP servers and tools
/skills      select a skill
/channels    manage remote channels
/compact     compact older context
/setting     open settings
/update      check for updates
/doctor      diagnose installation health
```

Workflows and agents are Markdown definition packs (`WORKFLOW.md`, `AGENT.md`).
Built-in packs ship with Mixdog; custom packs live under the Mixdog data
directory.

## Windows desktop app

Mixdog Desktop runs the same agent runtime as the CLI in an Electron
workbench:

- Split panes for parallel, independently routed agent sessions
- Monaco editor, LSP integration, diffs, and turn-by-turn edit review
- Git staging, commits, branches, and generated commit messages
- Windows file explorer with previews, thumbnails, and drag-and-drop
- Integrated PowerShell and ConPTY terminal tabs
- Image and video generation Studio with a persistent local gallery
- Visual workflow, agent, and schedule editors
- Provider setup, usage, git identity, and remote pairing settings

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
apps/desktop/   Windows desktop workbench
apps/relay/     remote web relay
native/         native process, search, patch, and support binaries
scripts/        tests, diagnostics, benchmarks, and build scripts
vendor/         vendored runtime components
```

## License

MIT
