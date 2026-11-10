import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, statSync, writeFileSync } from 'node:fs';
import { createPromotedCaptureRelease } from './lib/shell-run-settle.mjs';
import { join } from 'node:path';
import { TaskOutput, ShellTextDecoder } from './shell-exec-output.mjs';
import {
  ShellStreamDecoder,
  FileEncodingSniffer,
  evaluateWindow,
  alignedOffset,
  charBoundaryBefore,
  decodeShellBytes,
  oemTextEncoding,
  sniffShellEncoding,
} from './shell-codepage.mjs';
import { readShellTaskOutput } from './builtin/lib/shell-task-output.mjs';

void fixtureRoot;

// "트 32바이트 데이터 사용: 한글" in CP949 (트 = C6 AE, also valid UTF-8 "Ʈ").
const CP949 = Buffer.from([
  0xc6, 0xae, 0x20, 0x33, 0x32, 0xb9, 0xd9, 0xc0, 0xcc, 0xc6, 0xae, 0x20, 0xb5, 0xa5, 0xc0, 0xcc, 0xc5, 0xcd, 0x20,
  0xbb, 0xe7, 0xbf, 0xeb, 0x3a, 0x20, 0xc7, 0xd1, 0xb1, 0xdb,
]);
const CP949_TEXT = '트 32바이트 데이터 사용: 한글';
const UTF8_TEXT = '한글 테스트 데이터 😀 ok';

function streamAll(chunks, oem = 'euc-kr') {
  const d = new ShellStreamDecoder(oem);
  return chunks.map((c) => d.write(c)).join('') + d.end();
}

test('CP949-only stream decodes at every single split point', () => {
  assert.equal(streamAll([CP949]), CP949_TEXT);
  for (let cut = 0; cut <= CP949.length; cut++) {
    assert.equal(streamAll([CP949.subarray(0, cut), CP949.subarray(cut)]), CP949_TEXT, `cut ${cut}`);
  }
  // byte-by-byte
  assert.equal(streamAll([...CP949].map((b) => Buffer.from([b]))), CP949_TEXT);
});

test('ShellTextDecoder applies the same stream decision', () => {
  const d = new ShellTextDecoder('euc-kr');
  let out = '';
  for (let i = 0; i < CP949.length; i += 3) out += d.write(CP949.subarray(i, i + 3));
  assert.equal(out + d.end(), CP949_TEXT);
});

test('UTF-8-only stream decodes at every split point', () => {
  const bytes = Buffer.from(UTF8_TEXT.repeat(3), 'utf8');
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.equal(streamAll([bytes.subarray(0, cut), bytes.subarray(cut)]), UTF8_TEXT.repeat(3), `cut ${cut}`);
  }
});

test('ASCII-then-CP949 stream commits to the OEM page', () => {
  const bytes = Buffer.concat([Buffer.from('Ping 127.0.0.1\r\n'), CP949]);
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.equal(
      streamAll([bytes.subarray(0, cut), bytes.subarray(cut)]),
      `Ping 127.0.0.1\r\n${CP949_TEXT}`,
      `cut ${cut}`
    );
  }
  assert.equal(streamAll([Buffer.from('plain ascii')]), 'plain ascii');
});

test('no OEM page keeps plain UTF-8 behavior', () => {
  assert.equal(
    streamAll([Buffer.from('가', 'utf8').subarray(0, 1), Buffer.from('가', 'utf8').subarray(1)], null),
    '가'
  );
  assert.equal(decodeShellBytes(Buffer.from('가', 'utf8'), null), '가');
});

test('sniff: invalid UTF-8 is OEM, valid is UTF-8, short ambiguity waits', () => {
  assert.equal(sniffShellEncoding(CP949, 'euc-kr', true), 'euc-kr');
  assert.equal(sniffShellEncoding(Buffer.from(UTF8_TEXT), 'euc-kr', true), 'utf-8');
  assert.equal(sniffShellEncoding(Buffer.from('abc'), 'euc-kr', false), null);
});

test('real binary is still sanitized', () => {
  const out = new TaskOutput('codepage-binary');
  const decoder = new ShellTextDecoder('euc-kr');
  out.writeStdout(decoder.write(Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x00, 0x41])));
  assert.match(out.stdoutBuf, /^\[binary output on stdout sanitized/);
  assert.ok(!out.stdoutBuf.includes('\u0000'));
});

