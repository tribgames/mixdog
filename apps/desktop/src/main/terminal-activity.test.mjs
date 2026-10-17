import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalActivityTracker, TerminalMarkerScanner } from './terminal-activity.ts';
import { TerminalManager } from './terminal-manager.ts';
import { planShellIntegration } from './terminal-shell-integration.ts';
import { readTerminalActivityEvent } from '../shared/terminal-activity.ts';

const mark = (body, terminator = '\x07') => `\x1b]697;${body}${terminator}`;

test('marker scanner reads prompt, start and done markers with BEL or ST terminators, and strips them', () => {
  const scanner = new TerminalMarkerScanner();
  assert.deepEqual(
    scanner.scan(`out${mark('P')}more${mark('C', '\x1b\\')}x${mark('D;0')}${mark('D;-3')}${mark('D')}`),
    {
      text: 'outmorex',
      markers: [
        { kind: 'prompt' },
        { kind: 'start' },
        { kind: 'done', exitCode: 0 },
        { kind: 'done', exitCode: -3 },
        { kind: 'done', exitCode: null },
      ],
    }
  );
  const plain = 'plain output \x1b]0;title\x07 \x1b[31mred';
  assert.deepEqual(scanner.scan(plain), { text: plain, markers: [] });
  // Unknown bodies are private markers too (removed, not reported); other
  // OSC numbers are ordinary output.
  assert.deepEqual(scanner.scan(`${mark('X')}\x1b]6970;P\x07${mark('D;abc')}`), {
    text: '\x1b]6970;P\x07',
    markers: [],
  });
});

test('marker scanner completes and strips markers split across chunks, including inside the prefix', () => {
  const scanner = new TerminalMarkerScanner();
  const stream = `a${mark('D;127')}b${mark('P')}c${mark('C', '\x1b\\')}`;
  const expected = [{ kind: 'done', exitCode: 127 }, { kind: 'prompt' }, { kind: 'start' }];
  for (let split = 1; split < stream.length; split += 1) {
    const first = scanner.scan(stream.slice(0, split));
    const second = scanner.scan(stream.slice(split));
    assert.deepEqual([...first.markers, ...second.markers], expected, `split at ${split}`);
    assert.equal(first.text + second.text, 'abc', `no marker text at split ${split}`);
    assert.equal(scanner.pending, false);
  }
  // One char at a time.
  const markers = [];
  let text = '';
  for (const char of stream) {
    const out = scanner.scan(char);
    markers.push(...out.markers);
    text += out.text;
  }
  assert.equal(markers.length, 3);
  assert.equal(text, 'abc');
});

test('a held possible marker start is released by flush, and a too-long one is plain output', () => {
  const scanner = new TerminalMarkerScanner();
  assert.deepEqual(scanner.scan('esc\x1b'), { text: 'esc', markers: [] });
  assert.equal(scanner.pending, true);
  assert.equal(scanner.flush(), '\x1b');
  assert.equal(scanner.pending, false);
  const long = `\x1b]697;${'x'.repeat(40)}`;
  assert.deepEqual(scanner.scan(long), { text: long, markers: [] });
  assert.deepEqual(scanner.scan(mark('P')), { text: '', markers: [{ kind: 'prompt' }] });
});

function tracker(options = {}) {
  const events = [];
  const activity = new TerminalActivityTracker((state) => events.push({ state }), options);
  return { activity, events };
}

test('state transitions: unknown → idle → running → finished (unfocused) → idle on focus', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { activity, events } = tracker();
  assert.equal(activity.state, null);
  // A done marker before any command (the first prompt) changes nothing.
  activity.marker({ kind: 'done', exitCode: 0 });
  assert.equal(activity.state, null);
  activity.marker({ kind: 'prompt' });
  assert.equal(activity.state, 'idle');
  activity.marker({ kind: 'start' });
  activity.marker({ kind: 'start' });
  assert.equal(activity.state, 'running');
  activity.marker({ kind: 'done', exitCode: 2 });
  activity.marker({ kind: 'prompt' });
  assert.equal(activity.state, 'finished');
  assert.deepEqual(events, [{ state: 'idle' }, { state: 'running' }, { state: 'finished' }]);
  activity.setFocus('desktop', true);
  assert.equal(activity.state, 'idle');
  assert.deepEqual(events.at(-1), { state: 'idle' });
  activity.dispose();
});

test('a command finishing in a focused tab goes straight back to idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { activity, events } = tracker();
  activity.marker({ kind: 'prompt' });
  activity.setFocus('desktop', true);
  activity.marker({ kind: 'start' });
  activity.marker({ kind: 'done', exitCode: 0 });
  assert.equal(activity.state, 'idle');
  assert.deepEqual(
    events.map((event) => event.state),
    ['idle', 'running', 'idle']
  );
  // Leaving the tab, then finishing: finished.
  activity.setFocus('desktop', false);
  activity.marker({ kind: 'start' });
  activity.marker({ kind: 'prompt' });
  assert.equal(activity.state, 'finished');
  activity.dispose();
});

