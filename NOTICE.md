# NOTICE

Mixdog itself is MIT-licensed (see `LICENSE`). The license sections below
cover third-party code and data that Mixdog actually carries. The closing
"Behavioral references" section records projects that only informed the
implementation, with no code taken. Everything is kept here in one place so
the individual source files stay free of scattered attribution comments.

Full license texts live in `LICENSES/`:

- `LICENSES/MIT.txt` — the MIT permission notice with every covered copyright
  holder.
- `LICENSES/Apache-2.0.txt` — the Apache License 2.0.
- `LICENSES/codex-NOTICE.txt` — the upstream NOTICE file of the Codex CLI,
  carried forward as Apache-2.0 section 4(d) requires.
- `LICENSES/ripgrep-NOTICE.txt` — the ripgrep notice for the search crates
  compiled into the native binaries.
- `LICENSES/editor-assets-NOTICE.txt` — the editor icon and language-data
  notice referenced by the generated files.

## MIT

### Visual Studio Code — Copyright (c) Microsoft Corporation

<https://github.com/microsoft/vscode>

Explorer name-validation and sort grammar, editor/terminal defaults, the Seti
icon-theme resolution rules, shell-profile detection, and the built-in
language contributions used to generate the Monaco pane languages.

- `apps/desktop/src/renderer/explorer-logic.ts`, `ExplorerTree.tsx`,
  `editor-ansi.ts`, `file-icons.tsx`, `seti-icons.ts`
- `apps/desktop/src/shared/editor-languages.ts`
- `apps/desktop/src/main/shell-profiles.ts`
- `apps/desktop/scripts/generate-seti-icons.mjs`,
  `apps/desktop/scripts/generate-editor-languages.mjs`

`explorer-logic.ts` reuses the Explorer validation messages verbatim,
`editor-ansi.ts` the terminal ANSI palette values, and `seti-icons.ts` /
`editor-languages.ts` are generated from the shipped extension data.

### Visual Studio Code Codicons — Copyright (c) Microsoft Corporation

<https://github.com/microsoft/vscode-codicons>

The chrome-level UI glyph font used by the desktop and web renderer. The code
is MIT; the icons themselves are licensed under Creative Commons Attribution
4.0 International (CC BY 4.0).

### GitHub Pull Requests extension — Copyright (c) Microsoft Corporation

<https://github.com/microsoft/vscode-pull-request-github>

The default pull-request query set and its category labels in
`apps/desktop/src/main/gh-cli.ts`.

### Seti UI — Copyright (c) 2014 Jesse Weed

Bundled glyphs and colour tables. Full license text in
`apps/desktop/THIRD-PARTY-NOTICES.txt`.

### ripgrep — Copyright (c) 2015 Andrew Gallant

<https://github.com/BurntSushi/ripgrep>

The `grep` and `ignore` library crates are compiled into the native search
binary, and the packaged `rg` executable ships as the grep tool's fast path.
ripgrep is offered under the MIT License OR the Unlicense; Mixdog takes the
MIT terms. The upstream notice is preserved as `LICENSES/ripgrep-NOTICE.txt`.

- `native/mixdog-graph/` (the `grep` and `ignore` crates)
- `src/runtime/agent/orchestrator/tools/builtin/` (the `rg` fast path)

### Ink — Copyright (c) Vadim Demedes

Distributed under its own license.

## Apache License 2.0

### OpenAI Codex CLI — Copyright (c) OpenAI

<https://github.com/openai/codex>

The V4A `apply_patch` Lark grammar, reproduced verbatim from
`codex-rs/core/src/tools/handlers/apply_patch.lark` in
`src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs`, together with the
seek/replacement semantics of the patch engine.

- `src/runtime/agent/orchestrator/tools/patch/`
- `native/mixdog-patch/`

Statement of changes (Apache-2.0 section 4(b)): the Lark grammar is carried
unmodified. The patch engine under the two paths above is an independent
implementation in JavaScript and Rust that follows the same seek and
replacement semantics; it is not a copy of the upstream Rust sources. The
upstream NOTICE file is preserved as `LICENSES/codex-NOTICE.txt`.

The Apache-2.0 terms require this notice to travel with any redistribution of
the derived files. Full license text: `LICENSES/Apache-2.0.txt`
(<https://www.apache.org/licenses/LICENSE-2.0>).

## Behavioral references

The projects below informed Mixdog through publicly observable behavior, a
published wire contract, or a documented algorithm. No source code from them
is present in Mixdog, so no license obligation travels with the result; they
are recorded here because the source files themselves carry no attribution
comments.

- **Chromium** — the workspace tab strip follows Chromium's tab-strip layout
  semantics: two layout domains around the crossover width, the active-tab
  floor, the inactive sliver floor, the left-to-right remainder grant and the
  icon visibility ladder. The implementation is independent TypeScript and CSS
  on Mixdog's own constants (`apps/desktop/src/renderer/WorkspaceTabStrip.tsx`,
  `apps/desktop/src/renderer/desktop/04-workspace-tabs.css`).
- **GitHub Desktop** — the Source Control dock grammar: commit-form layout,
  changed-file status glyph semantics, single-sentence path colouring, history
  context-menu gating, and detached-checkout / tag rules. Painted entirely on
  Mixdog's own semantic tokens.
- **OpenCode** — transcript auto-scroll gesture grammar, virtual-timeline
  anchoring and the streaming-markdown projection model.
- **Orca** — editor-surface and tab-hierarchy structure, the terminal host
  portal, the keep-awake power-save blocker and the hosted-review link
  derivation.
- **Files** — the folder pane's grouping keys, date-span labels, size buckets
  and discrete layout size ladder
  (`apps/desktop/src/renderer/FolderPane.lazy.tsx`).
- **Claude Code** (Anthropic) — terminal input tokenizing and keypress
  parsing, the TUI selection word model in `node_modules/ink`, and interactive turn
  semantics such as queued-message recall, message-selector rewind and
  background-task lifetime. The Anthropic OAuth route additionally sends the
  client identity that Anthropic's token edge validates; those values are a
  wire requirement, not a derivation.
- **opencode-antigravity-auth** — MIT
  (<https://github.com/NoeFabris/opencode-antigravity-auth>). The Google Cloud
  Code Assist wire contract used by the Antigravity OAuth provider: OAuth
  client parameters, endpoint fallback order, client impersonation headers,
  request envelope and thinking-signature handling.
- **assistant-ui, Chatbox, Cherry Studio, Jan, Zed** — the heading-size and
  list-density survey behind the desktop markdown ladder in
  `apps/desktop/src/renderer/desktop/22-markdown.css`.
