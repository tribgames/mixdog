/**
 * The browser golden twin (WP-DESKTOP-HOST, DS-HOST-1) on the core harness: one script that uses every action the `browser`
 * tools expose runs against a real mixdogd with this Electron process as the host role, and the model-visible text of every
 * step (result text, image mime, or error text) must equal the corpus the product's Node engine recorded
 * (native/core/fixtures/desktop-host/browser-golden.json), once ports, paths, durations and ids numbered by the run are
 * normalised.
 *
 * The runner starts it once per mode (apps/desktop/scripts/run-browser-core-integration.mjs):
 *   --engine host  the host role's own runner answers (`browser/command`, forwarded as `host/browser/command`)
 *   --engine core  the core's browser engine answers (`test/browserEngine/run`)
 * Run (apps/desktop):
 *   node scripts/run-browser-core-integration.mjs --suite src/main/browser/golden-twin.integration.ts --engine core|host
 * The corpus is read from MIXDOG_BROWSER_GOLDEN (default native/core/fixtures/desktop-host/browser-golden.json, two folders
 * above the runner's working directory). It is never written here: the loopback bridge that recorded it is gone, and the
 * engine's own host calls are recorded with MIXDOG_BROWSER_TRANSCRIPT.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, webContents } from 'electron';
import { BROWSER_ACTIONS } from '../../shared/core-src/runtime/browser-bridge/browser-action-contract.mjs';
import { traceTextsEqual } from './trace-compare';
import { createBrowserFrameFixture, createBrowserPageFixture, createBrowserSocketFixture } from './host-integration-fixtures';
import { type CoreHarness, type CoreHarnessSuite, HARNESS_SESSION, progress } from './test-support/core-harness';

/** What the model sees for one command. */
interface Outcome {
  ok: boolean;
  text: string;
  imageMime?: string;
  /** Only the host runner's reply carries the timing; the engine hook's reply has none to compare. */
  hasTiming?: boolean;
}

/** `ref`: from the newest result text that carries element refs; `id`: from the previous result. */
interface Context {
  ref(name: string): string;
  id(pattern: RegExp): string;
}

interface Step {
  name: string;
  input: (context: Context) => Record<string, unknown>;
  /** Runs before the step (test-only setup). */
  before?: () => void;
}

/** One step of the corpus. */
interface GoldenStep {
  name: string;
  request: Record<string, unknown>;
  ok: boolean;
  text?: string;
  error?: string;
  imageMime?: string;
  hasTiming?: boolean;
}

