// A stand-in for Node's resident search server (`mixdog-graph <cwd> --serve-search`, native-search-transport.mjs), for
// recording what Node's grep tool does when a search reaches its deadline. The client spawns the Node executable as its
// search binary (MIXDOG_SEARCH_SERVER_BIN), which loads this module first (`NODE_OPTIONS=--import`); any other Node
// process ignores it.
//
// It runs the real server (STANDIN_REAL_BIN) as its own child and relays everything, except that each search request
// is answered as the real server answers when its soft deadline passes (serve_search/search.rs `scan_operand`,
// `response_window`, `handle_content_search`): the deadline is an input, sent by the recorder over the control pipe
// (STANDIN_PIPE) before each call, not a race.
//   { afterFiles: N }  the deadline passes once the first N files that have lines (in the server's path order) were
//                      scanned: their lines, cut at the window's collection stop (offset + limit + 1), `complete: false,
//                      partial: true, timeout: true`.
//   { silent: true }   the server never answers a search (a find's fuzzy one included) and ignores `{cancel}`: Node's
//                      own deadline timer decides.
//   { saturated: true } every search finds the server's queue full and is answered as serve_search/server.rs:370-383
//                      answers it (`error: "native search queue saturated"`, `saturated: true`, and the scheduler's
//                      telemetry, taken from the real server's answer to the same request); it is reported as
//                      `saturated`, not compared: the real server's queue cannot be filled on cue.
//   { observe: true }  the real server answers everything; each search request is reported as it is passed on
//                      (`request`), and each of the real server's answers as it passes back (`answer`, with
//                      `saturated` when it is the full queue's refusal), in the order they pass.
// The script a stand-in starts with is STANDIN_SCRIPT (JSON), else none: a server the client starts in place of an ended
// one takes its first requests under it, before the recorder could reach it over the control pipe.
// Every request it answers itself is also sent to the real server as it is, and the real server's answer is reported
// beside the stand-in's answer to the same request under a deadline that never passes (`compare`, without the fields
// that time the two runs: `queueMs`, `handlerMs`, `scheduler`, and the request `id`), for the recorder to require
// equal. Every request, cancel and answer is reported on the control pipe, so the recorder sees what the client did to
// the server; the pipe closing without a `stdin-end` report means the process was killed.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const at = process.argv.indexOf('--serve-search');
if (at > 0 && process.env.STANDIN_PIPE && process.env.STANDIN_REAL_BIN) {
  const cwd = process.argv[at - 1];
  const real = spawn(process.env.STANDIN_REAL_BIN, [cwd, '--serve-search'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const control = connect(process.env.STANDIN_PIPE);
  const report = (event) => control.write(`${JSON.stringify(event)}\n`);
  let script = process.env.STANDIN_SCRIPT ? JSON.parse(process.env.STANDIN_SCRIPT) : {};
  const isSearch = (message) => Array.isArray(message.args) || typeof message.fuzzy === 'string';
  // A search request's patterns (`-e <pattern>`), so the recorder can tell the requests of its calls apart.
  const patternsOf = (message) => (Array.isArray(message.args) ? message.args.filter((_, i) => message.args[i - 1] === '-e') : [message.fuzzy]);
  createInterface({ input: control }).on('line', (line) => {
    script = JSON.parse(line);
    report({ event: 'script', script });
  });
  // Requests the stand-in answers itself, by the client's id: the request, the script it is answered under, and the real
  // server's answers to its whole search (the client's id) and to the request as it is (REAL_ID + the client's id).
  const REAL_ID = 1_000_000_000;
  const held = new Map();
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const settle = (entry) => {
    if (entry.script.saturated) {
      if (!entry.real) return;
      held.delete(Number(entry.request.id));
      report({ event: 'answer', id: entry.request.id, saturated: true });
      send({ id: entry.request.id, error: 'native search queue saturated', saturated: true, scheduler: entry.real.scheduler });
      return;
    }
    if (!entry.whole || !entry.real) return;
    held.delete(Number(entry.request.id));
    report({ event: 'compare', real: untimed(entry.real), standin: untimed(answerOf(entry.request, entry.whole, null)) });
    if (entry.script.silent) return;
    const answer = answerOf(entry.request, entry.whole, entry.script.afterFiles);
    report({ event: 'answer', id: answer.id, lines: answer.lines.length, totalSeen: answer.totalSeen });
    send(answer);
  };
  createInterface({ input: real.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    const id = Number(message?.id);
    const mine = message?.event ? undefined : held.get(id >= REAL_ID ? id - REAL_ID : id);
    if (!mine) {
      if (script.observe && message?.id !== undefined && !message.event && !message.ready) {
        report({ event: 'answer', id: message.id, saturated: message.saturated === true });
      }
      process.stdout.write(`${line}\n`);
      return;
    }
    if (id >= REAL_ID) mine.real = message;
    else mine.whole = message;
    settle(mine);
  });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    // No deadline set: the real server answers.
    if (script.afterFiles === undefined && !script.silent && !script.saturated) {
      if (script.observe && isSearch(message)) report({ event: 'request', id: message.id, patterns: patternsOf(message) });
      real.stdin.write(`${line}\n`);
      return;
    }
    if (script.saturated && isSearch(message)) {
      report({ event: 'saturated', id: message.id });
      held.set(Number(message.id), { request: message, script });
      real.stdin.write(`${JSON.stringify({ ...message, id: REAL_ID + Number(message.id) })}\n`);
      return;
    }
    if (message.cancel !== undefined) {
      report({ event: 'cancel', id: message.cancel });
      if (!script.silent) real.stdin.write(`${line}\n`);
      return;
    }
    // A find's fuzzy request at a server that never answers is held too (it has no window to compare).
    if (script.silent && typeof message.fuzzy === 'string') {
      report({ event: 'request', id: message.id, patterns: patternsOf(message) });
      return;
    }
    if (!Array.isArray(message.args)) {
      real.stdin.write(`${line}\n`);
      return;
    }
    report({ event: 'request', id: message.id, offset: message.offset, limit: message.limit, patterns: patternsOf(message) });
    // The whole answer, which the deadline then cuts, and the real server's answer to the request as it is.
    held.set(Number(message.id), { request: message, script });
    real.stdin.write(`${JSON.stringify({ ...message, offset: 0, limit: 0 })}\n`);
    real.stdin.write(`${JSON.stringify({ ...message, id: REAL_ID + Number(message.id) })}\n`);
  });
  process.stdin.on('end', () => {
    report({ event: 'stdin-end' });
    real.stdin.end();
    control.end(() => process.exit(0));
  });
  // The process lives on its handles; the main module (the cwd operand) is never loaded.
  await new Promise(() => {});
}