test('character boundaries: DBCS lead/trail rules and UTF-8 rules', () => {
  // "트트트": every cut inside a pair backs up to the pair start.
  const k = Buffer.from([0xc6, 0xae, 0xc6, 0xae, 0xc6, 0xae]);
  assert.equal(charBoundaryBefore(k, 3, 'euc-kr'), 2);
  assert.equal(charBoundaryBefore(k, 4, 'euc-kr'), 4);
  // trail byte 0x41 ('A'-like) must not be mistaken for ASCII when walking from 0
  const t = Buffer.from([0xb0, 0x41, 0xb0, 0x41]);
  assert.equal(charBoundaryBefore(t, 3, 'euc-kr'), 2);
  const u = Buffer.from('가나', 'utf8');
  assert.equal(charBoundaryBefore(u, 4, 'utf-8'), 3);
  const fd = openSync(spill('u.bin', u), 'r');
  assert.equal(alignedOffset(fd, 1, 'utf-8'), 3);
  assert.equal(alignedOffset(fd, 3, 'utf-8'), 3);
  closeSync(fd);
});

test('alignedOffset on a CP949 line longer than the sync window never returns a misaligned offset', () => {
  for (const prefix of ['', 'a']) {
    const hangul = Buffer.alloc(2 * 100_000);
    for (let i = 0; i < 100_000; i++) hangul.set([0xc6, 0xae], 2 * i); // 트 = no byte < 0x40
    const bytes = Buffer.concat([Buffer.from(prefix), hangul, Buffer.from('\n')]);
    const fd = openSync(spill('long.bin', bytes), 'r');
    try {
      for (const offset of [
        prefix.length + 70_001,
        prefix.length + 70_002,
        prefix.length + 150_001,
        prefix.length + 150_002,
      ]) {
        const expected = prefix.length + 2 * Math.ceil((offset - prefix.length) / 2);
        assert.equal(alignedOffset(fd, offset, 'euc-kr'), expected, `prefix "${prefix}" offset ${offset}`);
      }
      // short distance from a sync byte (space)
      const spaced = spill('sp.bin', Buffer.from([0x20, 0xc6, 0xae, 0xc6, 0xae]));
      const fd2 = openSync(spaced, 'r');
      assert.equal(alignedOffset(fd2, 2, 'euc-kr'), 3);
      assert.equal(alignedOffset(fd2, 3, 'euc-kr'), 3);
      closeSync(fd2);
    } finally {
      closeSync(fd);
    }
  }
});

test('FileEncodingSniffer: empty/ASCII stays undecided while growing, then follows the producer', () => {
  const path = spill('grow.bin', Buffer.alloc(0));
  const sniffer = new FileEncodingSniffer('euc-kr');
  const probe = (final = false) => {
    const fd = openSync(path, 'r');
    try {
      return sniffer.probe(fd, fstatSync(fd).size, final);
    } finally {
      closeSync(fd);
    }
  };
  assert.equal(probe(), null);
  appendFileSync(path, 'Ping 127.0.0.1\r\n');
  assert.equal(probe(), null);
  assert.equal(sniffer.safeEnd(statSync(path).size), statSync(path).size);
  appendFileSync(path, CP949.subarray(0, 2)); // C6 AE: valid UTF-8, < 16 non-ASCII bytes
  assert.equal(probe(), null);
  appendFileSync(path, CP949.subarray(2));
  appendFileSync(path, CP949);
  assert.equal(probe(), 'euc-kr');
  assert.equal(probe(), 'euc-kr'); // committed
});

test('FileEncodingSniffer: UTF-8 split at the read edge is not judged; ASCII-only finishes as UTF-8', () => {
  const utf8 = Buffer.from('한글 테스트 데이터 그리고 더', 'utf8');
  for (let cut = 1; cut < utf8.length; cut++) {
    const path = spill('edge.bin', utf8.subarray(0, cut));
    const sniffer = new FileEncodingSniffer('euc-kr');
    const fd = openSync(path, 'r');
    const label = sniffer.probe(fd, cut, false);
    closeSync(fd);
    assert.notEqual(label, 'euc-kr', `cut ${cut}`);
  }
  const path = spill('ascii.bin', Buffer.from('only ascii'));
  const fd = openSync(path, 'r');
  const sniffer = new FileEncodingSniffer('euc-kr');
  assert.equal(sniffer.probe(fd, 10, false), null);
  assert.equal(sniffer.probe(fd, 10, true), 'utf-8');
  closeSync(fd);
});

