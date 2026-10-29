import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { areaOf, inventory, laneOf, scanText } from './inventory.mjs';

const TODAY = '2026-10-29';
const kinds = (text, lang) => scanText(text, TODAY, lang).skips.map((skip) => [skip.line, skip.kind]);

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'test-suite-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test('JS markers flag timers, spawns and fixed ports, and a fake clock clears timer and clock', () => {
  const risky = scanText("setTimeout(done, 50); spawn('git'); server.listen(4173); Date.now();", TODAY, 'js');
  assert.deepEqual(risky.markers.sort(), ['clock', 'port', 'spawn', 'timer']);
  assert.deepEqual(
    scanText('vi.useFakeTimers(); setTimeout(done, 50); Date.now(); server.listen(0);', TODAY, 'js').markers,
    []
  );
});

test('Python, Go and Rust markers are language specific', () => {
  const py = 'import time, subprocess\ntime.sleep(1)\nsubprocess.run(["x"])\ns.bind(("0.0.0.0", 8080))\ndatetime.now()';
  assert.deepEqual(scanText(py, TODAY, 'python').markers.sort(), ['clock', 'port', 'spawn', 'timer']);
  assert.deepEqual(scanText('@freeze_time("2026-01-01")\ntime.sleep(1)\ndatetime.now()', TODAY, 'python').markers, []);
  const go =
    'time.Sleep(time.Second)\nexec.Command("ls")\nnet.Listen("tcp", "127.0.0.1:9000")\ntime.Now()\nnet.Listen("tcp", ":0")';
  assert.deepEqual(scanText(go, TODAY, 'go').markers.sort(), ['clock', 'port', 'spawn', 'timer']);
  const rust = 'thread::sleep(d);\nCommand::new("ls");\nTcpListener::bind("127.0.0.1:7000");\nInstant::now();';
  assert.deepEqual(scanText(rust, TODAY, 'rust').markers.sort(), ['clock', 'port', 'spawn', 'timer']);
  assert.deepEqual(scanText('tokio::time::pause(); sleep(d); Instant::now();', TODAY, 'rust').markers, []);
  assert.deepEqual(scanText('open("a.py"); inspect.getsource(f)', TODAY, 'python').markers, ['source-text']);
});

test('JS skips are classified as capability, tracked, untracked or expired', () => {
  const text = [
    "const w = { skip: process.platform !== 'win32' && 'Windows only' };",
    "test('a', { skip: '#271 until 2026-11-30: port race' }, () => {});",
    "test('b', { skip: '#90 until 2026-01-01: old race' }, () => {});",
    "test('c', { skip: 'fails sometimes' }, () => {});",
    "it.skip('d', () => {}); // #12 until 2027-01-01",
    "xit('e', () => {});",
    "it.skipIf(isWindows)('f', () => {});",
  ].join('\n');
  assert.deepEqual(kinds(text, 'js'), [
    [1, 'capability'],
    [2, 'tracked'],
    [3, 'expired'],
    [4, 'untracked'],
    [5, 'tracked'],
    [6, 'untracked'],
    [7, 'capability'],
  ]);
});

test('naming a platform alone does not make a skip a capability skip', () => {
  const text = [
    "test('a', { skip: 'race on Windows' }, () => {});",
    "test('b', { skip: 'Windows only' }, () => {});",
  ].join('\n');
  assert.deepEqual(kinds(text, 'js'), [
    [1, 'untracked'],
    [2, 'capability'],
  ]);
});

test('Python skips cover pytest and unittest forms, including multi-line decorators', () => {
  const text = [
    '@pytest.mark.skip(reason="#5 until 2027-02-02: race")',
    '@pytest.mark.skipif(sys.platform == "win32", reason="requires posix")',
    '@pytest.mark.skip(reason="flaky")',
    '@pytest.mark.xfail',
    '@unittest.skipIf(IS_CI, "needs a display")',
    '@pytest.mark.skipif(',
    '    sys.platform == "win32",',
    '    reason="#8 until 2020-01-01: old",',
    ')',
    '    # @pytest.mark.skip commented out',
  ].join('\n');
  assert.deepEqual(kinds(text, 'python'), [
    [1, 'tracked'],
    [2, 'capability'],
    [3, 'untracked'],
    [4, 'untracked'],
    [5, 'capability'],
    [6, 'expired'],
  ]);
});

