// Isolate scheduling/retention from parser speed with an asynchronous worker.
// Run: node --import tsx scripts/markdown-request-bench.mjs
const workers = [];
let posts = 0;
let terminations = 0;
globalThis.Worker = class {
  handlers = new Map();
  requests = [];
  constructor() { workers.push(this); }
  addEventListener(type, listener) { this.handlers.set(type, listener); }
  postMessage(request) { posts += 1; this.requests.push(request); }
  terminate() { terminations += 1; }
  flush() {
    for (const request of this.requests.splice(0)) {
      this.handlers.get('message')?.({ data: {
        id: request.id,
        root: { type: 'root', children: [{ type: 'text', value: request.text }] },
      } });
    }
  }
};
const { parseStreamingMarkdownAst } = await import('../src/renderer/markdown-worker-client.ts');
const { _runIdleReclaimForTest } = await import('../src/renderer/idle-reclaim.ts');
const requests = Array.from({ length: 50 }, () => parseStreamingMarkdownAst('same pending text'));
await Promise.resolve();
for (const worker of workers) worker.flush();
const roots = await Promise.all(requests);
_runIdleReclaimForTest();
console.log(JSON.stringify({
  callers: requests.length,
  workerParses: posts,
  uniqueResults: new Set(roots).size,
  idleWorkersRetained: workers.length - terminations,
}));
