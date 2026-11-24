#!/usr/bin/env node
// Prints, as `name=value` lines (GitHub's output file format): core, core_scope (all | packages | none), core_packages,
// core_archive_args, core_filter, core_features, core_pg, core_pg_matrix, core_pg_macos, core_pg_macos_profiles, core_entry,
// core_tests, core_build, mixdogd_linux, mixdogd_windows, test_matrix_linux, test_matrix_macos, test_matrix_windows, core_systems,
// core_macos, core_windows, build_matrix_<os>, core_real_matrix, lint_matrix, core_doctests, core_daemon, store_key_<program>.
//
// --all is the full gate (every crate, three systems); without it a push or a pull request (the crates the change can affect,
// Linux). Also store_key_<program>: the content key of each program a job keeps in its store (STORES).
//
// Usage: node scripts/ci/core-select.mjs --changed <file with one path per line> [--all] [--mixdogd-dev true|false] [--mixdogd-windows true|false]
//          [--metadata <cargo metadata json>] [--root <repository root>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isCoreInput, reachesOf, REVIEWED } from './core-inputs.mjs';

// A leg takes about this many tests (about 4,370 s of summed test time over 15,902 tests is 0.27 s a test: a leg of this size is
// four to five minutes of a four-core runner) and a run has at most `maxLegs` legs per OS. A system whose tests run slower
// names a smaller share of its own (`testsPerLeg`).
export const TESTS_PER_LEG = 4000;

// The systems the product ships on, one build job and its test legs each. `nextest` is the name get.nexte.st serves the prebuilt
// binary under. Linux arm64 and macOS x64 are built by mixdogd-build.yml and not tested natively: the code that depends on the
// architecture is seven files (cfg(target_arch)), none of it a behaviour the x64/arm64 pair of these three systems does not run.
// macOS has three legs: an account runs five macOS jobs at once, and on a push to main its legs share them with the one
// Postgres job and core-real's release build (run 44943772315: four legs, two Postgres legs and core-real queued two legs 4 and
// 7 minutes behind the archive). Windows runs a partition of 4,000 tests in 8-9 minutes where Linux takes 3-4 (run 44959677392),
// after the longest archive build: it takes 3,000 tests a leg and up to six legs, when the Linux runners the other lanes used are free.
// Linux takes 3,000 a leg and up to six too: its legs end a push's run, each pays about a minute of setup, and four legs of 19,085
// tests ran partitions of 116-199 s (run 45068609184), so six bring the slowest near two minutes of tests beside that minute.
export const SYSTEMS = [
  { os: 'linux', runner: 'ubuntu-22.04', nextest: 'linux', exe: '', maxLegs: 6, testsPerLeg: 3000 },
  { os: 'macos', runner: 'macos-15', nextest: 'mac', exe: '', maxLegs: 3 },
  { os: 'windows', runner: 'windows-2022', nextest: 'windows-tar', exe: '.exe', maxLegs: 6, testsPerLeg: 3000 },
];

const HACK = 'mixdog-workspace-hack';
// The nextest profiles of the #[ignore]d tests that need a Postgres runtime (native/core/.config/nextest.toml), each with the one
// crate whose tests it selects.
export const PG_PROFILES = [
  { name: 'services-pg', package: 'mixdog-services' },
  { name: 'pg', package: 'mixdog-app-server-daemon' },
];
const slash = (path) => path.split(sep).join('/');

// A change to any of these reaches every crate: the build's own inputs, and this gate.
const WHOLE = [
  /^native\/core\/(Cargo\.(toml|lock)|clippy\.toml)$/,
  /^native\/rustfmt\.toml$/,
  /^native\/core\/(\.cargo|\.config|build-support)\//,
  /^rust-toolchain\.toml$/,
  /^\.github\/workflows\/release-gate\.yml$/,
  /^\.github\/actions\/install-nextest\/action\.yml$/,
  /^scripts\/ci\//,
];

