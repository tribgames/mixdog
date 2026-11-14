#!/usr/bin/env node
// Runtime smoke of the direct desktop-to-core path, over the protocol only (packages/protocol-client, no Electron): one
// connection as the main process (Local, no window header) and two as windows (`Mixdog-Window`, the header the desktop
// sets per webContents), against an isolated mixdogd.
//
//   node apps/desktop/scripts/direct-core-smoke.mjs --core <daemon.json> [--workspace <dir>] [--route <provider>:<model>]
//   node apps/desktop/scripts/direct-core-smoke.mjs --mixdogd <built mixdogd>
//
// --core      the discovery file of an isolated core already serving (<runtime root>/daemon.json: core.rpc.port and
//             endpoints.session.token, as dev-isolated.mjs reads them). The model steps need --route and --workspace there;
//             the approval steps need a model that calls a tool, so they only run with --mixdogd.
// --mixdogd   a built mixdogd: it is started on a fresh profile under the temp dir with three scripted model endpoints (one
//             answers the large prompt, two call `bash` so the core asks for an approval), and stopped at the end.
// Steps (one line each, ok or FAIL): list projects; start a thread; a ~1 MB prompt through blob refs; a 600 KB file written
// through a blob ref and read back; terminal ensure/attach/input/output on the main and on a window connection; an approval
// answered by a window; a denied process/spawn on a window; two windows on one thread (the first answer wins).
// Exit 0 when every step passed, 1 when one failed, 2 on a bad command line or an unreachable core.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// The client library imports TypeScript from the workspace package @mixdog/protocol, which Node's own type stripping refuses
// under node_modules: tsx is loaded first, as core-terminal-smoke.mjs does.
await import('tsx');
const { connect } = await import('../../../packages/protocol-client/src/index.ts');

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const PROMPT_CHARS = 999_000;
const FILE_BYTES = 600 * 1024;
const STEP_MS = 30_000;
const POLL_MS = 20;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const nonce = () => randomBytes(4).toString('hex');
const message = (error) => (error instanceof Error ? error.message : String(error));

