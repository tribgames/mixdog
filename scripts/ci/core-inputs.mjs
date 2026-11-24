// The paths whose change can change what a job of the Rust core builds or tests (core-build, core-tests, core-pg, core-entry,
// core-lint, core-real). A change that reaches none of them runs none of those jobs (core-select.mjs). Outside native/core they
// were found, not guessed: `outsideReads` lists every path a tracked core source names beyond native/core (include_str!,
// include_bytes!, include!, #[path], mixdog-testkit's fixture!/fixture_bytes!/fixture_const! (relative to the calling crate),
// and the `..` joins of CARGO_MANIFEST_DIR in sources and build scripts), and
// scripts/ci/release-gate-wiring.test.mjs fails on one this list does not cover, on a reach to the repository root or to a base
// it cannot resolve that REVIEWED does not explain, and on a REVIEWED site that no longer reaches out.
import { posix } from 'node:path';

// What a test reads when it starts the Node runtime from the package root (js-runtime.json `packageRoot`): the runtime's
// sources, the protocol packages it imports, the launcher, and the root manifest and lockfile it is installed from (the
// legs install pptxgenjs, jszip and @napi-rs/canvas from that lockfile).
const NODE_RUNTIME = ['src/', 'packages/', 'bin/', 'package.json', 'package-lock.json'];

export const CORE_INPUTS = [
  /^native\/core\//,
  // The libraries the core builds from these trees; mixdog-testkit native_mirrors reads their manifests and build scripts.
  /^native\/(mixdog-spawn|mixdog-patch|mixdog-graph|mixdog-secure-desktop)\//,
  // mixdog-tools desktop/computer_recovery.rs reads the helper's sources; computer_gnome_extension.rs looks for
  // native/gnome-extension above the executable, which in a test run is the checkout's.
  /^native\/mixdog-computer\/src\//,
  /^native\/gnome-extension\//,
  // core-real's tree-helper unit tests run with native/.config/nextest-standalone.toml; core-lint formats with native/rustfmt.toml.
  /^native\/\.config\//,
  /^native\/rustfmt\.toml$/,
  /^rust-toolchain\.toml$/,
  // The jobs themselves: this workflow, its actions and helper scripts, the CI scripts and the core's own scripts.
  /^\.github\/workflows\/release-gate\.yml$/,
  /^\.github\/actions\//,
  /^\.github\/scripts\/wait-for-artifact\.sh$/,
  /^scripts\/ci\//,
  /^scripts\/rust-core\//,
  // core-real's suites and the effort judge's request fixture (mixdog-services effort_judge/host_tests.rs).
  /^benchmarks\/token-lang\//,
  /^benchmarks\/terminal-bench-2\.1\/harness\//,
  // The Node runtime and what the core embeds from it (manifests, defaults, rules, skills), and the protocol packages.
  /^src\//,
  /^packages\//,
  /^bin\//,
  /^package(-lock)?\.json$/,
  // mixdog-cli build.rs (the Windows icon), mixdog-relay tests/tool_coturn.rs and tests/pages.rs.
  /^apps\/desktop\/build\/mixdog\.ico$/,
  /^apps\/relay\/deploy\/coturn\//,
  /^apps\/mobile\/src\/index\.html$/,
  /^apps\/desktop\/src\/renderer\/remote-pairing-screen\.ts$/,
  // mixdog-app-server-daemon compose_connections_language.rs embeds the catalogs; mixdog-imaging tests/features.rs reads the
  // generated image types.
  /^apps\/desktop\/src\/shared\/native-ui-catalogs\.json$/,
  /^apps\/desktop\/src\/shared\/image-types\.generated\.ts$/,
];

/** A path, or a folder named without its trailing slash, that a core job reads. */
export const isCoreInput = (path) => CORE_INPUTS.some((re) => re.test(path) || re.test(`${path}/`));

