// What the live and refusals recorders share: the provenance of a capture (the core binary and the sources cargo built it from, the recorder
// files, the public harness files), one unique owned storage folder per run, and one teardown that covers every stage a run can fail at,
// including the ones before the core serves. Nothing here touches a reply the core sent.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtFrom } from './remote-protocol-chat-abort-live.mjs';
import { endLeftovers } from './remote-protocol-chat-abort-procs.mjs';
import { NEUTRAL_ROOT, harnessHashes, privatePathIn, recorderHashes, sha256 } from './remote-protocol-chat-fixtures.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const HARNESS = fileURLToPath(new URL('./remote-protocol-chat-harness/', import.meta.url));
export const CLIENT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const CONFIG = (baseURL) => JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } });

/**
 * The identities a capture is bound to, none of them a path: the core binary by file name and sha256, with cargo's own record of the
 * sources it was built from (its dep-info, which must be of THIS checkout and not older than any source: `builtFrom`) folded into one digest,
 * so a dev build kept anywhere on the machine qualifies by what it was built from. And the recorder files and the public harness files.
 */
export function captureIdentity(name, bin) {
  const built = builtFrom(bin);
  return {
    binary: basename(bin),
    binarySha256: sha256(readFileSync(bin)),
    binaryBuilt: statSync(bin).mtime.toISOString(),
    builtFrom: built,
    recorder: recorderHashes(name),
    harness: harnessHashes(),
    clientVersion: CLIENT_VERSION,
  };
}

/**
 * Opens one recording run: unique storage, the harness, the PostgreSQL seed, the model endpoint, the core, and the app-server socket.
 * Returns what the recorder drives plus `finish(manifestExtra)` (the capture's manifest, refused if its identities moved during the run) and
 * `cleanup()` (every stage that was reached, undone in reverse; safe after any failure). A failure while opening cleans up before it throws.
 */
export async function openRecording(name, bin) {
  const identity = captureIdentity(name, bin);
  const undo = [];
  const cleanup = async () => {
    const errors = [];
    for (const step of undo.splice(0).reverse()) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `teardown of the ${name} recording failed: ${errors.map((e) => e.message).join('; ')}`);
  };
  let core;
  try {
    // A folder of this run's own: no run ever clears, reuses or shares another's.
    // It sits at the drive's root under a neutral name, so the paths the core sees (workspace, task workspace, data) name no user or checkout.
    const neutral = join(parse(tmpdir()).root, NEUTRAL_ROOT);
    mkdirSync(neutral, { recursive: true });
    const root = mkdtempSync(join(neutral, `${name}-`));
    undo.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const load = (file) => import(pathToFileURL(join(HARNESS, 'lib', file)).href);
    const { daemonEnv, isolatedPaths } = await load('env.mjs');
    const { seedPgRuntime } = await load('stage.mjs');
    const { startFakeProvider } = await load('fake-provider.mjs');
    const { launch } = await load('proc.mjs');
    const { createDeadline, latch } = await load('deadline.mjs');
    const paths = isolatedPaths(root);
    for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
    const deadline = createDeadline(240_000, () => core?.tail() ?? '(the core was not started)');
    undo.push(() => deadline.clear());
    seedPgRuntime(paths);
    const provider = await startFakeProvider({ workspace: paths.workspace });
    undo.push(() => provider.close());
    writeFileSync(join(paths.dataDir, 'mixdog-config.json'), CONFIG(provider.baseURL));

    core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
    undo.push(async () => {
      core.kill();
      // The exit is waited for under a deadline of its own; a core that does not end is reported with its pid.
      const ended = createDeadline(60_000, () => `the core (pid ${core.pid}) did not exit after its kill: ${core.tail()}`);
      try {
        await ended.race(core.exited.catch(() => {}), `the core (pid ${core.pid}) to exit`);
      } finally {
        ended.clear();
        // The core's tree and anything naming its folder (its postgres, whose command line writes the folder with `/`), ended with proof.
        if (core.pid) endLeftovers(core.pid, paths.envRoot);
      }
    });

    // The core publishes daemon.json when it serves: a directory watch is the readiness event.
    const daemonDoc = () => {
      const file = join(paths.runtimeRoot, 'daemon.json');
      if (!existsSync(file)) return null;
      let d;
      try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
      if (d?.core?.state === 'blocked') throw new Error(`blocked ${JSON.stringify(d.core.blocked)}`);
      return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
    };
    const served = latch();
    const watcher = watch(paths.runtimeRoot, () => {
      try { const d = daemonDoc(); if (d) served.resolve(d); } catch (e) { served.reject(e); }
    });
    undo.push(() => watcher.close());
    const early = daemonDoc();
    if (early) served.resolve(early);
    const doc = await deadline.race(Promise.race([served.promise, core.exited.then(({ code }) => { throw new Error(`the core exited (${code}) before it served: ${core.tail()}`); })]), 'the core to serve');

    const { default: WebSocket } = await import('ws');
    const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
    undo.push(() => socket.close());
    await deadline.race(new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), 'the app-server socket to open');

    return {
      paths, deadline, latch, socket, core,
      route: { provider: 'custom-harness', model: 'harness-model' },
      /** The capture's manifest: the identities taken before the run, refused if any moved while it ran. */
      finish(extra) {
        const now = captureIdentity(name, bin);
        if (JSON.stringify(now) !== JSON.stringify(identity)) throw new Error(`the binary, its sources, the recorder or the harness changed during the ${name} recording: the capture is not of one identity`);
        return { ...identity, ...extra };
      },
      /** Writes the capture, whole as captured: refused, nothing written, if any string in it names a private path. */
      write(file, out) {
        const leaked = privatePathIn(out);
        if (leaked) throw new Error(`the ${name} capture names a private path (${leaked}): not written`);
        writeFileSync(file, JSON.stringify(out, null, 2));
      },
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
