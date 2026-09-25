import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import {
  NOTO_FONT_DEFINITIONS,
  fontRegistrationCommand,
  getUserFontDirectory,
  isFontInstalled,
  prepareOfficeFonts,
} from './font-provisioner.mjs';

// A Windows profile path can carry an apostrophe (C:\Users\O'Brien); the
// registry value must be that path exactly, and nothing in it may run.
const QUOTED_PATH = "C:\\Users\\O'Brien\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Probe'; Remove-Item x; '.ttf";
const PROBE_FONT = { registryName: "Probe O'Font (TrueType)" };

test('font registration passes the name and path as data, never as script text', () => {
  const { command, args, env } = fontRegistrationCommand(PROBE_FONT, QUOTED_PATH);
  assert.equal(command, 'powershell.exe');
  const script = args.at(-1);
  assert.ok(!script.includes("O'Brien") && !script.includes('Probe O'), script);
  assert.equal(env.MIXDOG_FONT_PATH, QUOTED_PATH);
  assert.equal(env.MIXDOG_FONT_NAME, PROBE_FONT.registryName);
});

test('font registration hands PowerShell the path unchanged', { skip: platform() !== 'win32' }, async () => {
  const { command, args, env } = fontRegistrationCommand(PROBE_FONT, QUOTED_PATH);
  // The registry write is replaced by a function that reports what it received.
  const stub =
    'function New-ItemProperty { param($Path, $Name, $Value, $PropertyType, [switch]$Force) ' +
    '[Console]::Out.Write("$Name|$Value") }; ';
  const { stdout } = await promisify(execFile)(command, [...args.slice(0, -1), stub + args.at(-1)], {
    env,
    timeout: 30_000,
  });
  assert.equal(stdout, `${PROBE_FONT.registryName}|${QUOTED_PATH}`);
});

test('Noto font catalog is well-formed and unique', () => {
  const ids = new Set();
  const files = new Set();
  for (const def of NOTO_FONT_DEFINITIONS) {
    assert.match(def.id, /^noto-sans-[a-z]+$/);
    assert.match(def.family, /^Noto Sans/);
    assert.match(def.fileName, /^NotoSans[A-Za-z]*-Variable\.ttf$/);
    assert.match(def.url, /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/main\/ofl\//);
    assert.ok(Number.isInteger(def.bytes) && def.bytes > 0);
    assert.ok(!ids.has(def.id) && !files.has(def.fileName));
    ids.add(def.id);
    files.add(def.fileName);
  }
  assert.ok(ids.has('noto-sans-latin') && ids.has('noto-sans-kr'));
});

test('user font directory is absolute and unknown fonts report their install target', () => {
  const dir = getUserFontDirectory();
  assert.ok(isAbsolute(dir));
  const status = isFontInstalled({ fileName: 'Mixdog-NotInstalled-Probe.ttf' });
  assert.equal(status.installed, false);
  assert.ok(status.path.startsWith(dir));
});

test('prepareOfficeFonts absorbs download failures per font instead of throwing', async (t) => {
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const targets = [
    {
      id: 'probe-a',
      family: 'Probe A',
      fileName: 'Mixdog-Probe-A.ttf',
      registryName: 'Probe A',
      url: 'https://example.invalid/a.ttf',
      bytes: 1,
    },
    {
      id: 'probe-b',
      family: 'Probe B',
      fileName: 'Mixdog-Probe-B.ttf',
      registryName: 'Probe B',
      url: 'https://example.invalid/b.ttf',
      bytes: 1,
    },
  ];
  const results = await prepareOfficeFonts({ targets });
  assert.deepEqual(Object.keys(results).sort(), ['probe-a', 'probe-b']);
  for (const entry of Object.values(results)) {
    assert.equal(entry.installed, false);
    assert.match(entry.error, /offline/);
  }
});
