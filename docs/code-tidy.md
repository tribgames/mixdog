# Code tidy

The `tidy` tool formats, lints, and applies structural AST rules. The
built-in `code-tidy` skill owns call order, download approval, and
agent-level cleanup that the engines do not cover.

## Skill workflow

Load `code-tidy` before the first `tidy` call.

1. `tidy action:'scan'` — languages and engines (used / missing /
   `installHint`). Scan does not download and does not return
   `needsApproval`. Downloads happen automatically under the default `auto`
   policy. Only when the user set `tidy.downloads` to `ask` does a later
   `check` / `fix` / `install` result carry `needsApproval` — then ask once
   with engines and byte sizes and re-call with `approveDownloads:true`.
2. Never install toolchain engines (rustfmt, gofmt, dart, swift, zig, mix,
   dotnet). Report `installHint` instead. Managed engines (including
   PSScriptAnalyzer) download only through tidy (`auto` policy,
   `approveDownloads`, or `action:'install'`).
3. Deterministic layers first, each dry-run then apply (`fix` writes only
   with `apply:true`):
   - engine `check` with `structural:false`
   - engine `fix` with `structural:false`
   - structural rules (`tidy action:'fix' structural:true`)
   Engine steps must pass `structural:false` because `structural` defaults
   to true on check/fix.
4. Agent-level structural cleanup last (split oversized files, extract deep
   functions, drop history comments, and the rest of the skill checklist).
   Public API and behavior stay unchanged.
5. After every apply, run the project's tests/typecheck (from `package.json`,
   `Cargo.toml`, or `pyproject.toml`) and stop on failure.
6. If the project already has formatter config or tools, tidy uses them. Do
   not add or rewrite `biome.json`, `.prettierrc`, `.clang-format`, or similar
   unless the user asks.

Report: languages, engines used/missing, files changed, diagnostics remaining,
structural matches applied/skipped, test results.

## Rule packs

v1 structural rules live at `src/runtime/tidy/rules/<language>/<rule-id>.yml`
(ast-grep YAML: `id`, `language`, `severity`, `message`, `note`, `rule`,
optional `fix`). Tests are `src/runtime/tidy/rules/__tests__/<rule-id>.yml`
(`id` + `valid` / `invalid`).

| Rule | Severity | Fix | Languages |
|---|---|---|---|
| `no-history-comment` | warning | delete the comment | javascript, typescript, tsx, python, rust, go, c, cpp, java, csharp, ruby, php, swift, kotlin, lua, bash |
| `no-debugger` | error | delete the statement | javascript, typescript, tsx |
| `no-empty-catch` | warning | none | javascript, typescript, tsx, java, csharp, php |
| `todo-marker` | info | none | same as `no-history-comment` |

`id` is unique per language folder (ast-grep forbids duplicate ids in one
scan). Validate with a temporary `sgconfig.yml` whose `ruleDirs` is one
language directory and `testConfigs.testDir` is `__tests__`, using
`@ast-grep/cli@0.45.3`. On Windows, `npx --package @ast-grep/cli ast-grep`
cannot pick a bin (`ast-grep` vs `sg`); install that package in a temp
directory and invoke `node_modules/.bin/ast-grep.cmd`. Do not commit that
config or `node_modules`.

Node kinds must be valid for the ast-grep grammars bundled in
`mixdog-graph` (ast-grep-language 0.45.3). The `@ast-grep/cli` test is a
convenience; the native binary is authoritative — a kind the grammar
rejects (`Kind '…' is invalid`) exits 2 and, when packs are concatenated
into one document, yields zero matches for every language. Kotlin uses
`line_comment` + `block_comment` because that grammar has no
`multiline_comment` node.

Comment rules match whole comment nodes (ast-grep `regex` is a full-node
match) with language-specific `kind` values (`comment`, `line_comment`,
`block_comment`, `multiline_comment`). History-comment text is
`extracted verbatim`, `moved (here )?from`, `behavior-preserving move`,
`copied from`, `was previously in` (case-insensitive, word-bounded so
`removed from` is not a hit). TODO markers are `TODO`, `FIXME`, and `XXX`.
`__tests__` snippets include `//`, `#`, and `--` comment forms so one file
covers C-like, hash-comment, and lua languages.

