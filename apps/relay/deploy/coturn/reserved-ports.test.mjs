import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addRanges,
  coversRange,
  formatRanges,
  missingRanges,
  parseRanges,
  run,
  subtractRanges,
} from './reserved-ports.mjs';

/** A stand-in for /proc/sys/net/ipv4/ip_local_reserved_ports and the unit's record file. */
function sysctl(t, initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-reserved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = join(dir, 'proc');
  const record = join(dir, 'added');
  writeFileSync(proc, `${initial}\n`);
  return {
    proc,
    record,
    value: () => readFileSync(proc, 'utf8').trim(),
    set: (text) => writeFileSync(proc, `${text}\n`),
    run: (...argv) => run(argv, proc),
    /** Runs with a writer that throws on the nth write (1-based), as a failed save or a crash would. */
    runFailingWrite: (nth, ...argv) => {
      let writes = 0;
      return run(argv, proc, (path, data) => {
        writes += 1;
        if (writes === nth) throw new Error(`write ${nth} failed`);
        writeFileSync(path, data);
      });
    },
    /** The ranges the ownership record names. */
    recorded: () =>
      readFileSync(record, 'utf8')
        .trim()
        .replace(/^\w+ ?/u, ''),
    state: () => readFileSync(record, 'utf8').trim().split(' ')[0],
  };
}

test('port lists parse, merge and print the way the kernel reads them', () => {
  assert.deepEqual(parseRanges(''), []);
  assert.deepEqual(parseRanges('8080,10000-10010'), [
    [8080, 8080],
    [10000, 10010],
  ]);
  assert.deepEqual(
    parseRanges('10-20, 15-30,31,5'),
    [
      [5, 5],
      [10, 31],
    ],
    'overlapping and adjacent ranges join'
  );
  assert.equal(formatRanges(parseRanges('10000-10010,8080')), '8080,10000-10010');
  for (const bad of ['a', '10-', '-5', '20-10', '70000', '1-65536', '1;2']) {
    assert.throws(() => parseRanges(bad), RangeError, bad);
  }
});

test('missing, added and removed parts are exact', () => {
  const current = parseRanges('8080,50000-60000');
  assert.equal(formatRanges(missingRanges(current, 49152, 65535)), '49152-49999,60001-65535');
  assert.equal(formatRanges(missingRanges(current, 50000, 60000)), '');
  assert.equal(coversRange(current, 50100, 59999), true);
  assert.equal(coversRange(current, 49999, 60000), false);
  const added = missingRanges(current, 49152, 65535);
  assert.equal(formatRanges(addRanges(current, added)), '8080,49152-65535');
  assert.equal(formatRanges(subtractRanges(addRanges(current, added), added)), '8080,50000-60000');
});

test('apply reserves only the missing part and leaves what others reserved', (t) => {
  const s = sysctl(t, '8080,10000-10010');
  assert.match(s.run('apply', '49152', '65535', s.record), /added: 49152-65535/u);
  assert.equal(s.value(), '8080,10000-10010,49152-65535');
  assert.equal(s.recorded(), '49152-65535');
  assert.match(s.run('covers', '49152', '65535'), /^reserved:/u);

  const overlap = sysctl(t, '50000-60000');
  overlap.run('apply', '49152', '65535', overlap.record);
  assert.equal(overlap.value(), '49152-65535');
  assert.equal(overlap.recorded(), '49152-49999,60001-65535', 'only the missing parts are ours');
});

test('release takes back only what apply added, keeping reservations others made meanwhile', (t) => {
  const s = sysctl(t, '50000-60000');
  s.run('apply', '49152', '65535', s.record);
  s.set(`${s.value()},9000`);
  assert.match(s.run('release', s.record), /released 49152-49999,60001-65535/u);
  assert.equal(s.value(), '9000,50000-60000', 'the pre-existing range and the later one stay');
});

test('a range that was already reserved is neither recorded nor released', (t) => {
  const s = sysctl(t, '1000,49000-65535');
  assert.match(s.run('apply', '49152', '65535', s.record), /nothing, already reserved/u);
  assert.equal(s.value(), '1000,49000-65535', 'unchanged');
  assert.equal(s.recorded(), '');
  assert.equal(s.run('release', s.record), 'nothing to release');
  assert.equal(s.value(), '1000,49000-65535');
  // Containment, not equality: the wider reservation covers the range.
  assert.match(s.run('covers', '49152', '65535'), /^reserved:/u);
});

