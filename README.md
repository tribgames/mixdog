<p align="center">
  <img src="https://raw.githubusercontent.com/tribgames/mixdog/main/apps/desktop/build/mixdog.png" alt="" width="96">
</p>

<h1 align="center">Mixdog</h1>

<p align="center">
  <b>Same model. Same performance. 63% fewer tokens.</b><br>
  Free, open-source desktop coding agent for Windows.
</p>

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe">
    <img src="https://raw.githubusercontent.com/tribgames/mixdog/main/docs/assets/download-windows.svg" alt="Download Mixdog for Windows x64" width="320">
  </a>
</p>

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest"><img src="https://img.shields.io/github/v/release/tribgames/mixdog?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" alt="Windows x64">
</p>

<p align="center">
  <sub>The installer is not code-signed yet. If Windows SmartScreen appears,
  choose <b>More info → Run anyway</b>.</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/tribgames/mixdog/main/docs/assets/desktop.png" alt="Mixdog Desktop" width="860">
</p>

<a name="benchmarks"></a>
## Same performance, 63% fewer tokens

Mixdog and Codex CLI ran Terminal-Bench 2.1 on the same model, GPT-5.6 Sol
xhigh. Both passed the same share of tasks. Mixdog used 63% fewer tokens.

| | Mixdog | Codex CLI | |
| --- | --- | --- | --- |
| **Total tokens** (incl. cached input) | **156.5M** | 421.4M | **63% fewer** |
| Success rate | **86.5%** (385/445) | 86.1% (383/445) | matched |
| Priced cost per trial | **$0.476** | $0.782 | 39% lower |
| Median first request | **4.7k** | 14.4k | 67% smaller |
| Median final context | **18.5k** | 34.3k | 46% smaller |
| Wall time per trial | **415s** | 437s | matched |

