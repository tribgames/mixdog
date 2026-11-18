// The marker of what a -LocalRelayBuild deploy put on the server (scripts/deploy-remote.ps1). It says "the installed relay
// was built from the sources with this fingerprint", so it holds only until another relay replaces it: a CI deploy that
// uploads a relay clears it, and a later local deploy of the older sources then rebuilds and ships again.
//
//   node local-relay-marker.mjs --action=current --marker=<file> --hash=<relay source fingerprint>   prints true|false
//   node local-relay-marker.mjs --action=record  --marker=<file> --hash=<fingerprint> [--binarySha256= --sourceCommit= --dirty=]
//   node local-relay-marker.mjs --action=clear   --marker=<file>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function localRelayCurrent(markerPath, hash) {
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return Boolean(hash) && marker.relayHash === hash;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function recordLocalRelay(markerPath, fields) {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({ ...fields, deployedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function clearLocalRelay(markerPath) {
  rmSync(markerPath, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((entry) => {
      const match = /^--([^=]+)=(.*)$/s.exec(entry);
      return match ? [match[1], match[2]] : ['', ''];
    })
  );
  const marker = resolve(args.marker);
  if (args.action === 'current') process.stdout.write(`${localRelayCurrent(marker, args.hash)}\n`);
  else if (args.action === 'record') {
    recordLocalRelay(marker, {
      relayHash: args.hash,
      binarySha256: args.binarySha256 ?? '',
      sourceCommit: args.sourceCommit ?? '',
      dirty: args.dirty === 'true',
    });
  } else if (args.action === 'clear') clearLocalRelay(marker);
  else {
    console.error('Usage: local-relay-marker.mjs --action=current|record|clear --marker=<file> [--hash=...]');
    process.exitCode = 1;
  }
}