// The sites whose reach the scan cannot resolve to a path (the repository root, or a `..` join of a base other than the
// crate's own directory), each with what it reads, reviewed by reading the code.
export const REVIEWED = {
  'native/core/crates/mixdog-entry/tests/node_free.rs': {
    reads: NODE_RUNTIME,
    why: 'the Node runtime from the package root',
  },
  'native/core/crates/mixdog-tui/tests/support/daemon.rs': {
    reads: NODE_RUNTIME,
    why: 'the Node runtime from the package root',
  },
  'native/core/crates/mixdog-office/tests/live_com/other.rs': {
    reads: NODE_RUNTIME,
    why: 'the script runtime from the package root',
  },
  'native/core/crates/mixdog-office/tests/pptx_script.rs': {
    reads: NODE_RUNTIME,
    why: 'the pptx script entry and node_modules/pptxgenjs (installed from package-lock.json)',
  },
  'native/core/crates/mixdog-mcp/build.rs': {
    reads: ['src/runtime/shared/google-oauth-client.generated.json'],
    why: 'the gitignored OAuth client file it embeds, watched through its nearest existing folder',
  },
  'native/core/crates/mixdog-relay/tests/pages.rs': {
    reads: ['apps/mobile/src/index.html', 'apps/desktop/src/renderer/remote-pairing-screen.ts'],
    why: 'repo_file() of the two pages that carry the pairing CSS',
  },
  'native/core/crates/mixdog-skill-scripts/tests/launch.rs': {
    reads: ['src/'],
    why: 'repo_file() of the shipped skill scripts',
  },
  'native/core/crates/mixdog-core-replays/tests/workflow/context.rs': {
    reads: ['src/'],
    why: 'the shipped workflow packs under src',
  },
  'native/core/crates/mixdog-app-server-daemon/src/discovery/tests.rs': {
    reads: ['packages/protocol-client/src/launch/ensure-core.mjs'],
    why: 'the Node client launcher the same-PID attach test imports',
  },
  'native/core/crates/mixdog-tools/src/code_graph/tests.rs': {
    reads: [],
    why: 'measure_the_heap_of_this_repositorys_graph walks the whole checkout, but is #[ignore] ("a measurement, not a check") and run by no profile',
  },
  'native/core/crates/mixdog-testkit/tests/native_mirrors.rs': {
    reads: [
      'native/mixdog-spawn/Cargo.toml',
      'native/mixdog-patch/Cargo.toml',
      'native/mixdog-graph/Cargo.toml',
      'native/mixdog-secure-desktop/Cargo.toml',
    ],
    why: 'the manifests, library sources and build scripts of the four mirrored tools (MIRRORED), from crates/../../<name>',
  },
};

const DOTDOT = /"((?:\.\.\/)*\.\.\/?[^"]*|\.\.)"((?:\s*\)?\s*\.join\(\s*"[^"]+"\s*\))*)/g;
const REPO_LITERAL =
  /"((?:src|apps|packages|scripts|bin|benchmarks|native|vendor|docs|design|changelog|LICENSES|node_modules)\/[^"]+|package(?:-lock)?\.json)"/g;

const crateDirOf = (file, manifests) => {
  let dir = posix.dirname(file);
  while (dir !== '.' && !manifests.has(`${dir}/Cargo.toml`)) dir = posix.dirname(dir);
  return dir;
};
const outside = (path) => !path.startsWith('native/core/');

/** Which characters of a Rust source are code: not inside a comment, nor inside a string or character literal (its quotes are). */
export function codeMap(text) {
  const code = new Uint8Array(text.length).fill(1);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      code.fill(0, i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      code.fill(0, i, j);
      i = j;
    } else if ((c === 'r' || c === 'b') && !/\w/.test(text[i - 1] ?? '') && /^b?r#*"/.test(text.slice(i, i + 40))) {
      const open = /^b?r(#*)"/.exec(text.slice(i, i + 40));
      const close = `"${open[1]}`;
      const start = i + open[0].length;
      const end = text.indexOf(close, start);
      const stop = end < 0 ? text.length : end;
      code.fill(0, start, stop);
      i = stop + close.length;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      code.fill(0, i + 1, j);
      i = j + 1;
    } else if (c === "'") {
      const char = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/u.exec(text.slice(i, i + 16));
      if (char) code.fill(0, i + 1, i + char[0].length - 1);
      i += char ? char[0].length : 1;
    } else i += 1;
  }
  return code;
}

// The argument of a macro call whose `(` is at `open`: up to its matching `)`, counting the parentheses of code only.
function macroArgument(text, code, open) {
  const close = { '(': ')', '[': ']', '{': '}' }[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (!code[i]) continue;
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === close && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

// A macro call in any of its delimiters: `(`, `[`, `{`.
const OPEN = String.raw`\s*[(\[{]`;

// A path a macro argument names: a string literal (relative to `dir`), or concat! of string literals that may start with
// env!("CARGO_MANIFEST_DIR") (the crate) or env!("OUT_DIR") (the crate's own build-script output, so the crate). Anything else
// (a macro variable, another macro, a const) is null: the scan cannot resolve it.
function namedPath(argument, dir, crate) {
  const literal = /^\s*"([^"\\]*)"\s*$/.exec(argument);
  if (literal) return posix.normalize(posix.join(dir, literal[1]));
  const concat = /^\s*concat!\s*[([{]([\s\S]*)[)\]}]\s*$/.exec(argument);
  if (!concat) return null;
  const body = concat[1].trim().replace(/,$/, '');
  const parts = [
    ...body.matchAll(/\s*(?:env!\s*[([{]\s*"(CARGO_MANIFEST_DIR|OUT_DIR)"\s*[)\]}]|"([^"\\]*)")\s*(?:,|$)/gy),
  ];
  if (parts.map((part) => part[0]).join('') !== body || !parts.length) return null;
  const [first, ...rest] = parts;
  if (first[1] === 'OUT_DIR') return crate;
  const base = first[1] === 'CARGO_MANIFEST_DIR' ? crate : dir;
  const tail = [...(first[1] ? [] : [first[2]]), ...rest.map((part) => part[2] ?? '')].join('');
  if (rest.some((part) => part[1])) return null;
  return posix.normalize(posix.join(base, tail.replace(/^\/+/, '')));
}

