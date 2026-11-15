// Loaded into the Node CLI of the pty twin with `node --import <this file> src/cli.mjs`: every provider request the process makes
// with fetch goes to the stand-in's plain HTTP port ($BENCH_PROVIDER_PORT), the original origin in `x-bench-origin`. Nothing else
// changes (it is the fetch redirect of benchmarks/rust-core/recorders/lib/exec-cli-tap.mjs, without its output log).
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const headers = new Headers(init?.headers ?? request?.headers ?? {});
  headers.set('x-bench-origin', url.origin);
  const target = `http://127.0.0.1:${process.env.BENCH_PROVIDER_PORT}${url.pathname}${url.search}`;
  return realFetch(
    target,
    request
      ? { method: request.method, headers, body: request.body, duplex: 'half', signal: request.signal, ...init, headers }
      : { ...init, headers }
  );
};
