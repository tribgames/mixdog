/** Separate local latency samples: input-only must never stand in for a
 * pointer-bearing form. Assertions own outcomes, not wall-clock thresholds. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { BrowserCommandTiming } from './timing';
import type { CoreHarness } from './test-support/core-harness';
import { runBrowserParallelLatencyScenarios } from './parallel-latency-scenarios';

export async function runBrowserLatencyScenarios(
  command: (input: Record<string, unknown>) => Promise<{ text: string; timing?: BrowserCommandTiming }>,
  origin: string,
  progress: (message: string) => void
) {
  const tab = 'latency-scenarios';
  const measurementTurn = Date.now();
  const run = (input: Record<string, unknown>) =>
    command({ ...input, tab, background: true, turn_id: measurementTurn });
  await run({ action: 'navigate', url: origin });
  try {
    await run({
      action: 'evaluate',
      script: `(() => {
      document.body.innerHTML = '<label>First<input id="first"></label><label>Last<input id="last"></label>'
        + '<label>Plan<select id="plan"><option value="a">Basic</option><option value="b">Plus</option></select></label>'
        + '<label>Agree<input type="checkbox" id="agree"></label><button id="save">Save</button><output id="result"></output>';
      let saves = 0;
      document.getElementById('save').onclick = () => {
        document.getElementById('result').textContent = 'Saved ' + (++saves);
      };
    })()`,
    });
    const inputs = [
      { action: 'fill', target: { name: 'First', exact: true }, text: 'Jae' },
      { action: 'fill', target: { name: 'Last', exact: true }, text: 'Young' },
      { action: 'select', target: { name: 'Plan', exact: true }, values: ['b'] },
    ];
    const only = await run({ action: 'sequence', steps: inputs });
    assert.match(only.text, /value="Jae"/);
    assert.match(only.text, /value="Young"/);
    assert.match(only.text, /value="Plus"/);
    progress(`latency scenario input-only ${JSON.stringify(only.timing)}`);
    // Give both forms the same starting values; resetting is outside the sample.
    await run({
      action: 'evaluate',
      script: `(() => {
      document.getElementById('first').value = '';
      document.getElementById('last').value = '';
      document.getElementById('plan').value = 'a';
    })()`,
    });
    const batch = await run({
      action: 'fill',
      fields: inputs.map(({ target, text, values }) => ({ target, ...(values ? { values } : { text }) })),
    });
    assert.match(batch.text, /value="Jae"/);
    assert.match(batch.text, /value="Young"/);
    assert.match(batch.text, /value="Plus"/);
    progress(`latency scenario fill-fields ${JSON.stringify(batch.timing)}`);
    const mixed = await run({
      action: 'sequence',
      steps: [
        ...inputs.map((step) => (step.action === 'fill' ? { ...step, text: `${step.text} mixed` } : step)),
        { action: 'fill', target: { name: 'Agree', exact: true }, checked: true },
        { action: 'click', target: { name: 'Save', exact: true } },
        { action: 'wait', text: 'Saved 1' },
      ],
      expect: { text: 'Saved 1' },
    });
    assert.match(mixed.text, /value="Jae mixed"/);
    assert.match(mixed.text, /value="Young mixed"/);
    assert.match(mixed.text, /checked=true/);
    assert.match(mixed.text, /Saved 1/);
    assert.equal(mixed.timing?.mouseEvents?.mouseReleased?.count, 2);
    progress(`latency scenario check-and-save ${JSON.stringify(mixed.timing)}`);
    await assert.rejects(
      run({
        action: 'click',
        target: { name: 'Save', exact: true },
        expect: { text: 'unreachable result', timeoutMs: 500 },
      }),
      (error: Error & { timing?: BrowserCommandTiming }) => {
        assert.match(error.message, /Postcondition failed[\s\S]*Saved 2/);
        assert.ok(error.timing && error.timing.commandMs > 0);
        assert.equal(error.timing.mouseEvents?.mouseReleased?.count, 1);
        progress(`latency scenario failed-condition ${JSON.stringify(error.timing)}`);
        return true;
      }
    );
  } finally {
    await command({ action: 'close_tab', tab });
  }
  await runBrowserParallelLatencyScenarios(command, origin, progress);
}

/** The lines the engine gate writes to the harness progress log: `ENGINE_LATENCY_ROW_PREFIX` and one JSON row per call. */
export const ENGINE_LATENCY_ROW_PREFIX = 'latency-gate-row ';

