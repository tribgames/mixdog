# Mixdog

[![npm](https://img.shields.io/npm/v/mixdog)](https://www.npmjs.com/package/mixdog)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

## The most efficient harness. The easiest way to use it.

Mixdog's goal is simple: make the most efficient AI coding harness the
easiest to use. Get more work done with the same model and budget, without
needing to become an expert in agent infrastructure.

That means more than an easy first run. Advanced capabilities should be easy
to access, configure, and manage as your work grows—from choosing a model
to coordinating agents and shaping your own workflows.

- **Efficiency that turns into more work.** Cache-aware context, focused
  tools, and compaction reduce overhead so more of your budget goes toward
  the task. The same-model Terminal-Bench comparisons below show comparable
  or better results with less context and lower priced cost.
- **Advanced capabilities, within easy reach.** Guided setup and visual
  controls help you assign models by role, configure workflows, and work
  with parallel agent sessions without building your own agent stack.
- **Simple to manage. Flexible when you need it.** Manage providers, agents,
  workflows, and extensions in one app. Customize agent definitions and
  operating rules, or add skills, MCP servers, hooks, and plugins as needed.

Use supported subscription accounts, API keys, or Mixdog's built-in Local Provider.
Take the same agent beyond code into browsers, Windows apps, documents,
images, and video—and continue live sessions across terminal, Desktop,
and a paired browser on your computer or phone.

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

Requires Node.js 22.19+ (22.x) or 24+.

CLI native assets support Windows x64, macOS x64/ARM64, and Linux x64/ARM64.
Windows ARM64 Node.js is not supported. On ARM Windows, use x64 Node.js under
Windows x64 emulation; native ARM64 installation is not available.

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

These published runs use the official Harbor verifier with fast mode off;
task failures and agent timeouts are never retried. The Sol comparison
follows the protocol the official Terminal-Bench leaderboard requires on both
sides — all 89 tasks repeated five times (`k=5`, 445 trials each); the
Opus-side runs are single passes (`k=1`, 89 trials each). Speed is the full
trial wall clock, and cost values both sides at the same current API list
rates, not actual subscription charges or invoices. These are measurements of
the pinned source revision, not a new benchmark of every subsequent release.

The leaderboard is not accepting community submissions, so every run here ships
its raw artifacts instead — Harbor verdicts, official verifier output, pinned
task checksums, and the usage snapshots behind every cost figure — alongside
the harness, presets, and metric scripts that recompute each number above:
[`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/).

## What you can do

### Build, test, and review

Search repositories with text and symbol-aware tools, edit files, run tests
and background commands, and review changes. Desktop brings the agent together
with a Monaco editor, Git, terminals, and a file explorer. Use workflows and
role-specific models to organize work, and extend the toolset with MCP
servers, skills, hooks, and plugins.

The GitHub integration manages repositories, issues, pull requests and reviews,
Actions, releases, and notifications. Source Control commits use a manually
entered summary and optional description; there is no built-in AI commit-message
generator. See [Git & GitHub](docs/git-github-integration.md) for supported
operations and permission requirements.

### Keep longer work moving

Resume saved chats, recall prior work through local semantic and lexical
search, and retain project-scoped preferences across sessions. Compaction
keeps long conversations manageable. For an explicitly requested longer-running
objective, **Goals** track completion conditions and tasks, support time limits
and automatic continuation, and let you pause or resume the work.

### Work beyond the repository

- **Browser Use** — operate signed-in Chromium pages, forms, tabs, and
  downloads. On Windows, import a Chrome profile, including cookies and
  passwords; cookie and password import require administrator approval and
  a build with the native importer. Session cookies are encrypted with the
  OS keychain and restored on launch when encryption is available.
  Developer controls share the same pages and sign-in through
  `browser_devtools`.
- **Computer Use on Windows** — operate native apps through accessibility,
  screenshots, OCR, keyboard, and pointer input with guarded execution.
- **Documents** — create and edit Word, Excel, and PowerPoint files, work
  with PDFs, and inspect rendered previews and document quality checks.
- **Image and video Studio** — generate and edit images, generate short video
  clips, and keep the results in a persistent local gallery. Continue a clip
  by using its last frame as the reference for a new generation; this carries
  over the pose, not the original motion or camera trajectory. Available
  models and controls depend on your signed-in provider routes.

Browser Use and Computer Use are opt-in capabilities. In interactive sessions,
each asks for approval before its first live call by default; approval covers
the rest of that session, and a restart asks again. Headless and agent-owned
sessions without an approval UI are not gated by this first-use prompt.

### Continue from another screen

Desktop, TUI, and paired browsers share live sessions rather than starting
independent copies. The installable remote web app connects to Desktop over
authenticated end-to-end encryption, so you can follow and continue work from
a computer or phone.

## Providers

Mixdog supports subscription OAuth and API-key routes, including:

- Anthropic API keys and Claude account OAuth
- OpenAI API keys and ChatGPT/Codex account OAuth
- Google Gemini API keys and Antigravity OAuth
- xAI API keys and Grok account OAuth
- OpenRouter API keys and its unified model catalog
- Experimental Cursor account OAuth
- DeepSeek and OpenCode Go
- Mixdog's built-in Local Provider

The model picker combines live provider catalogs with model metadata for
context limits, pricing, tool support, reasoning, and recency.

The supported provider list above is not an arbitrary OpenAI-compatible
endpoint registry. The former Ollama and LM Studio routes have been retired.

### Local Provider

Download and run models directly in Mixdog, without managing a separate model
server. The managed runtime currently requires **Windows x64 and an NVIDIA
GPU**, with enough VRAM for the selected model.

Ask in chat to add a local model; Mixdog checks your hardware and guides
installation. **Extensions → Plugin → Local Provider** manages installed
models, download progress and resumption, and automatic unloading when idle.
Installed models are available through the `mixdog-local` provider.

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

# Enable remote mode
mixdog --remote

# Run onboarding again
mixdog --onboarding
```

Run `mixdog --help` for the complete option reference.

## Headless exec

`mixdog exec` runs one non-interactive, single-model session with ephemeral
configuration and no agent delegation. It requires an explicit provider and
model. It does not load the host's behavioral configuration, personal memory,
prior sessions, user profile, skills, MCP servers, or plugins:

```bash
mixdog exec --provider anthropic-oauth --model claude-opus-5 "fix the failing test"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --effort xhigh --fast "review the current diff"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --json "fix the failing test"
```

Web search and page retrieval are disabled by default. Enable them per run
when needed:

```bash
mixdog exec --provider openai-oauth --model gpt-5.6-sol --web-search "research this issue"
```

Disabling web search does **not** block ordinary shell networking: package
managers, Git clients, and other commands can still access the network.
Headless exec is not an offline sandbox.

`--memory`, `--workflow`, `--readonly`, `--remote`, and `--onboarding` are not
supported by `mixdog exec`. Use an interactive session for personal memory and
saved-work continuation. `--json` emits timestamped JSONL events to stdout;
diagnostics remain on stderr.

## TUI commands

```text
/clear        start a fresh chat
/project      switch the current project
/resume       resume a saved chat
/inherit      carry this conversation into a new session on the current model
/compact      compact older conversation context
/goal         start, inspect, pause, or resume a durable session Goal
/autoclear    manage idle-time context clearing
/context      inspect the current context surface
/usage        show provider quota and balance
/providers    configure provider authentication
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
/profile      set your title, development experience, and response language
/update       check for updates
/doctor       diagnose installation health
/quit         quit the TUI
```

Workflows and agents are Markdown definition packs (`WORKFLOW.md`, `AGENT.md`).
Built-in packs ship with Mixdog; custom packs live under the Mixdog data
directory.

**Solo** is the default workflow: the Lead does the work without delegating.
Choose **Cowork** (`mixdog --workflow default`) for parallel agent delegation.
Running multiple independent Desktop sessions is separate from delegating
work to agents within one session.

To start a time-bounded Goal, for example:

```text
/goal Fix the failing tests --time 1h
/goal status
/goal pause
/goal resume
```

## Desktop app

Mixdog Desktop runs the same agent runtime as the CLI. In the **Sessions**
panel, choose **New task** for agent work or **New Studio** for image and video
work. The **Projects** panel has **Project** and **Workflow** tabs for managing
repositories, workflow packs, and agent definitions.

The workspace includes:

- Split panes for parallel, independently routed agent sessions
- Live session handoff between the TUI, desktop windows, and paired browsers
- Monaco editor, LSP integration, diffs, and turn-by-turn edit review
- Git staging, commits with manually entered messages, and branches
- GitHub repositories, issues, pull requests, reviews, Actions, releases,
  and notifications
- File explorer with previews, thumbnails, search, and drag-and-drop
- Integrated terminal tabs using the local system shell
- Browser Use pane with agent control and Chrome profile import on Windows
- Computer Use on Windows with guarded native input
- Word, Excel, PowerPoint, and PDF tools with rendered previews
- Image and video generation Studio with a persistent local gallery
- Visual workflow, agent, schedule, and webhook editors, plus session Goal
  progress and controls
- Voice dictation with an optional local transcription runtime
- Extensions hub with guided setup for Git & GitHub, Memory, Browser Use,
  Computer Use, Office, Local Provider, and voice
- Provider setup, usage, git identity, and remote pairing settings

In **Extensions**, the **Plugin** tab manages integrations and built-in
capabilities; the **Skill** tab lets you add and manage skills and MCP servers.
Language servers start on demand when installed locally or on your system;
Mixdog does not download them automatically. See
[language server setup](docs/language-servers.md).

The paired remote web app is installable on desktop and mobile browsers. It
uses an authenticated end-to-end encrypted connection before session state,
terminal data, files, or operation requests cross the relay, and adds mobile
share-target intake, push notifications, and remote Browser Use.

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
npm test                       # discovered fast-lane tests
npm test -- src/runtime/memory  # narrow to one path
npm run test:slow              # *.slow.test.mjs
npm run test:live              # built-artifact or live-system checks
npm run build:tui
npm run audit:models
```

For desktop development, install the root dependencies above, then:

```bash
cd apps/desktop
npm install
npm run dev
```

Both packages discover `*.test.mjs` and `*-test.mjs` under their `src/` and
`scripts/` directories. Fast, slow, and live tests run in separate lanes;
live checks need their corresponding built artifacts or services. See
[testing practices](docs/testing.md) for details.

Main directories:

```text
src/            CLI, TUI, runtime, workflows, agents, and rules
apps/desktop/   cross-platform desktop app
apps/relay/     remote web app and relay
native/         native process, search, patch, and support binaries
scripts/        tests, diagnostics, benchmarks, and build scripts
benchmarks/     reproducible benchmark harnesses, results, and raw artifacts
src/vendor/     vendored runtime components
```

## License

Mixdog is licensed under [Apache-2.0](LICENSE).
Third-party components retain their respective licenses; see [NOTICE.md](NOTICE.md).
