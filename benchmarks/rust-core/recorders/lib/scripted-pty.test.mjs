import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FRAME_MAX, SCRIPTED_SHELL, spawn, takeFrames } from './scripted-pty.mjs';

const CONTROLS = String.fromCharCode(...Array.from({ length: 0x20 }, (_, i) => i), 0x7f);
const BIG = '0123456789abcdef'.repeat(200 * 64);
const frame = (text) => Buffer.concat([Buffer.from(`${Buffer.byteLength(text)}:`), Buffer.from(text)]);

test('each frame is one data event, whole, whatever its bytes or length or how the pipe cut it', () => {
  const stream = Buffer.concat([frame('one\r\ntwo\r\n'), frame(CONTROLS), frame(''), frame(BIG), frame('last'), Buffer.from('9:cut')]);
  const events = [];
  let pending = Buffer.alloc(0);
  for (const [from, to] of [[0, 3], [3, 17], [17, 40], [40, 70_000], [70_000, stream.length]]) {
    const { frames, rest } = takeFrames(Buffer.concat([pending, stream.subarray(from, to)]));
    pending = rest;
    events.push(...frames.map((f) => f.toString('utf8')));
  }
  assert.deepEqual(events, ['one\r\ntwo\r\n', CONTROLS, '', BIG, 'last']);
  assert.equal(pending.toString(), '9:cut', 'a frame cut off is never delivered short');
});

test('a header that is not a byte count, has a sign or claims more than the cap is an error', () => {
  for (const header of ['x1:a', '+1:a', '-1:a']) assert.throws(() => takeFrames(Buffer.from(header)), /not a byte count/, header);
  assert.throws(() => takeFrames(Buffer.from(`${FRAME_MAX + 1}:`)), /more than the 1048576/);
  assert.equal(takeFrames(frame('x'.repeat(FRAME_MAX))).frames[0].length, FRAME_MAX);
});

test("the frames decode as one stream, as node-pty's socket does: split characters whole, a dangling lead byte one U+FFFD at the end", async () => {
  const pty = spawn('', [], { cwd: process.cwd(), env: process.env });
  const events = [];
  const exited = new Promise((resolve) => pty.onExit(resolve));
  pty.onData((text) => events.push(text));
  pty.write('@bytes 61c3|a9|f09f|9880\n@bytes c3\n@exit 0\n');
  assert.deepEqual(await exited, { exitCode: 0, signal: undefined });
  assert.deepEqual(events, ['a', 'é', '😀', '\uFFFD']);
});

test("the script is the core's framed_profile, byte for byte", () => {
  const rust = readFileSync(new URL('../../../../native/mixdog-spawn/src/scripted.rs', import.meta.url), 'utf8');
  const literal = rust.slice(rust.indexOf('pub fn framed_profile')).match(/let script = "((?:[^"\\]|\\.)*)";/)[1];
  const script = Buffer.from(SCRIPTED_SHELL.args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, literal.replaceAll('\\\\', '\\'));
});

test('the scripted shell writes each chunk as one frame: RS and every control byte, 200 KiB; an empty chunk is no data event', async () => {
  const pty = spawn('', [], { cwd: process.cwd(), env: process.env });
  const events = [];
  const exited = new Promise((resolve) => pty.onExit(resolve));
  pty.onData((text) => events.push(text));
  const hex = [...CONTROLS].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  pty.write(`@chunks ${hex}|\n@chunks \n@fill ${BIG.length}\nplain\n@exit 4\n`);
  assert.deepEqual(await exited, { exitCode: 4, signal: undefined });
  assert.deepEqual(events, [CONTROLS, BIG, 'plain\r\n']);
});
