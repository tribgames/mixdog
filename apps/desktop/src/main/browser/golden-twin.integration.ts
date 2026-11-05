/**
 * Records the browser golden twin (WP-DESKTOP-HOST, DS-HOST-1): drives today's
 * Node product — the real Electron browser host behind the loopback bridge —
 * through one script that uses every action the `browser` tools expose, and
 * writes each request with the answer the model sees (result text, image mime,
 * or error text). The same script then runs through the protocol host channel
 * (`host/browser/command`) in a second session, and the run FAILS unless the
 * model-visible text of every step is identical on both channels.
 *
 * The Rust core replays the corpus over `host/browser/command`; text must match
 * byte for byte once ports, paths and durations are normalized.
 *
 * Run: node scripts/run-browser-host-integration.mjs --golden-twin  (apps/desktop)
 * Output: MIXDOG_BROWSER_GOLDEN_OUT (default native/core/fixtures/desktop-host/browser-golden.json).
 * The profile is a temp directory and is removed on exit.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, webContents } from 'electron';
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import { createPolling } from '../host-harness-poll';
import { createBrowserCommandHost } from '../host/browser-command';
import { readyBrowserFrame } from './harness-frame';
import { createBrowserHost, type BrowserHost } from './host';
import { traceTextsEqual } from './trace-compare';
import { createBrowserFrameFixture, createBrowserPageFixture, createBrowserSocketFixture } from './host-integration-fixtures';

const progressPath = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
const progress = (message: string): void => {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
};

const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-golden-profile-'));
const dataDirectory = join(profile, 'data');
const uploadFixturePath = join(profile, 'browser-upload-fixture.txt');
mkdirSync(join(profile, 'downloads'), { recursive: true });
writeFileSync(uploadFixturePath, 'Browser upload fixture');
process.env.MIXDOG_DATA_DIR = dataDirectory;
app.setPath('userData', join(profile, 'user-data'));
app.setPath('downloads', join(profile, 'downloads'));
app.disableHardwareAcceleration();

const { readDiscovery } = createPolling({ timeoutMs: 5_000, intervalMs: 50 });

/** What the model sees for one command on one channel. */
interface Outcome {
  ok: boolean;
  text: string;
  imageMime?: string;
  fileName?: string;
  hasTiming: boolean;
}

interface Channel {
  run(request: Record<string, unknown>): Promise<Outcome>;
}

/** `ref`: from the newest result text that carries element refs; `id`: from the previous result. */
interface Context {
  ref(name: string): string;
  id(pattern: RegExp): string;
}

interface Step {
  name: string;
  input: (context: Context) => Record<string, unknown>;
  /** Runs before the step on each channel (test-only setup). */
  before?: () => void;
}

/**
 * One recorded Chromium trace, delivered as the CDP events Chromium would
 * send. Live traces never repeat (GC and sampling events differ per run), so
 * both channels are fed this list at the tracer's event input and each renders
 * it through its own real code path.
 */
const RECORDED_TRACE_EVENTS = [
  { name: 'RunTask', ph: 'X', dur: 1200 },
  { name: 'RunTask', ph: 'X', dur: 800 },
  { name: 'V8.GC_MARK_COMPACTOR', ph: 'X', dur: 5400 },
  { name: 'FunctionCall', ph: 'X', dur: 300 },
  { name: 'FunctionCall', ph: 'X', dur: 150 },
  { name: 'FunctionCall', ph: 'X', dur: 50 },
  { name: 'thread_name', ph: 'M' },
];

const TRACE_STOPPED = 'Performance trace stopped.\n';
/** What the product renders for those events (sorted by total time, then count). */
const RECORDED_TRACE_LINES = [
  'Events: 7',
  '- V8.GC_MARK_COMPACTOR: 1 event(s), 5.40ms total',
  '- RunTask: 2 event(s), 2.00ms total',
  '- FunctionCall: 3 event(s), 0.50ms total',
  '- thread_name: 1 event(s), 0.00ms total',
];

/** Page debuggers already given the recorded trace. */
const tracedDebuggers = new WeakSet<object>();

/** Chromium is not asked to trace: `Tracing.start` is acknowledged, and
 *  `Tracing.end` answers with the recorded events as `Tracing.dataCollected`
 *  followed by `Tracing.tracingComplete`, through the debugger's own message
 *  event that the product's CDP router listens to. */
