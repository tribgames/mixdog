#!/usr/bin/env node
// Recording of apps/desktop/src/main/system-proxy.test.mjs (b6f10295a): the desktop window's side of the system-proxy lookup
// (apps/desktop/src/main/system-proxy.ts answerSystemProxyRequest, createSystemProxyLease) and the daemon's per-origin routing
// (src/runtime/shared/llm/system-proxy.mjs adoptSystemProxy, systemProxyRoute, attachSystemProxyResolver). Chromium's resolveProxy
// and the Windows registry reader are scripted. Recorded per case: what was asked, what was settled, resolver attach/detach counts
// and the route answers.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-system-proxy-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('system-proxy-cases', import.meta.url);
const daemonProxy = await set.load('src/runtime/shared/llm/system-proxy.mjs');
const { answerSystemProxyRequest, createSystemProxyLease, SYSTEM_PROXY_REQUEST_EVENT } = await set.load('apps/desktop/src/main/system-proxy.ts');
const { adoptSystemProxy, systemProxyRoute } = daemonProxy;
const turns = async (n) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

await set.run('the desktop and the runtime agree on the lookup event', () => ({ desktopEvent: SYSTEM_PROXY_REQUEST_EVENT, daemonEvent: daemonProxy.SYSTEM_PROXY_REQUEST_EVENT }));
await set.run('the window answers a lookup with Chromium’s answer for its origin, and failures by name only', async () => {
  const settled = [];
  const settle = async (args) => settled.push(args);
  const asked = [];
  const resolveProxy = async (url) => { asked.push(url); return 'PROXY proxy.corp:8080'; };
  const requests = [
    { id: 'r1', method: 'resolveProxy', args: ['https://api.openai.com'] },
    { id: 'r2', args: ['file:///etc/passwd'] },
    { args: ['https://a.test'] },
    { id: 'r3', args: ['https://b.test'] },
  ];
  await answerSystemProxyRequest(requests[0], resolveProxy, settle);
  await answerSystemProxyRequest(requests[1], resolveProxy, settle);
  await answerSystemProxyRequest(requests[2], resolveProxy, settle);
  await answerSystemProxyRequest(requests[3], async () => { throw new Error('PAC http://user:pass@pac.corp/p.pac failed'); }, settle);
  return { requests, chromiumAnswer: 'PROXY proxy.corp:8080', r3Throws: 'PAC http://user:pass@pac.corp/p.pac failed', chromiumAskedFor: asked, settled };
});
await set.run('the lease attaches one resolver while any asking client is connected', async () => {
  const attached = [];
  let detached = 0;
  const load = async () => ({ attachSystemProxyResolver: (resolve) => { attached.push(resolve); return () => { detached += 1; }; } });
  const request = async () => 'DIRECT';
  const lease = createSystemProxyLease(load, request);
  const log = [];
  log.push({ step: 'attach(1)', answer: await lease.attach(1), attachedCount: attached.length });
  log.push({ step: 'attach(2)', answer: await lease.attach(2), attachedCount: attached.length, attachedIsTheRequestFunction: attached[0] === request });
  lease.release(1);
  await turns(1);
  log.push({ step: 'release(1)', detached });
  lease.release(2);
  await turns(1);
  log.push({ step: 'release(2)', detached });
  log.push({ step: 'attach(NaN)', answer: await lease.attach(Number.NaN) });
  log.push({ step: 'older daemon without a per-origin resolver: attach(1)', answer: await createSystemProxyLease(() => undefined, request).attach(1) });
  return { log };
});
await set.run('an attached app routes the daemon per origin; when it leaves the fallback applies again', async () => {
  const registry = { proxyEnable: '0x1', proxyServer: '127.0.0.1:7890', proxyOverride: '<local>' };
  adoptSystemProxy({}, { platform: 'win32', reader: () => registry, apply: () => {}, log: () => {} });
  const pac = { 'api.openai.com': 'PROXY proxy.corp:8080', 'intranet.corp.example': 'DIRECT' };
  const asked = [];
  const lease = createSystemProxyLease(async () => daemonProxy, async (origin) => { asked.push(origin); return pac[new URL(origin).hostname] ?? 'PROXY other.corp:3128'; });
  const log = [];
  try {
    log.push({ step: 'before attach, registry fallback', origin: 'https://api.openai.com', route: systemProxyRoute('https://api.openai.com') });
    await lease.attach(1);
    for (const origin of ['https://api.openai.com', 'https://intranet.corp.example', 'https://api.anthropic.com']) log.push({ step: 'attached', origin, route: await systemProxyRoute(origin) });
    lease.release(1);
    await turns(1);
    log.push({ step: 'released, fallback again', origin: 'https://intranet.corp.example', route: systemProxyRoute('https://intranet.corp.example') });
  } finally { adoptSystemProxy({}, { platform: 'linux' }); }
  return { registry, pac, otherwise: 'PROXY other.corp:3128', chromiumAskedFor: asked, log };
});

await set.finish({
  entry: { runs: 'apps/desktop/src/main/system-proxy.ts (answerSystemProxyRequest, createSystemProxyLease) and src/runtime/shared/llm/system-proxy.mjs (adoptSystemProxy with a scripted platform/registry reader, systemProxyRoute, attachSystemProxyResolver, SYSTEM_PROXY_REQUEST_EVENT)', notRun: 'no Chromium: resolveProxy is a scripted function; no real Windows registry read; the one-turn waits after release are one event-loop turn' },
  replay: { entry: 'mixdog-app-server-daemon system_proxy_claim.rs and mixdog-ai netproxy: replay the lookup requests, lease attach/release and the route answers; compare asked origins, settled args, attach/detach counts and routes whole', normalised: {} },
});
process.exit(0);
