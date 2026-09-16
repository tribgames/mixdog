// The engine catalog: what tidy knows how to resolve and run.
//
// `toolchain: true` marks engines that ship with a language toolchain
// (rustfmt, gofmt, zig fmt, ...). Those are PATH-detected only and are NEVER
// downloaded; a missing one reports its installHint instead.
// `managed: true` marks engines that engines-manifest.json can install into
// <pluginData>/tools/<id>/<version>/.
// `projectLocal` lists the project-local roots that may provide the binary:
// 'node' → node_modules/.bin, 'venv' → .venv/{bin,Scripts} and venv/{bin,Scripts}.

export const ENGINE_CATALOG = Object.freeze({
  biome: {
    id: 'biome',
    bin: 'biome',
    kind: ['format', 'lint'],
    languages: ['javascript', 'typescript', 'json', 'css'],
    managed: true,
    projectLocal: ['node'],
    configFiles: ['biome.json', 'biome.jsonc'],
    // A project that already drives Prettier/ESLint from node_modules/.bin keeps
    // them; tidy never swaps a project's formatter or rewrites its config.
    suppressedBy: ['prettier', 'eslint'],
    installHint: 'npm i -D @biomejs/biome, or run tidy action:install engines:["biome"]',
  },
  prettier: {
    id: 'prettier',
    bin: 'prettier',
    kind: ['format'],
    languages: ['javascript', 'typescript', 'json', 'css', 'markdown', 'yaml', 'html'],
    managed: false,
    projectLocal: ['node'],
    projectLocalOnly: true,
    configFiles: ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'],
    installHint: 'npm i -D prettier (tidy only uses a project-local Prettier)',
  },
  eslint: {
    id: 'eslint',
    bin: 'eslint',
    kind: ['lint'],
    languages: ['javascript', 'typescript'],
    managed: false,
    projectLocal: ['node'],
    projectLocalOnly: true,
    configFiles: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'],
    installHint: 'npm i -D eslint (tidy only uses a project-local ESLint)',
  },
  ruff: {
    id: 'ruff',
    bin: 'ruff',
    kind: ['format', 'lint'],
    languages: ['python'],
    managed: true,
    projectLocal: ['venv'],
    configFiles: ['ruff.toml', '.ruff.toml'],
    tomlConfig: { file: 'pyproject.toml', section: '[tool.ruff' },
    installHint: 'pip install ruff, or run tidy action:install engines:["ruff"]',
  },
  'clang-format': {
    id: 'clang-format',
    bin: 'clang-format',
    kind: ['format'],
    languages: ['c', 'cpp', 'objc'],
    managed: true,
    projectLocal: [],
    configFiles: ['.clang-format', '_clang-format'],
    installHint: 'install LLVM/clang-format, or run tidy action:install engines:["clang-format"]',
  },
  shfmt: {
    id: 'shfmt',
    bin: 'shfmt',
    kind: ['format'],
    languages: ['bash'],
    managed: true,
    projectLocal: [],
    configFiles: ['.editorconfig'],
    installHint: 'install mvdan/sh, or run tidy action:install engines:["shfmt"]',
  },
  shellcheck: {
    id: 'shellcheck',
    bin: 'shellcheck',
    kind: ['lint'],
    languages: ['bash'],
    managed: true,
    projectLocal: [],
    configFiles: ['.shellcheckrc'],
    installHint: 'install shellcheck, or run tidy action:install engines:["shellcheck"]',
  },
  stylua: {
    id: 'stylua',
    bin: 'stylua',
    kind: ['format'],
    languages: ['lua'],
    managed: true,
    projectLocal: [],
    configFiles: ['stylua.toml', '.stylua.toml'],
    installHint: 'install StyLua, or run tidy action:install engines:["stylua"]',
  },
  gofumpt: {
    id: 'gofumpt',
    bin: 'gofumpt',
    kind: ['format'],
    languages: ['go'],
    managed: true,
    projectLocal: [],
    configFiles: [],
    installHint: 'go install mvdan.cc/gofumpt@latest, or run tidy action:install engines:["gofumpt"]',
  },
  // air (posit-dev/air): `air format --check` lists "Would reformat: <path>" on
  // stderr and exits non-zero; `air format` writes.
  air: {
    id: 'air',
    bin: 'air',
    kind: ['format'],
    languages: ['r'],
    managed: true,
    projectLocal: [],
    configFiles: ['air.toml', '.air.toml'],
    installHint: 'install air (posit-dev/air), or run tidy action:install engines:["air"]',
  },
  // mago (carthage-software/mago): `mago format --dry-run` prints one
  // "diff of '<file>':" header per file, `mago format` writes, and
  // `mago lint --reporting-format json` emits {issues:[...]}.
  mago: {
    id: 'mago',
    bin: 'mago',
    kind: ['format', 'lint'],
    languages: ['php'],
    managed: true,
    projectLocal: [],
    configFiles: ['mago.toml'],
    installHint: 'install mago (carthage-software/mago), or run tidy action:install engines:["mago"]',
  },
  dprint: {
    id: 'dprint',
    bin: 'dprint',
    kind: ['format'],
    languages: ['json', 'markdown', 'toml', 'javascript', 'typescript'],
    managed: true,
    projectLocal: ['node'],
    configFiles: ['dprint.json', 'dprint.jsonc', '.dprint.json'],
    // dprint only formats what its own config selects; without one there is
    // nothing to run.
    requiresConfig: true,
    installHint: 'install dprint and add dprint.json, or run tidy action:install engines:["dprint"]',
  },
  rustfmt: {
    id: 'rustfmt',
    bin: 'rustfmt',
    kind: ['format'],
    languages: ['rust'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['rustfmt.toml', '.rustfmt.toml'],
    installHint: 'rustup component add rustfmt',
  },
  gofmt: {
    id: 'gofmt',
    bin: 'gofmt',
    kind: ['format'],
    languages: ['go'],
    toolchain: true,
    projectLocal: [],
    configFiles: [],
    installHint: 'install the Go toolchain (gofmt ships with it)',
  },
  psscriptanalyzer: {
    id: 'psscriptanalyzer',
    // Runs through the PowerShell host; Invoke-Formatter / Invoke-ScriptAnalyzer
    // come from the PSScriptAnalyzer module.
    bin: 'pwsh',
    altBins: ['powershell'],
    kind: ['format', 'lint'],
    languages: ['powershell'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['PSScriptAnalyzerSettings.psd1'],
    versionArgs: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    installHint: 'Install-Module PSScriptAnalyzer -Scope CurrentUser (needs pwsh or powershell on PATH)',
  },
  // Toolchain formatters tidy detects and reports but has no v1 runner for:
  // resolution + installHint only, so `scan` stays honest about what exists.
  zig: {
    id: 'zig',
    bin: 'zig',
    kind: ['format'],
    languages: ['zig'],
    toolchain: true,
    projectLocal: [],
    configFiles: [],
    command: ['zig', 'fmt'],
    installHint: 'install the Zig toolchain (zig fmt)',
  },
  dart: {
    id: 'dart',
    bin: 'dart',
    kind: ['format'],
    languages: ['dart'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['analysis_options.yaml'],
    command: ['dart', 'format'],
    installHint: 'install the Dart SDK (dart format)',
  },
  'swift-format': {
    id: 'swift-format',
    bin: 'swift-format',
    kind: ['format'],
    languages: ['swift'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['.swift-format'],
    installHint: 'install swift-format (ships with recent Swift toolchains)',
  },
  mix: {
    id: 'mix',
    bin: 'mix',
    kind: ['format'],
    languages: ['elixir'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['.formatter.exs'],
    command: ['mix', 'format'],
    installHint: 'install Elixir (mix format)',
  },
  'dotnet-format': {
    id: 'dotnet-format',
    bin: 'dotnet',
    kind: ['format'],
    languages: ['csharp'],
    toolchain: true,
    projectLocal: [],
    configFiles: ['.editorconfig'],
    command: ['dotnet', 'format'],
    installHint: 'install the .NET SDK (dotnet format)',
  },
});

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINE_CATALOG));

/**
 * Engines that can touch at least one of `languages`. Structural rules are not
 * in this catalog at all: mixdog-graph runs them through structural.mjs.
 */
export function enginesForLanguages(languages) {
  const wanted = new Set(languages || []);
  if (wanted.size === 0) return [...ENGINE_IDS];
  return ENGINE_IDS.filter((id) => ENGINE_CATALOG[id].languages.some((language) => wanted.has(language)));
}

export function engineEntry(id) {
  return ENGINE_CATALOG[String(id || '')] || null;
}
