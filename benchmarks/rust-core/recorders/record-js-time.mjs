#!/usr/bin/env node
// Golden twin of `mixdog_js::time`: `Date.parse` (ISO and V8's legacy forms), local-time construction
// (`new Date(y, m, d, h, mi, s, ms)`), `getTimezoneOffset` and the local getters, recorded by
// Node under several `TZ` values (including DST gaps and overlaps). Output:
// native/core/crates/mixdog-js/testdata/time_v8.json
//
//   node benchmarks/rust-core/recorders/record-js-time.mjs [--out <dir>]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, parseArgs, writeJson } from './lib/common.mjs';

const ZONES = ['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'America/Sao_Paulo', 'Asia/Kolkata'];
const TRANSITIONS = ['2024-03-10', '2024-11-03', '2024-03-31', '2024-10-27', '1988-05-08', '1988-10-09', '2024-10-06', '2024-04-07', '2018-11-04', '2019-02-17'];

function record() {
  let seed = 0x7e57c10c;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ISO = /^([+-]\d{6}|\d{4})(-\d\d(-\d\d)?)?(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/;

  const strings = [
    '', 'x', '2025', '2025-03', '2025-03-01', '2025-13-01', '2025-00-10', '2025-01-32', '2025-02-30', '2024-02-29', '2023-02-29',
    '2025-03-01T10:00', '2025-03-01T10:00Z', '2025-03-01T10:00:00', '2025-03-01T10:00:00Z', '2025-03-01T10:00:00.5', '2025-03-01T10:00:00.123456789Z',
    '2025-03-01T10:00:00+09:00', '2025-03-01T10:00:00-05:30', '2025-03-01T24:00:00Z', '2025-03-01T24:00:00', '2025-03-01T24:00:01Z', '2025-03-01T25:00Z',
    '2025-03-01T10:60Z', '2025-03-01T10:00:60Z', '2025-03-01T10', '2025-03-01T10:00:00.', '2025-03-01 10:00', '2025-3-1', '-000000-01-01', '+000000-01-01',
    '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z', '+275761-01-01', '0000-01-01',
    '0099-05-05T05:05:05', '1970', '1969-12-31T23:59:59.999Z', '2025-03-01T10:00:00+0900', '2025-03-01t10:00:00z', ' 2025-03-01', '2025-03-01T10:00:00+09', 'Mar 1 2025',
    '2025/03/01', '2025-03-01T10:00:00.1234567Z', '2025-03-01T10:00:00+24:00', '2025-03-01T10:00:00+99:99',
  ];
  // V8's legacy reader: month names, slashes, weekday prefixes, am/pm, zone names and numeric
  // offsets, comments, numeric-only text, two-digit years and text that must be NaN.
  strings.push(
    'May 6, 2024', 'May 6 2024', '6 May 2024', 'May 2024', 'May 6', 'May', 'may 6, 2024', 'MAY 6, 2024', 'Mayday 6 2024', 'Sept 6 2024', 'September 6, 2024',
    'Janxyz 5 2020', 'Dec 31, 1999 23:59:59', 'Dec 31 1999 23:59:59.5', 'Dec 31 1999 23:59:59.123456', 'Feb 30 2024', 'Feb 29 2023', 'Apr 31 2024',
    '5/6/2024', '5/6/24', '5/6/49', '5/6/50', '5/6/99', '5/6', '13/6/2024', '12/31/2024', '2024/05/06', '2024/5/6', '2024/13/06', '2024/05/32', '1/2/3',
    '5-6-2024', '2024-5-6', '2024-05-6', '2024-5-06', '5/6/2024 10:30', '5/6/2024 10:30:15', '5/6/2024 10:30 PM', '5/6/2024 12:30 AM', '5/6/2024 12:30 PM',
    '5/6/2024 13:30 PM', '5/6/2024 0:30 AM', '5/6/2024 3 PM', '5/6/2024 3PM', '5/6/2024 3:04:05.678 pm', '5/6/2024 24:00', '5/6/2024 24:00:01', '5/6/2024 25:00',
    '5/6/2024 10:60', '5/6/2024 10:30::', '5/6/2024 10::', '5/6/2024 10:30:15:20', '5/6/2024 10.30', '5/6/2024 10:30.5', '5/6/2024 10:30:15.5', '5/6/2024 10:30:15.',
    'Mon, 06 May 2024 10:00:00 GMT', 'Mon, 06 May 2024 10:00:00 +0900', 'Mon, 06 May 2024 10:00:00 -0500', 'Mon, 06 May 2024 10:00:00 UT', 'Mon, 06 May 2024 10:00:00 UTC',
    'Monday May 6 2024', 'Mon May 06 2024 10:00:00 GMT+0900 (Korean Standard Time)', 'Mon May 06 2024 10:00:00 GMT+0900', 'Mon May 06 2024 10:00:00 GMT-0500 (Eastern Standard Time)',
    'Mon May 06 2024 10:00:00 GMT+09:00', 'Mon May 06 2024 10:00:00 GMT+9', 'Mon May 06 2024 10:00:00 GMT-8', 'Mon May 06 2024 10:00:00 GMT+12345', 'Mon May 06 2024 10:00:00 GMT+',
    'Mon May 06 2024 10:00:00 GMT+09:30', 'Mon May 06 2024 10:00:00 GMT+0930 extra', 'Mon May 06 2024 10:00:00 Z', 'Mon May 06 2024 10:00:00Z', 'May 6 2024 10:00 EST', 'May 6 2024 10:00 EDT',
    'May 6 2024 10:00 CST', 'May 6 2024 10:00 CDT', 'May 6 2024 10:00 MST', 'May 6 2024 10:00 MDT', 'May 6 2024 10:00 PST', 'May 6 2024 10:00 PDT', 'May 6 2024 10:00 XYZ',
    'May 6 2024 10:00 +05:30', 'May 6 2024 10:00 -0330', 'May 6 2024 10:00+09:00', 'May 6 2024 10:00 +09:00 PM', 'May 6 2024 10:00 +0900 +0900', 'May 6 2024 +0900', 'May 6 2024 GMT+0900',
    'May 6 (comment) 2024', '(c) May 6 2024', 'May 6 2024 (unclosed', 'May 6 2024 (a (nested) b) 10:00', 'May 6 2024)', '(May 6 2024)', 'May 6 2024 ((',
    '0', '1', '12', '99', '100', '1000', '2024', '12345', '99999', '999999', '1000000', '1000001', '2000000', '123456789', '1234567890', '12345678901', '-1', '+1', '-2024', '+2024',
    '0 0', '1 1', '1 2 3', '1 2 3 4', '0/0/0', '00/00/00', '1.2.3', '1.2', '2024.05.06', '5.6.2024', '1,2,3',
    'Tue Mar 01 2025', 'Tuesday, March 1, 2025', 'Tue, 1 Mar 2025', 'Tuesday', 'foo', 'foo 2024', '2024 foo', 'foo 5/6/2024', '5/6/2024 foo', 'foo5', '5foo', 'hello world 5', 'x 1 2',
    '2025-03-01 10:00', '2025-03-01 10:00:00', '2025-03-01 10:00:00Z', '2025-03-01 10:00:00 Z', '2025-03-01 10:00:00+09:00', '2025-03-01 10:00:00 +0900', '2025-03-01 10:00:00.123',
    '2025-03-01T10:00:00 +09:00', '2025-03-01T10:00:00 Z', '2025-03-01T10:00:00Z extra', '2025-03-01T10:00:00z', '2025-03-01Tfoo', '2025-03-01T', '2025-03-01T10:00:00+0900', '2025-03-01T10:00:00+09:0',
    '2025-03-01T10:00:00.000+09:00', '2025-03-01T1:00', '2025-03-01T10:0', '2025-03-01T10:00:0', '2025-03-01T24:00', '2025-03-01T24:00:00.000', '2025-03-01T24:00:00.001', '2025-03-01T10:00:00.Z',
    '2025-03-', '2025-03-0', '2025-03-001', '20250301', '2025031', '+002025-03-01', '+02025-03-01', '+0020250-03-01', '-002025-03-01', '+275760-09-13', '+275760-09-14', '-271821-04-20', '-271821-04-19',
    '+1000000-01-01', '+999999-12-31', '-999999-01-01', '-000000-01-01T00:00:00Z', '+000000-01-01', '-000001-01-01',
    '1970-01-01', '1970-01-01T00:00:00', '1970-01-01T00:00:00Z', '1970-1-1', '1970/1/1', 'Jan 1 1970', 'Jan 1, 1970 00:00:00 UTC', 'Jan 1, 1970 00:00:00 GMT', 'Thu, 01 Jan 1970 00:00:00 GMT',
    '1/1/1970 GMT', '1/1/1970 UTC', '1/1/1970 Z', '1/1/1970 00:00:00 +0000', '1/1/70', '1/1/00', '1/1/0', '1/1/1', '1/1/100', '1/1/-1', '1/-1/1', '-1/1/1',
    'Jan 1 275760 00:00:00 UTC', 'Sep 13 275760 00:00:00 UTC', 'Sep 13 275760 00:00:01 UTC', 'Jan 1 1000000', 'Jan 1 1000001', 'Jan 1 -1', 'Jan 1 0',
    ' May 6, 2024', 'May 6, 2024 ', '\tMay 6, 2024\n', 'May\u00a06,\u00a02024', 'May\u20036 2024', 'May\u20286 2024', 'May\ufeff6 2024', 'May\u00856 2024', 'caf\u00e9 5/6/2024', '\u00e95/6/2024',
    'May 6, 2024\u0000junk', '\u0000May 6, 2024', '5/6/2024 \u0000 foo', '\u65e5\u672c 2024', 'May 6 \ud83d\ude00 2024',
    'AM', 'PM 5/6/2024', '10:30', '10:30 PM', '10:30:15', '10:30:15 GMT', '3 PM', '10 AM May 6 2024', 'May 6 2024 AM', 'May 6 2024 10 AM', 'May 6 2024 10:00 AM AM', 'May 6 2024 10:00 AM PM',
    'T', 'Z', 'GMT', 'GMT+0900', 'UTC 2024', '2024 UTC', '2024 GMT+9', '2024 Z', '2024 T', '2024T', '2024-05-06T', '1 Z', '1 GMT', '1 z', '1 gmt+1',
    '+', '-', '--', '++', ')', '(', '()', '.', ':', '::', ',', '/', '//', '5//6', '5/', '/5', '5/6/', '5/6/2024/', '5/6/2024-', '5/6/2024+', '5/6/2024)',
    'Wed Dec 31 1969 19:00:00 GMT-0500 (Eastern Standard Time)', 'Fri, 31 Dec 1999 23:59:59 GMT', 'Sat, 01 Jan 2000 00:00:00 +0000', 'Sun, 02 Jan 2000 09:00:00 +0900',
    'Sun Jan 02 2000 09:00:00 GMT+0900 (KST)', '2000-01-02 09:00:00 +09:00', 'January 2, 2000 9:00 AM', 'Jan 2 2000 9:00am', 'Jan 2 2000 9:00 a.m.', '2 Jan 2000 09:00:00.250',
    'March 1st 2025', 'March 1st, 2025', '1st March 2025', 'Mar 1, 2025, 10:00:00 AM', '3/1/2025, 10:00:00 AM', '3/1/2025, 10:00:00 PM', '01.03.2025 10:00', '2025.03.01 10:00',
  );
  for (const day of TRANSITIONS) {
    for (let h = 0; h < 5; h += 1) for (const m of [0, 15, 30, 45]) strings.push(`${day}T${pad(h)}:${pad(m)}:00`, `${day}T${pad(h)}:${pad(m)}`);
  }
  // Legacy spellings of the transition instants (local-time readings in a DST gap or overlap).
  for (const day of TRANSITIONS) {
    const [y, mo, d] = day.split('-').map(Number);
    for (let h = 0; h < 5; h += 1) for (const m of [0, 30]) strings.push(`${mo}/${d}/${y} ${h}:${pad(m)}`, `${day} ${pad(h)}:${pad(m)}:00`, `${y}/${pad(mo)}/${pad(d)} ${pad(h)}:${pad(m)} AM`);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ZONES_TEXT = ['', ' GMT', ' UTC', ' Z', ' EST', ' PDT', ' +0900', ' -0530', ' GMT+0900', ' GMT-8', ' +09:00', ' (Comment)'];
  for (let i = 0; i < 400; i += 1) {
    // DST rules in 2100 are not in chrono-tz's table (ICU keeps applying them): out of range.
    const y = int(1900, 2099);
    const mo = int(1, 12);
    const d = int(1, 31);
    const time = rnd() < 0.7 ? ` ${int(0, 24)}:${pad(int(0, 59))}${rnd() < 0.5 ? `:${pad(int(0, 59))}` : ''}${rnd() < 0.3 ? ` ${rnd() < 0.5 ? 'AM' : 'PM'}` : ''}` : '';
    const zone = ZONES_TEXT[int(0, ZONES_TEXT.length - 1)];
    const wd = rnd() < 0.3 ? `${WEEKDAYS[int(0, 6)]}, ` : '';
    const yy = rnd() < 0.2 ? pad(y % 100) : String(y);
    const form = int(0, 5);
    const text = [`${mo}/${d}/${yy}`, `${y}/${mo}/${d}`, `${MONTHS[mo - 1]} ${d}, ${yy}`, `${d} ${MONTHS[mo - 1]} ${yy}`, `${MONTHS[mo - 1]} ${d} ${yy}`, `${y}-${mo}-${d}`][form];
    strings.push(`${wd}${text}${time}${zone}`);
  }
  for (let i = 0; i < 150; i += 1) {
    const n = int(1, 4);
    strings.push(Array.from({ length: n }, () => String(int(0, rnd() < 0.5 ? 99 : 3000))).join(['/', ' ', '-', ':', '.'][int(0, 4)]));
  }
  for (let i = 0; i < 300; i += 1) {
    const y = int(1900, 2099);
    let s = pad(y, 4);
    if (rnd() < 0.8) s += `-${pad(int(1, 12))}`;
    if (s.length > 4 && rnd() < 0.8) s += `-${pad(int(1, 31))}`;
    if (s.length > 7 && rnd() < 0.7) {
      s += `T${pad(int(0, 23))}:${pad(int(0, 59))}`;
      if (rnd() < 0.7) s += `:${pad(int(0, 59))}`;
      if (s.length > 16 && rnd() < 0.5) s += `.${pad(int(0, 999), int(1, 3))}`;
      const z = rnd();
      s += z < 0.3 ? 'Z' : z < 0.6 ? `${rnd() < 0.5 ? '+' : '-'}${pad(int(0, 14))}:${pad(int(0, 59))}` : '';
    }
    strings.push(s);
  }
  const parse = strings.map((text) => ({ text, iso: ISO.test(text) && !text.startsWith('-000000'), value: Date.parse(text) }));

  const locals = [];
  const push = (y, m, d, h, mi, s, ms) => locals.push({ args: [y, m, d, h, mi, s, ms], value: new Date(y, m - 1, d, h, mi, s, ms).getTime() });
  for (const day of TRANSITIONS) {
    const [y, m, d] = day.split('-').map(Number);
    for (let h = 0; h < 5; h += 1) for (const mi of [0, 15, 30, 45]) push(y, m, d, h, mi, 0, 0);
  }
  for (let i = 0; i < 400; i += 1) push(int(1950, 2060), int(1, 12), int(1, 31), int(0, 23), int(0, 59), int(0, 59), int(0, 999));
  push(2025, 1, 32, 25, 61, 61, 1001);
  push(2025, 3, 0, 0, 0, 0, 0);
  push(2025, 12, 31, 24, 0, 0, 0);
  push(275760, 9, 13, 0, 0, 0, 0);
  push(275760, 9, 14, 0, 0, 0, 0);

  const instants = [];
  for (const day of TRANSITIONS) {
    const base = Date.UTC(...day.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
    for (let h = -6; h < 30; h += 1) instants.push(base + h * 3600000, base + h * 3600000 + 1800000);
  }
  for (let i = 0; i < 300; i += 1) instants.push(Math.floor(rnd() * 3.3e12) - 1.0e12);
  const offsets = instants.map((t) => ({ t, offset: -new Date(t).getTimezoneOffset() * 60000 }));
  const fields = instants.map((t) => {
    const d = new Date(t);
    return { t, f: [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(), d.getDay()] };
  });
  return { parse, locals, offsets, fields };
}

if (process.argv.includes('--child')) {
  process.stdout.write(JSON.stringify(record()));
} else {
  const cli = parseArgs();
  const zones = {};
  for (const zone of ZONES) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env: { ...process.env, TZ: zone }, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (run.status !== 0) throw new Error(`child ${zone}: ${run.stderr}`);
    zones[zone] = JSON.parse(run.stdout);
  }
  // NaN is not JSON: the child's JSON.stringify wrote null for it.
  const outDir = cli.get('out') ?? join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-js', 'testdata');
  writeJson(join(outDir, 'time_v8.json'), { recorder: 'benchmarks/rust-core/recorders/record-js-time.mjs', node: process.version, zones });
  console.log(`recorded ${ZONES.length} zones`);
}
