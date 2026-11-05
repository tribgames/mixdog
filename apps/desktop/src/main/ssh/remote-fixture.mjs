// Shared fixtures of the ssh install tests: a staged release of fake `mixdogd`
// binaries (the real loader reads them) and a scripted ssh.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import { loadServerPayloads, manifestBuild } from './remote-install-payload.ts';

export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

/** True where the test shell is Git for Windows' sh: its filesystem cannot set POSIX modes. */
export const isGitSh = (sh) => sh.includes('\\');

/**
 * PATH for a test run of the generated script. Git for Windows keeps the coreutils next to its sh, but
 * its mkdir cannot apply `-m 700` on a Windows drive, so there (and only there) a `mkdir` that ignores
 * `-m` goes first. The product script is unchanged; the 0700 assertions run where modes exist.
 */
export function shellPath(sh) {
  if (!isGitSh(sh)) return process.env.PATH;
  const shim = makeTempDirSync('ssh-sh-shim');
  writeFileSync(
    join(shim, 'mkdir'),
    '#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -m) shift 2 ;;\n    *) args="$args \\"$1\\""; shift ;;\n  esac\ndone\neval exec /usr/bin/mkdir $args\n'
  );
  return `${shim};${sh.slice(0, sh.lastIndexOf('\\'))};${process.env.PATH}`;
}

/** Stage a release of `version` with one fake binary per platform. */
export async function stagedPayloads(version = '1.4.6') {
  const dir = makeTempDirSync('ssh-release');
  const binaries = {};
  for (const key of PLATFORMS) {
    const bytes = Buffer.from(`#!/bin/sh\n# fake mixdogd ${version} ${key}\n`);
    mkdirSync(join(dir, key));
    // The wire form is opaque to the loader (the server unpacks it): any bytes stand in for the tar.
    const bundle = gzipSync(Buffer.concat([Buffer.from(`bundle ${key}\n`), bytes]));
    writeFileSync(join(dir, key, 'bundle.tgz'), bundle);
    binaries[key] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      bundle: {
        file: 'bundle.tgz',
        sha256: createHash('sha256').update(bundle).digest('hex'),
        size: bundle.length,
        content: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  }
  const build = manifestBuild(binaries);
  writeFileSync(join(dir, 'servers.json'), JSON.stringify({ version, build, binaries }));
  return { dir, payloads: await loadServerPayloads(dir) };
}

/** ssh stand-in: each exec prints the next scripted stdout and exits. */
export function scriptedSsh(replies) {
  const calls = [];
  const inputs = [];
  const spawnImpl = (_command, args) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(args);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('end', () => inputs.push(Buffer.concat(chunks)));
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end(reply.stderr ?? '');
      setTimeout(() => {
        child.exitCode = reply.code ?? 0;
        child.emit('close', child.exitCode, null);
      }, 5);
    });
    return child;
  };
  return { calls, inputs, spawnImpl };
}

/** The script a recorded ssh call ran on the server. */
export function scriptOf(sshArgs) {
  const command = sshArgs[sshArgs.length - 1];
  return Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(command)[1], 'base64').toString('utf8');
}

/** The `server-ensure` arguments of one recorded ssh call. */
export function programArgs(sshArgs) {
  const encoded = /ARGS='([A-Za-z0-9+/=]+)'/.exec(scriptOf(sshArgs))[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

export const discoveryJson = (overrides = {}) =>
  JSON.stringify({
    pid: 4242,
    endpoints: { session: { port: 41002, token: 'session-secret-1' } },
    core: {
      version: '1.4.6',
      build: 'b',
      instanceId: 'i-1',
      processStartTime: 't',
      state: 'serving',
      rpc: { port: 41001 },
      control: { port: 41002 },
      ...overrides,
    },
  });

/** A MIXDOG_RESULT reply for a Linux x64 glibc server. */
export const reply = (value) => ({
  stdout: `MIXDOG_PLATFORM Linux x86_64|glibc\nMIXDOG_RESULT ${JSON.stringify(value)}\n`,
});

export const errorReply = (code, message, drain) => ({
  stdout: `MIXDOG_PLATFORM Linux x86_64|glibc\n${drain ? `MIXDOG_DRAIN ${JSON.stringify(drain)}\n` : ''}MIXDOG_ERROR ${code} ${message}\n`,
  code: 3,
});
