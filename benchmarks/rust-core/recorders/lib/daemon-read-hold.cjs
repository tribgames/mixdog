'use strict';
// Loaded into a recorder's Node daemon with `--require` (the daemon's fork takes the recorder's `process.execArgv`): one awaited
// file operation the recorder names is held until the recorder releases it, and the appends to a file the recorder names are
// reported. The channel is a TCP connection to the recorder at 127.0.0.1:$MIXDOG_RECORDER_READ_HOLD_PORT, one JSON object per line:
//   recorder → daemon  {"op":"arm","call":"stat"|"readFile","file":<basename>,"marker":<stack text>}
//                                                                             the next `fs/promises.<call>` of a file with that
//                                                                             basename whose stack names `marker` is held
//                      {"op":"release"}                                       the held read goes on
//                      {"op":"watch","file":<basename>}                       each `fs/promises.appendFile` to that basename that
//                                                                             has landed is reported, with its text
//                      {"op":"arm-rebuild"}                                   the next summary index rebuild worker is held
//                      {"op":"release-rebuild"}                               the held rebuild runs
//                      {"op":"settle"}                                        reported once every summary index op queued so
//                                                                             far has landed (the daemon's own
//                                                                             `settleSummaryIndexWrites`, store-summary-index.mjs:495)
//                      {"op":"watch-live","id":<session id>}                 the next live-session publication of that session
//                                                                             (`_publishLiveSession`, store.mjs `_admit`: a save's
//                                                                             admission, synchronous, before any write) is reported
//   daemon → recorder  {"ev":"hello","pid":…}  {"ev":"live-watching","error"?:…}  {"ev":"live","id":…}  {"ev":"armed"}  {"ev":"reached","file":…}  {"ev":"ended","file":…}
//                      {"ev":"watching"}  {"ev":"appended","file":…,"text":…}
//                      {"ev":"rebuild-armed"}  {"ev":"rebuild-reached"}  {"ev":"rebuild-landed","ok":…} (every rebuild)
//                      {"ev":"settled","ok":…,"error"?:…}
// Nothing else the daemon does is changed; with no read armed every read passes through. Worker threads are not touched.
const { isMainThread } = require('node:worker_threads');

const port = Number(process.env.MIXDOG_RECORDER_READ_HOLD_PORT);
if (isMainThread && port > 0) {
  const net = require('node:net');
  const fsp = require('node:fs/promises');
  const { basename } = require('node:path');
  const socket = net.connect({ host: '127.0.0.1', port });
  // The daemon's own lifetime decides when it exits, never this connection.
  socket.unref();
  socket.setEncoding('utf8');
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  socket.on('connect', () => send({ ev: 'hello', pid: process.pid }));
  socket.on('error', (error) => process.stderr.write(`[daemon-read-hold] connection to the recorder failed: ${error.message}\n`));
  let armed = null;
  let release = null;
  let watched = null;
  let rebuildArmed = false;
  let rebuildRelease = null;
  // The URL the daemon loads its summary index module under (its own instance, whose queue `settle` asks about), as resolved.
  let summaryIndexUrl = null;
  let observersUrl = null;
  require('node:module').registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (!summaryIndexUrl && resolved.url.endsWith('/orchestrator/session/store-summary-index.mjs')) summaryIndexUrl = resolved.url;
      if (!observersUrl && resolved.url.endsWith('/orchestrator/session/store/session-observers.mjs')) observersUrl = resolved.url;
      return resolved;
    },
  });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.op === 'arm') {
        armed = { call: message.call, file: message.file, marker: message.marker };
        send({ ev: 'armed' });
      } else if (message.op === 'release') {
        const resume = release;
        release = null;
        resume();
      } else if (message.op === 'arm-rebuild') {
        rebuildArmed = true;
        send({ ev: 'rebuild-armed' });
      } else if (message.op === 'release-rebuild') {
        const resume = rebuildRelease;
        rebuildRelease = null;
        resume();
      } else if (message.op === 'watch') {
        watched = message.file;
        send({ ev: 'watching' });
      } else if (message.op === 'watch-live') {
        if (!observersUrl) send({ ev: 'live-watching', error: 'the daemon has not loaded session-observers.mjs' });
        else
          import(observersUrl)
            .then((observers) => {
              const off = observers.subscribeLiveSessions((session) => {
                if (session?.id !== message.id) return;
                off();
                send({ ev: 'live', id: message.id });
              });
              send({ ev: 'live-watching' });
            })
            .catch((error) => send({ ev: 'live-watching', error: String(error?.message ?? error) }));
      } else if (message.op === 'settle') {
        if (!summaryIndexUrl) send({ ev: 'settled', ok: false, error: 'the daemon has not loaded store-summary-index.mjs' });
        else
          import(summaryIndexUrl)
            .then((index) => index.settleSummaryIndexWrites())
            .then((landed) => send({ ev: 'settled', ok: landed === true }))
            .catch((error) => send({ ev: 'settled', ok: false, error: String(error?.message ?? error) }));
      }
    }
  });
  for (const call of ['stat', 'readFile']) {
    const original = fsp[call];
    fsp[call] = async function (path, ...rest) {
      const hold = armed;
      if (hold?.call === call && basename(String(path)) === hold.file && (new Error().stack ?? '').includes(hold.marker)) {
        armed = null;
        await new Promise((resolve) => {
          release = resolve;
          send({ ev: 'reached', file: hold.file });
        });
        try {
          return await original.call(this, path, ...rest);
        } finally {
          send({ ev: 'ended', file: hold.file });
        }
      }
      return original.call(this, path, ...rest);
    };
  }
  const appendFile = fsp.appendFile;
  fsp.appendFile = async function (path, data, ...rest) {
    const result = await appendFile.call(this, path, data, ...rest);
    const file = basename(String(path));
    if (watched && file === watched) send({ ev: 'appended', file, text: String(data) });
    return result;
  };
  // The summary index's rebuild (`store/listing.mjs:111-142` scheduleSessionSummaryIndexRebuild, a worker that scans the session
  // files, writes the base index and empties its delta log, `summary-rebuild-worker.mjs`). Once armed, the next one spawned is held
  // before its script runs: the worker starts on a bootstrap that imports the script when the recorder releases it. Its landing
  // (the worker's answer, which `listing.mjs:137-140` adopts) is reported.
  const workerThreads = require('node:worker_threads');
  const BaseWorker = workerThreads.Worker;
  workerThreads.Worker = class extends BaseWorker {
    constructor(script, options) {
      const rebuild = String(script).endsWith('summary-rebuild-worker.mjs');
      const held = rebuild && rebuildArmed;
      if (held) {
        rebuildArmed = false;
        const bootstrap = `require('node:worker_threads').parentPort.once('message', () => import(${JSON.stringify(String(script))}));`;
        super(bootstrap, { ...options, eval: true });
      } else super(script, options);
      if (!rebuild) return;
      this.once('message', (message) => send({ ev: 'rebuild-landed', ok: message?.ok === true }));
      if (held) {
        rebuildRelease = () => this.postMessage('go');
        send({ ev: 'rebuild-reached' });
      }
    }
  };
  require('node:module').syncBuiltinESMExports();
}