/** One measured browser tool call through the core's engine (`test/browserEngine/run`). */
export interface EngineLatencyRow {
  /** `<action>:<variant>`, the key the gate's baselines use. */
  scenario: string;
  action: string;
  rep: number;
  warmup: boolean;
  /** The `turn_id` the call carried: the key of its `browser_timing` row in the core's agent trace. */
  turnId: number;
  ok: boolean;
  clientMs: number;
  /** `host/browser/*` requests the core sent to the desktop while the call ran. */
  hostCalls: number;
  /** For a `type`: characters typed and the `host/browser/events` notifications (events, serialized bytes) sent meanwhile. */
  chars?: number;
  events?: number;
  eventBytes?: number;
}

/** The thread the harness session belongs to (`HARNESS_SESSION` of the core harness). */
const GATE_THREAD = 'core-harness-session';

const GATE_FORM_MARKUP =
  '<h1>Latency form</h1>' +
  '<form id="gate-form"><label>R1 text <input id="r1-text" aria-label="R1 text" autocomplete="off"></label>' +
  '<button type="submit">R1 submit</button></form>' +
  '<button type="button" id="r1-count">R1 count</button><output id="r1-result">Idle</output>';

const GATE_FORM_SCRIPT = `(() => {
  let clicks = 0;
  document.getElementById('gate-form').onsubmit = (event) => event.preventDefault();
  document.getElementById('r1-count').onclick = () => {
    document.getElementById('r1-result').textContent = 'Clicked ' + (++clicks);
  };
})()`;