// The libraries of four standalone native tools are built into the core by the crates of the same name (their sources are
// `path = "../../../mixdog-spawn/src/lib.rs"` and so on); their own tests are not compiled by the core.
const STANDALONE = /^native\/(mixdog-(?:spawn|patch|graph|secure-desktop))\/(?:src\/|Cargo\.(?:toml|lock)$|build\.rs$)/;

// Reader text classification only. Test filenames never suppress reverse-dependency propagation.
const TEST_ONLY = /(^|\/)(tests|benches|examples)\/|_tests?\.rs$|\/tests\.rs$/;
// The folders of a crate (relative to it) that only its test, bench and example targets compile.
const TARGET_ONLY = /^(tests|benches|examples)\//;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walkRust(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkRust(path, out);
    else if (entry.name.endsWith('.rs')) out.push(path);
  }
  return out;
}

export function readWorkspace({ root, metadata }) {
  const meta =
    metadata ??
    JSON.parse(
      execFileSync(
        'cargo',
        [
          'metadata',
          '--locked',
          '--no-deps',
          '--format-version',
          '1',
          '--manifest-path',
          join(root, 'native/core/Cargo.toml'),
        ],
        { cwd: join(root, 'native/core'), encoding: 'utf8', maxBuffer: 1 << 28 }
      )
    );
  const names = new Set(meta.packages.map((pkg) => pkg.name));
  return meta.packages.map((pkg) => ({
    name: pkg.name,
    dir: slash(relative(root, resolve(pkg.manifest_path, '..'))),
    deps: [...new Set(pkg.dependencies.map((dep) => dep.name).filter((name) => names.has(name)))],
    // What a build of the crate compiles: normal and build dependencies, optional ones included.
    buildDeps: [
      ...new Set(
        pkg.dependencies
          .filter((dep) => dep.kind !== 'dev')
          .map((dep) => dep.name)
          .filter((name) => names.has(name))
      ),
    ],
    requiredFeatures: [...new Set((pkg.targets ?? []).flatMap((target) => target['required-features'] ?? []))],
  }));
}

