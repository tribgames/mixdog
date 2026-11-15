#!/usr/bin/env node
// Node half of every relay twin comparison: runs the tree's own relay
// (apps/relay/server.mjs + lib) with the scenario's knobs and recording fakes.
// The Rust twin host (nr-relay-server) must accept this contract unchanged.
//
// Invocation:  node relay-host.mjs '<json>'
//
// <json> is ONE object. Keys that are startRelay options of server.mjs are
// passed through with the same names and units (port 0 and a missing
// rendererDir/tls* mean what they mean there):
//   port, dataDir (required), rendererDir, rendererReleasesDir, tlsCert, tlsKey
//     (file paths), maxFrameBytes, maxHookPending, maxInflightBytes,
//     maxIngressBytes, ingressReservationBytes, ingressWindowBytes,
//     maxPayloadBytes, uplinkCapacityBytes  (bytes, or a count for
//     maxHookPending), handshakeStallMs, livenessProbeMs  (milliseconds),
//   feedbackEnv, nativePushEnv, turnEnv  (objects of environment strings: the
//     host never reads process.env for them),
//   feedbackOptions  (the numeric limits of createFeedbackService: maxPending,
//     maxRecords, baseDelayMs, maxDelayMs, ipLimit, ipWindowMs, globalLimit,
//     globalWindowMs, smtpTimeoutMs, maxPendingAttachmentBytes; function
//     options such as now/setTimer cannot be written in JSON and are absent).
// Host keys that are not startRelay options:
//   fakes             { feedbackSender?, nativePush?, webPushFetch? }, each
//                     { answers: [...] } as described in fakes.mjs, plus
//                     nativePush.platforms: ["apns"|"fcm", ...]. A fake that is
//                     absent leaves the relay's own service in place.
//   mobileRelease     object (written as JSON) or string (written verbatim) to
//                     mobile-release.json beside the copy of server.mjs.
//   treeRoot          tree to copy the relay from (default: the tree this file
//                     is in).
//   installBase       directory to make the temporary install under (default
//                     the OS temp directory).
// An unknown key is an error (a misspelt knob must not silently run defaults).
//
// Package resolution: the copy gets a node_modules link to apps/relay/node_modules
// of the tree when it holds ws and nodemailer, otherwise to the tree's root
// node_modules. When neither does, the host exits 1 telling to run
// `npm ci --prefix apps/relay`.
//
// stdout, one line each, in this order:
//   [twin] {"versions":{"ws":"8.21.3","nodemailer":"10.0.16","source":"<dir>"}}
//   [relay] <http|https> listening on :<port> (renderer: <dir>|none)   (exactly the CLI line of server.mjs)
// and then, as the scenario drives the relay, one line per fake call:
//   [twin] {"fake":"feedbackSender","call":"send","mail":{from,to,replyTo?,subject,text,messageId,
//           attachments?:[{filename,contentType,contentDisposition,bytes,sha256}]}}
//   [twin] {"fake":"feedbackSender","call":"close"}
//   [twin] {"fake":"nativePush","call":"send","message":{platform,token,mx,reason,collapseKey,...}}
//   [twin] {"fake":"nativePush","call":"close"}
//   [twin] {"fake":"webPushFetch","call":"fetch","url","method","headers","redirect","bodyBytes","bodyBase64"}
// The relay's own console output also reaches stdout/stderr unchanged.
// The host closes the relay (relay.close()) when stdin ends and exits 0; a
// start failure prints '[relay] failed to start: <message>' to stderr and exits 1.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFeedbackSender, createNativePushFake, createWebPushFetch, recordTwin } from './fakes.mjs';

const RELAY_OPTIONS = new Set([
  'port',
  'dataDir',
  'rendererDir',
  'rendererReleasesDir',
  'tlsCert',
  'tlsKey',
  'maxFrameBytes',
  'maxHookPending',
  'maxInflightBytes',
  'maxIngressBytes',
  'ingressReservationBytes',
  'ingressWindowBytes',
  'maxPayloadBytes',
  'uplinkCapacityBytes',
  'handshakeStallMs',
  'livenessProbeMs',
  'feedbackEnv',
  'feedbackOptions',
  'nativePushEnv',
  'turnEnv',
]);
const HOST_OPTIONS = new Set(['fakes', 'mobileRelease', 'treeRoot', 'installBase']);
const PACKAGES = ['ws', 'nodemailer'];
const MISSING_PACKAGES =
  'ws and nodemailer do not resolve: run `npm ci --prefix apps/relay` (or install the root dependencies) in the tree';

