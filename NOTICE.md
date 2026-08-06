# NOTICE

Mixdog itself is MIT-licensed (see `LICENSE`). Parts of it were written
against the public source of the projects listed below. Their terms are
preserved here in one place so the individual source files can stay free of
scattered attribution comments.

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

### Ink — Copyright (c) Vadim Demedes

Distributed under its own license.

## Apache License 2.0

### OpenAI Codex CLI — Copyright (c) OpenAI

<https://github.com/openai/codex>

The V4A `apply_patch` grammar with its seek/replacement semantics.

- `src/runtime/agent/orchestrator/tools/patch/`
- `native/mixdog-patch/`

### AiderDesk — Copyright (c) Hotovo

<https://github.com/hotovo/aider-desk>

electron-vite configuration structure in
`apps/desktop/electron.vite.config.ts`.

The Apache-2.0 terms require this notice to travel with any redistribution of
the derived files. Full license text:
<https://www.apache.org/licenses/LICENSE-2.0>.
