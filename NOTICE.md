# NOTICE

Mixdog
Copyright (c) 2026 tribgames

Mixdog itself is licensed under Apache-2.0 (see `LICENSE`). The sections below cover the
third-party code and data that Mixdog actually carries, kept here in one place
so the individual source files stay free of scattered attribution comments.

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
- `LICENSES/browser-import-NOTICE.txt` — source and license boundary for the
  optional GPL Chrome password import sidecar.
- Tidy engine license texts listed in the Tidy engines section below.

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

### Octicons — Copyright (c) GitHub, Inc.

<https://github.com/primer/octicons>

The five changed-file status glyphs in
`apps/desktop/src/renderer/ScmStatusIcon.tsx` carry Octicons 16px path data
unmodified: `diffAdded`, `diffModified`, `diffRemoved`, `diffRenamed` and
`alert`.

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

Installed from Mixdog's patched Ink runtime release asset. The package retains
the upstream MIT license.

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

## GPL-3.0-only

### Chrome password import sidecar

The Windows password importer is a separate process built from the
pinned source and Mixdog wrapper recorded in
`LICENSES/browser-import-NOTICE.txt`. It is not linked into the Apache-2.0 desktop
application. Its complete GPL text ships beside the two native executables.

## Tidy engines

Optional managed downloads for the tidy tool (`src/runtime/tidy/`). They are
not compiled into Mixdog. Redistributable engines may be mirrored to this
repository's GitHub releases; GPL binaries are never attached to that mirror.

### biome 2.5.13 — MIT

<https://github.com/biomejs/biome>

Full license text: `LICENSES/biome-MIT.txt`

### ruff 0.16.7 — MIT

<https://github.com/astral-sh/ruff>

Full license text: `LICENSES/ruff-MIT.txt`

### clang-format 20.0.0 — Apache-2.0 WITH LLVM-exception

<https://clang.llvm.org/docs/ClangFormat.html>

Binaries come from `muttleyxd/clang-tools-static-binaries` (`clang-format-20`).
The npm `clang-format` 1.8.0 tarball only ships win32, linux_x64, and
darwin_x64, so it is not used. linux-arm64 is omitted because neither npm nor
muttleyxd publishes that asset. Full license text:
`LICENSES/clang-format-Apache-2.0-WITH-LLVM-exception.txt`

### shfmt 3.14.1 — BSD-3-Clause

<https://github.com/mvdan/sh>

Full license text: `LICENSES/shfmt-BSD-3-Clause.txt`

### shellcheck 0.11.0 — GPL-3.0

<https://github.com/koalaman/shellcheck>

Downloaded from upstream, not redistributed.

### stylua 2.5.2 — MPL-2.0

<https://github.com/JohnnyMorganz/StyLua>

Full license text: `LICENSES/stylua-MPL-2.0.txt`

### gofumpt 0.12.0 — BSD-3-Clause

<https://github.com/mvdan/gofumpt>

Full license text: `LICENSES/gofumpt-BSD-3-Clause.txt`

### dprint 0.57.4 — MIT

<https://github.com/dprint/dprint>

Full license text: `LICENSES/dprint-MIT.txt`

### ast-grep 0.45.3 — MIT

<https://github.com/ast-grep/ast-grep>

Embedded in the `mixdog-graph` native binary as the Rust crates
`ast-grep-core`, `ast-grep-config`, `ast-grep-language` and
`ast-grep-outline` 0.45.3; the `ast-grep` CLI is never downloaded or
redistributed.

Full license text: `LICENSES/ast-grep-MIT.txt`

### mago 1.48.1 — MIT

<https://github.com/carthage-software/mago>

Full license text: `LICENSES/mago-MIT.txt`

### air 0.11.0 — MIT

<https://github.com/posit-dev/air>

Full license text: `LICENSES/air-MIT.txt`