/** The tree holding apps/relay/server.mjs, found upward from this file. */
export function findTreeRoot(start = dirname(fileURLToPath(import.meta.url))) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'apps', 'relay', 'server.mjs'))) return dir;
    if (dirname(dir) === dir) throw new Error(`no apps/relay/server.mjs above ${start}`);
  }
}

const packageVersion = (modulesDir, name) =>
  JSON.parse(readFileSync(join(modulesDir, name, 'package.json'), 'utf8')).version;

/** The node_modules directory holding ws and nodemailer: apps/relay's own
 *  first, the tree root's otherwise. */
export function resolvePackages(treeRoot = findTreeRoot()) {
  for (const modulesDir of [join(treeRoot, 'apps', 'relay', 'node_modules'), join(treeRoot, 'node_modules')]) {
    if (PACKAGES.every((name) => existsSync(join(modulesDir, name, 'package.json')))) {
      const versions = Object.fromEntries(PACKAGES.map((name) => [name, packageVersion(modulesDir, name)]));
      return { modulesDir, versions: { ...versions, source: modulesDir } };
    }
  }
  throw new Error(MISSING_PACKAGES);
}

/** Copies server.mjs and lib (without tests) into a fresh install directory
 *  with its node_modules link and mobile-release.json. */
export function installRelay({ treeRoot, installBase, mobileRelease }) {
  const { modulesDir, versions } = resolvePackages(treeRoot);
  const root = mkdtempSync(join(installBase || tmpdir(), 'relay-twin-'));
  const source = join(treeRoot, 'apps', 'relay');
  cpSync(join(source, 'server.mjs'), join(root, 'server.mjs'));
  cpSync(join(source, 'lib'), join(root, 'lib'), {
    recursive: true,
    filter: (file) => !/\.test\.mjs$/u.test(file),
  });
  symlinkSync(modulesDir, join(root, 'node_modules'), 'junction');
  if (mobileRelease !== undefined) {
    writeFileSync(
      join(root, 'mobile-release.json'),
      typeof mobileRelease === 'string' ? mobileRelease : JSON.stringify(mobileRelease),
    );
  }
  return { root, versions };
}

/** Deletes an install made by installRelay. The node_modules link is unlinked
 *  first: a recursive delete that entered the junction (Node 24's rmSync does)
 *  would delete the tree's packages it points at. When the link cannot be
 *  unlinked nothing is deleted. */
export function removeInstall(root) {
  const link = join(root, 'node_modules');
  let linked = false;
  try {
    linked = Boolean(lstatSync(link));
  } catch {
    /* no link */
  }
  if (linked) unlinkSync(link);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

function splitConfig(config) {
  const options = {};
  const host = {};
  for (const [key, value] of Object.entries(config)) {
    if (RELAY_OPTIONS.has(key)) options[key] = value;
    else if (HOST_OPTIONS.has(key)) host[key] = value;
    else throw new Error(`unknown knob: ${key}`);
  }
  if (typeof options.dataDir !== 'string' || !options.dataDir) throw new Error('knob dataDir is required');
  return { options, host };
}

function relayFakes(fakes = {}) {
  return {
    ...(fakes.feedbackSender ? { feedbackSender: createFeedbackSender(fakes.feedbackSender) } : {}),
    ...(fakes.nativePush ? { nativePush: createNativePushFake(fakes.nativePush) } : {}),
    ...(fakes.webPushFetch ? { webPushFetch: createWebPushFetch(fakes.webPushFetch) } : {}),
  };
}

async function main(argv) {
  const { options, host } = splitConfig(JSON.parse(argv[2] ?? '{}'));
  const treeRoot = host.treeRoot ? resolve(host.treeRoot) : findTreeRoot();
  let install;
  try {
    install = installRelay({ treeRoot, installBase: host.installBase, mobileRelease: host.mobileRelease });
  } catch (error) {
    process.stderr.write(`[relay-host] ${error.message}\n`);
    process.exit(1);
  }
  recordTwin({ versions: install.versions });
  const cleanUp = () => removeInstall(install.root);
  let relay;
  try {
    const { startRelay } = await import(pathToFileURL(join(install.root, 'server.mjs')).href);
    mkdirSync(options.dataDir, { recursive: true });
    relay = await startRelay({ port: 0, ...options, ...relayFakes(host.fakes) });
  } catch (error) {
    process.stderr.write(`[relay] failed to start: ${error?.message || error}\n`);
    cleanUp();
    process.exit(1);
  }
  const scheme = options.tlsCert && options.tlsKey ? 'https' : 'http';
  process.stdout.write(`[relay] ${scheme} listening on :${relay.port} (renderer: ${options.rendererDir || 'none'})\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => {
    try {
      await relay.close();
    } finally {
      cleanUp();
      process.exit(0);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => {
    process.stderr.write(`[relay-host] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