`no-empty-catch` matches a `catch_clause` whose body node
(`statement_block` / `block` / `compound_statement`) has no child nodes.
A body that contains only a comment is therefore **not** flagged: the
comment is a child, and the message does not treat comments as empty.
Optional-binding `catch {}` is flagged in JS/TS/TSX/C#; Java and PHP
require a typed parameter, so tests use `catch (e) {}`.

## Tool reference

Runtime: `src/runtime/tidy/`. Registered like `media` (tool defs in
`src/session-runtime/tool-defs.mjs`, dispatch in
`src/session-runtime/internal-tool-executor.mjs`, labels in
`src/runtime/shared/tool-surface.mjs`). One JSON result per call.

`tidy` is an installable built-in, like Office: the tool ships with the runtime
but stays off the session surface until the user installs it (Extensions →
Built-in) or `MIXDOG_FEATURE_TIDY` is set. It is deliberately NOT grandfathered,
so an upgraded profile installs it once. The `code-tidy` skill declares
`metadata.requires: tidy` and follows the same gate.

### Actions

| Action | Does | Writes |
|---|---|---|
| `scan` | detect languages, resolve engines, report policy | no |
| `check` | engines in check mode + structural rules | no |
| `fix` | same as check, plus the change plan; `apply:true` writes | only with `apply:true` |
| `install` | download the named managed engines (sha256-verified) | managed dir only |
| `rules` | list structural rule packs and their languages | no |

`scan` does not run structural rules. A mixdog-graph binary that does not
answer `--langs` is a note on `scan` (formatters still resolve) and an
`ok:false` error on `check` / `fix` / `rules`, naming that binary and the
rebuild remedy. Pass `structural:false` to run only the formatters and
linters. Zero structural matches are never reported as clean in that case.

Arguments: `paths[]` (project-relative scope), `languages[]`, `engines[]`,
`apply`, `approveDownloads`, `structural` (default true for check/fix).

### Language detection

Files come from `git ls-files` and map to languages by extension; the code
language table in `src/runtime/tidy/languages.mjs` mirrors
`native/mixdog-graph/src/lang.rs` (a test pins the two together) and adds the
formatter-only languages (powershell, json, yaml, markdown, toml, css, html).
When the local `mixdog-graph` binary answers `mixdog-graph <cwd> --langs`, its
language list wins and the report says `languageSource:"graph-binary"`.

### Engine resolution

Order, first hit wins — reported per engine as `source`:

1. `project-config` — `.mixdog/tidy.json` → `{engines:{<id>:{command,args,cwd?}}, policy:{downloads}}`
2. `project-local` — `node_modules/.bin`, `.venv/{bin,Scripts}`, `venv/{bin,Scripts}`
3. `path` — PATH lookup
4. `managed` — `<pluginData>/tools/<engine>/<version>/<binPath>`
5. `missing` — with `installHint`, plus `installable:true` when the manifest
   has an asset for this platform

A project whose `node_modules/.bin` provides Prettier or ESLint keeps them:
Biome resolves but is reported `skipped: "project uses prettier"`. tidy never
writes or rewrites a project's formatter config.

| Engine | Languages | Managed | Runner |
|---|---|---|---|
| biome | javascript, typescript, json, css | yes | `check --reporter=json` / `check --write` |
| ruff | python | yes | `check --output-format json` + `format --check` / `--fix`, `format` |
| clang-format | c, cpp, objc | yes | `--dry-run -Werror` / `-i` |
| shfmt | bash | yes | `-l` / `-w` |
| shellcheck | bash | yes | `-f json` (lint only, never writes) |
| stylua | lua | yes | `--check` / write |
| gofumpt | go | yes | `-l` / `-w` |
| dprint | json, markdown, toml, javascript, typescript | yes | `check` / `fmt` (needs `dprint.json`) |
| air | r | yes | `format --check` ("Would reformat: …") / `format` |
| mago | php | yes | `format --dry-run` ("diff of '…':") + `lint --reporting-format json` / `format`, `lint --fix` |
| rustfmt | rust | toolchain | `--check` / write |
| gofmt | go | toolchain | `-l` / `-w` |
| psscriptanalyzer | powershell | yes (module) | `Invoke-ScriptAnalyzer` + `Invoke-Formatter` (host: pwsh/powershell) |
| dotnet-format | csharp | toolchain | `format whitespace <folder> --folder --include` + `--report` json / write |
| prettier | js/ts, json, css, markdown, yaml, html | project-local only | `--list-different` / `--write` |
| eslint | javascript, typescript | project-local only | `-f json` / `--fix` |
| zig, dart, swift-format, mix | zig, dart, swift, elixir | toolchain | detection + `installHint` only |

