<h1 align="center">Mixdog</h1>

<p align="center">
  <b>Same model. Same score. 63% fewer tokens.</b><br>
  Free, open-source coding agent for Windows — benchmarked against Codex CLI on Terminal-Bench 2.1.
</p>

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe">
    <img src="https://img.shields.io/badge/Download_for_Windows_x64-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Download Mixdog for Windows x64" height="56">
  </a>
</p>

<p align="center">
  <sub>The installer is unsigned, so Windows SmartScreen may show a warning.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mixdog"><img src="https://img.shields.io/npm/v/mixdog" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license">
  <img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen" alt="Node.js ^22.19.0 || >=24.0.0">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/tribgames/mixdog/main/docs/assets/desktop.png" alt="Mixdog Desktop" width="860">
</p>

## Same model. Same results. A fraction of the tokens.

Terminal-Bench 2.1 — same model, same 89 tasks, same official verifier.
Only the harness changes.

### GPT-5.6 Sol xhigh — Mixdog vs Codex CLI (`k=5`, 445 trials each)

| | Mixdog | Codex CLI | |
| --- | --- | --- | --- |
| **Total tokens** (incl. cached input) | **156.5M** | 421.4M | **63% fewer** |
| Success rate | **86.5%** (385/445) | 86.1% (383/445) | +2 trials |
| Pass@5 | **96.6%** | 95.5% | |
| Priced cost per trial | **$0.476** | $0.782 | 39% lower |
| Median final context | **18.5k** | 34.3k | 46% smaller |
| Wall time per trial | **415s** | 437s | matched |

![Terminal-Bench 2.1: Mixdog with GPT-5.6 Sol xhigh versus Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

### Claude Opus 5 — Mixdog vs Claude Code (`k=1`, 89 trials each)

| | Mixdog | Claude Code | |
| --- | --- | --- | --- |
| Solved | **79/89** | 77/89 | +2 tasks |
| Priced cost per run | **$104.29** | $129.21 | 19% lower |
| Median final context | **27.6k** | 38.2k | 28% smaller |
| Wall time per trial | **610s** | 708s | 1.16× faster |

![Terminal-Bench 2.1: Mixdog with Claude Opus 5 versus Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

<sub>Official Harbor verifier, fast mode off, no retries of task failures or
agent timeouts. Mixdog runs are single-model, single-session — no sub-agents
or helper models. Cost values both sides at the same API list rates, not
subscription charges. Results measure the pinned source revision. Raw
verdicts, verifier output, usage snapshots, and the scripts that recompute
every number are in [`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/).</sub>

## Why Mixdog

- **All your models in one app.** Use supported subscription accounts, API
  keys, or the built-in Local Provider side by side.
- **Agents by role.** Assign a different model to each agent role and combine
  them through orchestration — from **Solo** (the lead does the work) up to
  **Swarm** (maximum delegation). Run separate sessions in parallel, too.
- **Easy to set up.** Onboarding walks you through connecting providers,
  choosing models, and setting up workflows. Workflows and agents are
  Markdown packs (`WORKFLOW.md`, `AGENT.md`) with visual editors in the app.
- **Lean context.** Scoped tools, provider-aware caching, and structured
  compaction keep prompts small. Search past work and keep project memory
  without loading the whole archive. See
  [Context efficiency](docs/context-efficiency.md).
- **See where tokens go.** Usage stats by provider and model — input, output,
  cache hits, and cost — plus supported providers' quota windows and resets.

## Beyond code

- **Workspace** — tabs and split panes, Monaco editor, Git and GitHub,
  terminals, file explorer, code graph, and Code Tidy in one window.
- **Browser Use** — operate signed-in Chromium pages, with Chrome profile
  import on Windows.
- **Computer Use (Windows)** — operate native apps with guarded input and an
  on-screen Stop control.
- **Documents** — Word, Excel, PowerPoint, and PDF with rendered previews.
- **Image and video Studio** — generate and edit with a local gallery.
- **Continue anywhere** — pick up the same live session from Desktop, the
  terminal, or a paired browser on your computer or phone over end-to-end
  encryption.

Browser Use and Computer Use are opt-in and ask for approval before their
first live call in each interactive session.

## Providers

- Anthropic API keys and Claude account OAuth
- OpenAI API keys and ChatGPT/Codex account OAuth
- Google Gemini API keys
- xAI API keys and Grok account OAuth
- OpenRouter, DeepSeek, and OpenCode Go
- Built-in **Local Provider** — download and run models in the app
  (Windows x64 with an NVIDIA GPU)

Cursor and Antigravity (Gemini) OAuth are off by default under
**Settings → Developer**; using them through OAuth risks account restrictions.

## Get started

### Desktop (Windows)

[Download the installer](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe)
and follow onboarding.

### CLI

Requires Node.js 22.19+ (22.x) or 24+.

```bash
npm install -g mixdog
mixdog
```

<details>
<summary><b>CLI options and headless exec</b></summary>

```bash
mixdog                                   # start in the current project
mixdog --provider anthropic-oauth --model claude-haiku-4-5-20251001
mixdog --workflow default
mixdog --readonly                        # read-only tools
mixdog --remote                          # enable remote mode
mixdog --onboarding                      # run onboarding again
```

`mixdog exec` runs one non-interactive, single-model session without personal
memory, prior sessions, skills, MCP servers, or plugins:

```bash
mixdog exec --provider openai-oauth --model gpt-5.6-sol --effort xhigh "fix the failing test"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --json "review the current diff"
```

Web search is off by default (`--web-search` enables it). This does not block
shell networking — headless exec is not an offline sandbox.

Run `mixdog --help` for the full reference.

</details>

<details>
<summary><b>TUI commands</b></summary>

```text
/clear        start a fresh chat
/project      switch the current project
/resume       resume a saved chat
/inherit      carry this conversation into a new session on the current model
/compact      compact older conversation context
/goal         start, inspect, pause, or resume a durable session Goal
/autoclear    manage idle-time context compaction
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

</details>

## Docs

- [Context efficiency](docs/context-efficiency.md)
- [Code Tidy](docs/code-tidy.md)
- [Git & GitHub](docs/git-github-integration.md)
- [Language servers](docs/language-servers.md)
- [Office runtime](src/runtime/office/README.md)
- [Development, configuration, and testing](docs/development.md)

## License

Mixdog is licensed under [Apache-2.0](LICENSE).
Third-party components retain their respective licenses; see [NOTICE.md](NOTICE.md).
