// Records the Node twin of a tab's output pipeline (UTF-8 decoding, marker scanning, replay
// window, activity) into terminal-pipeline.json, the golden file tests/terminal.rs replays.
// Run from the repository root:
//   apps/desktop/node_modules/.bin/tsx native/mixdog-spawn/tests/fixtures/record-terminal-pipeline.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { TerminalActivityTracker, TerminalMarkerScanner } from '../../../../apps/desktop/src/main/terminal-activity.ts';
import { TerminalReplayBuffer } from '../../../../apps/desktop/src/main/terminal-manager.ts';

const here = dirname(fileURLToPath(import.meta.url));
const START_OFFSET = 1000;
const LIMIT = 200_000;

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const chunksOf = (buffer, size) => {
  const out = [];
  for (let i = 0; i < buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
};
const text = (value) => Buffer.from(value, 'utf8');

function fnv(units) {
  let hash = 0x811c9dc5;
  for (const unit of units) {
    hash ^= unit & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= unit >> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** ops: { data: Buffer } | { focus: [client, bool] } | { input: string } | { exit: true } */
function run(ops, { inferStart = false, integrated = true } = {}) {
  const decoder = new StringDecoder('utf8');
  const buffer = new TerminalReplayBuffer(LIMIT, START_OFFSET);
  const transitions = [];
  const activity = new TerminalActivityTracker((state) => transitions.push(state), { inferStartFromSubmit: inferStart });
  const markers = integrated ? new TerminalMarkerScanner() : null;
  for (const op of ops) {
    if (op.data) {
      const chunk = decoder.write(op.data);
      if (!markers) {
        buffer.append(chunk);
        continue;
      }
      const scanned = markers.scan(chunk);
      buffer.append(scanned.text);
      for (const marker of scanned.markers) activity.marker(marker);
    } else if (op.focus) {
      activity.setFocus(op.focus[0], op.focus[1]);
    } else if (op.input !== undefined) {
      if (markers) activity.input(op.input);
    } else if (op.exit) {
      if (markers) buffer.append(markers.flush());
      activity.exit();
    } else if (op.flush) {
      if (markers) buffer.append(markers.flush());
    }
  }
  const replay = buffer.read();
  const units = Array.from({ length: replay.length }, (_, i) => replay.charCodeAt(i));
  return {
    cursor: buffer.cursor,
    trimmed: buffer.trimmed,
    length: replay.length,
    fnv: fnv(units),
    head: replay.slice(0, 80),
    tail: replay.slice(-80),
    replay: replay.length <= 6000 ? replay : null,
    transitions,
  };
}

const serialize = (ops) =>
  ops.map((op) => (op.data ? { data: hex(op.data) } : op));

const scenarios = [];
const add = (name, ops, options = {}) =>
  scenarios.push({ name, options, ops: serialize(ops), expect: run(ops, options) });

const cycle = text('before\x1b]697;P\x07prompt> \x1b]697;C\x07output line\r\n\x1b]697;D;0\x07\x1b]697;P\x07after');
add('marker cycle whole', [{ data: cycle }]);
add('marker cycle byte by byte', chunksOf(cycle, 1).map((data) => ({ data })));
add('marker cycle 5-byte chunks', chunksOf(cycle, 5).map((data) => ({ data })));
add('marker cycle with focus', [
  { data: text('\x1b]697;P\x07') },
  { focus: ['a', true] },
  { data: text('\x1b]697;C\x07x\x1b]697;D;1\x07') },
  { focus: ['a', false] },
  { data: text('\x1b]697;C\x07y\x1b]697;D;0\x07') },
  { focus: ['b', true] },
  { focus: ['b', false] },
]);
add('string terminator and unknown body', [{ data: text('a\x1b]697;P\x1b\\b\x1b]697;Z\x07c\x1b]697;D;-2147483648\x07d') }]);
add('too long body is output', [{ data: text('a\x1b]697;D;1234567890123456789012345678901234567890\x07b') }]);
add('unterminated tail held then released by next chunk', [
  { data: text('x\x1b]697;D;') },
  { data: text('0\x07y') },
]);
add('unterminated tail released at stream end', [{ data: text('x\x1b]697;D;1') }, { exit: true }]);
// The 24-character window counts UTF-16 units: 13 two-byte characters are 26 bytes but 13 units.
add('non-ascii body inside the window is a stripped marker', [{ data: text(`a\x1b]697;${'é'.repeat(13)}\x07b`) }]);
add('non-ascii body past the window is output', [{ data: text(`a\x1b]697;${'é'.repeat(25)}\x07b`) }]);
add('non-ascii unterminated tail is held by units', [
  { data: text(`x\x1b]697;${'é'.repeat(20)}`) },
  { data: text('\x07y') },
]);
add('non-ascii unterminated tail past the bound is output', [{ data: text(`x\x1b]697;${'世'.repeat(25)}`) }]);
add('astral characters count as two units', [{ data: text(`x\x1b]697;${'😀'.repeat(11)}\x07y`) }, { data: text(`\x1b]697;${'😀'.repeat(13)}\x07z`) }]);
add('non-ascii text around markers byte by byte', chunksOf(text('é\x1b]697;P\x07世\x1b]697;C\x07😀\x1b]697;D;0\x07ñ'), 1).map((data) => ({ data })));
add('prefix split', [{ data: text('a\x1b]69') }, { data: text('7;P\x07b') }]);
add('lone escape held then released', [{ data: text('a\x1b') }, { data: text('b') }]);
add('cmd infers start from submit', [
  { data: text('\x1b]697;P\x07') },
  { input: 'dir\r' },
  { data: text('listing\r\n\x1b]697;P\x07') },
  { input: 'x' },
], { inferStart: true });
add('not integrated passes markers through', [{ data: text('a\x1b]697;P\x07b') }], { integrated: false });
add('exit clears activity', [{ data: text('\x1b]697;P\x07\x1b]697;C\x07') }, { exit: true }]);

const utf8 = text('héllo 世界 😀 end ñ\r\n');
add('utf-8 whole', [{ data: utf8 }]);
add('utf-8 byte by byte', chunksOf(utf8, 1).map((data) => ({ data })));
add('utf-8 2-byte chunks', chunksOf(utf8, 2).map((data) => ({ data })));
add('utf-8 3-byte chunks', chunksOf(utf8, 3).map((data) => ({ data })));

// Deterministic burst: shared with the Rust test (see burst() there).
const burstLines = [];
let burstBytes = 0;
for (let i = 0; burstBytes < 5 * 1024 * 1024; i += 1) {
  const line = `burst line ${String(i).padStart(8, '0')} é世 \r\n`;
  burstLines.push(line);
  burstBytes += Buffer.byteLength(line);
}
const burst = text(burstLines.join(''));
{
  const ops = chunksOf(burst, 4093).map((data) => ({ data }));
  scenarios.push({
    name: 'burst 5 MB',
    options: {},
    burst: { chunk: 4093, bytes: burst.length },
    ops: [],
    expect: run(ops),
  });
}

// Shell integration plans. Only plans that do not name a file are recorded exactly; for the
// shells that write startup files, the files' contents are recorded instead.
const planCases = [
  { spawn: { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, platform: 'win32' },
  { spawn: { path: '/usr/bin/pwsh' }, platform: 'linux' },
  { spawn: { path: 'powershell.exe', args: ['-NoLogo'] }, platform: 'win32' },
  { spawn: { path: 'C:\\WINDOWS\\System32\\cmd.exe' }, platform: 'win32' },
  { spawn: { path: 'C:\\WINDOWS\\System32\\cmd.exe', env: { PROMPT: 'X$G' } }, platform: 'win32' },
  { spawn: { path: 'cmd.exe', args: ['/k'] }, platform: 'win32' },
  { spawn: { path: '/usr/bin/cmd' }, platform: 'linux' },
  { spawn: { path: '/bin/bash' }, platform: 'linux', noRoot: true },
  { spawn: { path: '/usr/bin/fish' }, platform: 'linux' },
  { spawn: { path: '/bin/bash', args: ['-c', 'x'] }, platform: 'linux' },
  { spawn: { path: 'C:\\Windows\\System32\\bash.exe' }, platform: 'win32' },
  { spawn: { path: '/bin/zsh' }, platform: 'win32' },
];
const plans = planCases.map(({ spawn, platform, noRoot }) => {
  const plan = planShellIntegration(spawn, noRoot ? null : '/nonexistent-root/integration', {}, platform);
  return { spawn, platform, noRoot: noRoot === true, plan };
});

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { planShellIntegration } from '../../../../apps/desktop/src/main/terminal-shell-integration.ts';

const root = mkdtempSync(join(tmpdir(), 'mixdog-integration-'));
const bashPlan = planShellIntegration({ path: '/bin/bash', args: ['-i'] }, root, {}, 'linux');
const zshPlan = planShellIntegration({ path: '/bin/zsh' }, root, { HOME: '/home/u' }, 'linux');
const loginPlan = planShellIntegration({ path: '/bin/bash', args: ['--login'] }, root, { PROMPT_COMMAND: 'inherited' }, 'linux');
const files = {};
const walk = (dir, prefix) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
    else files[`${prefix}${name}`] = readFileSync(full, 'utf8');
  }
};
const version = readdirSync(root)[0];
walk(join(root, version), '');
const shellFiles = {
  files,
  bashArgsShape: bashPlan.args.map((arg, i) => (i === 1 ? '<script>' : arg)),
  bashIntegration: bashPlan.integration,
  zshIntegration: zshPlan.integration,
  zshEnvKeys: Object.keys(zshPlan.env).sort(),
  zshUserZdotdir: zshPlan.env.MIXDOG_USER_ZDOTDIR,
  zshUnsetFlag: zshPlan.env.MIXDOG_ZDOTDIR_UNSET,
  loginArgs: loginPlan.args,
  loginPromptCommandSuffix: loginPlan.env.PROMPT_COMMAND.endsWith('; inherited'),
  loginPromptCommandPrefix: loginPlan.env.PROMPT_COMMAND.slice(0, 40),
};

writeFileSync(
  join(here, 'terminal-pipeline.json'),
  `${JSON.stringify({ startOffset: START_OFFSET, limit: LIMIT, scenarios, plans, shellFiles }, null, 1)}\n`
);
console.log(`recorded ${scenarios.length} scenarios`);
