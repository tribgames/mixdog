import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every PNG inside `bytes` (a .png, or the .ico/.icns that concatenate them) as its header and inflated pixels. */
function pngPixels(bytes) {
  const images = [];
  for (let at = bytes.indexOf(SIGNATURE); at !== -1; at = bytes.indexOf(SIGNATURE, at + 1)) {
    let cursor = at + SIGNATURE.length;
    let header = null;
    const data = [];
    for (let type = ''; type !== 'IEND'; ) {
      const length = bytes.readUInt32BE(cursor);
      type = bytes.toString('ascii', cursor + 4, cursor + 8);
      const body = bytes.subarray(cursor + 8, cursor + 8 + length);
      if (type === 'IHDR') header = body.toString('hex');
      if (type === 'IDAT') data.push(body);
      cursor += 12 + length;
    }
    images.push(`${header}:${inflateSync(Buffer.concat(data)).toString('hex')}`);
  }
  return images;
}

// The Windows packager does not regenerate the icons (electron-builder takes the committed files), so a change to the
// drawing without the regenerated files must fail here. Pixels are compared, not bytes: the deflate output depends on the zlib of the Node that ran it.
test('the committed Windows and macOS icons are what the generator draws', () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-icons-'));
  const scripts = join(root, 'apps', 'desktop', 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'apps', 'desktop', 'src', 'renderer', 'public'), { recursive: true });
  copyFileSync(join(desktopDir, 'scripts', 'generate-brand-icons.mjs'), join(scripts, 'generate-brand-icons.mjs'));
  execFileSync(process.execPath, [join(scripts, 'generate-brand-icons.mjs')], { stdio: 'pipe' });
  for (const file of ['mixdog.ico', 'mixdog.png', 'icon.icns']) {
    const committed = pngPixels(readFileSync(join(desktopDir, 'build', file)));
    assert.ok(committed.length > 0, `${file} holds no image`);
    assert.deepEqual(committed, pngPixels(readFileSync(join(root, 'apps', 'desktop', 'build', file))), file);
  }
});
