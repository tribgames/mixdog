#!/usr/bin/env node
// What the Rust core's CI runs for a change (release-gate.yml, job `changes`).
//
// Reads the paths a change touched and the workspace of native/core (`cargo metadata --no-deps`, no build; Cargo may populate its registry index) and decides:
//   scope   all       the whole workspace: a push to main, a manual run, the release gate, or a change that reaches every crate
//           packages  the crates the change can affect: the crates whose files changed, the crates that read a changed file
//                     (a fixture, a recording, a script, a source file of the product they open by path) and every crate that
//                     depends on one of those, including test module readers (the closure over the
//                     reverse dependencies, dev-dependencies included)
//           none      nothing a Rust test can see changed
// and prints, as `name=value` lines (GitHub's output file format), what the build and test jobs take:
//   core, core_scope, core_packages, core_archive_args (`--workspace` or `-p a -p b`), core_filter (a nextest filter),
//   core_pg, core_pg_matrix (the legs of the `core-pg` job: a nextest profile of #[ignore]d Postgres tests per system, for each crate the archive holds),
//   core_tests (the number of test attributes selected), core_legs (partitions per OS), core_build (a build job is needed: tests, or the
//   mixdogd the desktop replays drive), build_matrix, test_matrix.
//
// Soundness rule: shared/unowned paths (including deleted files) select all.
// Owned test paths also propagate: a test filename does not prevent another crate
// from compiling it with #[path]. Dynamic external readers are not narrowed by guesses.
//
// Usage: node scripts/ci/core-select.mjs --changed <file with one path per line> [--all] [--mixdogd-dev true|false] [--mixdogd-windows true|false]
//          [--metadata <cargo metadata json>] [--root <repository root>]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A leg takes about this many tests (about 4,370 s of summed test time over 15,902 tests is 0.27 s a test: a leg of this size is
// four to five minutes of a four-core runner) and a run has at most this many legs per OS.
export const TESTS_PER_LEG = 4000;
export const MAX_LEGS = 4;

// The systems the product ships on, one build job and its test legs each. `nextest` is the name get.nexte.st serves the prebuilt
// binary under. Linux arm64 and macOS x64 are built by mixdogd-build.yml and not tested natively: the code that depends on the
// architecture is seven files (cfg(target_arch)), none of it a behaviour the x64/arm64 pair of these three systems does not run.
export const SYSTEMS = [
  { os: 'linux', runner: 'ubuntu-22.04', nextest: 'linux', exe: '' },
  { os: 'macos', runner: 'macos-15', nextest: 'mac', exe: '' },
  { os: 'windows', runner: 'windows-2022', nextest: 'windows-tar', exe: '.exe' },
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
    requiredFeatures: [...new Set((pkg.targets ?? []).flatMap((target) => target['required-features'] ?? []))],
  }));
}

function crateReaders(root, crates) {
  // One read of each crate's sources, split into what its tests alone compile and the rest.
  const texts = new Map();
  const textOf = (crate) => {
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

  // A crate names a path when its sources spell a prefix of it two or more segments deep (`fixtures/agent`) or join its first
  // two segments one after the other (`.join("fixtures").join("agent")`).
  const names = (path) => {
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
  };
  const readerCache = new Map();
  const readers = (path) => {
    if (readerCache.has(path)) return readerCache.get(path);
    const { plain, joined } = names(path);
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
    // Paths outside a package can be constructed dynamically, scanned by a
    // directory reader, or deleted by this change. Literal hits are not an
    // exhaustive reader inventory, so narrowing here would silently omit tests.
    // Keep PR narrowing for package-owned sources; shared/unknown inputs run all.
    whole = true;
    reasons.push(`${path}: shared or unowned input; reader inventory is not provably complete`);
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

export function selectCore({ root, changed, all = false, mixdogdDev = false, mixdogdWindows = false, metadata }) {
  const crates = readWorkspace({ root, metadata });
  const byName = new Map(crates.map((crate) => [crate.name, crate]));
  const owner = (path) =>
    crates
      .filter((crate) => path === crate.dir || path.startsWith(`${crate.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];

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
  const legs = scope === 'none' ? 0 : Math.min(MAX_LEGS, Math.max(1, Math.ceil(tests / TESTS_PER_LEG)));

  const archiveArgs = scope === 'all' ? '--workspace' : packages.map((name) => `-p ${name}`).join(' ');
  const filter = scope === 'all' ? 'all()' : packages.map((name) => `package(=${name})`).join(' | ');
  // The relay's twin suites are built only with its test-support feature (required-features of its test targets); the feature
  // is named with its package, which cargo accepts only for a package the build selects.
  const features = selected
    .flatMap((crate) => crate.requiredFeatures.map((feature) => `${crate.name}/${feature}`))
    .join(',');
  // The #[ignore]d tests that need a Postgres runtime run from the same archive, one leg per nextest profile and system; a
  // profile whose package is not in the archive has nothing to run, and `--no-tests=fail` would fail it. Linux always, macOS
  // when the run is not a pull request (`all`: a push to main or a manual run), where the runner minutes are the release's.
  const pgSystems = SYSTEMS.filter((system) => system.os === 'linux' || (all && system.os === 'macos'));
  const pgMatrix = PG_PROFILES.filter((profile) => selected.some((crate) => crate.name === profile.package)).flatMap(
    (profile) => pgSystems.map((system) => ({ ...system, profile: profile.name }))
  );

  // The Linux entry scenarios run from the archive and drive the dev daemon even when no Node lane needs it.
  const needsMixdogdDev = mixdogdDev || selected.some((crate) => crate.name === 'mixdog-entry');
  // The Windows hidden-window app boot (desktop-computer) starts the app against this run's Windows dev daemon.
  const wantsDaemon = (system) =>
    (needsMixdogdDev && system.os === 'linux') || (mixdogdWindows && system.os === 'windows');
  const build = SYSTEMS.filter((system) => scope !== 'none' || wantsDaemon(system)).map((system) => ({
    ...system,
    tests: scope !== 'none',
    mixdogd: wantsDaemon(system),
  }));
  const test = [];
  if (scope !== 'none') {
    for (const system of SYSTEMS) {
      for (let part = 1; part <= legs; part += 1) test.push({ ...system, part, of: legs });
    }
  }
  return {
    core: scope !== 'none',
    core_scope: scope,
    core_packages: scope === 'all' ? '' : packages.join(' '),
    core_archive_args: archiveArgs,
    core_filter: filter,
    core_features: features,
    core_pg: pgMatrix.length > 0,
    core_pg_matrix: JSON.stringify({ include: pgMatrix }),
    core_tests: tests,
    core_legs: legs,
    core_build: build.length > 0,
    build_matrix: JSON.stringify({ include: build }),
    test_matrix: JSON.stringify({ include: test }),
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
  });
  const { reasons, ...outputs } = result;
  for (const reason of reasons) console.error(`[core-select] ${reason}`);
  console.error(
    `[core-select] scope ${result.core_scope}: ${result.core_packages || '(every crate)'}; ${result.core_tests} tests, ${result.core_legs} leg(s) per system`
  );
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`);
}