/**
 * Every reach of one core source (`file`, of the crate at `crate`) that the scan recognises: include_str!, include_bytes!,
 * include! of a literal or of concat! (env!("CARGO_MANIFEST_DIR"), env!("OUT_DIR"), literals), concat!(env!("CARGO_MANIFEST_DIR"),
 * ...) anywhere, #[path] and #[cfg_attr(..., path = ...)], the testkit's fixture macros (relative to the crate), and the `..` joins
 * and ancestors()/parent() climbs of CARGO_MANIFEST_DIR. Names in comments and strings are not reaches. An include whose path the
 * scan cannot resolve is a reach all the same (`review: 'include'`).
 * @returns {{line: number, path?: string, review?: string}[]} `path`: the repository path it resolves to; `review`: a reach
 *   it cannot resolve (`root`: the repository root; `base`: a `..` join of a base other than the crate's own directory;
 *   `include`: an include of a path it cannot name)
 */
export function reachesOf(file, text, crate) {
  const reaches = [];
  const code = codeMap(text);
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const reach = (index, path) => {
    const line = lineAt(index);
    if (path === null) reaches.push({ line, review: 'include' });
    else if (path === '.' || path === '..' || path.startsWith('../')) reaches.push({ line, review: 'root' });
    else reaches.push({ line, path });
  };
  const literal = (argument, dir) => {
    const value = /^\s*"([^"\\]*)"\s*,?\s*$/.exec(argument ?? '');
    return value ? posix.normalize(posix.join(dir, value[1])) : null;
  };
  const macros = new RegExp(
    String.raw`\b(?:r#)?(include(?:_str|_bytes)?|concat|fixture(?:_bytes|_const)?)!${OPEN}`,
    'g'
  );
  for (const match of text.matchAll(macros)) {
    if (!code[match.index]) continue;
    const argument = macroArgument(text, code, match.index + match[0].length - 1);
    if (match[1] === 'concat') {
      // A concat! inside an include is the include's argument; elsewhere it names a path only from the manifest directory.
      if (
        new RegExp(String.raw`include(?:_str|_bytes)?!${OPEN}\s*$`).test(
          text.slice(Math.max(0, match.index - 40), match.index)
        )
      )
        continue;
      if (
        argument === null ||
        !/^\s*env!\s*[([{]\s*"CARGO_MANIFEST_DIR"\s*[)\]}]/.test(argument) ||
        argument.includes('$')
      )
        continue;
      const path = namedPath(`concat!(${argument})`, posix.dirname(file), crate);
      if (path !== null) reach(match.index, path);
    } else if (match[1].startsWith('fixture')) reach(match.index, literal(argument, crate));
    else reach(match.index, argument === null ? null : namedPath(argument, posix.dirname(file), crate));
  }
  // #[path = "..."] and #[cfg_attr(<predicate>, path = "...")], across lines; a path the scan cannot read is a reach still.
  for (const match of text.matchAll(/#\s*\[\s*(path|cfg_attr)\b/g)) {
    if (!code[match.index]) continue;
    const after = match.index + match[0].length;
    if (match[1] === 'path') {
      const value = /^\s*=\s*("([^"\\]*)")?/.exec(text.slice(after));
      if (value)
        reach(match.index, value[2] !== undefined ? posix.normalize(posix.join(posix.dirname(file), value[2])) : null);
      continue;
    }
    const open = text.slice(after).search(/\S/) + after;
    const argument = text[open] === '(' ? macroArgument(text, code, open) : null;
    if (argument === null) continue;
    for (const inner of argument.matchAll(/\bpath\s*=\s*("([^"\\]*)")?/g)) {
      if (!code[open + 1 + inner.index]) continue;
      reach(match.index, inner[2] !== undefined ? posix.normalize(posix.join(posix.dirname(file), inner[2])) : null);
    }
  }
  const joinsManifest = /CARGO_MANIFEST_DIR/.test(text) || file.endsWith('/build.rs');
  let offset = 0;
  text.split('\n').forEach((line, index) => {
    const start = offset;
    offset += line.length + 1;
    const inCode = (match) => code[start + match.index] === 1;
    const at = { line: index + 1 };
    if (/^\s*\/\//.test(line)) return;
    if (/CARGO_MANIFEST_DIR/.test(line)) {
      const nth = /\.ancestors\(\)\s*\.nth\(\s*(\d+)\s*\)/.exec(line);
      const ups = nth ? Number(nth[1]) : (line.match(/\.parent\(\)/g) ?? []).length;
      if (ups > 0) {
        let path = posix.normalize(posix.join(crate, ...Array(ups).fill('..')));
        for (const join of line.matchAll(/join\(\s*"([^"]+)"\s*\)/g)) path = posix.normalize(posix.join(path, join[1]));
        reaches.push(
          path === '.' || path === '..' || path.startsWith('../') ? { ...at, review: 'root' } : { ...at, path }
        );
      }
    }
    if (!joinsManifest || /include(?:_str|_bytes)?!|#\[path|fixture(?:_bytes|_const)?!|concat!/.test(line)) return;
    for (const match of line.matchAll(DOTDOT)) {
      if (!inCode(match)) continue;
      const ups = match[1].split('/').filter((part) => part === '..').length;
      let path = posix.normalize(posix.join(crate, match[1]));
      for (const join of (match[2] ?? '').matchAll(/join\(\s*"([^"]+)"/g))
        path = posix.normalize(posix.join(path, join[1]));
      const ownBase = /CARGO_MANIFEST_DIR|manifest_dir|crate_dir/.test(line) || file.endsWith('/build.rs');
      if (path === '.' || path === '..' || path.startsWith('../')) reaches.push({ ...at, review: 'root' });
      else if (outside(path) || ownBase || ups < 2) reaches.push({ ...at, path });
      else reaches.push({ ...at, review: 'base' });
    }
  });
  return reaches;
}

/**
 * The repository paths a build script names in a string beyond the macros reachesOf reads: the files of its
 * `cargo:rerun-if-changed=` lines and of `.set_icon("...")`, relative to the crate's own directory.
 * @returns {string[]}
 */
export function buildScriptReads(text, crate) {
  const paths = [];
  for (const match of text.matchAll(/(?:rerun-if-changed=|set_icon\(\s*")((?:\.\.\/)+[^"{}\s)]+)/g)) {
    const path = posix.normalize(posix.join(crate, match[1]));
    if (!path.startsWith('../') && path !== '..') paths.push(path);
  }
  return paths;
}

/**
 * Every reach of a tracked core source beyond native/core.
 * @param {string[]} tracked tracked repository paths
 * @param {(path: string) => string} read
 * @returns {{file: string, line: number, path?: string, review?: string, literals?: string[]}[]} `path`: a resolved path;
 *   `review`: a reach the scan cannot resolve (`root`, `base`), with the repository-relative literals of its file
 */
export function outsideReads(tracked, read) {
  const manifests = new Set(tracked.filter((path) => path.endsWith('/Cargo.toml')));
  const sites = [];
  for (const file of tracked) {
    if (!file.startsWith('native/core/') || !file.endsWith('.rs') || file.includes('/vendor/')) continue;
    const text = read(file);
    const literals = [...text.matchAll(REPO_LITERAL)].map((match) => match[1]);
    for (const reach of reachesOf(file, text, crateDirOf(file, manifests))) {
      if (reach.review) sites.push({ file, line: reach.line, review: reach.review, literals });
      else if (outside(reach.path)) sites.push({ file, line: reach.line, path: reach.path });
    }
  }
  return sites;
}

/** What is wrong with the declared inputs against the scan: an empty list when every reach is covered. */
export function inputProblems(tracked, read) {
  const problems = [];
  const sites = outsideReads(tracked, read);
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    if (site.path !== undefined) {
      if (!isCoreInput(site.path)) problems.push(`${where} reads ${site.path}, which CORE_INPUTS does not cover`);
      continue;
    }
    const reviewed = REVIEWED[site.file];
    if (!reviewed) {
      const what = {
        root: 'the repository root',
        base: 'a base the scan cannot resolve',
        include: 'an include path the scan cannot resolve',
      };
      problems.push(`${where} reaches ${what[site.review]}: read it, list what it reads in REVIEWED`);
      continue;
    }
    for (const literal of site.literals)
      if (!isCoreInput(literal) && !(literal.startsWith('node_modules/') && isCoreInput('package-lock.json')))
        problems.push(`${where} names ${literal}, which CORE_INPUTS does not cover`);
  }
  for (const [file, reviewed] of Object.entries(REVIEWED)) {
    if (!sites.some((site) => site.file === file && site.review))
      problems.push(`REVIEWED names ${file}, which no longer reaches outside native/core: remove it`);
    for (const path of reviewed.reads)
      if (!isCoreInput(path)) problems.push(`REVIEWED ${file} reads ${path}, which CORE_INPUTS does not cover`);
  }
  return problems;
}