test('a focus claim lapses unless renewed, and focus is per client', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { activity } = tracker();
  activity.marker({ kind: 'prompt' });
  activity.setFocus('phone', true);
  activity.setFocus('desktop', true);
  activity.setFocus('desktop', false);
  assert.equal(activity.focused, true, 'the phone still has it');
  t.mock.timers.tick(30_001);
  assert.equal(activity.focused, false);
  activity.marker({ kind: 'start' });
  activity.marker({ kind: 'done', exitCode: 0 });
  assert.equal(activity.state, 'finished');
  activity.dispose();
});

test('prompt-only integration (cmd) starts a command on a submitted line', () => {
  const { activity } = tracker({ inferStartFromSubmit: true });
  activity.input('dir\r');
  assert.equal(activity.state, null, 'nothing before the first prompt');
  activity.marker({ kind: 'prompt' });
  activity.input('di');
  assert.equal(activity.state, 'idle');
  activity.input('r\r');
  assert.equal(activity.state, 'running');
  activity.marker({ kind: 'prompt' });
  assert.equal(activity.state, 'finished');
  // Marker-reporting shells never infer from input.
  const other = tracker();
  other.activity.marker({ kind: 'prompt' });
  other.activity.input('ls\r');
  assert.equal(other.activity.state, 'idle');
});

test('exit returns to unknown', () => {
  const { activity, events } = tracker();
  activity.marker({ kind: 'prompt' });
  activity.marker({ kind: 'start' });
  activity.exit();
  assert.equal(activity.state, null);
  assert.deepEqual(events.at(-1), { state: null });
});

function fakeManager(dir = null) {
  const manager = new TerminalManager({ shellIntegrationDir: dir });
  const ptys = [];
  manager.loadPtyBindings = async () => ({
    spawn: (file, args) => {
      const pty = { file, args, data: null, exit: null, writes: [] };
      Object.assign(pty, {
        onData: (listener) => (pty.data = listener),
        onExit: (listener) => (pty.exit = listener),
        write: (value) => pty.writes.push(value),
        resize() {},
        kill() {},
      });
      ptys.push(pty);
      return pty;
    },
  });
  const activity = [];
  manager.subscribeActivity((event) => activity.push(event));
  const output = [];
  manager.subscribe((event) => output.push(event));
  return { manager, ptys, activity, output };
}

test('a shell without integration stays unknown even if it prints marker-like output', async () => {
  const { manager, ptys, activity } = fakeManager();
  await manager.ensure('session-terminal:fish', null, { path: '/usr/bin/fish' });
  assert.deepEqual(ptys[0].args, []);
  ptys[0].data(`${mark('P')}${mark('C')}${mark('D;0')}`);
  manager.write('session-terminal:fish', 'ls\r');
  assert.deepEqual(activity, []);
  assert.deepEqual(manager.activitySnapshot(), []);
  manager.disposeAll();
});

test('an integrated shell reports through the manager; markers never reach output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, ptys, activity, output } = fakeManager();
  const id = 'session-terminal:ps';
  await manager.ensure(id, null, { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  assert.deepEqual(ptys[0].args.slice(0, 2), ['-NoExit', '-EncodedCommand']);
  ptys[0].data(`PS> ${mark('D;0')}${mark('P')}`);
  assert.deepEqual(output, [{ id, data: 'PS> ' }]);
  assert.deepEqual(manager.activitySnapshot(), [{ id, state: 'idle' }]);
  ptys[0].data(mark('C'));
  ptys[0].data(`done\r\n${mark('D;1')}`);
  assert.deepEqual(
    activity.map((event) => event.state),
    ['idle', 'running', 'finished']
  );
  manager.focus(id, 'desktop', true);
  assert.deepEqual(activity.at(-1), { id, state: 'idle' });
  ptys[0].exit({ exitCode: 0 });
  assert.deepEqual(activity.at(-1), { id, state: null });
  manager.disposeAll();
});

test('a trimmed replay never exposes marker text, and held output is flushed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, ptys, output } = fakeManager();
  const id = 'session-terminal:replay';
  await manager.ensure(id, null, { path: 'pwsh.exe' });
  // The marker is the oldest output; the next chunk trims the replay to a
  // point inside where it was.
  ptys[0].data(`${mark('P')}${mark('C')}`);
  ptys[0].data('x'.repeat(200_000 - 3));
  const replay = manager.snapshot(id).text;
  assert.equal(replay, 'x'.repeat(200_000 - 3));
  assert.ok(!replay.includes('697') && !replay.includes('\x07'));
  // A marker split over two chunks: the held part is never output alone.
  output.length = 0;
  ptys[0].data('a\x1b]69');
  ptys[0].data(`7;D;0\x07b`);
  assert.deepEqual(
    output.map((event) => event.data),
    ['a', 'b']
  );
  // A lone trailing ESC is released once no chunk follows.
  ptys[0].data('c\x1b');
  assert.deepEqual(output.at(-1), { id, data: 'c' });
  t.mock.timers.tick(50);
  assert.deepEqual(output.at(-1), { id, data: '\x1b' });
  manager.disposeAll();
});

