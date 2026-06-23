# mixdog-cli

Standalone coding-agent CLI/TUI workspace for turning **mixdog** into a [pi](https://github.com/badlogic/pi-mono)-based terminal app.

An Ink (React) terminal UI front-end driving multi-provider LLM agents (Anthropic, OpenAI, Google) over MCP, with a forked Ink renderer (`vendor/ink`) for full-screen alt-screen rendering, cursor handling, and scroll support.

## Requirements

- Node.js >= 22

## Setup

```bash
npm install
```

## Usage

```bash
# Run the CLI
npm start

# Build the Ink (React) TUI bundle
npm run build:tui

# Smoke test
npm run smoke

# Sync runtime
npm run sync
```

## Project layout

```
src/
  cli.mjs        # entry point (bin: mixdog-cli)
  app.mjs        # app wiring
  repl.mjs       # REPL loop
  runtime/       # agent runtime
  tui/           # canonical Ink (React) TUI (bundled to dist/)
  tui-pi/        # legacy pi-tui fallback implementation (not an entry route)
  lib/ ui/ hooks/ defaults/ vendor/
scripts/
  build-tui.mjs  # esbuild bundle of the React TUI
  patch-ink.mjs  # reapply vendor ink patches to node_modules
  smoke.mjs      # smoke test
  sync-runtime.mjs
vendor/
  ink/           # forked Ink renderer (alt-screen / cursor / scroll fixes)
  pi/            # pi monorepo packages
```

## Notes

- `vendor/ink` is a forked Ink build; `scripts/patch-ink.mjs` reapplies the fork to `node_modules/ink` at build time so `npm install`/sync won't clobber it.
- The TUI uses alt-screen mode with mouse-wheel scroll tracking.
