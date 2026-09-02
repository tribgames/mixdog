import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { resetOfficeSessionsForTest } from './index.mjs';

// Shared fixtures for the Office test suites. Each suite decides its own
// environment (for example MIXDOG_OOXML_VALIDATOR_DISABLED); this module has no side effects.
export async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'mixdog-office-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(path, 'mixdog-data');
  t.after(async () => {
    resetOfficeSessionsForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

export function value(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

export async function writeZip(path, entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

export async function parts(path) {
  const zip = await JSZip.loadAsync(await readFile(path));
  return {
    has: (name) => Boolean(zip.file(name)),
    text: async (name) => {
      const file = zip.file(name);
      assert.ok(file, `package is missing ${name}`);
      return await file.async('string');
    },
  };
}

export async function unicodeFontPath() {
  const candidates = [
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'malgun.ttf') : '',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

export const PNG_PIXEL = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000100ffff03000006000557bfabd400000000'
  + '49454e44ae426082',
  'hex',
);