// One read of each crate's sources, split into what its tests alone compile and the rest.
function crateTexts(root) {
  const texts = new Map();
  return (crate) => {
    if (!texts.has(crate.name)) {
      const product = [];
      const tests = [];
      let count = 0;
      for (const file of walkRust(join(root, crate.dir))) {
        const text = readFileSync(file, 'utf8');
        const inside = slash(relative(join(root, crate.dir), file));
        (TEST_ONLY.test(inside) ? tests : product).push(text);
        count += (text.match(/#\[\s*(?:[A-Za-z0-9_]+::)*(?:test|rstest|test_case)\b/g) ?? []).length;
      }
      texts.set(crate.name, { product: product.join('\n'), tests: tests.join('\n'), count });
    }
    return texts.get(crate.name);
  };
}

// A crate names a path when its sources spell a prefix of it two or more segments deep (`fixtures/agent`) or join its first
// two segments one after the other (`.join("fixtures").join("agent")`).
function pathNames(path) {
  const parts = path.split('/');
  const forms = [parts];
  if (path.startsWith('native/core/')) forms.push(parts.slice(2));
  if (path.startsWith('native/core/crates/')) forms.push(parts.slice(3));
  const plain = new Set();
  const joined = [];
  for (const form of forms) {
    const minimum = form[0] === 'native' && form[1] === 'core' ? 4 : 2;
    for (let end = form.length; end >= minimum; end -= 1) plain.add(form.slice(0, end).join('/'));
    if (form.length === 1) plain.add(form[0]);
    if (form.length >= 2 && minimum === 2)
      joined.push(new RegExp(`"${escapeRegExp(form[0])}"[\\s\\S]{0,160}?"${escapeRegExp(form[1])}"`));
  }
  return { plain: [...plain], joined };
}

function crateReaders(root, crates) {
  const textOf = crateTexts(root);
  const readerCache = new Map();
  const readers = (path) => {
    if (readerCache.has(path)) return readerCache.get(path);
    const { plain, joined } = pathNames(path);
    const hit = (text) => plain.some((key) => text.includes(key)) || joined.some((re) => re.test(text));
    const product = [];
    const testOnly = [];
    for (const crate of crates) {
      if (crate.name === HACK) continue;
      const text = textOf(crate);
      if (hit(text.product)) product.push(crate.name);
      else if (hit(text.tests)) testOnly.push(crate.name);
    }
    const result = { product, testOnly };
    readerCache.set(path, result);
    return result;
  };
  return { textOf, readers };
}
function classifyChanges({ changed, all, owner, readers }) {
  let whole = all;
  const direct = new Set();
  const propagate = new Set();
  const reasons = [];
  for (const raw of changed) {
    const path = slash(raw.trim());
    if (!path) continue;
    if (whole) break;
    // Only the standalone jobs load this file; workspace jobs use native/core/.config/nextest.toml.
    if (path === 'native/.config/nextest-standalone.toml') continue;
    if (WHOLE.some((re) => re.test(path))) {
      whole = true;
      reasons.push(`${path}: reaches every crate`);
      continue;
    }
    const standalone = STANDALONE.exec(path);
    if (standalone) {
      direct.add(standalone[1]);
      propagate.add(standalone[1]);
      continue;
    }
    const crate = owner(path);
    if (crate) {
      if (crate.name === HACK) {
        whole = true;
        reasons.push(`${path}: the workspace hack changes every crate's features`);
        continue;
      }
      direct.add(crate.name);
      // A tests/ filename is not ownership proof: other crates use #[path]
      // to compile those very modules (app-server-daemon reads app-server tests).
      // Propagate all owned changes and include every visible source reader.
      propagate.add(crate.name);
      const found = readers(path);
      for (const name of [...found.product, ...found.testOnly]) {
        direct.add(name);
        propagate.add(name);
      }
      continue;
    }
    // Outside the crates: a declared core input reaches every crate, since its readers are not provably complete; any other path
    // is read by no core job (scripts/ci/core-inputs.mjs: the wiring test fails on a core source that reads outside that set).
    // The sources' mention of a path is no reader proof here: README.md, apps/desktop and the mobile workflows are named in
    // comments and messages of crates that never read them.
    if (isCoreInput(path)) {
      whole = true;
      reasons.push(`${path}: a core input outside the crates; reader inventory is not provably complete`);
    }
  }
  return { whole, direct, propagate, reasons };
}

function affectedPackages({ crates, byName, direct, propagate, readers }) {
  // Reverse dependencies of every changed or reading crate, including dev dependencies.
  const reached = new Set(propagate);
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...reached]) {
      const source = byName.get(name);
      if (!source) continue;
      const found = readers(source.dir);
      for (const reader of [...found.product, ...found.testOnly]) {
        if (!reached.has(reader)) {
          reached.add(reader);
          grew = true;
        }
      }
    }
    for (const crate of crates) {
      if (!reached.has(crate.name) && crate.deps.some((dep) => reached.has(dep))) {
        reached.add(crate.name);
        grew = true;
      }
    }
  }
  const affected = new Set([...direct, ...reached]);
  // Core media replays spawn this binary beside deps; include its package so
  // nextest archives the non-test executable and its CARGO_BIN_EXE metadata.
  if (affected.size && byName.has('mixdog-exthost-worker')) affected.add('mixdog-exthost-worker');
  affected.delete(HACK);
  return [...affected].filter((name) => byName.has(name)).sort();
}

// The #[ignore]d tests that need a Postgres runtime run from the same archive; a profile whose package is not in the archive
// has nothing to run, and `--no-tests=fail` would fail it. Linux always, one leg per profile; macOS in the full gate (`all`),
// both profiles in one job
// (core-pg-macos) so its legs fit the five macOS jobs an account runs at once.
function pgProfilesOf(selected) {
  return PG_PROFILES.filter((profile) => selected.some((crate) => crate.name === profile.package)).map(
    (profile) => profile.name
  );
}

