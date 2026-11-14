#!/usr/bin/env node
// Recording of the shipped skill scripts and the launcher's argument carrier, for the Rust twin
// (native/core/crates/mixdog-skill-scripts/tests/node_twin.rs). Node runs the scripts of a product tree as they are
// shipped, on inputs this file builds in a temporary folder, and the argv, stdout, stderr and exit code of each run are
// written to native/core/fixtures/skill-scripts/golden.json; the inputs are written there too, so the twin builds the
// same folders. Nothing in the tree is written. Node built-ins only.
//
//   node benchmarks/rust-core/recorders/record-skill-scripts.mjs --tree C:\Project\mixdog [--out <fixture folder>]
//
// Runs:
//   validate  src/defaults/skills/skill-creator/scripts/validate-skill.mjs <folder> on every shipped skill of the tree
//             and on broken front matter, bad names, missing referenced files and the other checks;
//   inventory src/defaults/skills/test-suite/scripts/inventory.mjs <root> [--json] on fixture trees, each bound reached
//             (depth, directories, files, bytes read, entries listed);
//   parseArgs util.parseArgs with the options of the shipped scripts and of a synthetic set, on every argument list of
//             a token pool up to three long;
//   carrier   decodeSkillArgv (src/runtime/shared/skill-script-runtime.mjs) on well-formed and malformed values;
//   entry     src/skill-script-entry.mjs with no target, with arguments on the command line and carried in
//             MIXDOG_SKILL_ARGV, and with a missing script.
//
// Paths in the output: the temporary root is written <root> (separators as slashes), today's date <today>.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const flags = parseArgs({ options: { tree: { type: 'string' }, out: { type: 'string' } } }).values;
if (!flags.tree) throw new Error('usage: record-skill-scripts.mjs --tree <product tree with node_modules> [--out <folder>]');
const TREE = resolve(flags.tree);
const OUT = resolve(flags.out ?? join(REPO_ROOT, 'native', 'core', 'fixtures', 'skill-scripts'));
if (!existsSync(join(TREE, 'node_modules'))) throw new Error(`tree ${TREE} has no node_modules`);

const SKILLS = join(TREE, 'src', 'defaults', 'skills');
const VALIDATE = join(SKILLS, 'skill-creator', 'scripts', 'validate-skill.mjs');
const INVENTORY = join(SKILLS, 'test-suite', 'scripts', 'inventory.mjs');
const ENTRY = join(TREE, 'src', 'skill-script-entry.mjs');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const startDay = today();

const slashes = (text) => text.replaceAll('\\', '/');

// ---------------------------------------------------------------------------------------------------------------------
// Inputs: a folder is { files: { rel: text | { base64 } | { repeat, count, suffix? } }, dirs: [rel], gen: [...] }.
// gen: { files: { dir, count, name: 'x{n}.test.js', body } } writes `count` files; { dirs: { dir, count, name: 'd{n}' } } `count` folders.
// ---------------------------------------------------------------------------------------------------------------------
function fileBytes(spec) {
  if (typeof spec === 'string') return Buffer.from(spec, 'utf8');
  if (spec.base64 !== undefined) return Buffer.from(spec.base64, 'base64');
  return Buffer.from(spec.repeat.repeat(spec.count) + (spec.suffix ?? ''), 'utf8');
}

function materialise(root, input) {
  mkdirSync(root, { recursive: true });
  for (const dir of input.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, spec] of Object.entries(input.files ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), fileBytes(spec));
  }
  for (const gen of input.gen ?? []) {
    if (gen.files) {
      const { dir, count, name, body } = gen.files;
      mkdirSync(join(root, dir), { recursive: true });
      for (let n = 0; n < count; n += 1) writeFileSync(join(root, dir, name.replace('{n}', String(n))), body);
    } else {
      const { dir, count, name } = gen.dirs;
      mkdirSync(join(root, dir), { recursive: true });
      for (let n = 0; n < count; n += 1) mkdirSync(join(root, dir, name.replace('{n}', String(n))));
    }
  }
}