/** One command of the script in the harness's mode; it carries `turn_id`, as every command of a turn does. */
async function runCommand(harness: CoreHarness, request: Record<string, unknown>): Promise<Outcome> {
  const { action, ...input } = request;
  if (harness.engine === 'core') {
    const result = (await harness.runTool(HARNESS_SESSION, 'browser', { action, input: { turn_id: 1, ...input } })) as {
      text?: string;
      image?: { mimeType?: string };
      isError?: boolean;
    };
    return {
      ok: !result.isError,
      text: String(result.text ?? ''),
      ...(!result.isError && result.image ? { imageMime: result.image.mimeType } : {}),
    };
  }
  try {
    const value = (await harness.uiCommand(String(action), { turn_id: 1, ...input })) as {
      text?: string;
      image?: { mimeType?: string };
      timing?: unknown;
    };
    return {
      ok: true,
      text: String(value?.text ?? ''),
      ...(value?.image ? { imageMime: value.image.mimeType } : {}),
      hasTiming: Boolean(value?.timing),
    };
  } catch (error) {
    const failure = error as { message?: string; detail?: { message?: string; data?: { timing?: unknown } } };
    return {
      ok: false,
      text: String(failure.detail?.message ?? failure.message ?? ''),
      hasTiming: Boolean(failure.detail?.data?.timing),
    };
  }
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

const suite: CoreHarnessSuite = async (harness) => {
  const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-golden-profile-'));
  const uploadFixturePath = join(profile, 'browser-upload-fixture.txt');
  mkdirSync(join(profile, 'downloads'), { recursive: true });
  writeFileSync(uploadFixturePath, 'Browser upload fixture');
  app.setPath('downloads', join(profile, 'downloads'));
  const corpusPath =
    process.env.MIXDOG_BROWSER_GOLDEN ||
    join(process.cwd(), '..', '..', 'native', 'core', 'fixtures', 'desktop-host', 'browser-golden.json');
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { steps: GoldenStep[] };

  const socketFixture = createBrowserSocketFixture();
  const frameFixture = createBrowserFrameFixture();
  let frameOrigin = '';
  const { server: fixture, stalledResponses } = createBrowserPageFixture(() => frameOrigin);
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

    // The page the harness session shows, loaded as the pane would show it.
    await harness.guest.loadURL(`${origin}/root`);
    progress(`golden twin: mode ${harness.engine}`);

    const latest = { text: '', previous: '' };
    const context: Context = {
      ref(name) {
        const line = latest.text
          .split('\n')
          .find((entry) => entry.includes(JSON.stringify(name)) && /\[p\d+-s\d+-e\d+\]/.test(entry));
        const ref = line?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
        if (!ref) throw new Error(`no ref named ${name} in the latest snapshot`);
        return ref;
      },
      id: (pattern) => {
        const match = latest.previous.match(pattern)?.[1];
        if (!match) throw new Error(`no ${pattern} in the previous result: ${latest.previous.slice(0, 200)}`);
        return match;
      },
    };

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
        before: () => recordTraceOnPages(webContents.getAllWebContents().filter((page) => !page.getURL().startsWith('data:'))),
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

    assert.deepEqual(
      steps.map((step) => step.name),
      corpus.steps.map((step) => step.name),
      'the script and the corpus must list the same steps'
    );
    const results: Array<{ request: Record<string, unknown>; outcome: Outcome }> = [];
    for (const step of steps) {
      step.before?.();
      const request = step.input(context);
      const outcome = await runCommand(harness, request);
      latest.previous = outcome.text;
      if (/\[p\d+-s\d+-e\d+\]/.test(outcome.text)) latest.text = outcome.text;
      results.push({ request, outcome });
    }

    // Ids compare by order of first appearance, so a run that starts its page and download counters elsewhere still matches.
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
    const canonRun = canonical();
    const canonCorpus = canonical();
    const covered = new Set<string>();
    const mismatches: string[] = [];
    for (const [index, step] of steps.entries()) {
      const { request, outcome } = results[index];
      const recorded = corpus.steps[index];
      if (outcome.ok) covered.add(String(request.action));
      const expectedText = String(recorded.ok ? recorded.text : recorded.error);
      // A trace result is held to the full text: names, counts and structure, with only the two wall-clock fields normalised.
      const isTrace = outcome.text.startsWith(TRACE_STOPPED);
      if (isTrace) {
        for (const expected of RECORDED_TRACE_LINES) {
          assert.ok(outcome.text.includes(expected), `the recorded trace was not rendered: missing ${expected}`);
        }
      }
      const same =
        outcome.ok === recorded.ok &&
        JSON.stringify(JSON.parse(normalize(JSON.stringify(request)))) === JSON.stringify(recorded.request) &&
        (isTrace ? traceTextsEqual(expectedText, outcome.text) : canonCorpus(expectedText) === canonRun(outcome.text)) &&
        outcome.imageMime === recorded.imageMime &&
        (outcome.hasTiming === undefined || outcome.hasTiming === recorded.hasTiming);
      if (!same) {
        mismatches.push(
          `${step.name}\n  corpus: ${JSON.stringify([recorded.ok, expectedText.slice(0, 400)])}\n  ${harness.engine}: ${JSON.stringify([outcome.ok, canonRun(outcome.text).slice(0, 400)])}`
        );
      }
      progress(`${step.name}: ok=${outcome.ok} same=${same}`);
    }

    const unexercised = BROWSER_ACTIONS.filter((action: string) => !covered.has(action));
    assert.deepEqual(mismatches, [], `the ${harness.engine} answers differ from the corpus:\n${mismatches.join('\n')}`);
    assert.deepEqual(unexercised, [], 'every browser action must succeed at least once');
  } finally {
    for (const response of stalledResponses) response.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await new Promise<void>((resolve) => frameFixture.close(() => resolve()));
    await new Promise<void>((resolve) => socketFixture.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
  }
};

export default suite;