// The manifest folders of the packages whose rustdoc blocks a doctest leg runs (coverage/plan.json `rust.doctests`).
const DOCTEST_DIRS = JSON.parse(
  readFileSync(new URL('./coverage/plan.json', import.meta.url), 'utf8')
).rust.doctests.map((entry) => entry.manifestDir);

// core-real's systems, with the target of the shipped mixdogd the release's call boots (release.yml `mixdogd`).
const REAL = {
  linux: { runner: 'ubuntu-22.04', unix: true, target: 'x86_64-unknown-linux-gnu' },
  macos: { runner: 'macos-15', unix: true, target: 'aarch64-apple-darwin' },
  windows: { runner: 'windows-2022', unix: false, target: 'x86_64-pc-windows-msvc' },
};
function jobMatrices({ scope, tests, entry, mixdogdDev, mixdogdWindows, systems }) {
  // The dev daemon is its own job per system (`mixdogd-linux`, `mixdogd-windows`), beside the archive build rather than after it. The Linux entry scenarios
  // (core-entry) drive it even when no Node lane needs it. The Windows hidden-window app boot (desktop-computer) starts the
  // app against this run's Windows dev daemon.
  const wantsDaemon = (system) =>
    ((mixdogdDev || entry) && system.os === 'linux') || (mixdogdWindows && system.os === 'windows');
  const mixdogd = SYSTEMS.filter(wantsDaemon).map(({ maxLegs, testsPerLeg, ...system }) => system);
  // One test job per system, each needing only its own system's archive.
  const test = {};
  const build = {};
  for (const { maxLegs, testsPerLeg = TESTS_PER_LEG, ...system } of SYSTEMS) {
    const on = scope !== 'none' && systems.includes(system.os);
    const legs = on ? Math.min(maxLegs, Math.max(1, Math.ceil(tests / testsPerLeg))) : 0;
    test[system.os] = Array.from({ length: legs }, (_, index) => ({ ...system, part: index + 1, of: legs }));
    // One build of the selection per system, on one runner.
    build[system.os] = on ? [{ os: system.os, runner: system.runner }] : [];
  }
  return { mixdogd, test, build };
}

