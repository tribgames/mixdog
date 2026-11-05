// Drives a real worker process over its stdio protocol the way the core's pool does: one call at
// a time per worker, window credit returned for every chunk received.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, Kind, encodeFrame, encodeJsonFrame } from '../frame.mjs';

const workerPath = fileURLToPath(new URL('../worker.mjs', import.meta.url));

export function startWorker() {
  const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const decoder = new FrameDecoder();
  const frames = [];
  const waiting = [];
  child.stdout.on('data', (data) => {
    frames.push(...decoder.push(data));
    for (const w of waiting.splice(0)) w();
  });
  const until = async (predicate) => {
    while (!predicate()) await new Promise((resolve) => waiting.push(resolve));
  };
  let nextId = 1;
  const call = async (method, params, paths, thread = 't1') => {
    const id = nextId++;
    const from = frames.length;
    child.stdin.write(encodeJsonFrame(Kind.CALL, id, { method, params, paths, thread }));
    const credited = new Set();
    const credit = () => {
      for (const f of frames.slice(from)) {
        if (f.id !== id || f.kind !== Kind.CHUNK || credited.has(f)) continue;
        credited.add(f);
        const body = Buffer.alloc(4);
        body.writeUInt32BE(f.body.length);
        child.stdin.write(encodeFrame(Kind.CREDIT, id, body));
      }
    };
    await until(() => {
      credit();
      return frames.some((f, i) => i >= from && f.kind === Kind.RESULT && f.id === id);
    });
    const mine = frames.slice(from).filter((f) => f.id === id);
    return {
      result: JSON.parse(mine.find((f) => f.kind === Kind.RESULT).body.toString()),
      chunks: mine.filter((f) => f.kind === Kind.CHUNK).map((f) => f.body),
    };
  };
  const cancel = (id) => child.stdin.write(encodeFrame(Kind.CANCEL, id, Buffer.alloc(0)));
  const ready = until(() => frames.some((f) => f.kind === Kind.READY));
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.stdin.write(encodeFrame(Kind.BYE, 0, Buffer.alloc(0)));
    await new Promise((resolve) => child.once('exit', resolve));
  };
  const kill = () => child.kill();
  return { ready, call, cancel, stop, kill, pid: child.pid };
}