test('Go and Rust skips are classified', () => {
  const go = [
    'if runtime.GOOS == "windows" { t.Skip("windows only") }',
    't.Skipf("#3 until 2027-05-05: %s", why)',
    't.Skip("flaky")',
    't.SkipNow()',
  ].join('\n');
  assert.deepEqual(kinds(go, 'go'), [
    [1, 'capability'],
    [2, 'tracked'],
    [3, 'untracked'],
    [4, 'untracked'],
  ]);
  const rust = [
    '#[ignore = "requires docker"]',
    '#[ignore = "#4 until 2020-01-01: race"]',
    '#[ignore]',
    '#[cfg_attr(windows, ignore)]',
  ].join('\n');
  assert.deepEqual(kinds(rust, 'rust'), [
    [1, 'capability'],
    [2, 'expired'],
    [3, 'untracked'],
    [4, 'capability'],
  ]);
});

test('lane and area derive from the path', () => {
  assert.equal(laneOf('a/b.slow.test.mjs'), 'slow');
  assert.equal(laneOf('a/b.e2e.spec.ts'), 'e2e');
  assert.equal(laneOf('a/test_x.py'), 'fast');
  assert.equal(areaOf('src/runtime/shell/a.test.mjs'), 'runtime/shell');
  assert.equal(areaOf('pkg/sub/deep/x_test.go'), 'pkg/sub');
  assert.equal(areaOf('x.test.js'), '.');
});

test('inventory discovers JS, Python, Go and Rust tests, skips vendored dirs and does not follow links', (t) => {
  const root = fixture(t, {
    'web/src/a.test.ts': "setTimeout(f, 1); spawn('x'); test('t', { skip: '#7 race' }, () => {});",
    'web/src/b.slow.spec.js': "test('x', { skip: 'flaky' }, () => {});",
    'web/src/__tests__/c.js': 'plain',
    'web/src/helper.ts': 'not a test',
    'web/node_modules/dep/ignored.test.js': 'ignored',
    'py/tests/test_a.py': '@pytest.mark.skip\ndef test_a(): pass',
    'py/tests/helper.py': 'not a test',
    'py/.venv/lib/test_dep.py': 'ignored',
    'go/pkg/x_test.go': 't.Skip("windows only")',
    'go/vendor/y_test.go': 'ignored',
    'rs/tests/it.rs': '#[ignore]',
    'rs/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }',
    'rs/src/plain.rs': 'pub fn x() {}',
    'rs/target/debug/z.rs': '#[test]',
  });
  const outside = fixture(t, { 'out.test.js': 'outside the root' });
  try {
    symlinkSync(outside, join(root, 'linked'), 'junction');
  } catch {
    // Link creation can be denied; the walk is still exercised without it.
  }
  const report = inventory(root, { today: TODAY });
  assert.equal(report.files, 7);
  const langs = {};
  for (const row of report.areas)
    for (const [lang, count] of Object.entries(row.langs)) langs[lang] = (langs[lang] || 0) + count;
  assert.deepEqual(langs, { js: 3, python: 1, go: 1, rust: 2 });
  assert.deepEqual(report.attention.map((item) => [item.file, item.kind]).sort(), [
    ['py/tests/test_a.py', 'untracked'],
    ['rs/tests/it.rs', 'untracked'],
    ['web/src/a.test.ts', 'tracked'],
    ['web/src/b.slow.spec.js', 'untracked'],
  ]);
  assert.deepEqual(report.fastRisk, ['web/src/a.test.ts']);
  const web = report.areas.find((row) => row.area === 'web/src');
  assert.deepEqual([web.files, web.fast, web.slow], [3, 2, 1]);
});

test('the command line prints Markdown or JSON and rejects bad input', (t) => {
  const root = fixture(t, { 'pkg/a_test.go': 't.Skip("flaky")' });
  const script = join(dirname(fileURLToPath(import.meta.url)), 'inventory.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const md = run(root);
  assert.equal(md.status, 0);
  assert.match(md.stdout, /\| pkg \| 1 \|/);
  assert.match(md.stdout, /untracked: `pkg\/a_test\.go:1`/);
  const json = run(root, '--json');
  assert.equal(JSON.parse(json.stdout).files, 1);
  assert.equal(run().status, 2);
  assert.equal(run(root, '--bogus').status, 2);
  const missing = run(join(root, 'missing'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not a directory/);
});