test('integration plans: PowerShell, cmd, bash (login and not), zsh, and the unchanged cases', () => {
  const root = process.platform === 'win32' ? 'C:\\tmp\\mixdog-it' : '/tmp/mixdog-it';
  const ps = planShellIntegration({ path: 'powershell.exe' }, null, {}, 'win32');
  assert.equal(ps.integration, 'powershell');
  const script = Buffer.from(ps.args[2], 'base64').toString('utf16le');
  assert.match(script, /PSConsoleHostReadLine/);
  assert.equal(planShellIntegration({ path: 'pwsh', args: ['-NoProfile'] }, null).integration, null);

  const cmd = planShellIntegration({ path: 'C:\\Windows\\System32\\cmd.exe' }, null, { PROMPT: '$G' }, 'win32');
  assert.equal(cmd.env.PROMPT, '$e]697;P$e\\$G');
  assert.equal(cmd.integration, 'cmd');

  // File-based integrations need Mixdog's directory.
  assert.equal(planShellIntegration({ path: '/bin/bash' }, null, {}, 'linux').integration, null);
  assert.equal(
    planShellIntegration({ path: 'C:\\Windows\\System32\\bash.exe' }, root, {}, 'win32').integration,
    null,
    'the WSL launcher is not integrated'
  );
  assert.equal(planShellIntegration({ path: 'wsl.exe', args: ['-d', 'Ubuntu'] }, root, {}, 'win32').integration, null);
  assert.equal(planShellIntegration({ path: '/usr/bin/fish' }, root, {}, 'linux').integration, null);
  assert.equal(planShellIntegration({ path: '/bin/bash', args: ['-c', 'x'] }, root, {}, 'linux').integration, null);
});

test('bash and zsh plans point at startup files written under Mixdog’s directory', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'mixdog-shell-it-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitBash = planShellIntegration(
    { path: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
    root,
    {},
    'win32'
  );
  assert.equal(gitBash.integration, 'bash');
  // A login shell keeps its own arguments (a real login shell) and is booted
  // from an inherited PROMPT_COMMAND.
  assert.deepEqual(gitBash.args, ['--login', '-i']);
  const script = /\. '([^']+)'/.exec(gitBash.env.PROMPT_COMMAND)?.[1];
  assert.ok(script && !script.includes('\\'), 'a POSIX-style path for MSYS bash');
  const rc = await readFile(script, 'utf8');
  assert.match(rc, /PROMPT_COMMAND="__mixdog_prompt/);
  assert.match(rc, /\]697;C/);
  const inherited = planShellIntegration(
    { path: '/bin/bash', args: ['-l'] },
    root,
    { PROMPT_COMMAND: 'mine' },
    'linux'
  );
  assert.match(inherited.env.PROMPT_COMMAND, /; mine$/);
  const plain = planShellIntegration({ path: '/bin/bash' }, root, {}, 'linux');
  assert.equal(plain.args[0], '--init-file');
  assert.equal(plain.env.PROMPT_COMMAND, undefined);

  const zsh = planShellIntegration({ path: '/bin/zsh', args: ['-l'] }, root, { HOME: '/home/u' }, 'darwin');
  assert.equal(zsh.integration, 'zsh');
  assert.deepEqual(zsh.args, ['-l']);
  assert.equal(zsh.env.MIXDOG_USER_ZDOTDIR, '/home/u');
  assert.equal(zsh.env.MIXDOG_ZDOTDIR_UNSET, '1');
  assert.match(await readFile(join(zsh.env.ZDOTDIR, '.zshrc'), 'utf8'), /precmd_functions=\(__mixdog_precmd/);
});

test('activity events validate off the wire', () => {
  assert.equal(readTerminalActivityEvent(null), null);
  assert.equal(readTerminalActivityEvent({ state: 'running' }), null);
  assert.deepEqual(readTerminalActivityEvent({ id: 't', state: 'bogus' }), { id: 't', state: null });
  assert.deepEqual(readTerminalActivityEvent({ id: 't', state: 'finished', extra: 1 }), { id: 't', state: 'finished' });
});