const gatePage = (title: string, body: string, script = ''): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}${script ? `<script>${script}</script>` : ''}`;

function gateText(kind: 'ascii' | 'korean', length: number): string {
  const alphabet = kind === 'ascii' ? 'abcdefghijklmnopqrstuvwxyz' : '가나다라마바사아자차카타파하';
  let text = '';
  for (let index = 0; text.length < length; index += 1) text += alphabet[index % alphabet.length];
  return text;
}

function refNamed(snapshot: string, ...names: string[]): string {
  for (const name of names) {
    const line = snapshot.split('\n').find((entry) => entry.includes(JSON.stringify(name)) && /\[p\d+-s\d+-e\d+\]/.test(entry));
    const ref = line?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
    if (ref) return ref;
  }
  throw new Error(`The snapshot has no ref named ${names.join(' / ')}.`);
}

const listen = (server: Server, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('The fixture server has no port.'));
    });
  });

/**
 * The latency gate's scenarios, run with Electron as the host role and the core's engine driving the browser. Every call is
 * one `browser` tool call through the engine hook with its own `turn_id`; a row per call goes to `emit` with the client time,
 * the host requests the core made and, for a `type`, the engine events it caused. The core's own `commandMs` comes from its
 * `browser_timing` rows (the core is started with `MIXDOG_AGENT_TRACE_TIMING`), joined by `turnId` by the gate script.
 * `MIXDOG_LATENCY_GATE_REPS` and `MIXDOG_LATENCY_GATE_WARMUP` set the repetitions (default 10 and 1).
 */
export async function runBrowserEngineLatencyGate(harness: CoreHarness, emit: (line: string) => void): Promise<void> {
  const reps = Math.max(1, Number(process.env.MIXDOG_LATENCY_GATE_REPS) || 10);
  const warmups = Math.max(0, Number(process.env.MIXDOG_LATENCY_GATE_WARMUP ?? 1) || 0);

  // `search` fetches on every key, `spa` rewrites its URL and re-renders, `frames` holds a cross-origin frame (the second
  // server is another origin: 127.0.0.2).
  const frameServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(gatePage('Frame', '<button type="button">Frame action</button>'));
  });
  const frameOrigin = `http://127.0.0.2:${await listen(frameServer, '127.0.0.2')}`;
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/q') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ results: [1, 2, 3] }));
      return;
    }
    const pages: Record<string, string> = {
      '/root': gatePage('Latency root', '<h1>Latency root</h1><p>Plain page</p>'),
      '/form': gatePage('Latency form', GATE_FORM_MARKUP, GATE_FORM_SCRIPT),
      '/plain': gatePage('Plain', '<label>Plain text <input aria-label="Plain text" autocomplete="off"></label>'),
      '/search': gatePage(
        'Search',
        '<label>Search text <input aria-label="Search text" autocomplete="off" id="q"></label><output id="out"></output>',
        `document.getElementById('q').oninput = async (event) => {
          const reply = await fetch('/q?x=' + encodeURIComponent(event.target.value));
          document.getElementById('out').textContent = (await reply.json()).results.length;
        }`
      ),
      '/spa': gatePage(
        'Spa',
        '<label>Spa text <input aria-label="Spa text" autocomplete="off" id="q"></label><ul id="list"></ul>',
        `document.getElementById('q').oninput = (event) => {
          history.replaceState(null, '', '?q=' + encodeURIComponent(event.target.value));
          document.getElementById('list').innerHTML = '<li>' + event.target.value.length + '</li>';
        }`
      ),
      '/frames': gatePage(
        'Frames',
        `<button type="button" id="r1-root-btn">R1 root button</button><iframe title="widget" src="${frameOrigin}/widget"></iframe>`
      ),
    };
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(pages[path] ?? pages['/root']);
  });
  const origin = `http://127.0.0.1:${await listen(server, '127.0.0.1')}`;

  let hostCalls = 0;
  let events = 0;
  let eventBytes = 0;
  const stopRequests = harness.client.onEvent((event) => {
    if (event.type !== 'serverRequest') return;
    const method = (event as { request?: { method?: unknown } }).request?.method;
    if (typeof method === 'string' && method.startsWith('host/browser/')) hostCalls += 1;
  });
  // `host/browser/events` is the notification that carries the page's CDP events to the core; the host role sends it through
  // this connection's `notify`.
  const notify = harness.client.notify;
  harness.client.notify = (method, params) => {
    if (method === 'host/browser/events') {
      const batch = (params as { events?: unknown[] } | undefined)?.events;
      events += Array.isArray(batch) ? batch.length : 1;
      eventBytes += Buffer.byteLength(JSON.stringify(params) ?? '');
    }
    notify.call(harness.client, method, params);
  };

  let turn = Date.now();
  const call = async (action: string, input: Record<string, unknown>): Promise<{ text: string; turnId: number; clientMs: number }> => {
    turn += 1;
    const turnId = turn;
    hostCalls = 0;
    events = 0;
    eventBytes = 0;
    const started = performance.now();
    const result = (await harness.runTool(GATE_THREAD, 'browser', { action, input: { ...input, turn_id: turnId } })) as {
      text?: string;
      isError?: boolean;
    };
    const clientMs = performance.now() - started;
    if (result?.isError) throw new Error(`browser ${action} failed: ${String(result.text).slice(0, 300)}`);
    return { text: String(result?.text ?? ''), turnId, clientMs };
  };
  const group = async (
    action: string,
    variant: string,
    input: (rep: number) => Record<string, unknown>,
    chars?: number
  ): Promise<void> => {
    for (let index = 0; index < warmups + reps; index += 1) {
      const rep = index - warmups;
      const { turnId, clientMs } = await call(action, input(rep));
      const row: EngineLatencyRow = {
        scenario: `${action}:${variant}`,
        action,
        rep,
        warmup: rep < 0,
        turnId,
        ok: true,
        clientMs,
        hostCalls,
        ...(chars ? { chars, events, eventBytes } : {}),
      };
      emit(`${ENGINE_LATENCY_ROW_PREFIX}${JSON.stringify(row)}`);
    }
  };
  /** Opens `path` and reads the refs named `names` from its snapshot (unmeasured calls: their trace rows have no gate row). */
  const refsOn = async (path: string, ...names: string[]): Promise<string[]> => {
    await call('navigate', { url: `${origin}${path}` });
    const { text } = await call('snapshot', {});
    return names.map((name) => refNamed(text, name));
  };

  try {
    await group('navigate', 'root-fixture', (rep) => ({ url: `${origin}/root?nav=${rep}` }));

    const [formText, formCount] = await refsOn('/form', 'R1 text', 'R1 count');
    await group('snapshot', 'form', () => ({}));
    for (const [variant, text] of [
      ['ascii10', gateText('ascii', 10)],
      ['ascii50', gateText('ascii', 50)],
      ['ascii200', gateText('ascii', 200)],
      ['korean50', gateText('korean', 50)],
    ] as const) {
      await group('type', variant, () => ({ ref: formText, text }), text.length);
    }
    await group('click', 'no-iframe', () => ({ ref: formCount }));

    // Events per typed character on a page that answers a key with nothing, with a request and with a re-render.
    for (const [variant, path, label] of [
      ['plain', '/plain', 'Plain text'],
      ['search', '/search', 'Search text'],
      ['spa', '/spa', 'Spa text'],
    ] as const) {
      const [ref] = await refsOn(path, label);
      const text = gateText('ascii', 50);
      await group('type', `ascii50-${variant}`, () => ({ ref, text }), text.length);
    }

    await refsOn('/frames', 'R1 root button');
    await group('snapshot', 'frames', () => ({}));
  } finally {
    harness.client.notify = notify;
    stopRequests();
    await Promise.all([server, frameServer].map((one) => new Promise<void>((resolve) => one.close(() => resolve()))));
  }
}
