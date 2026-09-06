import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownWorkerHost } from "./markdown-worker-host.ts";

class FakeWorker {
  handlers = new Map();
  sent = [];
  terminated = 0;
  addEventListener(type, listener) { this.handlers.set(type, listener); }
  postMessage(value) { this.sent.push(value); }
  terminate() { this.terminated += 1; }
  emit(type, event) { this.handlers.get(type)?.(event); }
  reply(index = 0) {
    const { id, text } = this.sent[index];
    this.emit("message", { data: {
      id, root: { type: "root", children: [{ type: "text", value: text }] },
    } });
  }
}

test("idle reclaim waits for pending parses and a retired worker cannot break its replacement", async () => {
  const workers = [];
  const host = new MarkdownWorkerHost(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const pending = host.parse("first");
  host.reclaim();
  assert.equal(workers[0].terminated, 0);
  workers[0].reply();
  assert.equal((await pending).children[0].value, "first");
  assert.equal(workers[0].terminated, 1);
  const next = host.parse("second");
  workers[0].emit("error", { message: "late retired error", preventDefault() {} });
  workers[1].reply();
  assert.equal((await next).children[0].value, "second");
  assert.equal(workers[1].terminated, 0);
  host.reclaim();
  assert.equal(workers[1].terminated, 1);
});

test("new work cancels a pending idle reclaim instead of repeatedly restarting the parser", async () => {
  const worker = new FakeWorker();
  const host = new MarkdownWorkerHost(() => worker);
  const first = host.parse("one");
  host.reclaim();
  const second = host.parse("two");
  worker.reply(0);
  worker.reply(1);
  await Promise.all([first, second]);
  assert.equal(worker.terminated, 0);
  host.reclaim();
  assert.equal(worker.terminated, 1);
});

for (const type of ["error", "messageerror"]) {
  test(`${type} rejects all pending work and does not recreate a broken bootstrap`, async () => {
    const worker = new FakeWorker();
    let creations = 0;
    let prevented = 0;
    const host = new MarkdownWorkerHost(() => { creations += 1; return worker; });
    const first = host.parse("one");
    const second = host.parse("two");
    const settled = Promise.allSettled([first, second]);
    worker.emit(type, { message: "failed", preventDefault() { prevented += 1; } });
    assert.deepEqual((await settled).map((result) => result.status), ["rejected", "rejected"]);
    await assert.rejects(host.parse("later"));
    assert.equal(prevented, 1);
    assert.equal(creations, 1);
    assert.equal(worker.terminated, 1);
  });
}

test("a failed post does not strand pending work during idle reclaim", async () => {
  const worker = new FakeWorker();
  worker.postMessage = () => { throw new Error("clone failed"); };
  const host = new MarkdownWorkerHost(() => worker);
  await assert.rejects(host.parse("bad"), /clone failed/);
  host.reclaim();
  assert.equal(worker.terminated, 1);
});

test("client shares concurrent parses, releases idle workers and preserves fallback recovery", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers = [];
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class extends FakeWorker {
    constructor() { super(); workers.push(this); }
  } });
  const { parseStreamingMarkdownAst } = await import("./markdown-worker-client.ts");
  const { _runIdleReclaimForTest } = await import("./idle-reclaim.ts");
  try {
    const requests = Array.from({ length: 50 }, () => parseStreamingMarkdownAst("shared"));
    assert.equal(workers[0].sent.length, 1);
    workers[0].reply();
    const roots = await Promise.all(requests);
    assert.ok(roots.every((root) => root === roots[0]));
    _runIdleReclaimForTest();
    assert.equal(workers[0].terminated, 1);
    const next = parseStreamingMarkdownAst("shared");
    assert.equal(workers.length, 2, "settled promises cannot retain an evicted AST");
    workers[1].reply();
    await next;
    const recovered = [
      parseStreamingMarkdownAst("**recovered**"),
      parseStreamingMarkdownAst("**recovered**"),
    ];
    workers[1].emit("error", { message: "bootstrap failed", preventDefault() {} });
    const fallback = await Promise.all(recovered);
    assert.equal(fallback[0], fallback[1]);
    assert.equal(fallback[0].children[0].children[0].tagName, "strong");
    await parseStreamingMarkdownAst("after failure");
    assert.equal(workers.length, 2);
  } finally {
    _runIdleReclaimForTest();
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else delete globalThis.Worker;
  }
});