test('an apply after a crash keeps owning what the interrupted one added', (t) => {
  const s = sysctl(t, '8080');
  s.run('apply', '49152', '65535', s.record);
  s.run('apply', '49152', '65535', s.record);
  assert.equal(s.recorded(), '49152-65535');
  s.run('release', s.record);
  assert.equal(s.value(), '8080');
});

test('ownership is recorded before the reservation changes: a failed save leaves nothing reserved', (t) => {
  const s = sysctl(t, '8080');
  // Write 1 is the record's pending save.
  assert.throws(() => s.runFailingWrite(1, 'apply', '49152', '65535', s.record), /write 1 failed/u);
  assert.equal(s.value(), '8080', 'the sysctl was not touched');
  assert.throws(() => readFileSync(s.record), { code: 'ENOENT' });
});

test('a crash between the steps leaves a record that releases whatever was reserved', (t) => {
  // Dies at the sysctl write (2): pending record, nothing reserved yet.
  const beforeSysctl = sysctl(t, '8080');
  assert.throws(
    () => beforeSysctl.runFailingWrite(2, 'apply', '49152', '65535', beforeSysctl.record),
    /write 2 failed/u
  );
  assert.equal(beforeSysctl.value(), '8080');
  assert.equal(beforeSysctl.state(), 'pending');
  assert.equal(beforeSysctl.recorded(), '49152-65535');
  beforeSysctl.run('release', beforeSysctl.record);
  assert.equal(beforeSysctl.value(), '8080');

  // Dies after the sysctl write but before it is confirmed (write 3, the applied save):
  // the reservation is in place AND the record already names it.
  const afterSysctl = sysctl(t, '8080');
  assert.throws(() => afterSysctl.runFailingWrite(3, 'apply', '49152', '65535', afterSysctl.record), /write 3 failed/u);
  assert.equal(afterSysctl.value(), '8080,49152-65535');
  assert.equal(afterSysctl.state(), 'pending');
  assert.equal(afterSysctl.recorded(), '49152-65535');
  // The next start does not mistake it for somebody else's, and a release takes it back.
  afterSysctl.run('apply', '49152', '65535', afterSysctl.record);
  assert.equal(afterSysctl.state(), 'applied');
  assert.equal(afterSysctl.recorded(), '49152-65535');
  afterSysctl.run('release', afterSysctl.record);
  assert.equal(afterSysctl.value(), '8080');
  assert.equal(afterSysctl.state(), 'released');
  assert.equal(afterSysctl.run('release', afterSysctl.record), 'nothing to release', 'a second release is a no-op');

  // A start that failed after the reservation (what ExecStopPost cleans up) with no further apply.
  const failedStart = sysctl(t, '');
  assert.throws(() => failedStart.runFailingWrite(3, 'apply', '49152', '65535', failedStart.record), /write 3 failed/u);
  failedStart.run('release', failedStart.record);
  assert.equal(failedStart.value(), '');
});

test('a release whose sysctl write fails keeps the record, so it can be retried', (t) => {
  const s = sysctl(t, '8080');
  s.run('apply', '49152', '65535', s.record);
  assert.throws(() => s.runFailingWrite(1, 'release', s.record), /write 1 failed/u);
  assert.equal(s.value(), '8080,49152-65535');
  assert.equal(s.recorded(), '49152-65535');
  s.run('release', s.record);
  assert.equal(s.value(), '8080');
});

test('a damaged ownership record is refused, not guessed at', (t) => {
  const s = sysctl(t, '');
  writeFileSync(s.record, 'garbage\n');
  assert.throws(() => s.run('release', s.record), /not an ownership record/u);
  assert.throws(() => s.run('apply', '49152', '65535', s.record), /not an ownership record/u);
});

test('covers fails, naming what is reserved, when the range is not wholly in the set', (t) => {
  const s = sysctl(t, '49152-65000');
  assert.throws(() => s.run('covers', '49152', '65535'), /not wholly reserved \(reserved: 49152-65000\)/u);
  const empty = sysctl(t, '');
  assert.throws(() => empty.run('covers', '49152', '65535'), /reserved: none/u);
});

test('a bad command or port is refused', (t) => {
  const s = sysctl(t, '');
  assert.throws(() => s.run('nope'), /usage/u);
  assert.throws(() => s.run('apply', '0', '10', s.record), /not a port/u);
  assert.throws(() => s.run('apply', '10', '70000', s.record), /not a port/u);
});
