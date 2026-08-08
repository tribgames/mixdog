// Orphan temp-postmaster sweep classifier: only a mixdog-named pgdata under
// the OS temp root, run by a POSTMASTER (not a fork child), older than the
// uptime floor may be reaped. Real data dirs, dev roots, young test runs and
// foreign postgres installs must never match.
import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyOrphanTempPostmaster } = await import('../src/runtime/memory/lib/pg/process.mjs');

const TEMP = 'C:/Users/tempe/AppData/Local/Temp';
const OLD = 60 * 60; // 1h
const YOUNG = 5 * 60;

function row(args, uptimeSec = OLD, tempRoot = TEMP) {
  return classifyOrphanTempPostmaster({ args, uptimeSec, tempRoot });
}

test('temp mixdog postmasters older than the floor are reaped', () => {
  assert.equal(row(
    `"${TEMP}/mixdog-spread-perf-abc/data/runtime/runtime-pg16.4/bin/postgres.exe" -D "${TEMP}/mixdog-spread-perf-abc/data/pgdata"`,
  ), true);
  // Backslash command lines (raw Win32 CommandLine) normalize the same way.
  assert.equal(row(
    `C:\\Users\\tempe\\AppData\\Local\\Temp\\mixdog\\runtime\\bin\\postgres.exe -D C:\\Users\\tempe\\AppData\\Local\\Temp\\mixdog\\pgdata`,
    OLD,
    'C:\\Users\\tempe\\AppData\\Local\\Temp',
  ), true);
});

test('everything else is kept', () => {
  // Young: a live test/perf run still owns it.
  assert.equal(row(
    `postgres.exe -D "${TEMP}/mixdog-spread-perf-live/data/pgdata"`, YOUNG,
  ), false);
  // Real data dir: not under temp.
  assert.equal(row(
    'postgres.exe -D "C:/Users/tempe/.mixdog/data/pgdata"',
  ), false);
  // Dev root: not under temp.
  assert.equal(row(
    'postgres.exe -D "C:/Project/mixdog/.mixdog/dev-data/pgdata"',
  ), false);
  // Temp but not mixdog-named: a foreign postgres.
  assert.equal(row(
    `postgres.exe -D "${TEMP}/other-app/pgdata"`,
  ), false);
  // Fork children die with their postmaster; never target them directly.
  assert.equal(row(
    `postgres.exe --forkbackend 5592 -D "${TEMP}/mixdog-x/pgdata"`,
  ), false);
  // No -D at all.
  assert.equal(row('postgres.exe --single'), false);
});
