// Provenance of the exact relay binary uploaded by a reusable build workflow.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELAY_BUILD_INFO = 'relay-build.json';
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const validCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export function recordRelayArtifact({ folder, target, sourceCommit }) {
  if (!validCommit(sourceCommit)) throw new Error('A full checked-out Git commit is required.');
  if (!/^(x86_64|aarch64)-unknown-linux-gnu$/.test(target)) throw new Error('Unsupported relay target.');
  const info = { schema: 1, sourceCommit, target, binarySha256: digest(join(folder, 'mixdog-relay')) };
  writeFileSync(join(folder, RELAY_BUILD_INFO), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export function verifyRelayArtifact({ folder, target }) {
  const info = JSON.parse(readFileSync(join(folder, RELAY_BUILD_INFO), 'utf8'));
  if (info.schema !== 1 || !validCommit(info.sourceCommit) || info.target !== target)
    throw new Error('Relay build provenance does not identify the requested target and source.');
  if (typeof info.binarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.binarySha256)
      || info.binarySha256 !== digest(join(folder, 'mixdog-relay')))
    throw new Error('Relay binary differs from its build provenance.');
  return info.sourceCommit;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, folder, target, sourceCommit] = process.argv.slice(2);
  try {
    if (mode === 'record') recordRelayArtifact({ folder, target, sourceCommit });
    else if (mode === 'verify') process.stdout.write(`${verifyRelayArtifact({ folder, target })}\n`);
    else throw new Error('Usage: relay-artifact.mjs record|verify <folder> <target> [checked-out commit]');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
