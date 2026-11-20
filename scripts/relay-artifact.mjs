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

// A binary built on this PC by scripts/deploy-remote.ps1 -LocalRelayBuild: not a CI artifact. `sourceFingerprint` is the
// deploy plan's relay-source hash of the tree it was built from (the tree may be dirty, so the commit alone names nothing).
// `build: "local"` makes verifyRelayArtifact refuse it, so no CI-artifact check can take it for a CI build.
export function recordLocalRelayArtifact({ folder, target, sourceCommit, sourceFingerprint, dirty }) {
  if (!validCommit(sourceCommit)) throw new Error('A full checked-out Git commit is required.');
  if (!/^(x86_64|aarch64)-unknown-linux-gnu$/.test(target)) throw new Error('Unsupported relay target.');
  if (!/^[0-9a-f]{64}$/.test(sourceFingerprint)) throw new Error('A relay source fingerprint is required.');
  const info = {
    schema: 1,
    build: 'local',
    dirty: Boolean(dirty),
    sourceCommit,
    sourceFingerprint,
    target,
    binarySha256: digest(join(folder, 'mixdog-relay')),
  };
  writeFileSync(join(folder, RELAY_BUILD_INFO), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** The provenance of a local build whose binary and target match; its fingerprint names the sources it was built from. */
export function verifyLocalRelayArtifact({ folder, target }) {
  const info = JSON.parse(readFileSync(join(folder, RELAY_BUILD_INFO), 'utf8'));
  if (
    info.schema !== 1 ||
    info.build !== 'local' ||
    info.target !== target ||
    !validCommit(info.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(info.sourceFingerprint ?? '')
  )
    throw new Error('Not the provenance of a local relay build for the requested target.');
  if (typeof info.binarySha256 !== 'string' || info.binarySha256 !== digest(join(folder, 'mixdog-relay')))
    throw new Error('Relay binary differs from its build provenance.');
  return info;
}

export function verifyRelayArtifact({ folder, target }) {
  const info = JSON.parse(readFileSync(join(folder, RELAY_BUILD_INFO), 'utf8'));
  if (info.build === 'local') throw new Error('A local relay build is not a CI artifact.');
  if (info.schema !== 1 || !validCommit(info.sourceCommit) || info.target !== target)
    throw new Error('Relay build provenance does not identify the requested target and source.');
  if (
    typeof info.binarySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(info.binarySha256) ||
    info.binarySha256 !== digest(join(folder, 'mixdog-relay'))
  )
    throw new Error('Relay binary differs from its build provenance.');
  return info.sourceCommit;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, folder, target, sourceCommit, sourceFingerprint, dirty] = process.argv.slice(2);
  try {
    if (mode === 'record') recordRelayArtifact({ folder, target, sourceCommit });
    else if (mode === 'record-local') {
      recordLocalRelayArtifact({ folder, target, sourceCommit, sourceFingerprint, dirty: dirty === 'dirty' });
    } else if (mode === 'verify') process.stdout.write(`${verifyRelayArtifact({ folder, target })}\n`);
    else if (mode === 'verify-local')
      process.stdout.write(`${verifyLocalRelayArtifact({ folder, target }).sourceFingerprint}\n`);
    else {
      throw new Error(
        'Usage: relay-artifact.mjs record|verify <folder> <target> [checked-out commit] | ' +
          'record-local <folder> <target> <commit> <source fingerprint> clean|dirty | verify-local <folder> <target>'
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