test('late OEM output after 270 KB of ASCII is detected (sniffer and head/tail reader)', async () => {
  const ascii = Buffer.from(`${'x'.repeat(99)}\n`.repeat(2700));
  const bytes = Buffer.concat([ascii, ...Array.from({ length: 40 }, () => Buffer.concat([CP949, Buffer.from('\n')]))]);
  const path = spill('late.bin', bytes);
  const fd = openSync(path, 'r');
  assert.equal(new FileEncodingSniffer('euc-kr').probe(fd, bytes.length, false), 'euc-kr');
  closeSync(fd);
  if (oemTextEncoding() !== 'euc-kr') return;
  const out = new TaskOutput('codepage-late');
  out.spilled = true;
  out.direct = true;
  out.stdoutPath = path;
  const text = await out.getStdout();
  assert.ok(!text.includes('\uFFFD'));
  assert.ok(text.trimEnd().endsWith(CP949_TEXT));
});

test('task reader: ASCII first, CP949 appended later, is decoded correctly', () => {
  if (oemTextEncoding() !== 'euc-kr') return;
  const path = spill('later.log', Buffer.alloc(0));
  const task = { status: 'running' };
  let text = readShellTaskOutput(task, { stdout_path: path });
  appendFileSync(path, 'start\n');
  text += readShellTaskOutput(task, { stdout_path: path });
  for (let i = 0; i < 3; i++) {
    appendFileSync(path, Buffer.concat([CP949, Buffer.from('\n')]));
    text += readShellTaskOutput(task, { stdout_path: path });
  }
  task.status = 'done';
  text += readShellTaskOutput(task, { stdout_path: path });
  assert.ok(!text.includes('\uFFFD'));
  assert.equal(text.split(CP949_TEXT).length - 1, 3);
});

test('large single-byte ä stream flows: 8 MiB after one early é is fast and not retained', () => {
  const d = new ShellStreamDecoder('euc-kr');
  const chunk = Buffer.from('x'.repeat(64 * 1024));
  const started = Date.now();
  let out = d.write(Buffer.from('é', 'utf8'));
  let length = out.length;
  let maxHeld = d.held.length;
  for (let i = 0; i < 128; i++) {
    out = d.write(chunk);
    length += out.length;
    maxHeld = Math.max(maxHeld, d.held.length);
  }
  length += d.end().length;
  assert.ok(Date.now() - started < 2000, 'finished quickly');
  assert.ok(maxHeld <= 4096, `held ${maxHeld}`);
  assert.equal(length, 1 + 128 * 64 * 1024);
});

test('truncated UTF-8 tail (ED 95) is undecided live and UTF-8 with U+FFFD when final', async () => {
  const bytes = Buffer.concat([Buffer.from('ok '), Buffer.from([0xed, 0x95])]);
  assert.equal(evaluateWindow(bytes, 'euc-kr', false).label, null);
  assert.equal(evaluateWindow(bytes, 'euc-kr', true).label, 'utf-8');
  const path = spill('trunc.bin', bytes);
  const out = new TaskOutput('codepage-trunc');
  out.spilled = true;
  out.direct = true;
  out.stdoutPath = path;
  out.stdoutFileSize = bytes.length;
  if (oemTextEncoding() !== 'euc-kr') return;
  assert.equal(out.getLiveTail(), 'ok ');
  assert.equal(await out.getStdout(), 'ok '); // mid-run snapshot (promotion): held back
  assert.equal(await out.getStdout(true), 'ok \uFFFD');
});

function directOutput(name, bytes) {
  const out = new TaskOutput(name);
  out.spilled = true;
  out.direct = true;
  out.stdoutPath = spill(`${name}.bin`, bytes);
  out.stdoutFileSize = bytes.length;
  return out;
}