/** The value `probe` returns once it is truthy; a rejection naming `what` after `ms`. */
async function waitFor(what, ms, probe) {
  const until = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() >= until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (!['core', 'mixdogd', 'workspace', 'route'].includes(name)) throw new Error(`unknown option --${name}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    out[name] = value;
  }
  if (!out.core === !out.mixdogd) throw new Error('give exactly one of --core and --mixdogd');
  return out;
}

// ───────────────────────────── connections ─────────────────────────────

/** The client library's `Connector` over a WebSocket with the discovery token and, for a window, its header. */
function connectorFor(doc, windowId) {
  const url = `ws://127.0.0.1:${doc.core.rpc.port}/rpc`;
  const headers = { Authorization: `Bearer ${doc.endpoints.session.token}`, ...(windowId ? { 'Mixdog-Window': windowId } : {}) };
  return {
    open(_target, sink) {
      const socket = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
      return new Promise((resolveWriter, reject) => {
        let opened = false;
        socket.on('open', () => {
          opened = true;
          resolveWriter({ send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason) });
        });
        socket.on('message', (data, isBinary) => {
          if (!isBinary) sink.frame(data.toString('utf8'));
        });
        socket.on('close', (code, reason) => {
          if (opened) sink.closed(code, reason.toString('utf8'));
        });
        socket.on('error', (error) => {
          if (!opened) reject(error);
        });
        socket.on('unexpected-response', (_request, response) => {
          reject(new Error(`the core refused the connection (HTTP ${response.statusCode})`));
          socket.terminate();
        });
      });
    },
  };
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g;

/** One connection: the client, the approvals offered to it and resolved on it, and the output of the tabs it attached. */
class Link {
  constructor(client, label) {
    this.client = client;
    this.label = label;
    this.approvals = [];
    this.resolved = [];
    this.tabs = new Map();
    this.off = client.on((event) => {
      if (event.type === 'serverRequest' && /requestApproval$/.test(event.request.method)) this.approvals.push(event.request);
      else if (event.type === 'serverRequestResolved') this.resolved.push(event.params);
      else if (event.type === 'notification') this.frame(event.notification);
    });
  }

  frame(notification) {
    const feed = notification.feed?.id;
    if (typeof feed !== 'string' || !feed.startsWith('process:') || notification.method !== 'process/outputDelta') return;
    const tab = this.tabs.get(feed.slice('process:'.length));
    if (!tab) return;
    const { bytesB64, leadUnit, tailUnit } = notification.params ?? {};
    const unit = (value) => (typeof value === 'number' ? String.fromCharCode(value) : '');
    tab.partial += unit(leadUnit) + tab.decoder.decode(Buffer.from(String(bytesB64 ?? ''), 'base64'), { stream: true }) + unit(tailUnit);
    const cut = tab.partial.lastIndexOf('\n');
    if (cut < 0) return;
    for (const row of tab.partial.slice(0, cut).split('\n')) {
      const visible = row.replace(ANSI, '').replace(/\r+$/, '');
      tab.lines.push(visible.slice(visible.lastIndexOf('\r') + 1));
    }
    tab.partial = tab.partial.slice(cut + 1);
  }

  /** The tap exists before the attach is asked for: frames may be queued ahead of its answer. */
  async attach(tabId) {
    this.tabs.set(tabId, { decoder: new TextDecoder(), partial: '', lines: [] });
    return this.client.call('terminal/attach', { tabId });
  }

  async close() {
    this.off();
    await this.client.close().catch(() => undefined);
  }
}

// ───────────────────────────── the core under test ─────────────────────────────

/** Starts mixdogd on a fresh profile with three scripted model endpoints; resolves with what the steps need. */
async function startOwnCore(bin) {
  const { startCore, within } = await import('../../../scripts/rust-core/lib/core-session.mjs');
  const { startScriptedProvider } = await import('../../../scripts/rust-core/lib/scripted-provider.mjs');
  const ids = { prompt: 'custom-11111111-1111-4111-8111-111111111111', approve: 'custom-22222222-2222-4222-8222-222222222222', race: 'custom-33333333-3333-4333-8333-333333333333' };
  const command = JSON.stringify({ command: 'echo approval-smoke' });
  const providers = {
    prompt: await startScriptedProvider({ tool: 'read', args: '{}' }),
    approve: await startScriptedProvider({ tool: 'bash', args: command }),
    race: await startScriptedProvider({ tool: 'bash', args: command }),
  };
  const entry = (key) => ({ type: 'custom', name: `smoke-${key}`, protocol: 'openai-chat', baseURL: providers[key].baseURL, auth: 'none', models: [{ id: 'smoke' }] });
  const config = { agent: { providers: Object.fromEntries(Object.keys(ids).map((key) => [ids[key], entry(key)])) } };
  const root = mkdtempSync(join(tmpdir(), 'mixdog-direct-smoke-'));
  let core;
  try {
    core = await startCore({ bin, root, config, readyTimeoutMs: 120_000, clientName: 'direct-core-smoke' });
  } catch (error) {
    await Promise.all(Object.values(providers).map((provider) => provider.close()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    doc: core.discovery,
    workspace: core.paths.workspace,
    routes: Object.fromEntries(Object.keys(ids).map((key) => [key, { provider: ids[key], model: 'smoke' }])),
    providers,
    async stop() {
      await within(core.client.close(), 15_000, 'closing the core connection').catch(() => undefined);
      await core.stop().catch((error) => console.error(`stopping the core: ${message(error)}`));
      await Promise.all(Object.values(providers).map((provider) => provider.close()));
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.error(`could not remove ${root}: ${message(error)}`);
      }
    },
  };
}

// ───────────────────────────── the run ─────────────────────────────

async function run() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`direct-core-smoke: ${message(error)}`);
    console.error('usage: direct-core-smoke.mjs --core <daemon.json> [--workspace <dir>] [--route <provider>:<model>] | --mixdogd <binary>');
    return 2;
  }
  let own = null;
  let doc;
  let workspace = args.workspace ? resolve(args.workspace) : null;
  let routes = {};
  try {
    if (args.mixdogd) {
      own = await startOwnCore(resolve(args.mixdogd));
      ({ doc, workspace, routes } = own);
    } else {
      doc = JSON.parse(readFileSync(resolve(args.core), 'utf8'));
      if (!doc?.core?.rpc?.port || !doc?.endpoints?.session?.token) throw new Error(`${args.core} is not a serving core's discovery file (core.rpc.port, endpoints.session.token)`);
      if (args.route) {
        const cut = args.route.indexOf(':');
        if (cut <= 0) throw new Error('--route is <provider>:<model>');
        routes = { prompt: { provider: args.route.slice(0, cut), model: args.route.slice(cut + 1) } };
      }
    }
  } catch (error) {
    console.error(`direct-core-smoke: ${message(error)}`);
    await own?.stop();
    return 2;
  }

  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const links = [];
  // The core accepts exactly its own version; the first refusal names it.
  const dial = async (label, windowId) => {
    let wanted = String(version);
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await connect({
          target: { id: label },
          connector: connectorFor(doc, windowId),
          clientInfo: { name: `direct-core-smoke-${label}`, title: label, version: wanted, kind: windowId ? 'desktop' : 'cli' },
          capabilities: windowId ? { approvalsInbox: true } : {},
          clock: { sleep },
          random: Math.random,
        });
        const link = new Link(client, label);
        links.push(link);
        return link;
      } catch (error) {
        if (attempt === 0 && error?.detail?.kind === 'versionRefused') {
          wanted = error.detail.serverVersion;
          continue;
        }
        throw error;
      }
    }
  };

  let main;
  let windowA;
  let windowB;
  try {
    main = await dial('main');
    windowA = await dial('window-a', `smoke-a-${nonce()}`);
    windowB = await dial('window-b', `smoke-b-${nonce()}`);
  } catch (error) {
    console.error(`direct-core-smoke: cannot connect to 127.0.0.1:${doc.core.rpc.port}: ${message(error)}`);
    await Promise.all(links.map((link) => link.close()));
    await own?.stop();
    return 2;
  }

  const results = [];
  const check = async (name, work) => {
    const started = Date.now();
    let ok = true;
    let detail = '';
    try {
      detail = (await work()) ?? '';
    } catch (error) {
      ok = false;
      detail = message(error);
    }
    results.push(ok);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${Date.now() - started} ms)${detail ? ` ${detail}` : ''}`);
    return ok;
  };
  const needs = (what, ...values) => {
    if (values.some((value) => !value)) throw new Error(`not run: needs ${what}`);
  };
  const blobText = async (client, text) => ({ $blobRef: (await client.putBlob(Buffer.from(text, 'utf8'), 'text/plain')).blob.digest, as: 'text' });
  const startThread = async (client, route, interactive) => {
    const draft = { projectPath: workspace, route, orchestrationMode: 'none', ...(interactive ? {} : { workflowId: 'headless' }) };
    const session = interactive ? undefined : { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await client.call('thread/start', { kind: 'task', projectPath: workspace, draft, ...(session ? { session } : {}) });
    const id = started?.thread?.id;
    if (!id) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
    return id;
  };

  await check('list projects (main)', async () => `${JSON.stringify(await main.client.call('project/list', {})).length} bytes`);
  await check('list projects (window)', async () => `${JSON.stringify(await windowA.client.call('project/list', {})).length} bytes`);

  let promptThread = null;
  await check('start a thread', async () => {
    needs('--route and --workspace', routes.prompt, workspace);
    promptThread = await startThread(main.client, routes.prompt, false);
    return promptThread;
  });

  await check('1 MB prompt through blob refs', async () => {
    needs('a started thread', promptThread);
    const head = `HEAD-${nonce()}`;
    const tail = `TAIL-${nonce()}`;
    const text = head + 'a'.repeat(PROMPT_CHARS - head.length - tail.length) + tail;
    const started = await main.client.call('turn/start', { threadId: promptThread, input: { prompt: [{ type: 'text', text: await blobText(main.client, text) }] } });
    if (started?.kind !== 'started' && started?.kind !== 'queued') throw new Error(`turn/start answered ${JSON.stringify(started).slice(0, 200)}`);
    const provider = own?.providers.prompt;
    if (!provider) return `accepted (${text.length} chars); the model side is not scripted here`;
    const request = await waitFor('the model request', STEP_MS, () => provider.requests[0]);
    if (!request.body.includes(head) || !request.body.includes(tail) || request.body.length < PROMPT_CHARS) {
      throw new Error(`the model request does not carry the whole prompt (${request.body.length} bytes)`);
    }
    return `${text.length} chars reached the model (${request.body.length} bytes)`;
  });

  await check('600 KB file through a blob ref', async () => {
    needs('--workspace', workspace);
    const rel = `.direct-core-smoke-${nonce()}.txt`;
    const text = '0123456789abcdef'.repeat(Math.ceil(FILE_BYTES / 16)).slice(0, FILE_BYTES - 1) + '\n';
    await windowA.client.call('projectFs/writeText', { root: workspace, rel, content: await blobText(windowA.client, text), expectedContent: '' });
    try {
      const read = await main.client.call('projectFs/readText', { root: workspace, rel });
      const back = typeof read === 'string' ? read : (read?.content ?? read?.text);
      if (typeof back !== 'string') throw new Error(`projectFs/readText answered ${JSON.stringify(read).slice(0, 200)}`);
      if (back !== text) throw new Error(`the file read back differs (${back.length} chars, wrote ${text.length})`);
      return `${rel}, ${text.length} bytes`;
    } finally {
      // The file is the smoke's own: it does not stay in the workspace (a --core run may point at a real project).
      await main.client.call('projectFs/trash', { root: workspace, rel }).catch((error) => console.error(`could not trash ${rel}: ${message(error)}`));
    }
  });

  for (const link of [main, windowA]) {
    await check(`terminal ensure/attach/input/output (${link.label})`, async () => {
      const made = await link.client.call('terminal/ensure', { options: { cols: 80, rows: 24 } });
      if (!made || typeof made.id !== 'string' || !made.id) throw new Error(`terminal/ensure answered ${JSON.stringify(made)}`);
      try {
        const reply = await link.attach(made.id);
        if (!reply || typeof reply.replay !== 'string' || typeof reply.subscription?.id !== 'string') throw new Error(`terminal/attach answered ${JSON.stringify(reply)}`);
        const mark = `MK-${nonce()}`;
        link.client.notify('terminal/input', { tabId: made.id, data: `echo ${mark}\r` });
        const tab = link.tabs.get(made.id);
        // The typed line is echoed too: only a line that is exactly the marker is the command's output.
        await waitFor(`the line ${mark} (read ${tab.lines.length} lines)`, STEP_MS, () => tab.lines.includes(mark));
        return mark;
      } finally {
        await link.client.call('terminal/dispose', { tabId: made.id }).catch(() => undefined);
      }
    });
  }

  await check('denied process/spawn (window)', async () => {
    try {
      await windowA.client.call('process/spawn', { processHandle: `smoke-${nonce()}`, argv: ['node', '-v'], owner: 'internal' });
    } catch (error) {
      const detail = error?.detail;
      if (detail?.kind === 'rpc' && detail.reason === 'permissionDenied') return 'permissionDenied';
      throw new Error(`refused for another reason: ${message(error)}`);
    }
    throw new Error('the window was allowed to spawn a process');
  });

  /** A turn on `route` that makes the core ask for an approval: the thread, held by every link in `watchers`. */
  const askApproval = async (route, watchers) => {
    const thread = await startThread(main.client, route, true);
    for (const link of watchers) await link.client.resumeThread(thread, { lastItems: 20 });
    await main.client.call('turn/start', { threadId: thread, input: { prompt: 'run the command' } });
    const offered = (link) => link.approvals.find((request) => request.params.threadId === thread);
    for (const link of watchers) await waitFor(`an approval on ${link.label}`, STEP_MS, () => offered(link));
    return { thread, offered };
  };
  const decided = (link, thread) => link.resolved.find((resolved) => resolved.threadId === thread);

  await check('approval answered by a window', async () => {
    needs('--mixdogd (a scripted model that calls a tool)', own);
    const { thread, offered } = await askApproval(routes.approve, [windowA]);
    windowA.client.respond(offered(windowA).id, { result: { approved: false } });
    const resolved = await waitFor('the approval resolved', STEP_MS, () => decided(windowA, thread));
    if (resolved.resolution.kind !== 'decided' || resolved.resolution.decision.approved !== false) throw new Error(`resolved as ${JSON.stringify(resolved.resolution).slice(0, 200)}`);
    return `denied by ${resolved.resolution.connectionKind}`;
  });

  await check('two windows on one thread, the first answer wins', async () => {
    needs('--mixdogd (a scripted model that calls a tool)', own);
    const { thread, offered } = await askApproval(routes.race, [windowA, windowB]);
    windowA.client.respond(offered(windowA).id, { result: { approved: false } });
    windowB.client.respond(offered(windowB).id, { result: { approved: true } });
    for (const link of [windowA, windowB]) {
      const resolved = await waitFor(`the approval resolved on ${link.label}`, STEP_MS, () => decided(link, thread));
      if (resolved.resolution.kind !== 'decided' || resolved.resolution.decision.approved !== false) {
        throw new Error(`${link.label} saw ${JSON.stringify(resolved.resolution).slice(0, 200)}, not the first window's denial`);
      }
    }
    return 'both windows saw the first answer';
  });

  await Promise.all(links.map((link) => link.close()));
  await own?.stop();
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `direct-core-smoke: ${failed} of ${results.length} steps FAILED` : `direct-core-smoke: all ${results.length} steps passed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
  // A leftover socket must not keep a finished smoke alive.
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}