function run(script, input, argv) {
  const root = mkdtempSync(join(tmpdir(), 'skill-scripts-'));
  try {
    materialise(root, input);
    const fixed = slashes(root);
    const args = argv.map((arg) => arg.replaceAll('<root>', fixed));
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    const dates = new Set([startDay, today()]);
    const norm = (text) => {
      let out = text.split(root).join('<root>').split(fixed).join('<root>');
      out = slashes(out);
      for (const day of dates) out = out.split(day).join('<today>');
      return out;
    };
    return { stdout: norm(result.stdout), stderr: norm(result.stderr), status: result.status };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = { validate: [], inventory: [], parseArgs: [], carrier: [], entry: [] };

// ---------------------------------------------------------------------------------------------------------------------
// validate-skill
// ---------------------------------------------------------------------------------------------------------------------
const doc = (front, body = ['# Instructions', 'Do the work.'], eol = '\n') => ['---', ...front, '---', ...body].join(eol);
const OK_FRONT = ['name: sample', 'description: Sample skill.', 'when_to_use: Sample requests.'];

function validate(name, input, argv) {
  cases.validate.push({ case: name, input, argv, observed: run(VALIDATE, input, argv) });
}
const sample = (text) => ({ files: { 'sample/SKILL.md': text } });
const onSample = (text, extra = {}) => ({ files: { 'sample/SKILL.md': text, ...extra } });

// every shipped skill of the tree: SKILL.md as it is, every other file as an empty placeholder
for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
  if (!entry.isDirectory() || !existsSync(join(SKILLS, entry.name, 'SKILL.md'))) continue;
  const files = {};
  const dirs = [];
  const walk = (dir) => {
    for (const child of readdirSync(join(SKILLS, entry.name, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${child.name}` : child.name;
      if (child.isDirectory()) {
        dirs.push(`${entry.name}/${rel}`);
        walk(rel);
      } else files[`${entry.name}/${rel}`] = rel === 'SKILL.md' ? readFileSync(join(SKILLS, entry.name, rel), 'utf8') : '';
    }
  };
  walk('');
  validate(`shipped skill ${entry.name}`, { files, dirs }, [`<root>/${entry.name}`]);
}

validate('no argument', {}, []);
validate('an empty argument', {}, ['']);
validate('a missing folder', {}, ['<root>/missing']);
validate('a folder without SKILL.md', { dirs: ['empty'] }, ['<root>/empty']);
validate('a path that is a file', { files: { 'file.txt': 'x' } }, ['<root>/file.txt']);
validate('SKILL.md is a folder', { dirs: ['sample/SKILL.md'] }, ['<root>/sample']);
validate('a path with a trailing separator', sample(doc(OK_FRONT)), ['<root>/sample/']);
validate('a path with dot segments', sample(doc(OK_FRONT)), ['<root>/sample/../sample/.']);
validate('a valid skill', sample(doc(OK_FRONT)), ['<root>/sample']);
validate('extra arguments are ignored', sample(doc(OK_FRONT)), ['<root>/sample', 'other']);
validate('no front matter', sample('# Just a body\n'), ['<root>/sample']);
validate('front matter that never closes', sample('---\nname: sample\n'), ['<root>/sample']);
validate('invalid YAML', sample('---\nname: [unterminated\n---\nbody\n'), ['<root>/sample']);
validate('front matter that is a list', sample('---\n- a\n- b\n---\nbody\n'), ['<root>/sample']);
validate('front matter that is a scalar', sample('---\njust text\n---\nbody\n'), ['<root>/sample']);
validate('an empty front matter', sample('---\n---\nbody\n'), ['<root>/sample']);
validate('a byte order mark before the front matter', sample(`\uFEFF${doc(OK_FRONT)}`), ['<root>/sample']);
validate('CRLF line ends', sample(doc(OK_FRONT, ['# Instructions', 'Do it.'], '\r\n')), ['<root>/sample']);
validate('the name is missing', sample(doc(['description: d', 'when_to_use: w'])), ['<root>/sample']);
validate('the name is not a string', sample(doc(['name: 5', 'description: d'])), ['<root>/sample']);
validate('the name has capitals', sample(doc(['name: Sample', 'description: d'])), ['<root>/sample']);
validate('the name has an underscore', sample(doc(['name: sam_ple', 'description: d'])), ['<root>/sample']);
validate('the name is too long', sample(doc([`name: ${'a'.repeat(65)}`, 'description: d'])), ['<root>/sample']);
validate('the name is 64 long but the folder differs', sample(doc([`name: ${'a'.repeat(64)}`, 'description: d'])), ['<root>/sample']);
validate('the name starts with a hyphen', sample(doc(['name: -sample', 'description: d'])), ['<root>/sample']);
validate('the name ends with a hyphen', sample(doc(['name: sample-', 'description: d'])), ['<root>/sample']);
validate('the name has two hyphens in a row', sample(doc(['name: sam--ple', 'description: d'])), ['<root>/sample']);
validate('the description is missing', sample(doc(['name: sample', 'when_to_use: w'])), ['<root>/sample']);
validate('the description is blank', sample(doc(['name: sample', "description: '   '"])), ['<root>/sample']);
validate('the description is not a string', sample(doc(['name: sample', 'description: [a]'])), ['<root>/sample']);
validate('the description is 1025 long', sample(doc(['name: sample', `description: ${'d'.repeat(1025)}`])), ['<root>/sample']);
validate('the description is 1024 long', sample(doc(['name: sample', `description: ${'d'.repeat(1024)}`, 'when_to_use: w'])), ['<root>/sample']);
validate('the description is 100 long', sample(doc(['name: sample', `description: ${'d'.repeat(100)}`, 'when_to_use: w'])), ['<root>/sample']);
validate('the description is 101 long', sample(doc(['name: sample', `description: ${'d'.repeat(101)}`, 'when_to_use: w'])), ['<root>/sample']);
validate('the trigger is 1025 long', sample(doc(['name: sample', 'description: d', `when_to_use: ${'t'.repeat(1025)}`])), ['<root>/sample']);
validate('the trigger is 100 long', sample(doc(['name: sample', 'description: d', `when_to_use: ${'t'.repeat(100)}`])), ['<root>/sample']);
validate('the trigger is 101 long', sample(doc(['name: sample', 'description: d', `when_to_use: ${'t'.repeat(101)}`])), ['<root>/sample']);
validate('the trigger is empty', sample(doc(['name: sample', 'description: d', "when_to_use: ''"])), ['<root>/sample']);
validate('the trigger is not a string', sample(doc(['name: sample', 'description: d', 'when_to_use: 7'])), ['<root>/sample']);
validate('the description counts UTF-16 units', sample(doc(['name: sample', `description: ${'\u{1F600}'.repeat(51)}`, 'when_to_use: w'])), ['<root>/sample']);
validate('angle brackets in the description', sample(doc(['name: sample', 'description: use <b> tags', 'when_to_use: w'])), ['<root>/sample']);
validate('angle brackets in the trigger', sample(doc(['name: sample', 'description: d', 'when_to_use: a > b'])), ['<root>/sample']);
validate('unsupported front matter fields', sample(doc([...OK_FRONT, 'extra: 1', 'another: 2', 'license: MIT'])), ['<root>/sample']);
validate('numeric keys come first as a script enumerates them', sample(doc([...OK_FRONT, 'zeta: 1', '"2": a', '"1": b'])), ['<root>/sample']);
validate('all allowed fields', sample(doc([...OK_FRONT, 'license: MIT', 'compatibility: any', 'metadata:', '  k: v', 'allowed-tools: [read]'])), ['<root>/sample']);
validate('dependencies as a string', sample(doc([...OK_FRONT, 'dependencies: nope'])), ['<root>/sample']);
validate('dependencies as a list', sample(doc([...OK_FRONT, 'dependencies:', '  - a'])), ['<root>/sample']);
validate('dependencies as a number', sample(doc([...OK_FRONT, 'dependencies: 3'])), ['<root>/sample']);
validate('dependencies null', sample(doc([...OK_FRONT, 'dependencies:'])), ['<root>/sample']);
validate('dependencies without tools', sample(doc([...OK_FRONT, 'dependencies: {}'])), ['<root>/sample']);
validate('dependencies tools null', sample(doc([...OK_FRONT, 'dependencies:', '  tools:'])), ['<root>/sample']);
validate('dependencies tools not a list', sample(doc([...OK_FRONT, 'dependencies:', '  tools: read'])), ['<root>/sample']);
validate('a dependency that is not a mapping', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', '    - read'])), ['<root>/sample']);
validate('a dependency without a value', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', '    - type: tool'])), ['<root>/sample']);
validate('a dependency with a space in its value', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', '    - type: tool', '      value: a b'])), ['<root>/sample']);
validate('a dependency type that is long', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', '    - type: tool', `      value: ${'v'.repeat(257)}`])), ['<root>/sample']);
validate('valid dependencies, duplicates, any type', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', '    - type: tool', '      value: read', '    - type: TOOL', '      value: read', '    - type: url', '      value: x'])), ['<root>/sample']);
validate('128 dependencies', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', ...Array.from({ length: 128 }, (_, n) => `    - {type: tool, value: t${n}}`)])), ['<root>/sample']);
validate('129 dependencies', sample(doc([...OK_FRONT, 'dependencies:', '  tools:', ...Array.from({ length: 129 }, (_, n) => `    - {type: tool, value: t${n}}`)])), ['<root>/sample']);
validate('the folder name differs from the name', sample(doc(['name: other', 'description: d', 'when_to_use: w'])), ['<root>/sample']);
validate('compatibility is not a string', sample(doc([...OK_FRONT, 'compatibility: 5'])), ['<root>/sample']);
validate('compatibility is 500 long', sample(doc([...OK_FRONT, `compatibility: ${'c'.repeat(500)}`])), ['<root>/sample']);
validate('compatibility is 501 long', sample(doc([...OK_FRONT, `compatibility: ${'c'.repeat(501)}`])), ['<root>/sample']);
validate('compatibility is 500 long and padded', sample(doc([...OK_FRONT, `compatibility: "  ${'c'.repeat(500)}  "`])), ['<root>/sample']);
validate('compatibility null', sample(doc([...OK_FRONT, 'compatibility:'])), ['<root>/sample']);
validate('metadata as a list', sample(doc([...OK_FRONT, 'metadata: [1]'])), ['<root>/sample']);
validate('metadata as a string', sample(doc([...OK_FRONT, 'metadata: text'])), ['<root>/sample']);
validate('metadata null', sample(doc([...OK_FRONT, 'metadata:'])), ['<root>/sample']);
validate('an empty body', sample(doc(OK_FRONT, [])), ['<root>/sample']);
validate('a blank body', sample('---\nname: sample\ndescription: d\nwhen_to_use: w\n---\n\n\n'), ['<root>/sample']);
validate('a closed code fence', sample(doc(OK_FRONT, ['Write:', '```', 'x', '```'])), ['<root>/sample']);
validate('a code fence glued to a line', sample(doc(OK_FRONT, ['Never wrap.```', 'x', '```'])), ['<root>/sample']);
validate('an unclosed tilde fence', sample(doc(OK_FRONT, ['~~~', 'x'])), ['<root>/sample']);
validate('a fence indented three spaces', sample(doc(OK_FRONT, ['   ```', 'x', '   ```'])), ['<root>/sample']);
validate('a fence indented four spaces', sample(doc(OK_FRONT, ['    ```', 'x'])), ['<root>/sample']);
validate('a tab before a fence', sample(doc(OK_FRONT, ['\t```', 'x'])), ['<root>/sample']);
validate('mixed fences', sample(doc(OK_FRONT, ['```', 'x', '~~~'])), ['<root>/sample']);
validate('a body of 500 lines', sample(doc(OK_FRONT, Array.from({ length: 500 }, (_, n) => `line ${n}`))), ['<root>/sample']);
validate('a body of 501 lines', sample(doc(OK_FRONT, Array.from({ length: 501 }, (_, n) => `line ${n}`))), ['<root>/sample']);
validate('referenced files that exist', onSample(doc(OK_FRONT, ['See `references/a.md`, [b](scripts/b.sh) and `assets/c.png`.']), { 'sample/references/a.md': '', 'sample/scripts/b.sh': '', 'sample/assets/c.png': '' }), ['<root>/sample']);
validate('a referenced file missing from a bundled folder', onSample(doc(OK_FRONT, ['See `references/a.md` and [x](references/b.md).']), { 'sample/references/other.md': '' }), ['<root>/sample']);
validate('a referenced path of a folder the skill does not bundle', onSample(doc(OK_FRONT, ['Run `scripts/build.js` and see [d](assets/logo.png).'])), ['<root>/sample']);
validate('a referenced path that escapes the folder', onSample(doc(OK_FRONT, ['See `references/../../x.md` and `scripts/../../../y`.']), { 'sample/references/a.md': '' }), ['<root>/sample']);
validate('a referenced path that stays inside after dot segments', onSample(doc(OK_FRONT, ['See `references/sub/../a.md`.']), { 'sample/references/a.md': '' }), ['<root>/sample']);
validate('a referenced path that names the folder itself', onSample(doc(OK_FRONT, ['See `references/..` and `scripts/.`.']), { 'sample/references/a.md': '' }), ['<root>/sample']);
validate('a referenced folder', onSample(doc(OK_FRONT, ['See `references/sub`.']), { 'sample/references/sub/a.md': '' }), ['<root>/sample']);
validate('the same path named twice and in both forms', onSample(doc(OK_FRONT, ['`references/a.md` again `references/a.md` and [x](references/a.md).'])), ['<root>/sample']);
validate('links first in the text, backticks second in the report', onSample(doc(OK_FRONT, ['[l](scripts/l.sh) then `scripts/t.sh`.']), { 'sample/scripts/z': '' }), ['<root>/sample']);
validate('references that do not match the pattern', onSample(doc(OK_FRONT, ['`references/with space.md` `refs/a.md` `references/` [x](references/a b.md) ``references/a.md``']), { 'sample/references/a.md': '' }), ['<root>/sample']);
validate('several errors and warnings together', onSample(doc(['name: other', 'description: <x>', 'dependencies: 1', 'odd: 1', 'compatibility: 1', 'metadata: 1'], ['```', '`references/gone.md` `assets/gone.png`']), { 'sample/references/a.md': '' }), ['<root>/sample']);

// ---------------------------------------------------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------------------------------------------------
function inventory(name, input, argv) {
  cases.inventory.push({ case: name, input, argv, observed: run(INVENTORY, input, argv) });
}
const both = (name, input, extra = []) => {
  inventory(`${name} (markdown)`, input, ['<root>', ...extra]);
  inventory(`${name} (json)`, input, ['<root>', '--json', ...extra]);
};

const MIXED = {
  files: {
    'web/src/a.test.ts': "setTimeout(f, 1); spawn('x'); test('t', { skip: '#7 race' }, () => {});",
    'web/src/b.slow.spec.js': "test('x', { skip: 'flaky' }, () => {});",
    'web/src/__tests__/c.js': 'plain',
    'web/src/helper.ts': 'not a test',
    'web/src/types.d.ts': 'declare const x: number;',
    'web/node_modules/dep/ignored.test.js': 'ignored',
    'web/dist/built.test.js': 'ignored',
    'py/tests/test_a.py': '@pytest.mark.skip\ndef test_a(): pass',
    'py/tests/helper.py': 'not a test',
    'py/tests/b_test.py': 'import time\ntime.sleep(1)\nsubprocess.run(["x"])',
    'py/.venv/lib/test_dep.py': 'ignored',
    'go/pkg/x_test.go': 't.Skip("windows only")',
    'go/vendor/y_test.go': 'ignored',
    'rs/tests/it.rs': '#[ignore]',
    'rs/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }',
    'rs/src/plain.rs': 'pub fn x() {}',
    'rs/target/debug/z.rs': '#[test]',
    'x.test.js': '',
    'src/top.test.mjs': '',
  },
};
both('mixed languages with vendored folders', MIXED);
inventory('an empty tree (markdown)', { dirs: ['empty'] }, ['<root>/empty']);
inventory('an empty tree (json)', { dirs: ['empty'] }, ['<root>/empty', '--json']);
inventory('the option may come first', MIXED, ['--json', '<root>']);
inventory('a path that starts with a single dash is the root', {}, ['-x']);

const SKIPS = {
  files: {
    'a/js.test.js': [
      "const w = { skip: process.platform !== 'win32' && 'Windows only' };",
      "test('a', { skip: '#271 until 2099-11-30: port race' }, () => {});",
      "test('b', { skip: '#90 until 2020-01-01: old race' }, () => {});",
      "test('c', { skip: 'fails sometimes' }, () => {});",
      "it.skip('d', () => {}); // #12 until 2099-01-01",
      "xit('e', () => {});",
      "it.skipIf(isWindows)('f', () => {});",
      "test('g', { skip: 'race on Windows' }, () => {});",
      "test('h', { skip: \"needs a display\" }, () => {});",
      'test(`i`, { skip: `no bash on this host` }, () => {});',
      "// reason on the line before: requires docker\nit.skip('j');",
      "describe.skip('k', () => {}); // until 2020-02-02 expired",
      "test('l', { skip: true }, () => {});",
      "t.skip();",
      "test('m', { skip: cond && 'a && b' }, () => {});",
    ].join('\n'),
    'a/reasons.test.js': [
      'no bash on this host',
      'dotnet SDK is not on PATH',
      'mandatory file locks are a Windows behavior',
      'the file is still readable here (e.g. running as root)',
      'a mixdog-graph build with the --langs/--scan modes is not available on this machine',
      'fixture skip',
      'fails when the disk is busy',
      'Windows behavior is broken',
      'crashes when running as root',
      'flaky on Windows',
      'skipped when running as root',
      'is a Windows feature',
      'no tool on this runner',
      'unsupported here',
    ].map((reason) => `t.skip('${reason}');`).join('\n'),
    'a/py/test_x.py': [
      '@pytest.mark.skip(reason="#5 until 2099-02-02: race")',
      '@pytest.mark.skipif(sys.platform == "win32", reason="requires posix")',
      '@pytest.mark.skip(reason="flaky")',
      '@pytest.mark.xfail',
      '@unittest.skipIf(IS_CI, "needs a display")',
      '@pytest.mark.skipif(',
      '    sys.platform == "win32",',
      '    reason="#8 until 2020-01-01: old",',
      ')',
      '    # @pytest.mark.skip commented out',
      '@pytest.mark.skip("positional reason")',
      '@unittest.skipUnless(HAS_GPU, "no gpu available")',
      'x = pytest.importorskip("numpy")',
      'pytest.skip("inline skip")  # because of #3',
      '@unittest.expectedFailure',
      '@pytest.mark.skip(',
      '    reason="a very long wrapped reason that is #9 tracked"',
      ')',
    ].join('\n'),
    'a/go/y_test.go': [
      'if runtime.GOOS == "windows" { t.Skip("windows only") }',
      't.Skipf("#3 until 2099-05-05: %s", why)',
      't.Skip("flaky")',
      't.SkipNow()',
      '// t.Skip("commented")',
      "t.Skip('single quoted')",
    ].join('\n'),
    'a/rs/tests/z.rs': [
      '#[ignore = "requires docker"]',
      '#[ignore = "#4 until 2020-01-01: race"]',
      '#[ignore]',
      '#[cfg_attr(windows, ignore)]',
      '#[ignore = "flaky"]',
      '#[ignore("x")]',
      '#[test] // note: needs a display\n#[ignore]',
    ].join('\n'),
  },
};
both('skip classification across languages', SKIPS);

const MARKERS = {
  files: {
    'm/a.test.js': "setTimeout(done, 50); spawn('git'); server.listen(4173); Date.now(); readFileSync('x.mjs');",
    'm/b.test.js': 'vi.useFakeTimers(); setTimeout(done, 50); Date.now(); server.listen(0);',
    'm/c.test.js': 'new Date(); fork(x); delay (5);',
    'm/d.test.js': 'sleep(1); execFileSync("x"); installFakeClock(); Date.now()',
    'm/test_a.py': 'import time, subprocess\ntime.sleep(1)\nsubprocess.run(["x"])\ns.bind(("0.0.0.0", 8080))\ndatetime.now()\nopen("a.py")',
    'm/test_b.py': '@freeze_time("2026-01-01")\ntime.sleep(1)\ndatetime.now()\nport = 8080',
    'm/test_c.py': 'os.system("x"); asyncio.sleep(1); inspect.getsource(f); date.today()',
    'm/a_test.go': 'time.Sleep(time.Second)\nexec.Command("ls")\nnet.Listen("tcp", "127.0.0.1:9000")\ntime.Now()\nnet.Listen("tcp", ":0")',
    'm/b_test.go': 'synctest.Run(f)\ntime.Sleep(1)\ntime.Now()\nos.ReadFile("x.go")',
    'm/tests/a.rs': 'thread::sleep(d);\nCommand::new("ls");\nTcpListener::bind("127.0.0.1:7000");\nInstant::now();\ninclude_str!("x.rs");',
    'm/tests/b.rs': 'tokio::time::pause(); sleep(d); Instant::now(); process::Command',
  },
};
both('markers of every language', MARKERS);

const ORDER = {
  files: Object.fromEntries(
    ['b', 'B', 'a', 'A', 'a-b', 'a_b', 'ab', '_x', '10', '9', 'Z', 'é', 'e', 'f', 'ä', 'z z'].flatMap((dir) => [
      [`${dir}/one.test.js`, "setTimeout(f, 1); spawn('x'); it.skip('s');"],
      [`${dir}/Two.test.js`, "setTimeout(f, 1); spawn('x'); it.skip('s');"],
      [`${dir}/three.TEST.js`, 'ignored by the pattern'],
    ])
  ),
};
both('areas of equal size are ordered by locale and entries by the file system', ORDER);
both('names that sort differently by case and by byte', { files: { 'Z.test.js': 'it.skip("1")', 'a.test.js': 'it.skip("2")', 'B.test.js': 'it.skip("3")', '_.test.js': 'it.skip("4")', '1.test.js': 'it.skip("5")' } });

both('CRLF text and a byte order mark', { files: { 'a.test.js': '\uFEFFit.skip("a");\r\nit.skip("b"); // note\r\n', 'b.test.js': 'it.skip("a");\rit.skip("b");' } });
both('invalid UTF-8 in a test file', { files: { 'a.test.js': { base64: Buffer.concat([Buffer.from("it.skip('x\u00e9"), Buffer.from([0xff, 0xfe]), Buffer.from("');")]).toString('base64') } } });
both('a file only the first megabyte of which is read', {
  files: {
    'a.test.js': { repeat: ' ', count: 1 << 20, suffix: "\nit.skip('beyond');" },
    'b.test.js': { repeat: ' ', count: (1 << 20) - 12, suffix: "it.skip('x');it.skip('y');" },
    'c.test.js': { repeat: 'x', count: (1 << 20) - 1, suffix: '\u00e9\u00e9 it.skip("c")' },
  },
});
both('a nesting of 40 folders', { files: { [`${Array.from({ length: 40 }, (_, n) => `d${n}`).join('/')}/deep.test.js`]: "it.skip('deep');" } });
inventory('a nesting of 41 folders', { files: { [`${Array.from({ length: 41 }, (_, n) => `d${n}`).join('/')}/deep.test.js`]: "it.skip('deep');" } }, ['<root>']);
both('201 skips that need action and 201 fast files with timers and processes', {
  files: Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`many/t${String(n).padStart(3, '0')}.test.js`, "setTimeout(f, 1); spawn('x'); it.skip('s');"])),
});
both('a skip without a reason', { files: { 'a.test.js': 'it.skip("x"); xit("y");' } });
both('file names with spaces and non-ASCII letters', { files: { 'dir with space/caf\u00e9 test.test.js': "it.skip('s');", 'd\u00e9j\u00e0/\u30c6\u30b9\u30c8.test.js': 'x' } });
inventory('a root with a trailing slash', MIXED, ['<root>/']);
inventory('a root with dot segments', MIXED, ['<root>/web/..']);
inventory('a root that is a file', { files: { 'f.txt': 'x' } }, ['<root>/f.txt']);
inventory('a missing root', {}, ['<root>/missing']);
inventory('no arguments', {}, []);
inventory('only the json flag', {}, ['--json']);
inventory('an unknown option', MIXED, ['<root>', '--bogus']);
inventory('an unknown option before the root', MIXED, ['--bogus', '<root>']);
inventory('the first of several roots is read', MIXED, ['<root>/web', '<root>/py']);
inventory('more than 20000 test files', { gen: [{ files: { dir: 'many', count: 20001, name: 't{n}.test.js', body: '' } }] }, ['<root>']);
inventory('more than 50000 directories', { gen: [{ dirs: { dir: 'many', count: 50000, name: 'd{n}' } }] }, ['<root>']);

// ---------------------------------------------------------------------------------------------------------------------
// util.parseArgs
// ---------------------------------------------------------------------------------------------------------------------
const CONFIGS = {
  // qc-pages.mjs and review-deck.mjs
  qc: { allowPositionals: true, options: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, output: { type: 'string' }, pages: { type: 'string' }, 'no-vision': { type: 'boolean' } } },
  // aliases, no positionals
  short: { allowPositionals: false, options: { provider: { type: 'string', short: 'p' }, verbose: { type: 'boolean', short: 'v' }, quiet: { type: 'boolean', short: 'q' }, 'no-vision': { type: 'boolean' }, o: { type: 'string' } } },
  // aliases, positionals allowed
  mixed: { allowPositionals: true, options: { provider: { type: 'string', short: 'p' }, verbose: { type: 'boolean', short: 'v' }, quiet: { type: 'boolean', short: 'q' }, 'no-vision': { type: 'boolean' }, o: { type: 'string' } } },
};
const POOL = ['--provider', '--no-vision', '--output', '--pages', '--verbose', '-p', '-v', '-q', '-vq', '-vp', '-pfoo', '-qvx', '-o', '-x', '--', '-', '--=x', '--==x', '---a', '-=x', '--provider=x', '--provider=', '--no-vision=1', '--no-model', '--model=a=b', '-p=x', '-vqpz', 'a', '', '-1', '--1', '-ab', '-ox', '--o', '--o=', '--bogus'];
const lists = [[]];
for (const first of POOL) {
  lists.push([first]);
  for (const second of POOL) {
    lists.push([first, second]);
  }
}
for (const [a, b, c] of [['--provider', '-x', 'a'], ['-p', '--', '--'], ['--output', 'f', '--pages'], ['-vp', 'x', 'y'], ['--provider', 'a', '--provider'], ['a', '--provider', 'b', 'c'], ['--', '--provider', 'x'], ['--provider', '--', 'x'], ['-v', '-p', '-q'], ['--no-vision', 'x', '--no-vision'], ['-pa', '-pb', 'c'], ['--provider=1', '--provider=2'], ['-o', '-v', 'x'], ['--o', '-', 'x']]) {
  lists.push([a, b, c]);
}
for (const [name, config] of Object.entries(CONFIGS)) {
  for (const args of lists) {
    let observed;
    try {
      const { values, positionals } = parseArgs({ args, ...config });
      observed = { values: Object.entries(values), positionals };
    } catch (error) {
      observed = { code: error.code, message: error.message };
    }
    cases.parseArgs.push({ config: name, args, observed });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the argument carrier
// ---------------------------------------------------------------------------------------------------------------------
const { decodeSkillArgv } = await import(pathToFileURL(join(TREE, 'src', 'runtime', 'shared', 'skill-script-runtime.mjs')).href);
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const carried = (...items) => `mixdog1${items.map((item) => `,${b64(item)}`).join('')}`;
let seed = 0x2f6e2b1;
const next = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_ \t\n*!.,';
const randomItem = () => Array.from({ length: next() % 14 }, () => ALPHABET[next() % ALPHABET.length]).join('');
const carrierValues = [
  undefined, '', 'mixdog', 'mixdog1', 'mixdog1,', 'mixdog1,,', 'mixdog1,,,', 'mixdog2,YQ==', 'xmixdog1,YQ==', 'MIXDOG1,YQ==', 'mixdog1YQ==', 'mixdog1;YQ==', 'mixdog1,YQ==,',
  carried('probe.mjs'), carried('probe.mjs', 'a&b', ''), carried('probe.mjs', 'he said "hi"', "it's", 'caf\u00e9 \u{1F600}'), carried('', '', ''), carried('a,b'), carried('line\nbreak'),
  'mixdog1,YQ', 'mixdog1,YWI', 'mixdog1,YWJj', 'mixdog1,YQ==YQ==', 'mixdog1,YW Jj\nZA==', 'mixdog1,Y*Q!=', 'mixdog1,-_-_', 'mixdog1,+/+/', 'mixdog1,Y', 'mixdog1,=', 'mixdog1,==', 'mixdog1,/w==', 'mixdog1,gA==', 'mixdog1,wA==', 'mixdog1,4pyT', 'mixdog1,4py',
  'mixdog1,YQ=', 'mixdog1,YQ===', 'mixdog1,YQ=a', 'mixdog1,a=b', 'mixdog1,!!!!', 'mixdog1,    ', 'mixdog1,YQ,Yg,Yw', 'mixdog1,YQ,,Yw', 'mixdog1,\u00e9\u00e9\u00e9\u00e9', 'mixdog1,YQ\u00e9\u00e9', 'mixdog1,\u{1F600}YQ',
  ...Array.from({ length: 120 }, () => `mixdog1${Array.from({ length: 1 + (next() % 4) }, () => `,${randomItem()}`).join('')}`),
];
for (const value of carrierValues) cases.carrier.push({ value: value === undefined ? { undefined: true } : value, observed: decodeSkillArgv(value) });

// ---------------------------------------------------------------------------------------------------------------------
// the entry
// ---------------------------------------------------------------------------------------------------------------------
const PROBE = "console.log(JSON.stringify({ args: process.argv.slice(2), self: process.argv[1].replaceAll('\\\\', '/').split('/').pop(), carried: 'MIXDOG_SKILL_ARGV' in process.env }));\n";
function entry(name, argv, env) {
  const root = mkdtempSync(join(tmpdir(), 'skill-scripts-'));
  try {
    writeFileSync(join(root, 'probe.mjs'), PROBE);
    const fixed = slashes(root);
    const childEnv = { ...process.env };
    delete childEnv.MIXDOG_SKILL_ARGV;
    if (env !== undefined) childEnv.MIXDOG_SKILL_ARGV = env;
    const result = spawnSync(process.execPath, [ENTRY, ...argv.map((arg) => arg.replaceAll('<root>', fixed))], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    // The probe's output is JSON: separators are left as they are, since a slash in place of a backslash would break
    // its escapes. A failure's text is a stack with Node's own frames: only that there is one is recorded.
    const failed = result.status === 1 && !result.stdout;
    cases.entry.push({
      case: name,
      argv,
      env: env === undefined ? null : env,
      observed: { stdout: result.stdout.split(root).join('<root>').split(fixed).join('<root>'), stderr: failed ? '<failure text>' : result.stderr, status: result.status },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
entry('no target', [], undefined);
entry('no target and the tag only', [], 'mixdog1');
entry('an empty carried list', [], 'mixdog1,');
entry('arguments on the command line', ['probe.mjs', 'a', 'b'], undefined);
entry('arguments carried in the environment', [], carried('probe.mjs', 'a&b', '', 'he said "hi"'));
entry('the command line wins over the carried arguments', ['probe.mjs', 'x'], carried('probe.mjs', 'y'));
entry('a value that is not carried arguments', [], 'junk');
entry('a malformed carried item', [], 'mixdog1,cHJvYmUubWpz,Y*Q!=');
entry('a script that does not exist', ['missing.mjs'], undefined);
entry('a script carried that does not exist', [], carried('missing.mjs', 'a'));

// ---------------------------------------------------------------------------------------------------------------------
const trees = {
  [relative(TREE, VALIDATE).split(sep).join('/')]: sha256(readFileSync(VALIDATE)),
  [relative(TREE, INVENTORY).split(sep).join('/')]: sha256(readFileSync(INVENTORY)),
  [relative(TREE, ENTRY).split(sep).join('/')]: sha256(readFileSync(ENTRY)),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'golden.json'), `${JSON.stringify({ node: process.version, scripts: trees, cases }, null, 1)}\n`);
const counts = Object.fromEntries(Object.entries(cases).map(([key, list]) => [key, list.length]));
const files = readdirSync(OUT).filter((name) => name !== 'MANIFEST.json').map((name) => ({ path: name, bytes: statSync(join(OUT, name)).size, sha256: sha256(readFileSync(join(OUT, name))) }));
writeFileSync(
  join(OUT, 'MANIFEST.json'),
  `${JSON.stringify(
    {
      set: 'skill-scripts',
      recorder: 'benchmarks/rust-core/recorders/record-skill-scripts.mjs',
      recorderSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      command: 'node benchmarks/rust-core/recorders/record-skill-scripts.mjs --tree <product tree with node_modules>',
      nodeVersion: process.version,
      cases: counts,
      scripts: trees,
      values: 'plain JSON: argv, stdout, stderr and exit status of each run; the temporary root is written <root> (separators as slashes), today <today>',
      replay: 'native/core/crates/mixdog-skill-scripts/tests/node_twin.rs runs run_validate_skill, run_inventory, parse_args, decode_skill_argv and entry_arguments on the same inputs and compares byte for byte',
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
    },
    null,
    2
  )}\n`
);
console.log(`skill-scripts: ${JSON.stringify(counts)}`);
