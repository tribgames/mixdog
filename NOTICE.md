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
- `LICENSES/simple-icons-CC0-1.0.txt` — the CC0 1.0 dedication of the Simple
  Icons brand marks used for connectors.
- `LICENSES/rust-crates-NOTICE.txt` — every Rust crate in the dependency
  closure of the native binaries with its version, licence expression and
  copyright lines, followed by the licence texts those crates carry beyond MIT
  and Apache-2.0 (see the Rust crates section below).
- `LICENSES/libvpx-BSD-3-Clause.txt` — the libvpx licence and patent grant
  for the prebuilt libvpx linked into the native binaries.
- Texts for the code ported or embedded in the Rust core, named in the Ported
  and embedded works section below (`pdfium-*`, `adobe-cmap-*`, `openjpeg-*`,
  `liberation-fonts-*`, `skia-*`, `highlight.js-*`, `cli-highlight-*`,
  `marked-*`, `v8-*`, `fdlibm-*`, `icu-*`, `formulajs-*`, `jstat-*`, `bessel-*`,
  `unicode-script-*`), plus `freetype-FTL.txt` and `libjpeg-IJG.txt`.
- Tidy engine license texts listed in the Tidy engines section below.

## MIT

### Visual Studio Code — Copyright (c) Microsoft Corporation

<https://github.com/microsoft/vscode>

Explorer name-validation and sort grammar, editor/terminal defaults, the Seti
icon-theme resolution rules, shell-profile detection, and the built-in
language contributions used to generate the Monaco pane languages.

- `apps/desktop/src/renderer/explorer-logic.ts`, `ExplorerTree.tsx`,
  `editor-ansi.ts`, `seti-icons.ts`
- `apps/desktop/src/shared/editor-languages.ts`
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
`native/core/crates/mixdog-scm/src/gh/pr.rs`.

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

### fancy-regex 0.19.2 — Copyright 2015 The Fancy Regex Authors

<https://github.com/fancy-regex/fancy-regex>

The crate is vendored and compiled into the Rust core, where it matches the
`pattern` keywords of MCP tools' output schemas. The upstream license is
preserved as `LICENSES/fancy-regex-MIT.txt` and beside the vendored tree.

- `native/core/vendor/fancy-regex/`

`native/core/vendor/fancy-regex-differential/` (a test harness that is not built
into the product; its `corpus/upstream.json` holds the patterns of fancy-regex
0.19.2's own tests) carries the same license text as `LICENSE`.

Statement of changes (listed in `native/core/vendor/fancy-regex/MIXDOG.md` and
marked `mixdog` in the sources): a stop a caller sets on its thread, which a
match reads at bounded intervals of counted steps (`src/interrupt.rs`, new;
`src/vm.rs`); searches handed to regex-automata run its lazy DFA one byte at a
time in the VM (`src/vm.rs`, `src/compile.rs`, `src/lib.rs`), and no seek
pre-filter is compiled; the manifest drops the examples, tests, benches and
dev-dependencies.

### regress 0.10.5 — Copyright (c) 2020 ridiculous_fish

<https://github.com/ridiculousfish/regress>

The crate is vendored and compiled into the Rust core as its ECMAScript-syntax
regex engine. It is offered under the MIT License OR the Apache License 2.0;
Mixdog takes the MIT terms. Both license files are kept beside the vendored
tree (`native/core/vendor/regress/LICENSE-MIT`, `LICENSE-APACHE`); the MIT text
is `LICENSES/MIT.txt`.

- `native/core/vendor/regress/`

Statement of changes (listed in `native/core/vendor/regress/MIXDOG.md` and
marked `mixdog` in the sources): with the `utf16` feature, a start-anchored
regex, a start-anchored alternation included, is tried at the one position it
can match at instead of at every position (`src/classicalbacktrack.rs`,
`src/startpredicate.rs`); a case-insensitive pattern outside Unicode mode
follows ECMAScript's `Canonicalize` as V8 does (`src/unicode.rs`,
`src/parse.rs`, `src/api.rs`); the crate's tests are not vendored.

### ast-grep-core 0.45.3 — Copyright (c) 2022 Herrington Darkholme