// The crate that owns a path: the one with the deepest directory containing it.
const ownerOf = (crates) => (path) =>
  crates
    .filter((crate) => path === crate.dir || path.startsWith(`${crate.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];

// The programs a job keeps in a store keyed by their inputs instead of building them again (release-gate.yml): the development
// mixdogd with the two programs built beside it (jobs mixdogd-<os>), the release mixdogd (core-real), the relay (relay-rust).
export const STORES = {
  mixdogd_dev: ['mixdog-cli', 'mixdog-entry', 'mixdog-askpass'],
  mixdogd: ['mixdog-cli'],
  relay: ['mixdog-relay'],
};

/**
 * The content key of a program built from `packages`: the mode, object and path of every tracked core input (core-inputs.mjs),
 * without the files of the crates its build does not compile. A crate is compiled when it is a normal or build dependency of one
 * compiled (optional ones included, whatever the features), or when a source the build compiles (any but a crate's tests/,
 * benches/ and examples/, and every file a compiled one includes) reaches into it (core-inputs.mjs reachesOf:
 * include_str!, include_bytes!, include!, #[path], the fixture macros, the CARGO_MANIFEST_DIR climbs; a reach to the repository
 * root counts what REVIEWED says it reads, and a reach the scan cannot resolve counts every crate). Every other input stays in the
 * key: the build's own files, the toolchain, this gate and its scripts, the Node runtime the core embeds.
 * @param {string[]} stage `git ls-files -s` entries: `<mode> <object> <stage>\t<path>`
 */
function storeKey({ root, crates, stage, packages }) {
  const byName = new Map(crates.map((crate) => [crate.name, crate]));
  const owner = ownerOf(crates);
  const paths = stage.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const tracked = new Set(paths);
  // A program's build compiles no file of a crate's tests/, benches/ or examples/ unless a compiled source includes it.
  const sources = new Map();
  for (const path of paths) {
    const crate = path.endsWith('.rs') && !path.includes('/vendor/') && owner(path);
    if (crate && !TARGET_ONLY.test(path.slice(crate.dir.length + 1)))
      sources.set(crate.name, [...(sources.get(crate.name) ?? []), path]);
  }
  const built = new Set();
  const scanned = new Set();
  const pending = [...packages];
  const files = [];
  const add = (name) => {
    if (name && !built.has(name)) pending.push(name);
  };
  while (pending.length || files.length) {
    if (pending.length) {
      const name = pending.pop();
      if (built.has(name)) continue;
      built.add(name);
      const crate = byName.get(name);
      if (!crate) continue;
      for (const dep of crate.buildDeps) add(dep);
      files.push(...(sources.get(name) ?? []));
      continue;
    }
    const file = files.pop();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const base = owner(file)?.dir ?? file.slice(0, file.lastIndexOf('/'));
    for (const reach of reachesOf(file, readFileSync(join(root, file), 'utf8'), base)) {
      if (reach.path !== undefined) {
        add(owner(reach.path)?.name);
        if (reach.path.endsWith('.rs') && tracked.has(reach.path)) files.push(reach.path);
      } else if (reach.review === 'root') for (const path of REVIEWED[file]?.reads ?? []) add(owner(path)?.name);
      else for (const other of crates) add(other.name);
    }
  }
  const hash = createHash('sha256').update(`${packages.join(',')}\n`);
  paths.forEach((path, index) => {
    const crate = owner(path);
    if (isCoreInput(path) && (!crate || built.has(crate.name))) hash.update(`${stage[index]}\n`);
  });
  return hash.digest('hex').slice(0, 40);
}

/**
 * @param {object} options
 * @param {boolean} [options.all] the full gate: every crate on the three systems, whatever changed (otherwise a push or a pull
 *   request: the crates the change can affect, on Linux)
 * @param {string[]} [options.stage] the tracked files (`git ls-files -s`), for the store keys
 */
export function selectCore({
  root,
  changed,
  all = false,
  mixdogdDev = false,
  mixdogdWindows = false,
  metadata,
  stage,
}) {
  const crates = readWorkspace({ root, metadata });
  const byName = new Map(crates.map((crate) => [crate.name, crate]));
  const owner = ownerOf(crates);

  const { textOf, readers } = crateReaders(root, crates);
  const { whole, direct, propagate, reasons } = classifyChanges({ changed, all, owner, readers });

  let scope = 'none';
  let packages = [];
  if (whole) {
    scope = 'all';
    packages = crates.map((crate) => crate.name).sort();
  } else {
    packages = affectedPackages({ crates, byName, direct, propagate, readers });
    if (packages.length) scope = 'packages';
  }

  const selected =
    scope === 'all' ? crates.filter((crate) => crate.name !== HACK) : packages.map((name) => byName.get(name));
  const tests = selected.reduce((sum, crate) => sum + textOf(crate).count, 0);

  const archiveArgs = scope === 'all' ? '--workspace' : packages.map((name) => `-p ${name}`).join(' ');
  const filter = scope === 'all' ? 'all()' : packages.map((name) => `package(=${name})`).join(' | ');
  // Some relay test targets are built only with its test-support feature (their required-features); the feature
  // is named with its package, which cargo accepts only for a package the build selects.
  const features = selected
    .flatMap((crate) => crate.requiredFeatures.map((feature) => `${crate.name}/${feature}`))
    .join(',');
  const pgProfiles = pgProfilesOf(selected);
  const [linuxSystem] = SYSTEMS.filter((system) => system.os === 'linux').map(({ maxLegs, ...system }) => system);
  const pgMatrix = pgProfiles.map((profile) => ({ ...linuxSystem, profile }));
  // The full gate tests on the three systems; a push and a pull request on Linux.
  const systems = all ? SYSTEMS.map((system) => system.os) : ['linux'];
  const pgMacos = all ? pgProfiles : [];
  const entry = selected.some((crate) => crate.name === 'mixdog-entry');
  const { mixdogd, test, build } = jobMatrices({ scope, tests, entry, mixdogdDev, mixdogdWindows, systems });
  const real = systems.map((os) => ({ os, ...REAL[os] }));
  // Clippy and the plain stable compile on the systems the archive is built for (the full gate's three, Linux otherwise).
  const lint =
    scope === 'none'
      ? []
      : SYSTEMS.filter((system) => systems.includes(system.os)).map(({ os, runner }) => ({ os, runner }));
  // The doctest packages (coverage/plan.json rust.doctests) the selection holds.
  const doctests = selected.filter((crate) => DOCTEST_DIRS.includes(crate.dir)).map((crate) => crate.name);
  return {
    core: scope !== 'none',
    core_systems: JSON.stringify(scope === 'none' ? [] : systems),
    core_macos: scope !== 'none' && systems.includes('macos'),
    core_windows: scope !== 'none' && systems.includes('windows'),
    build_matrix_linux: JSON.stringify({ include: build.linux }),
    build_matrix_macos: JSON.stringify({ include: build.macos }),
    build_matrix_windows: JSON.stringify({ include: build.windows }),
    core_real_matrix: JSON.stringify({ include: real }),
    lint_matrix: JSON.stringify({ include: lint }),
    core_doctests: JSON.stringify(doctests),
    // Clippy lints the daemon, so it runs when the selection holds it.
    core_daemon: selected.some((crate) => crate.name === 'mixdog-app-server-daemon'),
    core_scope: scope,
    core_packages: scope === 'all' ? '' : packages.join(' '),
    core_archive_args: archiveArgs,
    core_filter: filter,
    core_features: features,
    core_pg: pgMatrix.length > 0,
    core_pg_matrix: JSON.stringify({ include: pgMatrix }),
    core_pg_macos: pgMacos.length > 0,
    core_pg_macos_profiles: JSON.stringify(pgMacos),
    core_entry: entry,
    core_tests: tests,
    core_build: scope !== 'none',
    mixdogd_linux: mixdogd.some((system) => system.os === 'linux'),
    mixdogd_windows: mixdogd.some((system) => system.os === 'windows'),
    test_matrix_linux: JSON.stringify({ include: test.linux }),
    test_matrix_macos: JSON.stringify({ include: test.macos }),
    test_matrix_windows: JSON.stringify({ include: test.windows }),
    ...(stage
      ? {
          store_key_mixdogd_dev: storeKey({ root, crates, stage, packages: STORES.mixdogd_dev }),
          store_key_mixdogd: storeKey({ root, crates, stage, packages: STORES.mixdogd }),
          store_key_relay: storeKey({ root, crates, stage, packages: STORES.relay }),
        }
      : {}),
    reasons,
  };
}

function parseArgs(argv) {
  const out = { all: false, mixdogdDev: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--changed') out.changed = argv[++i];
    else if (arg === '--mixdogd-dev') out.mixdogdDev = argv[++i] === 'true';
    else if (arg === '--mixdogd-windows') out.mixdogdWindows = argv[++i] === 'true';
    else if (arg === '--metadata') out.metadata = argv[++i];
    else if (arg === '--root') out.root = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? fileURLToPath(new URL('../..', import.meta.url)));
  const changed = args.changed ? readFileSync(args.changed, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const result = selectCore({
    root,
    changed,
    all: args.all,
    mixdogdDev: args.mixdogdDev,
    mixdogdWindows: args.mixdogdWindows,
    metadata: args.metadata ? JSON.parse(readFileSync(args.metadata, 'utf8')) : undefined,
    stage: execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter(Boolean),
  });
  const { reasons, ...outputs } = result;
  for (const reason of reasons) console.error(`[core-select] ${reason}`);
  console.error(
    `[core-select] scope ${result.core_scope}: ${result.core_packages || '(every crate)'}; ${result.core_tests} tests, legs ${SYSTEMS.map((system) => `${system.os} ${JSON.parse(result[`test_matrix_${system.os}`]).include.length}`).join(', ')}`
  );
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`);
}