test('promotion snapshot and live tail hold back an incomplete tail, before and after commitment', async () => {
  const committed = Buffer.from('한글 테스트 데이터 그리고 더 많은 글', 'utf8'); // > 16 non-ASCII bytes
  const text = committed.toString('utf8');
  for (const [label, bytes, expected] of [
    ['undecided', Buffer.concat([Buffer.from('ok '), Buffer.from([0xed, 0x95])]), 'ok '],
    ['committed', Buffer.concat([committed, Buffer.from([0xed, 0x95])]), text],
    ['committed-3of4', Buffer.concat([committed, Buffer.from([0xf0, 0x9f, 0x98])]), text],
  ]) {
    const out = directOutput(`codepage-hold-${label}`, bytes);
    assert.equal(await out.getStdout(), expected, `${label} snapshot`);
    assert.equal(out.getLiveTail(), expected, `${label} live tail`);
    assert.ok((await out.getStdout(true)).endsWith('\uFFFD'), `${label} final`);
  }
});

test('CP949 stream ending in a lone lead byte is held back until final', async () => {
  if (oemTextEncoding() !== 'euc-kr') return;
  const out = directOutput('codepage-lead', Buffer.concat([CP949, Buffer.from([0xc7])]));
  assert.equal(out.getLiveTail(), CP949_TEXT);
  assert.equal(await out.getStdout(), CP949_TEXT);
  assert.equal(await out.getStdout(true), `${CP949_TEXT}\uFFFD`);
  const done = Buffer.concat([CP949, Buffer.from([0xc7, 0xd1])]);
  assert.equal(directOutput('codepage-lead2', done).getLiveTail(), `${CP949_TEXT}한`);
});

test('promoted completion flushes the decoders', () => {
  const run = {
    child: { exitCode: 0 },
    taskOutput: new TaskOutput('codepage-promoted'),
    stdoutDecoder: new ShellTextDecoder('euc-kr'),
    stderrDecoder: new ShellTextDecoder('euc-kr'),
  };
  assert.equal(run.stdoutDecoder.write(Buffer.from('é done\n', 'utf8')), '');
  createPromotedCaptureRelease(run)();
  assert.equal(run.taskOutput.stdoutBuf, 'é done\n');
});

function spill(name, bytes) {
  const dir = mkdtempSync(join(fixtureRoot, 'cp-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

test('task reader: CP949 and UTF-8 files read across small page boundaries', async () => {
  const line = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from('\n')]);
  for (const [bytes, expected] of [
    [
      Buffer.concat([line('head'), ...Array.from({ length: 3000 }, () => Buffer.concat([CP949, Buffer.from('\n')]))]),
      CP949_TEXT,
    ],
    [Buffer.concat([line('head'), ...Array.from({ length: 3000 }, () => Buffer.from(`${UTF8_TEXT}\n`))]), UTF8_TEXT],
  ]) {
    if (expected === CP949_TEXT && oemTextEncoding() !== 'euc-kr') continue; // needs a CP949 OEM machine
    const path = spill('out.log', bytes);
    const task = { status: 'running' };
    let text = '';
    for (let i = 0; i < 40; i++) {
      text += readShellTaskOutput(task, { stdout_path: path });
    }
    task.status = 'done';
    text += readShellTaskOutput(task, { stdout_path: path });
    assert.ok(!text.includes('\uFFFD'), 'no replacement characters');
    assert.ok(text.includes(expected));
  }
});

test('head/tail spill read cuts on character boundaries for both encodings', async () => {
  for (const [unit, expected] of [
    [Buffer.concat([CP949, Buffer.from('\n')]), CP949_TEXT],
    [Buffer.from(`${UTF8_TEXT}\n`), UTF8_TEXT],
  ]) {
    if (expected === CP949_TEXT && oemTextEncoding() !== 'euc-kr') continue; // needs a CP949 OEM machine
    const out = new TaskOutput('codepage-headtail');
    const path = spill('ht.stdout', Buffer.concat(Array.from({ length: 20000 }, () => unit)));
    out.spilled = true;
    out.direct = true;
    out.stdoutPath = path;
    out.stdoutFileSize = 20000 * unit.length;
    const text = await out.getStdout();
    assert.ok(text.includes('bytes elided'));
    assert.ok(!text.includes('\uFFFD'));
    assert.ok(text.startsWith(expected));
    assert.ok(text.trimEnd().endsWith(expected));
  }
});