![Terminal-Bench 2.1: Mixdog with GPT-5.6 Sol xhigh versus Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- **The official leaderboard protocol.** All 89 tasks, five trials each — 445
  trials per side — with unmodified task timeouts and resources, scored by the
  official Harbor verifier.
- **Same conditions on both sides.** Same model and reasoning level, the same
  kind of subscription sign-in, fast mode off, no retries of task failures or
  agent timeouts.
- **Everything is published.** Verdicts, verifier output, and usage snapshots
  for both sides, plus the scripts that recompute every number, are in
  [`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/).

### Across the 89 tasks

Mixdog used fewer tokens on 87 of the 89 tasks. The median task used 68% fewer.

| Token change | Tasks |
| --- | --- |
| 75% fewer or better | 24 |
| 50–75% fewer | 42 |
| 25–50% fewer | 19 |
| 0–25% fewer | 2 |
| More tokens | 2 |

Pass counts were equal on 60 tasks; Mixdog passed more trials on 14 and Codex
CLI on 15. Mixdog used more tokens on `mteb-leaderboard` (6.8×) and
`crack-7z-hash` (1.4×). Every task is listed in
[`results.md`](benchmarks/terminal-bench-2.1/results.md).

<details>
<summary><b>Claude Opus 5 — Mixdog vs Claude Code</b> (single pass, 89 trials each)</summary>

| | Mixdog | Claude Code | |
| --- | --- | --- | --- |
| Solved | **79/89** | 77/89 | +2 tasks |
| Priced cost per run | **$104.29** | $129.21 | 19% lower |
| Median final context | **27.6k** | 38.2k | 28% smaller |
| Wall time per trial | **610s** | 708s | 1.16× faster |

![Terminal-Bench 2.1: Mixdog with Claude Opus 5 versus Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

One trial per task, so per-task differences sit within run-to-run variance.

</details>

<sub>Codex CLI 0.151.0. Mixdog ran single-model, single-session — no
sub-agents or helper models. Cost values both sides at the same API list
rates, not subscription charges. Results measure the pinned source revision.
The leaderboard is not accepting community submissions, so the runs are
published here instead.</sub>

## How it uses fewer tokens

- **A light start.** System instructions and tool descriptions are kept to
  what the model needs.
  *67% smaller first request — 4.7k tokens against 14.4k.*
- **Fewer round trips.** The agent picks the right tool first and runs
  independent actions in one batch.
  *33% fewer model requests — a median of 10 per trial against 16.*
- **Smaller requests.** Tools return only the part that was asked for, and
  95% of terminal output is filtered before it reaches the model.
  *46% less input per request — 24.3k tokens against 44.9k.*
- **Shorter output.** Less filler and repetition in replies.
  *8% fewer output tokens.*

The benchmark ran one model in one session. In everyday use, more applies on
top of that:

- **Auto-clear.** After a long break, the conversation is compacted before
  work resumes.
- **Light compaction.** Long sessions continue from a structured handoff
  instead of the full history.
- **Database memory.** Past work is stored and searched, so the prompt does
  not grow with the archive.
- **Code graph.** Query a project's structure instead of reading whole files.
- **Orchestration.** Hand routine work to cheaper models and keep the
  expensive one for the steps that need it.

See [Context efficiency](docs/context-efficiency.md) for how each layer works.

## A model for each job

Not every step needs your most expensive model.

- **Mix models by role.** Let a strong model lead and plan while cheaper ones
  search, edit, and review.
- **Dial delegation from Solo to Swarm.** The lead can do the work itself or
  coordinate a team of agents working in parallel.
- **Workflows you can read.** Workflows and agents are plain Markdown
  (`WORKFLOW.md`, `AGENT.md`) with visual editors in the app.
- **Every account in one place.** Claude, ChatGPT, and Grok subscriptions, API
  keys, and local models side by side.
- **Run models on your own GPU.** The built-in Local Provider downloads and
  runs models inside the app.
- **Know what it costs.** Usage by provider and model — input, output, cache
  hits, and cost — plus quota windows and resets.

## Everything in one window

- **A full workspace.** Tabs and split panes, Monaco editor, terminals, file
  explorer, and language servers that start when you open a file.
- **Git and GitHub built in.** Review changes, commit, and handle pull
  requests, issues, Actions, and releases without leaving the app.
- **Code that stays clean.** The code graph maps a project's structure, and
  Code Tidy formats, lints, and applies structural fixes.
- **Memory that lasts.** Mixdog remembers what matters across sessions and
  searches past work on demand.
- **Extend it.** Add skills, MCP servers, and plugins from one Extensions view.

## It keeps working when you step away

- **Goals.** Set a Goal and the session keeps working toward it — pause and
  resume whenever you like.
- **Schedules and webhooks.** Run a task on a timer or whenever a URL is
  called.
- **Your phone is the remote.** Scan a QR code to continue the same live
  session from your phone, end-to-end encrypted, with a notification when the
  task finishes.

## Beyond code

- **Browser Use.** Operate real, signed-in web pages, with Chrome profile
  import.
- **Computer Use.** Operate native Windows apps with guarded input and an
  on-screen Stop control.
- **Documents.** Create and edit Word, Excel, PowerPoint, and PDF with
  rendered previews.
- **Image and video Studio.** Generate and edit with a local gallery.

Browser Use and Computer Use are opt-in and ask for approval before their
first live call in each session.

## Get started

[Download the installer](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe)
and sign in. No config files, no YAML, no terminal.

- **One sign-in and you are working.** Use the ChatGPT, Claude, or Grok
  subscription you already pay for, or paste an API key. Mixdog picks the
  model for you.
- **Advanced setups, one switch each.** A team of agents, a model per role,
  long-term memory, phone access — each is a toggle, not a config file.
- **You won't get lost.** A short tutorial gets you set up in five quick
  steps.
- **Batteries included.** Git, Memory, Browser, and Office tools ship with the
  app. Turn on what you need.

<details>
<summary><b>Supported providers</b></summary>

- Anthropic API keys and Claude account OAuth
- OpenAI API keys and ChatGPT/Codex account OAuth
- Google Gemini API keys
- xAI API keys and Grok account OAuth
- OpenRouter, DeepSeek, and OpenCode Go
- Built-in **Local Provider** — download and run models in the app
  (Windows x64 with an NVIDIA GPU)

Cursor and Antigravity (Gemini) OAuth are off by default under
**Settings → Developer**; using them through OAuth risks account restrictions.

</details>

<details>
<summary><b>Command line</b></summary>

Mixdog also runs in the terminal. Requires Node.js 22.19+ (22.x) or 24+.

```bash
npm install -g mixdog
mixdog
```

`mixdog exec` runs one non-interactive, single-model session without personal
memory, prior sessions, skills, MCP servers, or plugins:

```bash
mixdog exec --provider openai-oauth --model gpt-5.6-sol --effort xhigh "fix the failing test"
```

Web search is off by default (`--web-search` enables it). This does not block
shell networking — headless exec is not an offline sandbox.

Run `mixdog --help` for the full reference.

</details>

## Docs

- [Context efficiency](docs/context-efficiency.md)
- [Benchmarks](benchmarks/terminal-bench-2.1/)
- [Code Tidy](docs/code-tidy.md)
- [Git & GitHub](docs/git-github-integration.md)
- [Language servers](docs/language-servers.md)
- [Office runtime](src/runtime/office/README.md)
- [Development, configuration, and testing](docs/development.md)

## Feedback

Found a bug or missing a feature?
[Open an issue](https://github.com/tribgames/mixdog/issues). If Mixdog saves
you tokens, a star helps others find it.

## License

Mixdog is licensed under [Apache-2.0](LICENSE).
Third-party components retain their respective licenses; see [NOTICE.md](NOTICE.md).