<https://github.com/ast-grep/ast-grep>

The crate is vendored and compiled into the Rust core (its `mixdog-graph`
crate), where it runs the code graph's structural matches. Its `LICENSE` is kept
beside the vendored tree and is `LICENSES/ast-grep-MIT.txt`; see ast-grep under
Tidy engines for the other ast-grep crates.

- `native/core/vendor/ast-grep-core/`

Statement of changes (listed in `native/core/vendor/ast-grep-core/MIXDOG.md` and
marked `mixdog` in the sources): the composite matchers put a capture
environment back only when an arm changed it, instead of copying an unchanged
one (`src/ops.rs`); the crate's tests are not vendored.

### marked 14.1.4 — Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey

<https://github.com/markedjs/marked>

The Markdown lexer and block/inline rules of `native/core/crates/mixdog-markdown-ansi/`
are a Rust translation of marked 14.1.4. Full license text:
`LICENSES/marked-MIT.txt`.

### Ink — Copyright (c) Vadim Demedes

Installed from Mixdog's patched Ink runtime release asset. The package retains
the upstream MIT license.

### webrtc and rtc 0.21.1 — Copyright (c) 2021 WebRTC.rs

<https://github.com/webrtc-rs/webrtc>, <https://github.com/webrtc-rs/rtc>

The sans-I/O WebRTC stack (`rtc` and its `rtc-*` sub-crates) and its async layer
(`webrtc`) are linked into the Rust core through `mixdog-remote`. They are
offered under the MIT License OR the Apache License 2.0; Mixdog takes the MIT
terms (`LICENSES/MIT.txt`). The crates are listed with their version and
copyright line in `LICENSES/rust-crates-NOTICE.txt`; the `rtc-*` sub-crates ship
no license file of their own and are covered by the `rtc` workspace license.

Four of them are vendored and modified; both license files are kept beside
each tree (`LICENSE-MIT`, `LICENSE-APACHE`; `rtc-ice`'s and `rtc-turn`'s are
those of `rtc`):

- `native/core/vendor/webrtc/`
- `native/core/vendor/rtc/`
- `native/core/vendor/rtc-ice/`
- `native/core/vendor/rtc-turn/`

Statement of changes (listed in each tree's `MIXDOG.md` and marked `mixdog` in
the sources): `webrtc` gathers TURN relay candidates over TCP and TLS as well as
UDP (`src/peer_connection/transport/turn_stream.rs`, new;
`src/peer_connection/transport/turn_relayer.rs`, `src/peer_connection/driver.rs`,
`src/peer_connection/mod.rs`), stops the driver of a dropped connection and
depends on `rustls`; `rtc` keeps the transport of a local relay candidate's
TURN allocation in its candidate event and stats entry and can take a relay
candidate back (`src/peer_connection/mod.rs`, `src/peer_connection/internal.rs`,
`src/peer_connection/transport/ice/mod.rs`); `rtc-ice`'s agent can remove a
local candidate with its pairs (`src/agent/mod.rs`); `rtc-turn` reports the success, error and timeout of one Allocate under one
transaction id and retries a 438 once (`src/client/mod.rs`,
`src/client/proto.rs`). The manifests drop the examples, tests, benches and
dev-dependencies.

## Apache License 2.0

### OpenAI Codex CLI — Copyright (c) OpenAI

<https://github.com/openai/codex>

The V4A `apply_patch` Lark grammar, reproduced verbatim from
`codex-rs/core/src/tools/handlers/apply_patch.lark` in
`native/core/crates/mixdog-tools/src/fs/specs/apply_patch.json`, together with the
seek/replacement semantics of the patch engine.

- `native/mixdog-patch/`

Statement of changes (Apache-2.0 section 4(b)): the Lark grammar is carried
unmodified. The patch engine under the path above is an independent
implementation in Rust that follows the same seek and
replacement semantics; it is not a copy of the upstream Rust sources. The
upstream NOTICE file is preserved as `LICENSES/codex-NOTICE.txt`.

