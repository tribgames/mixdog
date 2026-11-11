import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCRIPTED_SHELL, spawn, takeFrames } from './scripted-pty.mjs';

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

test('a header that is not a byte count is an error', () => {
  assert.throws(() => takeFrames(Buffer.from('x1:a')), /not a byte count/);
});

test("the script is the core's framed_profile, byte for byte", () => {
  const rust = readFileSync(new URL('../../../../native/mixdog-spawn/src/scripted.rs', import.meta.url), 'utf8');
  const literal = rust.slice(rust.indexOf('pub fn framed_profile')).match(/let script = "((?:[^"\\]|\\.)*)";/)[1];
  const script = Buffer.from(SCRIPTED_SHELL.args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, literal.replaceAll('\\\\', '\\'));
});

test('the scripted shell writes each chunk as one frame: RS and every control byte, an empty chunk, 200 KiB', async () => {
  const pty = spawn('', [], { cwd: process.cwd(), env: process.env });
  const events = [];
  const exited = new Promise((resolve) => pty.onExit(resolve));
  pty.onData((text) => events.push(text));
  const hex = [...CONTROLS].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  pty.write(`@chunks ${hex}|\n@chunks \n@fill ${BIG.length}\nplain\n@exit 4\n`);
  assert.deepEqual(await exited, { exitCode: 4, signal: undefined });
  assert.deepEqual(events, [CONTROLS, '', '', BIG, 'plain\r\n']);
});
