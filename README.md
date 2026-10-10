<p align="center">
  <img src="https://raw.githubusercontent.com/tribgames/mixdog/main/apps/desktop/build/mixdog.png" width="80" alt="Mixdog">
</p>

<h1 align="center">Mixdog</h1>

<p align="center">
  The open-source coding agent that uses 63% fewer tokens.
</p>

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe"><img src="https://raw.githubusercontent.com/tribgames/mixdog/main/docs/assets/download-windows.svg" alt="Download for Windows" height="48"></a>
  &nbsp;
  <a href="https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-mac-arm64.dmg"><img src="https://raw.githubusercontent.com/tribgames/mixdog/main/docs/assets/download-macos.svg" alt="Download for macOS" height="48"></a>
</p>

<p align="center">
  <a href="https://github.com/tribgames/mixdog/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/tribgames/mixdog?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/mixdog"><img alt="npm" src="https://img.shields.io/npm/v/mixdog?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://aiscroll.io/mixdog/"><b>Website</b></a> ·
  <a href="benchmarks/terminal-bench-2.1/"><b>Benchmarks</b></a> ·
  <a href="#documentation"><b>Docs</b></a>
</p>

https://github.com/user-attachments/assets/af515dc9-b0fb-4b6a-aaa1-1d82db792ed0

## Highlights

- [63% fewer tokens](#benchmarks) than Codex CLI on the same model, at the
  same success rate.
- **Auto reasoning effort** — each message and tool step gets the effort it
  needs. On by default.
- Use the **Claude, ChatGPT, or Grok** subscription you already have, API
  keys, or local models on your own GPU.
- Mix models by role and scale from **Solo to Swarm** — a strong model leads
  while cheaper ones search, edit, and review in parallel.
- A full workspace: editor, terminals, Git and GitHub, code graph, and
  language servers.
- Keeps working on its own with **Goals, schedules, and webhooks** — and
  continues from your phone, end-to-end encrypted.
- Goes beyond code with **browser and desktop control**, Office and PDF
  documents, and image and video generation.
- Runs on Windows and macOS. No config files.

## Installation

Download the desktop app:

| Platform | Download |
| --- | --- |
| Windows (x64) | [`mixdog-desktop-win-x64.exe`](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe) |
| macOS (Apple Silicon) | [`mixdog-desktop-mac-arm64.dmg`](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-mac-arm64.dmg) |

Then sign in with a ChatGPT, Claude, or Grok account, or paste an API key. A
five-step tutorial walks you through the rest.

> [!NOTE]
> The Windows installer is not code-signed yet. If SmartScreen appears,
> choose **More info → Run anyway**. The Mac app is signed and notarized.

Or run it in the terminal (Node.js 22.19+ or 24+):

```bash
npm install -g mixdog
mixdog
```

<details>
<summary>Supported providers</summary>

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
<summary>Headless <code>mixdog exec</code></summary>

`mixdog exec` runs one non-interactive, single-model session without personal
memory, prior sessions, skills, MCP servers, or plugins:

```bash
mixdog exec --provider openai-oauth --model gpt-5.6-sol --effort xhigh "fix the failing test"
```

Web search is off by default (`--web-search` enables it). This does not block
shell networking — headless exec is not an offline sandbox. Run
`mixdog --help` for the full reference.

</details>

## Benchmarks

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex-light.svg">
    <img alt="Bar chart: Mixdog vs Codex CLI on Terminal-Bench 2.1" src="https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex-light.svg">
  </picture>
</p>

<p align="center">
  <i>All 89 Terminal-Bench 2.1 tasks × 5 trials on GPT-5.6 Sol xhigh, scored by the official Harbor verifier.</i>
</p>

Mixdog used fewer tokens on 87 of 89 tasks. With Claude Opus 5, it solved 2
more tasks than Claude Code at 19% lower cost. Every verdict, log, and script
is published in [`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/),
and [Context efficiency](docs/context-efficiency.md) explains where the
savings come from.

## Documentation

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

Mixdog is licensed under [Apache-2.0](LICENSE). Third-party components retain
their respective licenses; see [NOTICE.md](NOTICE.md).
