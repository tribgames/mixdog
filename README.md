# mixdog

Mixdog is a standalone coding-agent CLI/TUI workspace for developers who want
one terminal experience across multiple LLM providers.

It combines an Ink-based terminal UI, a multi-provider runtime, workflow agents,
MCP/plugin/skill loading, memory, web search, channel integrations, and focused
repo tools for reading, editing, testing, and reviewing code.

## Highlights

- Multi-provider model routing for Anthropic, OpenAI-compatible APIs, Google,
  XAI/Grok, OAuth-backed providers, and local endpoints.
- Full-screen TUI with slash commands, model/workflow pickers, provider setup,
  usage dashboards, tool cards, statusline integration, and resumable sessions.
- Agent task delegation through the `agent` tool and `/agent` command.
- Focused repo tools for `read`, `grep`, `glob`, `list`, `code_graph`,
  `apply_patch`, `shell`, `cwd`, `explore`, web search, and memory recall.
- Workflow agents for implementation, review, debugging, maintenance, web
  research, and heavier model routes.
- Optional Discord/channel/webhook/schedule integrations for remote or event
  driven workflows.

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
# Run the TUI from any project directory
mixdog

# Run the basic smoke test
npm run smoke

# Run the core smoke suite
npm run smoke:all
```

Inside the TUI, use `/providers` to configure model access, `/model` to switch
models, `/workflow` to select a workflow, `/agents` to inspect available
workflow agents, and `/agent` to manage active agent tasks.

## Documentation

- [Feature Map](docs/features.md)
- [Agent Tasks](docs/agent-tasks.md)

## Project Layout

```text
src/
  cli.mjs        # CLI entry point (bin: mixdog)
  app.mjs        # app wiring
  repl.mjs       # plain REPL loop
  runtime/       # provider runtime, tools, memory, channels
  tui/           # canonical Ink TUI (bundled to dist/)
  agents/        # workflow agent definitions
  rules/         # Lead and agent instructions
scripts/
  smoke*.mjs     # smoke checks
  build-tui.mjs  # esbuild bundle for the React TUI
vendor/
  ink/           # Mixdog Ink renderer
```

## Data And Configuration

Standalone Mixdog uses `~/.mixdog` as its home root. Runtime data lives in
`~/.mixdog/data` by default. Set `MIXDOG_HOME` to move the root, or
`MIXDOG_DATA_DIR` to override only the data directory.

The TUI uses alt-screen mode and app-owned mouse wheel scrolling / drag
selection by default. Set `MIXDOG_TUI_MOUSE=0` to opt into terminal-native mouse
behavior.
