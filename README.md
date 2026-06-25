# mixdog

Standalone coding-agent CLI/TUI workspace for **mixdog**.

An Ink (React) terminal UI front-end driving multi-provider LLM agents (Anthropic, OpenAI, Google) over MCP, with Mixdog's Ink renderer (`vendor/ink`) for full-screen alt-screen rendering, cursor handling, and scroll support.

## Requirements

- Node.js >= 22

## Setup

```bash
npm install
```

To install the CLI globally from this checkout:

```bash
npm install -g .
mixdog --help
```

## Usage

```bash
# Run the CLI from any project directory
mixdog

# Build the Ink (React) TUI bundle
npm run build:tui

# Smoke test
npm run smoke

```

## Project layout

```
src/
  cli.mjs        # entry point (bin: mixdog)
  app.mjs        # app wiring
  repl.mjs       # REPL loop
  runtime/       # agent runtime
  tui/           # canonical Ink (React) TUI (bundled to dist/)
  lib/ ui/ hooks/ defaults/ vendor/
scripts/
  build-tui.mjs  # esbuild bundle of the React TUI
  smoke.mjs      # smoke test
vendor/
  ink/           # Mixdog Ink renderer (alt-screen / cursor / scroll fixes)
```

## Notes

- `vendor/ink` is bundled directly into the TUI dist; the build does not rewrite installed dependencies.
- Standalone Mixdog uses `~/.mixdog` as its home root, matching Claude Code's `~/.claude` style. Runtime data lives in `~/.mixdog/data` by default. Set `MIXDOG_HOME` to move the root, or `MIXDOG_DATA_DIR` to override only the data directory.
- Pi/Codex/OpenCode reference snapshots live outside this package under `C:\Project\refs`.
- The TUI uses alt-screen mode with mouse-wheel scroll tracking.