The Rust core under `native/core/` (the `mixdog-*` crates of the daemon
backend) takes Codex's `codex-rs` workspace as its architectural reference:
the split into protocol, app-server, app-server-daemon, core and store crates,
the JSON-RPC thread/turn/item protocol with generated JSON Schema and
TypeScript types, the append-only session log with a SQLite state store, and
the tokio-based runtime layout. Mixdog reimplements these designs in its own
code to reproduce Mixdog's existing behaviour; no Codex source file is copied
into `native/core/`.

The Apache-2.0 terms require this notice to travel with any redistribution of
the derived files. Full license text: `LICENSES/Apache-2.0.txt`
(<https://www.apache.org/licenses/LICENSE-2.0>).

### EmbeddingGemma 2 — Copyright (c) Google

<https://huggingface.co/google/embeddinggemma-2>

The effort-judge model of the Auto reasoning built-in is derived from
EmbeddingGemma 2. It is not part of the package: installing the built-in
downloads it from this repository's `effort-judge-v*` GitHub releases, as
listed in `src/runtime/effort-judge/model-manifest.json`.

Statement of changes (Apache-2.0 section 4(b)): only the text encoder is kept,
reduced to 18 of its layers; a four-level classification head is added and the
model is fine-tuned to rate the reasoning effort a request or an agent step
needs; the weights are exported to ONNX and quantized to 4 bits. Full license
text: `LICENSES/Apache-2.0.txt`.

Its training data includes requests and agent steps from SWE-chat
(<https://huggingface.co/datasets/SALT-NLP/SWE-chat>, Open Data Commons
Attribution License 1.0); OpenAssistant oasst2
(<https://huggingface.co/datasets/OpenAssistant/oasst2>, Apache License 2.0);
DataClaw exports that their authors published on the Hugging Face Hub under the
MIT License (<https://huggingface.co/datasets/di-zhang-fdu/ShareDataClaw>);
DevGPT by Tao Xiao, Christoph Treude, Hideaki Hata and Kenichi Matsumoto
(<https://doi.org/10.5281/zenodo.16392320>, CC BY 4.0); issue texts from the
SWE-bench training split (<https://github.com/SWE-bench/SWE-bench>, MIT
License); and agent steps from NVIDIA's SWE-Hero OpenHands trajectories
(<https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories>,
CC BY 4.0).

Contains information from WildChat-4.8M
(<https://huggingface.co/datasets/allenai/WildChat-4.8M>) which is made
available under the ODC Attribution License
(<https://opendatacommons.org/licenses/by/1-0/>).

Since `effort-judge-v7` it also includes questions from Stack Exchange sites
(via <https://huggingface.co/datasets/HuggingFaceTB/stackexchange_2025_md>;
each post is licensed CC BY-SA 2.5, 3.0 or 4.0 by its author, and its URL and
author are kept with the training item); GitHub issues and pull requests of
permissively licensed repositories (via
<https://huggingface.co/datasets/common-pile/github_archive>, with each item's
repository, URL, license and authors kept); issues and pull requests from
Nebius SWE-rebench-V2 (<https://huggingface.co/datasets/nebius/SWE-rebench-V2>,
<https://huggingface.co/datasets/nebius/SWE-rebench-V2-PRs>, CC BY 4.0,
permissively licensed repositories only); and agent steps from Nebius
SWE-agent trajectories
(<https://huggingface.co/datasets/nebius/SWE-agent-trajectories>, CC BY 4.0),
Nebius SWE-rebench OpenHands trajectories
(<https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories>,
CC BY 4.0), Kwai-Klear SWE-smith mini-swe-agent-plus trajectories
(<https://huggingface.co/datasets/Kwai-Klear/SWE-smith-mini_swe_agent_plus-trajectories-66k>,
MIT License), SWE-Factory DeepSWE-Agent Kimi-K2 trajectories
(<https://huggingface.co/datasets/SWE-Factory/DeepSWE-Agent-Kimi-K2-Trajectories-2.8K>,
MIT License), SWE-Gym OpenHands SFT trajectories
(<https://huggingface.co/datasets/SWE-Gym/OpenHands-SFT-Trajectories>, MIT
License), SWE-ZERO-12M trajectories
(<https://huggingface.co/datasets/AlienKevin/SWE-ZERO-12M-trajectories>, Apache
License 2.0), SWE-Lego real and synthetic data
(<https://huggingface.co/datasets/Lego-X/SWE-Lego-Real-Data>,
<https://huggingface.co/datasets/Lego-X/SWE-Lego-Synthetic-Data>, Apache
License 2.0) and TIGER-Lab SWE-Next SFT trajectories
(<https://huggingface.co/datasets/TIGER-Lab/SWE-Next-SFT-Trajectories>, MIT
License). Each `effort-judge-v*` release lists its files, hashes and
attributions.

### pdf.js 6.4.299 — Copyright 2012 Mozilla Foundation

<https://github.com/mozilla/pdf.js>

The PDF lexer, parser, object model and cross-reference handling of
`native/core/crates/mixdog-pdf/`, and the stream filters and standard security
handler of `native/core/crates/mixdog-pdf-codec/`, are Rust translations of the
pdf.js sources named in the `NOTICE` file of each crate. The notice files stay
beside the crates; the Apache-2.0 text is `LICENSES/Apache-2.0.txt`.

Statement of changes (Apache-2.0 section 4(b)): translated from JavaScript to
Rust; no pdf.js source file is distributed.

### shiguredo_libvpx 2026.2.0-canary.3 — Shiguredo (libvpx-rs authors)

<https://github.com/shiguredo/libvpx-rs>

The Rust bindings to libvpx, used by `mixdog-remote`'s WebRTC stack
for VP8 encoding. The crate's license is the unmodified Apache License
2.0 (`LICENSES/Apache-2.0.txt`) and names no copyright holder.

Its build script downloads a prebuilt static libvpx (libvpx v1.17.0, symbols
prefixed `shiguredo_vpx_`) from
`https://github.com/shiguredo/libvpx-rs/releases/download/<crate version>/libvpx-<target>.tar.gz`
and links it into `mixdogd`. That archive holds only `lib/` and `bindings.rs` and
no license text. libvpx is BSD-3-Clause, Copyright (c) 2010, The WebM Project
authors, with the WebM patent license grant (PATENTS); both are in
`LICENSES/libvpx-BSD-3-Clause.txt`, taken from the libvpx v1.17.0 tree.

## BSD-3-Clause, BSD-2-Clause, ISC and Unicode-3.0 works carried in the Rust core

### Ported and embedded works

- **V8** (Copyright 2011-2024 the V8 project authors, BSD-3-Clause) and **fdlibm**
  (Copyright (C) 1993 Sun Microsystems, Inc.): the JavaScript `Math` functions and
  number-to-string radix conversion of `native/core/crates/mixdog-js/src/math/`
  and `.../number/`. `LICENSES/v8-BSD-3-Clause.txt`, `LICENSES/fdlibm-NOTICE.txt`.
- **ICU / CLDR data** (Copyright (c) 2016-2025 Unicode, Inc.; ICU 77.1): the date-name
  and default-locale data embedded in `mixdog-js`
  (`src/date_string/data/`, `src/default_locale/data/`). `LICENSES/icu-ICU.txt`
  (Unicode License v3).
- **formulajs** (Copyright (c) 2014 Sutoiku, Inc., MIT), **jStat** (Copyright (c)
  2013 jStat, MIT) and **bessel** (Copyright (C) 2013-present SheetJS, Apache-2.0):
  the spreadsheet function ports in `native/core/crates/mixdog-xlsx-formula/`.
  `LICENSES/formulajs-MIT.txt`, `LICENSES/jstat-MIT.txt`,
  `LICENSES/bessel-Apache-2.0.txt`.
- **unicode-script** (Copyright (c) 2019 Manish Goregaokar, MIT): the script
  tables used by `mixdog-fonts`. `LICENSES/unicode-script-MIT.txt`.
- **highlight.js 10.7.3** (Copyright (c) 2006, Ivan Sagalaev, BSD-3-Clause) and
  **cli-highlight 2.1.11** (Copyright (c) 2016, Felix Frederick Becker, ISC): the
  language definitions and colorizer of `native/core/crates/mixdog-highlight/`.
  `LICENSES/highlight.js-BSD-3-Clause.txt`, `LICENSES/cli-highlight-ISC.txt`.
- **Skia** (Copyright (c) 2011 Google Inc., BSD-3-Clause; the analytic
  trapezoid rasterizer, at the revision pinned by `@napi-rs/canvas` 1.0.11):
  `native/core/crates/mixdog-raster/src/canvas/analytic.rs`.
  `LICENSES/skia-BSD-3-Clause.txt`, the notice retained in that file's header.
- **PDFium** (Copyright 2014 The PDFium Authors, BSD-3-Clause): the JBIG2 and
  CCITT decoders of `mixdog-pdf` (`LICENSES/pdfium-jbig2-LICENSE.txt`, as shipped
  with pdf.js's `wasm/LICENSE_JBIG2`) and the Foxit standard fonts
  (`.pfb` files under `native/core/crates/mixdog-pdf/assets/` and
  `src/fontfile/stdfonts/`, embedded in the binary; `LICENSES/pdfium-BSD-3-Clause.txt`).
- **Adobe CMap resources** (Copyright 1990-2009 Adobe Systems Incorporated,
  BSD-3-Clause): the predefined CMaps in `mixdog-pdf` (`src/fontfile/cmaps/`).
  `LICENSES/adobe-cmap-BSD-3-Clause.txt`.
- **OpenJPEG 2.5** (Universite catholique de Louvain and contributors,
  BSD-2-Clause): the JPEG 2000 reader of `mixdog-pdf` follows it, as compiled into
  pdf.js's `wasm/openjpeg.wasm`. `LICENSES/openjpeg-BSD-2-Clause.txt`.
- **dav1d / rav1d** (VideoLAN and dav1d authors, BSD-2-Clause) and **avif-parse**
  (Mozilla, MPL-2.0): the AVIF/HEIF decoding crates `rav1d` and `avif-parse` of
  `mixdog-imaging`. `LICENSES/rav1d-BSD-2-Clause.txt`,
  `LICENSES/avif-parse-MPL-2.0.txt`.

### Libraries bundled inside Rust crates

Compiled from C sources that a crate carries: **libwebp** (Copyright (c) 2010,
Google Inc., BSD-3-Clause with the WebM patent grant) in `libwebp-sys`;
**zstd** (Copyright (c) Meta Platforms, Inc. and affiliates; BSD-3-Clause is
taken from its BSD OR GPL-2.0 offer) in `zstd-sys`; **BoringSSL** and **fiat-crypto**
parts of `ring`; the IANA time-zone data of `chrono-tz`; the Unicode and ICU
tables of `tree-sitter`, `regex-syntax`, `unicode-ident` and `icu_*`. Each text is
reproduced in `LICENSES/rust-crates-NOTICE.txt` from the file the crate carries.

## icu_collator 2.4.0 (vendored) — Unicode License v3

<https://github.com/unicode-org/icu4x>

Copyright (c) 2020-2024 Unicode, Inc. The crate is vendored and compiled into the
Rust core for `localeCompare` ordering; its data crate `icu_collator_data`
(CLDR 49 / Unicode 18) is a registry dependency. The license file is kept as
`native/core/vendor/icu_collator/LICENSE` (Unicode License v3, the same text as
`LICENSES/icu-ICU.txt` apart from the copyright years).

- `native/core/vendor/icu_collator/`

Statement of changes (listed in `native/core/vendor/icu_collator/MIXDOG.md`, with
the hashes of the original files in `MIXDOG-PROVENANCE.json`): the comparison
accepts raw UTF-16 code units, including unpaired surrogates, as JavaScript
strings do (`CollatorBorrowed::compare_raw_utf16`; `src/elements.rs`,
`src/comparison.rs`); the manifest is unchanged.

## Rust crates

The Rust core links about 850 crates (`native/core/Cargo.lock`; the closure of
`mixdogd`, `mixdog`, `mixdog-askpass` and `mixdog-relay`). Most are MIT OR
Apache-2.0, as is usual for the ecosystem; Mixdog takes the MIT terms where both
are offered (as for ripgrep above) and otherwise the single license a crate
states. `LICENSES/rust-crates-NOTICE.txt` lists every crate with its version,
license expression and copyright lines, and reproduces, from the crates' own
files, each license text other than MIT and Apache-2.0: BSD-2-Clause,
BSD-3-Clause, ISC, Zlib, Unicode License v3 and the ICU license, MPL-2.0,
CDLA-Permissive-2.0 (`webpki-roots`), CC0-1.0, the `ring` / BoringSSL terms and
the other texts a crate ships.

MPL-2.0 crates (`avif-parse`, `cssparser`, `cssparser-macros`, `dtoa-short`,
`nucleo-matcher`, `option-ext`, `selectors`) are used unmodified; their source is
the registry release of the version in `Cargo.lock`
(<https://crates.io>), and Mixdog's own files remain under Apache-2.0.

## FreeType Project License (FTL) — FreeType-derived code

FreeType is offered under the FreeType Project License or the GNU General
Public License v2; Mixdog takes the FreeType Project License. Full text:
`LICENSES/freetype-FTL.txt` (`docs/FTL.TXT` of FreeType commit
264b5fbf5b912b39f98d038bf75d39be0a73f21b, the revision pinned by
`@napi-rs/canvas` 1.0.11's Skia).

Portions of this software are copyright © 1996-2002, 2006 The FreeType Project
(<https://www.freetype.org>). All rights reserved.

- `native/core/crates/mixdog-fonts/src/autohint.rs` is a Rust translation of
  the light-mode vertical grid fitting of FreeType's auto-hinter (`aflatin.c`,
  `afhints.c`, the Hebrew blue strings of `afblue.dat`, and the CJK module
  `afcjk.c`), in the same 26.6 and 16.16 integer arithmetic.
- `native/core/crates/mixdog-raster/src/canvas/glyph.rs` follows FreeType's
  gray rasterizer (the exact pixel-area coverage and the conic flattening) and
  its outline handling.

Statement of changes: translated from C to Rust and fitted to Mixdog's glyph
and outline types; only the parts named above are carried, and no FreeType
source file is distributed. Observable results follow FreeType's.

## IJG License — libjpeg-derived code

This software is based in part on the work of the Independent JPEG Group.

`native/core/crates/mixdog-imaging/src/jpeg_enc.rs` (the baseline JPEG encoder)
and the JPEG decoding arithmetic in `native/core/crates/mixdog-imaging/src/decode.rs`
(YCbCr to RGB, `jdcolor.c`) follow libjpeg: `jfdctint.c`, `jcdctmgr.c`,
`jccolor.c`, `jcsample.c`, `jchuff.c` and the IJG quantisation tables, as built
in mozjpeg commit 0826579 (the libjpeg-turbo-based JPEG library of
`@img/sharp-libvips` 1.3.4, which `sharp` 0.35.5 uses and the ports reproduce).
libjpeg is Copyright (C) 1991-2020 Thomas G. Lane, Guido Vollbeding. The IJG
License (the "LEGAL ISSUES" section of its `README`) is the only license taken
for this code; libjpeg-turbo's additional BSD-3-Clause grant covers its
TurboJPEG API, which Mixdog does not use. Full text: `LICENSES/libjpeg-IJG.txt`.

Statement of changes (IJG condition 1): the algorithms are translated from C to
Rust; the encoder's structure (blocks, zigzag, entropy symbols, marker layout)
follows `image` 0.25.9 (MIT OR Apache-2.0, in
`LICENSES/rust-crates-NOTICE.txt`) and is not libjpeg's. No libjpeg source file
is distributed.

## GPL-2.0 with the Liberation font exception

The four Liberation Sans faces in
`native/core/crates/mixdog-pdf/assets/standard_fonts/` (Copyright 2007-2011 Red
Hat, Inc.) are embedded in the binary as the PDF reader's standard-font
substitutes. They are licensed under the GNU General Public License v2 with the
font-embedding exception of the Liberation license; the exception covers
documents that embed the font, and its clause (b) asks that a distribution of
the object code in a physical product give access to the source. The full text
is `LICENSES/liberation-fonts-GPL-2.0-with-exception.txt` (as shipped with
pdf.js's `standard_fonts/LICENSE_LIBERATION`). The fonts are data files kept
separate from Mixdog's code, which stays under Apache-2.0.

## CC0-1.0

### Simple Icons 16.35.0

<https://simpleicons.org> · <https://github.com/simple-icons/simple-icons>

The connector brand marks in
`apps/desktop/src/renderer/connectors-brand-icons.ts` carry Simple Icons path
data and brand colours unmodified (Airtable, Blender, Confluence,
Dropbox, Figma, GitHub, Gmail, Google Calendar, Google Drive, Hugging Face,
Jira, Linear, Notion, PostgreSQL, Sentry, Stripe, Supabase, Trello,
Unity, Vercel); Unity's mark is drawn in black, as its listed colour is white.
Simple Icons is dedicated to the public domain under CC0 1.0; each
mark remains the trademark of its owner and is shown only to name that
service. Slack is not in Simple Icons and its mark is not openly licensed, so
it is shown as a letter tile. Full text: `LICENSES/simple-icons-CC0-1.0.txt`.

## GPL-3.0-only

### Chrome password import sidecar

The Windows password importer is a separate process built from the
pinned source and Mixdog wrapper recorded in
`LICENSES/browser-import-NOTICE.txt`. It is not linked into the Apache-2.0 desktop
application. Its complete GPL text ships beside the two native executables.

## Tidy engines

Optional managed downloads for the tidy tool (`native/core/crates/mixdog-services/src/tidy/`). They are
not compiled into Mixdog. Redistributable engines may be mirrored to this
repository's GitHub releases; GPL binaries are never attached to that mirror.

### biome 2.6.8 — MIT

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

License text: <https://github.com/koalaman/shellcheck/blob/v0.11.0/LICENSE>

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

### google-java-format 2.0.0 — Apache-2.0

<https://github.com/google/google-java-format>

The native executables of the upstream release; darwin-x64 has none and is
omitted. Full license text: `LICENSES/Apache-2.0.txt`

### ktfmt 0.65 — Apache-2.0

<https://github.com/Kotlin/ktfmt>

The native executables of the upstream release; darwin-x64 and linux-arm64 have
none and are omitted. Full license text: `LICENSES/Apache-2.0.txt`

### taplo 0.10.0 — MIT

<https://github.com/tamasfe/taplo>

Full license text: `LICENSES/taplo-MIT.txt`

### PSScriptAnalyzer 1.25.0 — MIT

<https://github.com/PowerShell/PSScriptAnalyzer>

The module package from the PowerShell Gallery. Full license text:
`LICENSES/psscriptanalyzer-MIT.txt`

### oh-my-pi — MIT

<https://github.com/can1357/oh-my-pi>

The Devin provider follows its Devin integration. The model-family table in
`native/core/crates/mixdog-ai/src/providers/devin/reviewed_families.json` is
data taken from its model-collapse rules, and the code under
`native/core/crates/mixdog-ai/src/providers/devin/` contains code derived from
it: catalog discovery and family collapsing, client identity values, model
classification and thinking rendering, tool schema normalization and
tool-argument repair.

Full license text: `LICENSES/oh-my-pi-MIT.txt`

## Cairo pen geometry (LGPL-2.1 or MPL-1.1)

`native/core/crates/mixdog-raster/src/svg/cairo_pen.rs` translates the stroke pen-collapse and major-axis calculations from Cairo 1.18.6 (`cairo-compositor.c`, `cairo-pen.c`, `cairo-matrix.c`). Copyright 2002 University of Southern California, 2008 Chris Wilson, and 2011 Intel Corporation. The original notices and the choice of LGPL version 2.1 or MPL version 1.1 are retained in that file. Full license texts are distributed in `LICENSES/cairo/` and beside the crate.

Mixdog modifications, 2026-11-16: translated the relevant calculations into Rust and connected them to SVG stroke rendering. The covered source, its notices, and modifications are included in Mixdog's source distribution at the same release tag, under the path above: <https://github.com/tribgames/mixdog>. This file retains its stated license terms; the surrounding Mixdog code remains under its own licenses.
