import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { reviewRenderedOfficePages } from '../src/runtime/office/assurance.mjs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function pageFromPath(path, fallback) {
  const match = basename(path).match(/(?:page|slide)[-_ ]?(\d+)/i);
  return match ? Number(match[1]) : fallback;
}

export async function auditOfficeDesignImages(paths, {
  format = 'pptx',
} = {}) {
  const images = await Promise.all(paths.map(async (path, index) => {
    const absolute = resolve(path);
    const data = await readFile(absolute);
    return {
      page: pageFromPath(absolute, index + 1),
      path: absolute,
      mimeType: 'image/png',
      data: data.toString('base64'),
    };
  }));
  images.sort((left, right) => left.page - right.page);
  return reviewRenderedOfficePages(images, { format });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const format = argumentValue('--format') || 'pptx';
  const paths = process.argv.slice(2).filter((entry, index, values) => (
    entry !== '--format' && values[index - 1] !== '--format'
  ));
  if (!paths.length) throw new Error('Pass rendered page image paths to audit.');
  const report = await auditOfficeDesignImages(paths, { format });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