function recordTraceOnPages(pages: Electron.WebContents[]): void {
  for (const page of pages) {
    if (page.isDestroyed() || tracedDebuggers.has(page.debugger)) continue;
    const cdp = page.debugger;
    tracedDebuggers.add(cdp);
    const real = cdp.sendCommand.bind(cdp);
    cdp.sendCommand = ((method: string, params?: object, sessionId?: string) => {
      if (method === 'Tracing.start') return Promise.resolve({});
      if (method === 'Tracing.end') {
        setImmediate(() => {
          cdp.emit('message', {}, 'Tracing.dataCollected', { value: RECORDED_TRACE_EVENTS });
          cdp.emit('message', {}, 'Tracing.tracingComplete', {});
        });
        return Promise.resolve({});
      }
      return real(method, params, sessionId);
    }) as typeof cdp.sendCommand;
  }
}

function listen(server: { listen: (...args: any[]) => unknown; once: (...args: any[]) => unknown }, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
}

async function run(): Promise<void> {
  const socketFixture = createBrowserSocketFixture();
  const frameFixture = createBrowserFrameFixture();
  let frameOrigin = '';
  const { server: fixture, stalledResponses } = createBrowserPageFixture(() => frameOrigin);
  let parent: BrowserWindow | null = null;
  let host: BrowserHost | null = null;
  try {
    await listen(socketFixture, '127.0.0.1');
    await listen(frameFixture, '0.0.0.0');
    await listen(fixture, '127.0.0.1');
    frameOrigin = `http://127.0.0.2:${(frameFixture.address() as { port: number }).port}`;
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const socketUrl = `ws://127.0.0.1:${(socketFixture.address() as { port: number }).port}/socket`;
    // Ports, paths and durations differ per run; the corpus stores placeholders.
    const normalize = (text: string): string =>
      text
        .replaceAll(origin, '<ORIGIN>')
        .replaceAll(frameOrigin, '<FRAME_ORIGIN>')
        .replaceAll(socketUrl, '<SOCKET>')
        .replaceAll(uploadFixturePath, '<UPLOAD>')
        .replaceAll(uploadFixturePath.replaceAll('\\', '/'), '<UPLOAD>')
        .replaceAll(profile, '<PROFILE>')
        .replaceAll(profile.replaceAll('\\', '/'), '<PROFILE>')
        .replace(/\b\d+(\.\d+)? ?ms\b/g, '<N>ms');

    parent = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
    });
    host = createBrowserHost(parent, { remoteSession: true, requestApproval: async () => true });
    await parent.loadURL('data:text/html;charset=utf-8,<!doctype html><title>shell</title>');
    const bridgeSession = 'golden-bridge';
    // The same session id on both passes (releasing it between them), so each
    // pass starts from an identical page set and snapshot numbering.
    const hostSession = bridgeSession;
    // The pane shows one session at a time: each channel's pass gets it in turn.
    const showSession = async (session: string): Promise<void> => {
      progress(`showing session ${session}`);
      const frame = await readyBrowserFrame(host!, session);
      const guest = webContents.fromId(frame.webContentsId)!;
      await guest.loadURL(`${origin}/root`);
      host!.setGuestActive(session, guest.id, true);
    };
    await showSession(bridgeSession);
    host.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(dataDirectory, 'browser-bridge.json'));

    const outcomeOf = (
      ok: boolean,
      value: { text?: string; image?: { mimeType?: string }; file?: { name?: string }; timing?: unknown } | undefined,
      error: string | undefined,
      timing: unknown
    ): Outcome => ({
      ok,
      text: ok ? String(value?.text ?? '') : String(error ?? ''),
      ...(ok && value?.image ? { imageMime: value.image.mimeType } : {}),
      ...(ok && value?.file ? { fileName: value.file.name } : {}),
      hasTiming: Boolean(ok ? value?.timing : timing),
    });

    // Today's path: the loopback bridge's HTTP command endpoint.
    const bridgeChannel: Channel = {
      async run(request) {
        const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
          method: 'POST',
          headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: bridgeSession, turn_id: 1, ...request }),
        });
        const payload = (await response.json()) as {
          ok: boolean;
          value?: Parameters<typeof outcomeOf>[1];
          error?: string;
          timing?: unknown;
        };
        return outcomeOf(payload.ok, payload.value, payload.error, payload.timing);
      },
    };

    // The protocol path: `host/browser/command` served by the real host handler.
    let hostHandler: ((params: unknown, signal: AbortSignal) => Promise<unknown>) | null = null;
    createBrowserCommandHost(
      {
        request: async () => ({}),
        notify: () => undefined,
        sendBinary: () => undefined,
        handleRequest: (method: string, handler: typeof hostHandler) => {
          if (method === 'host/browser/command') hostHandler = handler;
        },
        handleNotification: () => undefined,
        onClose: () => undefined,
      } as never,
      host.commandRunner,
      { remoteBrowserControl: async () => ({}), remote: async () => ({}) }
    );
    const hostChannel: Channel = {
      async run(request) {
        const { action, ...input } = request;
        try {
          const value = (await hostHandler!(
            { action, input: { turn_id: 1, ...input }, threadId: hostSession },
            new AbortController().signal
          )) as Parameters<typeof outcomeOf>[1];
          return outcomeOf(true, value, undefined, undefined);
        } catch (error) {
          const failure = error as { message?: string; data?: { timing?: unknown } };
          return outcomeOf(false, undefined, failure.message, failure.data?.timing);
        }
      },
    };

    const contextFor = (): { context: Context; remember(outcome: Outcome): void } => {
      let latest = '';
      let previous = '';
      return {
        remember(outcome) {
          previous = outcome.text;
          if (/\[p\d+-s\d+-e\d+\]/.test(outcome.text)) latest = outcome.text;
        },
        context: {
          ref(name) {
            const line = latest
              .split('\n')
              .find((entry) => entry.includes(JSON.stringify(name)) && /\[p\d+-s\d+-e\d+\]/.test(entry));
            const ref = line?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
            if (!ref) throw new Error(`no ref named ${name} in the latest snapshot`);
            return ref;
          },
          id: (pattern) => {
            const match = previous.match(pattern)?.[1];
            if (!match) throw new Error(`no ${pattern} in the previous result: ${previous.slice(0, 200)}`);
            return match;
          },
        },
      };
    };
    const onBridge = contextFor();
    const onHost = contextFor();

    const alpha = { tab: 'alpha' } as const;
    const steps: Step[] = [
      { name: 'navigate', input: () => ({ action: 'navigate', url: `${origin}/root`, background: true, ...alpha, maxChars: 6000 }) },
      { name: 'snapshot', input: () => ({ action: 'snapshot', ...alpha }) },
      { name: 'snapshot-unknown-field', input: () => ({ action: 'snapshot', includeScreenshot: true, ...alpha }) },
      { name: 'locate', input: () => ({ action: 'locate', query: 'yellow', ...alpha }) },
      { name: 'read', input: () => ({ action: 'read', query: 'Waiting', ...alpha }) },
      { name: 'extract', input: () => ({ action: 'extract', selector: '#ledger tbody tr', ...alpha }) },
      { name: 'evaluate', input: () => ({ action: 'evaluate', script: 'document.title', ...alpha }) },
      {
        name: 'click',
        input: (c) => ({ action: 'click', ref: c.ref('Update SPA'), expect: { text: 'SPA done 1', timeoutMs: 2000 }, ...alpha }),
      },
      {
        name: 'click-postcondition-failed',
        input: (c) => ({ action: 'click', ref: c.ref('Update SPA'), expect: { text: 'condition that never appears', timeoutMs: 600 }, ...alpha }),
      },
      { name: 'wait', input: () => ({ action: 'wait', text: 'SPA done 2', ...alpha }) },
      { name: 'wait-timeout', input: () => ({ action: 'wait', text: 'condition that never appears', timeoutMs: 500, ...alpha }) },
      { name: 'fill', input: (c) => ({ action: 'fill', ref: c.ref('First name'), text: 'Ada', ...alpha }) },
      { name: 'type', input: (c) => ({ action: 'type', ref: c.ref('Type probe'), text: 'abc', ...alpha }) },
      { name: 'select', input: (c) => ({ action: 'select', ref: c.ref('Preferred role'), values: ['engineer'], ...alpha }) },
      { name: 'hover', input: (c) => ({ action: 'hover', ref: c.ref('Hover target'), ...alpha }) },
      { name: 'press', input: () => ({ action: 'press', key: 'Tab', ...alpha }) },
      { name: 'scroll', input: () => ({ action: 'scroll', dy: 200, ...alpha }) },
      {
        name: 'drag',
        input: (c) => ({ action: 'drag', ref: c.ref('Drag source'), targetRef: c.ref('Drag target'), ...alpha }),
      },
      {
        name: 'sequence',
        input: (c) => ({
          action: 'sequence',
          steps: [
            { action: 'fill', ref: c.ref('First name'), text: 'Grace' },
            { action: 'fill', ref: c.ref('Last name'), text: 'Hopper' },
            { action: 'select', ref: c.ref('Preferred role'), values: ['designer'] },
          ],
          expect: { text: 'Role designer', timeoutMs: 2000 },
          ...alpha,
        }),
      },
      { name: 'upload', input: (c) => ({ action: 'upload', ref: c.ref('Upload fixture'), paths: [uploadFixturePath], ...alpha }) },
      { name: 'click-dialog', input: (c) => ({ action: 'click', ref: c.ref('Open dialog'), ...alpha }) },
      { name: 'handle_dialog', input: () => ({ action: 'handle_dialog', accept: true, ...alpha }) },
      { name: 'console', input: () => ({ action: 'console', ...alpha }) },
      { name: 'network', input: () => ({ action: 'network', query: '/root', ...alpha }) },
      { name: 'storage-set', input: () => ({ action: 'storage', operation: 'set', storageType: 'local', name: 'golden', value: 'v', ...alpha }) },
      { name: 'storage-get', input: () => ({ action: 'storage', operation: 'get', storageType: 'local', name: 'golden', ...alpha }) },
      { name: 'cookies', input: () => ({ action: 'cookies', operation: 'clear', ...alpha }) },
      {
        name: 'intercept-add',
        input: () => ({ action: 'intercept', operation: 'add', url: '*/recovered*', body: 'golden-mocked', resourceTypes: ['fetch'], ...alpha }),
      },
      { name: 'intercept-list', input: () => ({ action: 'intercept', ...alpha }) },
      { name: 'intercept-clear', input: () => ({ action: 'intercept', operation: 'clear', ...alpha }) },
      { name: 'init_script-add', input: () => ({ action: 'init_script', operation: 'add', script: 'window.__golden = 1;', ...alpha }) },
      {
        name: 'init_script-remove',
        input: (c) => ({ action: 'init_script', operation: 'remove', scriptId: c.id(/init script (is\d+)/), ...alpha }),
      },
      { name: 'emulate', input: () => ({ action: 'emulate', width: 390, height: 844, mobile: true, ...alpha }) },
      { name: 'emulate-reset', input: () => ({ action: 'emulate', reset: true, ...alpha }) },
      {
        name: 'performance-start',
        before: () => recordTraceOnPages(webContents.getAllWebContents().filter((page) => page !== parent!.webContents)),
        input: () => ({ action: 'performance', operation: 'start', ...alpha }),
      },
      { name: 'performance-stop', input: () => ({ action: 'performance', operation: 'stop', ...alpha }) },
      { name: 'navigate-second', input: () => ({ action: 'navigate', url: `${origin}/secondary`, ...alpha }) },
      { name: 'back', input: () => ({ action: 'back', ...alpha }) },
      // The attachment arrives in two halves; the foreground navigation waits
      // for the page to be idle, so `downloads` reads it completed on both channels.
      {
        name: 'navigate-download',
        input: () => ({ action: 'navigate', url: `${origin}/download-held`, ...alpha }),
      },
      {
        name: 'downloads',
        input: () => ({ action: 'downloads', wait: true, timeoutMs: 3000 }),
      },
      { name: 'navigate-404', input: () => ({ action: 'navigate', url: `${origin}/missing`, background: true, tab: 'beta' }) },
      { name: 'navigate-refused-address', input: () => ({ action: 'navigate', url: 'http://10.255.255.1/', background: true, tab: 'beta' }) },
      { name: 'status', input: () => ({ action: 'status' }) },
      { name: 'list_tabs', input: () => ({ action: 'list_tabs' }) },
      { name: 'close_tab', input: () => ({ action: 'close_tab', tab: 'beta' }) },
      { name: 'close_tab-unknown', input: () => ({ action: 'close_tab', tab: 'nope' }) },
      { name: 'unknown-action', input: () => ({ action: 'definitely_not_an_action' }) },
      { name: 'click-without-ref', input: () => ({ action: 'click', ...alpha }) },
      { name: 'open', input: () => ({ action: 'open' }) },
      { name: 'hide', input: () => ({ action: 'hide' }) },
    ];

    const golden: Array<Record<string, unknown>> = [];
    const covered = new Set<string>();
    const mismatches: string[] = [];
    const passes = new Map<string, Array<{ request: Record<string, unknown>; outcome: Outcome }>>();
    const runPass = async (channel: Channel, context: ReturnType<typeof contextFor>) => {
      const results: Array<{ request: Record<string, unknown>; outcome: Outcome }> = [];
      for (const step of steps) {
        step.before?.();
        const request = step.input(context.context);
        const outcome = await channel.run(request);
        context.remember(outcome);
        results.push({ request, outcome });
      }
      return results;
    };
    passes.set('bridge', await runPass(bridgeChannel, onBridge));
    host.releaseSession(bridgeSession);
    await showSession(hostSession);
    passes.set('host', await runPass(hostChannel, onHost));
    // The second pass reuses the released session, so its page and download
    // counters continue where the first stopped; ids compare by order of first
    // appearance within each pass. The stored corpus keeps the raw first pass.
    const canonical = (): ((text: string) => string) => {
      const seen = {
        page: new Map<string, number>(),
        download: new Map<string, number>(),
        rule: new Map<string, number>(),
      };
      const ordinal = (table: Map<string, number>, id: string): number => {
        if (!table.has(id)) table.set(id, table.size + 1);
        return table.get(id)!;
      };
      return (text) =>
        normalize(text)
          .replace(/\bp(\d+)\b(?=-s\d|[ \]"):,.]|$)/g, (_all, id) => `p#${ordinal(seen.page, id)}`)
          .replace(/\[d(\d+)\]/g, (_all, id) => `[d#${ordinal(seen.download, id)}]`)
          .replace(/\b(is?)(\d+)\b(?=[\] .,:]|$)/g, (_all, kind, id) => `${kind}#${ordinal(seen.rule, `${kind}${id}`)}`)
          .replace(/[a-z0-9]{8}-(?=browser-fixture\.txt)/g, '');
    };
    const canonBridge = canonical();
    const canonHost = canonical();
    for (const [index, step] of steps.entries()) {
      const { request: bridgeRequest, outcome: viaBridge } = passes.get('bridge')![index];
      const { outcome: viaHost } = passes.get('host')![index];
      if (viaBridge.ok) covered.add(String(bridgeRequest.action));
      const seen = normalize(viaBridge.text);
      // A trace result is held to the full text: names, counts and structure,
      // with only the two wall-clock fields normalised.
      const isTrace = viaBridge.text.startsWith(TRACE_STOPPED);
      if (isTrace) {
        for (const expected of RECORDED_TRACE_LINES) {
          assert.ok(viaBridge.text.includes(expected), `the recorded trace was not rendered: missing ${expected}`);
        }
      }
      const same =
        viaBridge.ok === viaHost.ok &&
        (isTrace
          ? traceTextsEqual(viaBridge.text, viaHost.text)
          : canonBridge(viaBridge.text) === canonHost(viaHost.text)) &&
        viaBridge.imageMime === viaHost.imageMime &&
        viaBridge.fileName === viaHost.fileName &&
        viaBridge.hasTiming === viaHost.hasTiming;
      if (!same) {
        mismatches.push(
          `${step.name}\n  bridge: ${JSON.stringify([viaBridge.ok, seen.slice(0, 400)])}\n  host:   ${JSON.stringify([viaHost.ok, canonHost(viaHost.text).slice(0, 400)])}`
        );
      }
      golden.push({
        name: step.name,
        request: JSON.parse(normalize(JSON.stringify(bridgeRequest))),
        ok: viaBridge.ok,
        [viaBridge.ok ? 'text' : 'error']: seen,
        ...(viaBridge.imageMime ? { imageMime: viaBridge.imageMime } : {}),
        ...(viaBridge.fileName ? { fileName: viaBridge.fileName } : {}),
        hasTiming: viaBridge.hasTiming,
        hostChannelIdentical: same,
      });
      progress(`${step.name}: bridge ok=${viaBridge.ok} host ok=${viaHost.ok} same=${same}`);
    }

    const unexercised = BROWSER_ACTIONS.filter((action: string) => !covered.has(action));
    const out =
      process.env.MIXDOG_BROWSER_GOLDEN_OUT ||
      join(process.cwd(), '..', '..', 'native', 'core', 'fixtures', 'desktop-host', 'browser-golden.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify({ version: 2, producer: 'electron browser host via loopback bridge', actions: BROWSER_ACTIONS, steps: golden }, null, 2)}\n`
    );
    progress(`recorded ${golden.length} steps to ${out}`);
    assert.deepEqual(mismatches, [], `host channel differs from the loopback bridge:\n${mismatches.join('\n')}`);
    assert.deepEqual(unexercised, [], 'every browser action must succeed at least once through the bridge');
    progress('integration passed');
  } finally {
    for (const response of stalledResponses) response.destroy();
    await host?.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await new Promise<void>((resolve) => frameFixture.close(() => resolve()));
    await new Promise<void>((resolve) => socketFixture.close(() => resolve()));
  }
}

void app
  .whenReady()
  .then(async () => {
    await run();
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    app.exit(0);
  })
  .catch(async (error) => {
    progress(`failed: ${String((error as Error)?.stack || error)}`);
    console.error(error);
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    app.exit(1);
  });
