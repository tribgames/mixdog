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
//   { silent: true }   the server never answers a search and ignores `{cancel}`: Node's own deadline timer decides.
//   { compare: true }  a check of the stand-in, not a deadline: the real server answers the request itself, and the
//                      stand-in's answer under a deadline that never passes is reported beside it (`compare`).
// Every request, cancel and answer is reported on the control pipe, so the recorder sees what the client did to the
// server; the pipe closing without a `stdin-end` report means the process was killed.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const at = process.argv.indexOf('--serve-search');
if (at > 0 && process.env.STANDIN_PIPE && process.env.STANDIN_REAL_BIN) {
  const cwd = process.argv[at - 1];
  const real = spawn(process.env.STANDIN_REAL_BIN, [cwd, '--serve-search'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const control = connect(process.env.STANDIN_PIPE);
  const report = (event) => control.write(`${JSON.stringify(event)}\n`);
  let script = {};
  createInterface({ input: control }).on('line', (line) => {
    script = JSON.parse(line);
    report({ event: 'script', script });
  });
  // Requests the stand-in answers itself, by id: the client's request and the script it is answered under.
  const held = new Map();
  // Compared requests, by the id of their whole request: the client's request and the answers so far.
  const COMPARE_ID = 1_000_000_000;
  const compared = new Map();
  const reportCompare = (entry) => {
    if (!entry.real || !entry.whole) return;
    report({ event: 'compare', real: entry.real, standin: cutAtDeadline(entry.request, entry.whole, Infinity) });
  };
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: real.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    if (!message?.event && compared.has(Number(message?.id))) {
      const entry = compared.get(Number(message.id));
      if (Number(message.id) >= COMPARE_ID) {
        entry.whole = message;
      } else {
        entry.real = message;
        process.stdout.write(`${line}\n`);
      }
      reportCompare(entry);
      return;
    }
    const mine = held.get(Number(message?.id));
    if (!mine || message.event) {
      process.stdout.write(`${line}\n`);
      return;
    }
    held.delete(Number(message.id));
    const answer = cutAtDeadline(mine.request, message, mine.script.afterFiles);
    report({ event: 'answer', id: answer.id, lines: answer.lines.length, totalSeen: answer.totalSeen });
    send(answer);
  });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    // No deadline set: the real server answers.
    if (script.afterFiles === undefined && !script.silent && !script.compare) {
      real.stdin.write(`${line}\n`);
      return;
    }
    if (message.cancel !== undefined) {
      report({ event: 'cancel', id: message.cancel });
      if (!script.silent) real.stdin.write(`${line}\n`);
      return;
    }
    if (!Array.isArray(message.args)) {
      real.stdin.write(`${line}\n`);
      return;
    }
    report({ event: 'request', id: message.id, offset: message.offset, limit: message.limit });
    if (script.silent) return;
    if (script.compare) {
      const entry = { request: message };
      compared.set(Number(message.id), entry);
      compared.set(COMPARE_ID + Number(message.id), entry);
      real.stdin.write(`${line}\n`);
      real.stdin.write(`${JSON.stringify({ ...message, id: COMPARE_ID + Number(message.id), offset: 0, limit: 0 })}\n`);
      return;
    }
    // The whole answer, which the deadline then cuts.
    held.set(Number(message.id), { request: message, script });
    real.stdin.write(`${JSON.stringify({ ...message, offset: 0, limit: 0 })}\n`);
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

// The real server's answer when its deadline passes after `afterFiles` files with lines: those files' lines in its path
// order, stopped at the window's collection stop, then windowed (`response_window`).
function cutAtDeadline(request, whole, afterFiles) {
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
  return {
    ...whole,
    id: request.id,
    lines,
    complete: false,
    totalSeen: Math.max(0, collected.length - request.offset),
    partial: true,
    timeout: true,
    filesScanned: files,
    inventoryChecked: false,
  };
}
