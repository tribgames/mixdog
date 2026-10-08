import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { makePdf, makeEncryptedPdf } from '../tools/builtin/pdf-test-fixtures.mjs';
import { capMcpResult, normalizeMcpToolResult } from './client.mjs';
import {
  normalizeContentForAnthropic,
  normalizeContentForOpenAIChat,
  sanitizeContentForStoredHistory,
} from '../providers/media-normalization.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const png = PNG.toString('base64');
const pdf = makePdf(1).toString('base64');
const xlsx = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)]).toString('base64');

test('MCP image content becomes a real image part', async () => {
  const out = await normalizeMcpToolResult({ content: [{ type: 'text', text: 'shot' }, { type: 'image', data: png, mimeType: 'image/png' }] });
  assert.deepEqual(out, {
    content: [
      { type: 'text', text: 'shot' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ],
  });
});

test('MCP blob resources become file parts named from the uri; text resources and audio become text', async () => {
  const out = await normalizeMcpToolResult({
    content: [
      { type: 'resource', resource: { uri: 'file:///tmp/My%20Doc.pdf', mimeType: 'application/pdf', blob: pdf } },
      { type: 'resource', resource: { uri: 'file:///tmp/book.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blob: xlsx } },
      { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
    ],
  });
  assert.deepEqual(out.content[0], { type: 'file', data: pdf, mimeType: 'application/pdf', filename: 'My Doc.pdf' });
  assert.equal(out.content[1].filename, 'book.xlsx');
  assert.equal(out.content[1].data, xlsx);
  assert.deepEqual(out.content[2], { type: 'text', text: 'hello' });
  assert.match(out.content[3].text, /^\[MCP audio content: audio\/wav \(3 bytes\) saved to .*mcp-[0-9a-f]{64}\.wav; open it from disk with read\.\]$/);
  assert.ok(!JSON.stringify(out.content.filter((p) => p.type === 'text')).includes('AAAA'));
});

test('MCP text-only and error results keep their string / Error: prefix behavior', async () => {
  assert.equal(await normalizeMcpToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(await normalizeMcpToolResult({ content: [{ type: 'text', text: 'bad' }], isError: true }), 'Error: bad');
  const media = await normalizeMcpToolResult({ content: [{ type: 'image', data: png, mimeType: 'image/png' }], isError: true });
  assert.deepEqual(media.content[0], { type: 'text', text: 'Error:' });
  assert.equal(media.content[1].type, 'image');
});

test('same MCP result normalizes identically twice and lowers byte-identically after session save/reload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-mcp-cache-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = () => ({
    content: [
      { type: 'text', text: 'result' },
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x/report.pdf', mimeType: 'application/pdf', blob: pdf } },
      { type: 'resource', resource: { uri: 'file:///x/book.xlsx', mimeType: 'application/octet-stream', blob: xlsx } },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
    ],
  });
  const first = await normalizeMcpToolResult(raw());
  const second = await normalizeMcpToolResult(raw());
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const lower = (content) => ({
    anthropic: JSON.stringify(normalizeContentForAnthropic(content)),
    chat: JSON.stringify(normalizeContentForOpenAIChat(content)),
  });
  const live = lower(first.content);
  const stored = sanitizeContentForStoredHistory(first.content);
  const reloaded = JSON.parse(JSON.stringify(stored));
  assert.deepEqual(lower(reloaded), live);
  // lowering the same stored history repeatedly is stable too
  assert.deepEqual(lower(reloaded), lower(JSON.parse(JSON.stringify(stored))));
});

test('only png/jpeg/gif/webp become image parts; other image types become fixed text', async () => {
  const out = await normalizeMcpToolResult({
    content: [
      { type: 'image', data: png, mimeType: 'image/svg+xml' },
      { type: 'image', data: png, mimeType: 'image/bmp' },
      { type: 'image', data: png, mimeType: 'IMAGE/WEBP' },
      { type: 'resource', resource: { uri: 'file:///a.gif', mimeType: 'image/gif', blob: png } },
      { type: 'resource', resource: { uri: 'file:///a.tiff', mimeType: 'image/tiff', blob: png } },
    ],
  });
  assert.deepEqual(out.content[0], { type: 'text', text: '[MCP image omitted: image/svg+xml is not a supported image type]' });
  assert.deepEqual(out.content[1], { type: 'text', text: '[MCP image omitted: image/bmp is not a supported image type]' });
  assert.deepEqual(out.content[2], { type: 'image', data: png, mimeType: 'image/webp' });
  assert.deepEqual(out.content[3], { type: 'image', data: png, mimeType: 'image/gif' });
  assert.equal(out.content[4].text, '[MCP image omitted: image/tiff is not a supported image type]');
});

test('line-wrapped base64 is canonicalized so live and stored forms lower identically', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-mcp-b64-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const wrap = (s) => s.match(/.{1,16}/g).join('\r\n');
  const out = await normalizeMcpToolResult({
    content: [
      { type: 'image', data: wrap(png), mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///r.pdf', mimeType: 'application/pdf', blob: wrap(pdf) } },
    ],
  });
  assert.equal(out.content[0].data, png);
  assert.equal(out.content[1].data, pdf);
  const stored = sanitizeContentForStoredHistory(out.content);
  assert.ok(stored.every((p) => p.attachmentRef || p.ref || p.type === 'file' || p.type === 'image'));
  assert.ok(!JSON.stringify(stored).includes(png));
  assert.equal(
    JSON.stringify(normalizeContentForAnthropic(JSON.parse(JSON.stringify(stored)))),
    JSON.stringify(normalizeContentForAnthropic(out.content)),
  );
});

test('oversized MCP media is replaced by fixed text with no payload', async () => {
  const big = (mib) => Buffer.alloc(mib * 1024 * 1024 + 3, 1).toString('base64');
  const img = big(48);
  const blob = big(64);
  const bigPdf = big(20);
  const out = await normalizeMcpToolResult({
    content: [
      { type: 'image', data: img, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///huge.bin', mimeType: 'application/octet-stream', blob } },
      { type: 'resource', resource: { uri: 'file:///big.pdf', mimeType: 'application/pdf', blob: bigPdf } },
      { type: 'resource', resource: { uri: 'file:///ok.bin', mimeType: 'application/octet-stream', blob: big(21) } },
      { type: 'image', data: png, mimeType: 'image/png' },
    ],
  });
  assert.equal(out.content[0].text, '[MCP image omitted: image/png image exceeds the 48 MiB limit]');
  assert.equal(out.content[1].text, '[MCP resource omitted: huge.bin (application/octet-stream) exceeds the 64 MiB limit]');
  assert.equal(out.content[2].text, '[MCP resource omitted: big.pdf (application/pdf) exceeds the 20 MiB PDF limit]');
  assert.match(out.content[3].text, /saved to .*mcp-[0-9a-f]{64}\.bin; open it from disk with read\./);
  assert.equal(
    await normalizeMcpToolResult({ content: [{ type: 'image', data: img, mimeType: 'image/png' }] }),
    '[MCP image omitted: image/png image exceeds the 48 MiB limit]'
  );
});

test('the bytes, not the declared MIME type, decide the PDF limits', async () => {
  const pdf101 = makePdf(101).toString('base64');
  const pdf3 = makePdf(3).toString('base64');
  const out = await normalizeMcpToolResult({
    content: [
      { type: 'resource', resource: { uri: 'file:///long.pdf', mimeType: 'application/octet-stream', blob: pdf101 } },
      { type: 'resource', resource: { uri: 'file:///short.bin', mimeType: 'application/octet-stream', blob: pdf3 } },
      { type: 'resource', resource: { uri: 'file:///locked.pdf', mimeType: 'application/pdf', blob: makeEncryptedPdf().toString('base64') } },
      { type: 'resource', resource: { uri: 'file:///book.xlsx', mimeType: 'application/pdf', blob: xlsx } },
    ],
  });
  assert.equal(out.content[0].text, '[MCP resource omitted: long.pdf has 101 pages, too many to attach (max 100)]');
  assert.deepEqual(out.content[1], { type: 'file', data: pdf3, mimeType: 'application/octet-stream', filename: 'short.bin' });
  assert.equal(out.content[2].text, '[MCP resource omitted: locked.pdf is password-protected or not a valid PDF]');
  // Declared as a PDF but the bytes are a zip: no valid PDF, so it is not attached.
  assert.equal(out.content[3].text, '[MCP resource omitted: book.xlsx is password-protected or not a valid PDF]');
});

test('blobs with no inline form and audio are saved to a content-hash path; the same bytes give the same path', async () => {
  const bytes = Buffer.from('arbitrary binary payload \u0000\u0001\u0002');
  const raw = () => ({
    content: [
      { type: 'resource', resource: { uri: 'file:///x/data.dat', mimeType: 'application/x-custom', blob: bytes.toString('base64') } },
      { type: 'audio', data: bytes.toString('base64'), mimeType: 'audio/mpeg' },
    ],
  });
  const first = await normalizeMcpToolResult(raw());
  const second = await normalizeMcpToolResult(raw());
  assert.deepEqual(first, second);
  assert.equal(typeof first, 'string');
  const [, resourcePath] = /saved to (.+?\.dat);/.exec(first) || [];
  const [, audioPath] = /saved to (.+?\.mpeg);/.exec(first) || [];
  assert.ok(resourcePath && audioPath);
  assert.equal(resourcePath.replace(/\.dat$/, ''), audioPath.replace(/\.mpeg$/, ''));
  assert.ok(existsSync(resourcePath));
  assert.deepEqual(readFileSync(resourcePath), bytes);
  assert.ok(!first.includes(bytes.toString('base64')));
});

test('text is computed once and capped as one budget across parts', async () => {
  const line = 'x'.repeat(100);
  const body = Array.from({ length: 1500 }, () => line).join('\n');
  const result = await normalizeMcpToolResult({
    content: [
      { type: 'text', text: body },
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'text', text: body },
    ],
  });
  const capped = capMcpResult(result);
  // Original order is kept: text, image, text.
  assert.deepEqual(capped.content.map((p) => p.type), ['text', 'image', 'text']);
  assert.match(capped.content[0].text, /full output spilled to/);
  assert.doesNotMatch(capped.content[2].text, /full output spilled to/);
  assert.ok(capped.content[0].text.length + capped.content[2].text.length < body.length * 2);
  const strip = (r) => r.content.map((p) => (p.text ?? p.data).replace(/\[full output spilled to [^\]]*\]/, ''));
  assert.deepEqual(strip(capMcpResult(result)), strip(capped));
  const small = { content: [{ type: 'text', text: 'a' }, { type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: 'b' }] };
  assert.equal(capMcpResult(small), small);
});

test('400 short text runs interleaved with images stay within the total cap, in order', () => {
  const content = [];
  for (let i = 0; i < 400; i += 1) {
    content.push({ type: 'text', text: `run-${i}\n${Array.from({ length: 9 }, () => 'é😀'.repeat(6)).join('\n')}` });
    content.push({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  }
  const original = { content };
  const joinedLength = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n').length;
  const capped = capMcpResult(original);
  const again = capMcpResult(original);
  const textOf = (r) => r.content.filter((p) => p.type === 'text').map((p) => p.text);
  const total = textOf(capped).join('\n');
  // Same cap as the single-string path: bounded far below the input and marked.
  assert.ok(total.length < joinedLength / 2);
  assert.match(total, /TRUNCATED/);
  assert.equal(textOf(capped).filter((t) => /TRUNCATED/.test(t)).length, 1);
  assert.doesNotMatch(total, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  // Media is untouched and run order (by index) is preserved.
  assert.equal(capped.content.filter((p) => p.type === 'image').length, 400);
  const indexes = textOf(capped).flatMap((t) => [...t.matchAll(/run-(\d+)/g)].map((m) => Number(m[1])));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  const strip = (r) => JSON.stringify(r).replace(/\[full output spilled to [^\]]*\]/, '');
  assert.equal(strip(capped), strip(again));
});
