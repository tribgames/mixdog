# NOTICE

Mixdog itself is MIT-licensed (see `LICENSE`). Parts of it were written
against the public source of the projects listed below. Their terms are
preserved here in one place so the individual source files can stay free of
scattered attribution comments.

Full license texts live in `LICENSES/`:

- `LICENSES/MIT.txt` — the MIT permission notice with every covered copyright
  holder.
- `LICENSES/Apache-2.0.txt` — the Apache License 2.0.
- `LICENSES/codex-NOTICE.txt` — the upstream NOTICE file of the Codex CLI,
  carried forward as Apache-2.0 section 4(d) requires.

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

### GitHub Pull Requests extension — Copyright (c) Microsoft Corporation

<https://github.com/microsoft/vscode-pull-request-github>

The default pull-request query set and its category labels in
`apps/desktop/src/main/gh-cli.ts`.

### Seti UI — Copyright (c) 2014 Jesse Weed

Bundled glyphs and colour tables. Full license text in
`apps/desktop/THIRD-PARTY-NOTICES.txt`.

### Files — Copyright (c) Files Community

<https://github.com/files-community/Files>

Folder-pane grouping keys, date-span labels, size buckets and the discrete
layout size ladder in `apps/desktop/src/renderer/FolderPane.lazy.tsx`.

### OpenCode — Copyright (c) Anomaly / SST

<https://github.com/anomalyco/opencode>

Transcript auto-scroll gesture grammar, virtual-timeline anchoring and the
streaming-markdown projection model.

- `apps/desktop/src/renderer/use-transcript-follow.ts`, `TranscriptList.tsx`,
  `transcript-measure.ts`, `transcript-rows.ts`, `transcript-virtual-cache.ts`,
  `StreamingMarkdownBody.tsx`, `streaming-markdown.ts`, `Conversation.tsx`

### pi — Copyright (c) 2025 Mario Zechner

<https://github.com/earendil-works/pi>

`trimPartialClosingFences()` in `src/tui/markdown/stream-fence.mjs`, ported
from the TUI markdown component.

### Orca — Copyright (c) 2026 Lovecast Inc.

Editor-surface and tab-hierarchy structure, the terminal host portal, the
keep-awake power-save blocker and the hosted-review link derivation.

- `apps/desktop/src/renderer/EditorPane.lazy.tsx`, `PaneSurfaceGate.tsx`,
  `PullRequestsPane.tsx`, `SourceControlDock.tsx`
- `apps/desktop/src/main/agent-awake.ts`

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