// The file a result line belongs to: `--files-with-matches` lines are paths, `--count` lines `path:N`, match lines
// `path:N:text`.
function fileOf(line, args) {
  if (args.includes('--files-with-matches') || args.includes('-l')) return line;
  if (args.includes('--count') || args.includes('-c')) return /^(.*):\d+$/.exec(line)?.[1] ?? line;
  return /^(.*?):\d+:/.exec(line)?.[1] ?? line;
}

// An answer without the fields that time its run, and without its id.
function untimed({ id: _id, queueMs: _queue, handlerMs: _handler, scheduler: _scheduler, ...rest }) {
  return rest;
}

// The real server's answer to `request` from its whole answer (offset 0, no limit), serve_search/search.rs
// `handle_content_search` and `response_window`: with `afterFiles` null no deadline passes; otherwise it passes once
// `afterFiles` files with lines were scanned, or when the search ends. The lines, in the server's path order, stop at
// the window's collection stop (offset + limit + 1) or at the deadline, then are windowed. A scan stopped by the
// collection stop opened the files with lines up to it (the files scanned).
function answerOf(request, whole, afterFiles) {
  const kept = [];
  let files = 0;
  let last = null;
  for (const line of whole.lines) {
    const file = fileOf(line, request.args);
    if (file !== last) {
      if (files === afterFiles) break;
      files += 1;
      last = file;
    }
    kept.push(line);
  }
  const collectUntil = request.limit > 0 ? request.offset + request.limit + 1 : Infinity;
  const collected = kept.slice(0, collectUntil);
  const lines = collected.slice(request.offset, request.limit > 0 ? request.offset + request.limit : undefined);
  const totalSeen = Math.max(0, collected.length - request.offset);
  if (afterFiles !== null) {
    return { ...whole, id: request.id, lines, complete: false, totalSeen, partial: true, timeout: true, filesScanned: files, inventoryChecked: false };
  }
  const stopped = collected.length >= collectUntil;
  const complete = whole.scanErrors === 0 && !stopped && (request.limit === 0 || totalSeen <= request.limit);
  const filesScanned = stopped ? new Set(collected.map((line) => fileOf(line, request.args))).size : whole.filesScanned;
  return { ...whole, id: request.id, lines, complete, totalSeen, partial: whole.scanErrors > 0, timeout: false, filesScanned, inventoryChecked: complete };
}
