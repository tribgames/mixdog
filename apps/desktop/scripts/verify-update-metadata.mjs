#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIELDS = Object.freeze({
  provider: 'github',
  owner: 'tribgames',
  repo: 'mixdog',
});

async function findMetadataFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMetadataFiles(path));
    } else if (entry.isFile() && entry.name === 'app-update.yml') {
      files.push(path);
    }
  }
  return files;
}

export async function verifyUpdateMetadata(distDirectory) {
  const dist = resolve(distDirectory);
  const files = await findMetadataFiles(dist);
  if (files.length === 0) {
    throw new Error(`Packaged updater metadata is missing under ${dist}`);
  }
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [field, value] of Object.entries(REQUIRED_FIELDS)) {
      const pattern = new RegExp(`^${field}:\\s*${value}\\s*$`, 'm');
      if (!pattern.test(source)) {
        throw new Error(`${file} does not declare ${field}: ${value}`);
      }
    }
  }
  return files;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const distArg = process.argv.find((value) => value.startsWith('--dist='));
  const dist = distArg ? distArg.slice('--dist='.length) : resolve('dist');
  const files = await verifyUpdateMetadata(dist);
  console.log(`Verified packaged updater metadata: ${files.length} file(s).`);
}