Engines see only the files of their own languages inside the requested scope,
spawn with argument arrays (never a shell) and `windowsHide`, run under a
timeout, and run concurrently — except during `apply`, where they run one at a
time so two formatters never write the same file at once.

### Downloads

`tidy.downloads` in `.mixdog/tidy.json` (or `MIXDOG_TIDY_DOWNLOADS`):
`auto` (default) | `ask` | `never`. Under `auto`, missing managed engines
download without prompting. Under `ask` the call returns
`needsApproval:{engines:[{id,version,bytes}],bytes}` and downloads nothing;
re-call with `approveDownloads:true`. Toolchain engines are never downloaded.
Assets come from `src/runtime/tidy/engines-manifest.json`, stream through the
shared bounded downloader, are sha256-verified before extraction (zip via
`jszip`, tar.gz via `zlib` + a minimal ustar reader), and are renamed
atomically into `<pluginData>/tools/<engine>/<version>/`.

### Structural rules

`structural.mjs` exposes `scan({cwd, rulesText, files, fix})` over exactly one
implementation — there is no fallback engine:

- `graph-binary` — `mixdog-graph <cwd> --scan --rules - [--files ...] [--fix]`,
  rules YAML on stdin, JSONL on stdout with a final `{"summary":...}` line; exit
  0 ok, 1 internal, 2 usage/rule-parse (reported as `structural.error`). `--fix`
  only asks for fix payloads — the binary writes nothing. Support is probed with
  `mixdog-graph <cwd> --langs`, and the probe requires the language registry in
  the output: a binary from before the scan mode accepts the flag, exits 0 and
  prints nothing, which would otherwise read as "no findings".

mixdog-graph embeds the ast-grep crates, so the packs run against the grammars
the code graph itself parses with; the `ast-grep` CLI is never installed. When
the resolved binary does not answer `--langs`, structural actions fail with an
explicit error naming that binary and the remedy (rebuild
`native/mixdog-graph`, or update the packaged native tool) — rules are never
skipped silently. `structural:false` runs only the formatters and linters.

Rule packs are sent one language group at a time (`rules/<language>/*.yml`), the
way their authors validate them: a scan takes a single rule document, so one
rule with a `kind:` a grammar lacks would otherwise fail every language in the
run. A broken group is reported in `structural.error` / `ruleErrors` while the
other languages still produce matches. Groups are filtered to the detected
languages, with one alias: a `.tsx` file is detected as `typescript` but parsed
with the `tsx` grammar, so the `tsx` packs run whenever typescript is in scope.

The adapter normalizes the binary's zero-based positions to 1-based
line/column and keeps byte offsets verbatim. With no rule packs installed the
section is `adapter:"none"` with a note; a missing or outdated engine is an
error, not a note.

### Writes

Fixes never touch `fs` directly. Structural replacements apply in descending
byte order after an overlap check — a file with overlapping fixes is rejected
whole and left byte-identical — then go through `atomicWrite`. Every written
path (including files an engine rewrote in place) runs the same post-write trio
as the builtin edit adapters: `invalidateBuiltinResultCache`,
`markCodeGraphDirtyPaths`, `recordReadSnapshot`. UNC, Windows device, and ADS
paths are refused by the shared device-path guards.

### Report

`{ok, action, languages, languageSource, engines, missing, policy, results[],
structural, needsApproval, installed, notes, elapsedMs}`, where each result is
`{id, source, filesChecked, filesChanged, filesChangedCount, diagnostics, more,
diagnosticsCount}` and `structural` is `{adapter, packs, matches, fixable,
applied, rejected}`. Diagnostic and file samples are capped with a `more`
count; if the encoded report still exceeds the tool output budget the samples
shrink further and `truncated:true` is set. Counts always survive trimming.
