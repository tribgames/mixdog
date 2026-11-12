// The tap `record-exec-cli.mjs` puts into Node's real `mixdog` CLI process (`node --import <data URL calling
// installExecCliTap()> src/cli.mjs exec ...`), before the CLI's own modules load:
// - every provider request goes to the recorder's stand-in at 127.0.0.1:$BENCH_PROVIDER_PORT, its original origin in
//   `x-bench-origin` (the fetch the provider adapters use is redirected; nothing else changes);
// - every write the process makes to stdout or stderr is appended, in order and with its stream, to $BENCH_CHUNK_LOG
//   (one JSON line each), before it goes to the stream. The recorder checks that each stream's chunks, joined, are
//   the bytes its pipe carried.
// Exporting only: importing this module changes nothing.
import { appendFileSync } from 'node:fs';

export function installExecCliTap({ port = process.env.BENCH_PROVIDER_PORT, log = process.env.BENCH_CHUNK_LOG } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(init?.headers ?? request?.headers ?? {});
    headers.set('x-bench-origin', url.origin);
    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    return realFetch(
      target,
      request
        ? { method: request.method, headers, body: request.body, duplex: 'half', signal: request.signal, ...init, headers }
        : { ...init, headers }
    );
  };
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name];
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      appendFileSync(log, `${JSON.stringify({ stream: name, text })}\n`);
      return write(chunk, ...rest);
    };
  }
}
