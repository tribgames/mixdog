#!/usr/bin/env node
// Golden twin of how Node on Windows words a failed file operation: libuv's own translation of a
// Win32 error to an errno (`uv_translate_sys_error`, src/win/error.c of the libuv bundled with the
// Node that runs this: process.versions.uv), the Win32 error numbers from the Windows SDK's
// winerror.h, libuv's description of each errno, and the whole message of real failed calls.
//
//   node benchmarks/rust-core/recorders/record-errno-win32.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, openSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { FIXTURES_ROOT } from './lib/common.mjs';

if (process.platform !== 'win32') throw new Error('records how Node words Win32 errors: run it on Windows');

const tag = `v${process.versions.uv}`;
const url = `https://raw.githubusercontent.com/libuv/libuv/${tag}/src/win/error.c`;
const source = await (await fetch(url)).text();
const body = source.slice(source.indexOf('int uv_translate_sys_error'), source.indexOf('int uv_translate_write_sys_error'));
const cases = [...body.matchAll(/case (\w+):\s+return UV_(\w+);/g)].map(([, win, uv]) => ({ win, uv }));
if (cases.length < 100) throw new Error(`parsed only ${cases.length} cases from ${url}`);

const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\Include';
const sdk = readdirSync(kits).filter((name) => existsSync(join(kits, name, 'shared', 'winerror.h'))).sort().pop();
const header = readFileSync(join(kits, sdk, 'shared', 'winerror.h'), 'utf8');
const numberOf = (name) => {
  const hit = header.match(new RegExp(`^#define\\s+${name}\\s+\\(?(0x[0-9a-fA-F]+|\\d+)L?\\)?\\s*(?:$|//|/\\*)`, 'm'));
  if (!hit) throw new Error(`${name} not defined in winerror.h`);
  return Number(hit[1]);
};

const described = {};
for (const [, [name, description]] of getSystemErrorMap()) described[name] = description;
const uvNames = [...new Set(cases.map(({ uv }) => uv))].sort();
const descriptions = Object.fromEntries(uvNames.map((name) => [name, described[name] ?? (() => { throw new Error(`no description of ${name}`); })()]));
const pairs = cases.map(({ win, uv }) => ({ win, number: numberOf(win), errno: uv }));
const unknown = { errno: 'UNKNOWN', description: described.UNKNOWN };

// Real failures. Paths are in a sandbox; the recorded text names it `<dir>`.
const dir = mkdtempSync(join(tmpdir(), 'errno-win32-'));
const real = [];
const attempt = (name, step, run) => {
  try {
    run();
    throw new Error(`${name}: the call succeeded`);
  } catch (error) {
    if (!error.code) throw error;
    real.push({ name, step, message: error.message.split(dir).join('<dir>'), code: error.code });
  }
};
const file = (name, text = 'x') => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
attempt('a file that is not there', 'open', () => openSync(join(dir, 'absent.json'), 'r'));
attempt('a directory that is not there', 'open', () => openSync(join(dir, 'no-dir', 'a.json'), 'wx'));
attempt('a file that already exists', 'open', () => openSync(file('exists.json'), 'wx'));
attempt('a name Windows refuses', 'open', () => openSync(join(dir, 'a|b'), 'wx'));
attempt('a directory that already exists', 'mkdir', () => (mkdirSync(join(dir, 'made')), mkdirSync(join(dir, 'made'))));
const locked = file('locked.json');
chmodSync(locked, 0o444);
const from = file('from.json');
attempt('a rename onto a read-only file', 'rename', () => renameSync(from, locked));
mkdirSync(join(dir, 'target-dir'));
attempt('a rename onto a directory', 'rename', () => renameSync(file('from2.json'), join(dir, 'target-dir')));
mkdirSync(join(dir, 'full'));
file(join('full', 'inner.json'));
attempt('a directory with something in it removed', 'rmdir', () => rmdirSync(join(dir, 'full')));
// A file another process holds open with no sharing.
const held = file('held.json');
const holder = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${held}','Open','ReadWrite','None'); 'ready'; Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((resolve) => holder.stdout.once('data', resolve));
attempt('a file another process holds open, removed', 'unlink', () => unlinkSync(held));
attempt('a file another process holds open, renamed over', 'rename', () => renameSync(file('over.json'), held));
holder.kill();
await new Promise((resolve) => holder.once('exit', resolve));
rmSync(dir, { recursive: true, force: true });

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/errno-win32-twin.json`,
  `${JSON.stringify({ domain: 'errno-win32-twin', recorder: 'benchmarks/rust-core/recorders/record-errno-win32.mjs', source: { url, tag, libuv: process.versions.uv, node: process.version, function: 'uv_translate_sys_error' }, numbers: { windowsSdk: sdk, file: 'shared/winerror.h' }, pairs, descriptions, unknown, real }, null, 1)}\n`
);
console.log(`recorded ${pairs.length} pairs, ${uvNames.length} errnos, ${real.length} calls (libuv ${tag}, SDK ${sdk})`);
