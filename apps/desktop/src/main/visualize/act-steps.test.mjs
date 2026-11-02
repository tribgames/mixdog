// `visualize act`: request parsing, the step loop run against a real DOM, and
// the service routing (panel frame vs. off-screen window, final capture).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { runActSteps } from './act-steps.ts';
import { createVisualizeService } from './service.ts';
import { parseVisualizeRequest } from './targets.ts';

const cwd = realpathSync(tmpdir());
const parseAct = (input) => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'act', input });

test('act requests are validated and normalized', () => {
  const parsed = parseAct({
    tab: 'v1',
    pane: 2,
    output: 'shots/end.png',
    steps: [
      { do: 'click', selector: ' #go ' },
      { do: 'type', selector: '#name', text: '' },
      { do: 'key', key: 'Control+a' },
      { do: 'key', key: 'esc', selector: '#name' },
      { do: 'scroll', y: 400 },
      { do: 'wait', selector: '.done' },
      { do: 'wait', ms: 200 },
      { do: 'evaluate', script: 'document.title' },
    ],
  });
  assert.equal(parsed.pane, 1, 'pane is 1-based in the input');
  assert.equal(parsed.output, 'shots/end.png');
  assert.deepEqual(parsed.steps, [
    { do: 'click', selector: '#go' },
    { do: 'type', selector: '#name', text: '' },
    { do: 'key', label: 'Control+a', key: 'a', code: 'KeyA', ctrl: true, shift: false, alt: false, meta: false },
    {
      do: 'key',
      label: 'esc',
      key: 'Escape',
      code: 'Escape',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      selector: '#name',
    },
    { do: 'scroll', y: 400 },
    { do: 'wait', selector: '.done', timeout: 5000 },
    { do: 'wait', ms: 200 },
    { do: 'evaluate', script: 'document.title' },
  ]);

  const rejects = [
    [{ tab: 'v1' }, /steps must list 1-25 steps/],
    [{ tab: 'v1', steps: Array.from({ length: 26 }, () => ({ do: 'wait', ms: 1 })) }, /steps must list 1-25/],
    [{ tab: 'v1', steps: [{ do: 'hover', selector: 'a' }] }, /steps\[0\]: do must be click, type/],
    [{ tab: 'v1', steps: [{ do: 'wait', ms: 1 }, { do: 'click' }] }, /steps\[1\]: selector must be a non-empty/],
    [{ tab: 'v1', steps: [{ do: 'type', selector: 'input' }] }, /steps\[0\]: type requires text/],
    [{ tab: 'v1', steps: [{ do: 'key', key: 'Hyper+a' }] }, /unknown modifier "Hyper"/],
    [{ tab: 'v1', steps: [{ do: 'key', key: 'two words' }] }, /neither one character nor a key name/],
    [{ tab: 'v1', steps: [{ do: 'scroll' }] }, /scroll takes a selector/],
    [{ tab: 'v1', steps: [{ do: 'wait' }] }, /wait takes ms/],
    [{ tab: 'v1', steps: [{ do: 'wait', ms: 10_001 }] }, /ms must be a whole number from 1 to 10000/],
    [{ tab: 'v1', steps: [{ do: 'wait', selector: 'a', timeout: 0 }] }, /timeout must be a whole number/],
    [{ tab: 'v1', steps: [{ do: 'evaluate', script: ' ' }] }, /script must be a non-empty string/],
    [{ tab: 'v1', output: 'end.jpg', steps: [{ do: 'wait', ms: 1 }] }, /output must be a \.png path/],
    [{ tab: 'v1', pane: 0, steps: [{ do: 'wait', ms: 1 }] }, /pane must be a whole number from 1 to 6/],
    [{ steps: [{ do: 'wait', ms: 1 }] }, /tab must be a non-empty string/],
  ];
  for (const [input, error] of rejects) assert.throws(() => parseAct(input), error, JSON.stringify(input));
});

/** A page in jsdom whose `exec` runs a script the way a frame does. */
function page(body) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only' });
  const { window } = dom;
  // Layout APIs jsdom lacks; Chromium has them.
  window.Element.prototype.scrollIntoView = () => {};
  window.Element.prototype.checkVisibility = function () {
    return !this.hidden;
  };
  window.HTMLFormElement.prototype.requestSubmit = function () {
    this.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  return { window, document: window.document, exec: async (script) => window.eval(script) };
}

test('steps run in order against the page and evaluate values come back', async () => {
  const { window, document, exec } = page(`
    <button id="go">Go</button><p id="count">0</p>
    <form id="f"><input id="name" value="old"></form>
    <div id="list" style="overflow:auto"></div>`);
  const seen = [];
  document.querySelector('#go').addEventListener('click', (event) => {
    seen.push(`click ${event.clientX >= 0}`);
    document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1);
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p class="done">done</p>'), 30);
  });
  document.querySelector('#name').addEventListener('input', (event) => seen.push(`input ${event.target.value}`));
  document.querySelector('#name').addEventListener('change', () => seen.push('change'));
  document.addEventListener('keydown', (event) => seen.push(`keydown ${event.key} ctrl=${event.ctrlKey}`));
  document.querySelector('#f').addEventListener('submit', (event) => {
    event.preventDefault();
    seen.push('submit');
  });
  const steps = parseAct({
    tab: 'v1',
    steps: [
      { do: 'click', selector: '#go' },
      { do: 'type', selector: '#name', text: 'Ada' },
      { do: 'key', key: 'Control+a' },
      { do: 'key', key: 'Enter', selector: '#name' },
      { do: 'wait', selector: '.done', timeout: 2000 },
      { do: 'scroll', selector: '#list' },
      {
        do: 'evaluate',
        script:
          '({ count: document.querySelector("#count").textContent, name: document.querySelector("#name").value })',
      },
      { do: 'evaluate', script: '(async () => { await new Promise((r) => setTimeout(r, 5)); return [1, "two"]; })()' },
    ],
  }).steps;
  const outcomes = await runActSteps(steps, exec);
  assert.ok(
    outcomes.every((outcome) => outcome.ok),
    JSON.stringify(outcomes)
  );
  assert.equal(outcomes.length, 8);
  assert.deepEqual(seen, [
    'click true',
    'input Ada',
    'change',
    'keydown a ctrl=true',
    'keydown Enter ctrl=false',
    'submit',
  ]);
  assert.equal(outcomes[0].detail, 'clicked button#go');
  assert.equal(outcomes[3].detail, 'pressed Enter on input#name (submitted its form)');
  assert.match(outcomes[4].detail, /^\.done is shown after \d+ ms$/);
  assert.equal(outcomes[6].value, '{"count":"1","name":"Ada"}');
  assert.equal(outcomes[7].value, '[1,"two"]');
  window.close();
});

test('the first failing step stops the run with its reason', async () => {
  const { window, exec } = page('<button id="go" disabled>Go</button><input type="checkbox" id="box">');
  const run = (list) => runActSteps(parseAct({ tab: 'v1', steps: list }).steps, exec, { budgetMs: 2000 });

  const missing = await run([
    { do: 'evaluate', script: '1 + 1' },
    { do: 'click', selector: '#nope' },
    { do: 'evaluate', script: 'never()' },
  ]);
  assert.deepEqual(
    missing.map((outcome) => [outcome.step, outcome.ok]),
    [
      [1, true],
      [2, false],
    ],
    'step 3 never runs'
  );
  assert.equal(missing[0].value, '2');
  assert.equal(missing[1].error, 'no element matches "#nope"');

  const reasons = async (step) => (await run([step]))[0].error;
  assert.equal(await reasons({ do: 'click', selector: '#go' }), 'button#go is disabled');
  assert.match(await reasons({ do: 'click', selector: 'p[' }), /^invalid CSS selector "p\["$/);
  assert.match(await reasons({ do: 'type', selector: '#box', text: 'x' }), /checkbox input, not a text field/);
  assert.equal(
    await reasons({ do: 'evaluate', script: '(() => { throw new Error("boom"); })()' }),
    'the script threw: boom'
  );
  assert.match(
    await reasons({ do: 'wait', selector: '.never', timeout: 150 }),
    /^no visible element matches "\.never" after \d+ ms$/
  );
  assert.match(await reasons({ do: 'wait', ms: 5000 }), /waiting 5000 ms would pass the act time limit/);

  const big = (await run([{ do: 'evaluate', script: '"x".repeat(5000)' }]))[0];
  assert.equal(big.value.length, 4000);
  assert.equal(big.detail, 'result cut to 4000 of 5002 characters');
  window.close();
});

test('a page call that never answers fails at the time limit', async () => {
  const steps = parseAct({ tab: 'v1', steps: [{ do: 'click', selector: 'a' }] }).steps;
  const [outcome] = await runActSteps(steps, () => new Promise(() => {}), { budgetMs: 50 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /the step did not finish within \d+ ms/);
  const [gone] = await runActSteps(steps, async () => {
    throw new Error('the page is no longer shown');
  });
  assert.equal(gone.error, 'the page could not run it: the page is no longer shown');
});

test('once the time limit has run out, no later step reaches the page', async () => {
  for (const next of [
    { do: 'click', selector: '#a' },
    { do: 'evaluate', script: '1' },
    { do: 'wait', selector: '#a' },
    { do: 'key', key: 'Enter' },
  ]) {
    let clock = 0;
    const sent = [];
    const exec = async (script) => {
      sent.push(script);
      clock += 200; // the first step uses up the whole limit
      return { ok: true, detail: 'done' };
    };
    const steps = parseAct({ tab: 'v1', steps: [{ do: 'click', selector: '#first' }, next] }).steps;
    const outcomes = await runActSteps(steps, exec, { budgetMs: 100, now: () => clock });
    assert.equal(sent.length, 1, `${next.do}: nothing is dispatched after the limit`);
    assert.equal(outcomes[1].ok, false);
    assert.match(outcomes[1].error, /the act time limit \(0\.1 s for all steps\) ran out/);
  }
});

test('a wait for a selector keeps to its own timeout', async () => {
  const steps = parseAct({ tab: 'v1', steps: [{ do: 'wait', selector: '.late', timeout: 1 }] }).steps;
  // A match that arrives after the step's deadline is refused.
  let clock = 0;
  const late = async () => {
    clock += 100;
    return { ok: true, found: true };
  };
  const [refused] = await runActSteps(steps, late, { now: () => clock });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'no visible element matches ".late" after 100 ms');
  // A look-up that never answers is given up at the step's timeout, not the whole limit.
  const started = Date.now();
  const [hung] = await runActSteps(steps, () => new Promise(() => {}), { budgetMs: 5000 });
  assert.ok(Date.now() - started < 1000, 'bounded by the 1 ms step timeout');
  assert.match(hung.error, /^no visible element matches "\.late" after \d+ ms$/);
});

test('a timed-out evaluate stops the run and says the script may still be running', async () => {
  const steps = parseAct({
    tab: 'v1',
    steps: [
      { do: 'evaluate', script: 'new Promise(() => {})' },
      { do: 'click', selector: '#a' },
    ],
  }).steps;
  const [outcome, ...rest] = await runActSteps(steps, () => new Promise(() => {}), { budgetMs: 30 });
  assert.equal(rest.length, 0);
  assert.equal(outcome.scriptRunning, true);
  assert.match(outcome.error, /did not finish within \d+ ms; it may still be changing the page/);
});

function service(overrides = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-act-')));
  mkdirSync(join(dir, 'site'));
  writeFileSync(join(dir, 'site', 'a.html'), '<button id="go">Go</button>');
  writeFileSync(join(dir, 'site', 'pic.png'), 'png');
  const calls = { act: [], offscreen: [], capture: 0 };
  const outcomes = [{ step: 1, label: 'click #go', ok: true, detail: 'clicked button#go' }];
  const visualize = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async (target) => `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    async act(_sessionId, tab, pane, steps) {
      calls.act.push({ tab: tab.id, pane, steps });
      return outcomes;
    },
    async actOffscreen(pane, allowNetwork, options) {
      calls.offscreen.push({ pane: pane.label, allowNetwork, ...options });
      return {
        outcomes: [
          ...outcomes,
          { step: 2, label: 'wait for .x', ok: false, error: 'no visible element matches ".x" after 5000 ms' },
        ],
        ...(options.capture ? { png: Buffer.from('HIDDEN') } : {}),
        problems: ['error: boom (line 3)'],
      };
    },
    async capture() {
      calls.capture += 1;
      return Buffer.from('SCREEN');
    },
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  });
  const run = (action, input) => visualize.execute({ sessionId: 's1', cwd: dir, action, input });
  const cleanup = () => {
    visualize.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, calls, run, cleanup };
}

test('act on a shown tab runs in its panel frame and captures the end state', async () => {
  const t = service();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    const result = await t.run('act', { tab: 'v1', output: 'out/end.png', steps: [{ do: 'click', selector: '#go' }] });
    assert.deepEqual(t.calls.act, [{ tab: 'v1', pane: 0, steps: [{ do: 'click', selector: '#go' }] }]);
    assert.equal(t.calls.offscreen.length, 0);
    assert.match(
      result.text,
      /^Ran all 1 steps on tab v1 \(input simulated in the page\):\n1\. click #go — ok: clicked button#go\nCaptured the final state to /
    );
    assert.equal(readFileSync(join(t.dir, 'out', 'end.png'), 'utf8'), 'SCREEN');
    assert.equal(result.path, join(t.dir, 'out', 'end.png'));
  } finally {
    t.cleanup();
  }
});

test('act on a verify tab runs off screen and reports the failing step and page problems', async () => {
  const t = service();
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    const result = await t.run('act', {
      tab: 'v1',
      output: 'end.png',
      steps: [
        { do: 'click', selector: '#go' },
        { do: 'wait', selector: '.x' },
        { do: 'evaluate', script: '1' },
      ],
    });
    assert.equal(t.calls.act.length, 0, 'a verify tab never runs in the panel');
    assert.equal(t.calls.offscreen.length, 1);
    assert.equal(t.calls.offscreen[0].capture, true);
    assert.equal(t.calls.capture, 0);
    assert.match(result.text, /^Ran 1 of 3 steps on tab v1, off screen in a freshly loaded page at 1280×900/);
    assert.match(
      result.text,
      /\n2\. wait for \.x — failed: no visible element matches "\.x" after 5000 ms\nStopped at step 2 of 3; step 3 did not run\./
    );
    assert.match(result.text, /\nPage problems while it ran:\n- error: boom \(line 3\)$/);
    assert.equal(readFileSync(join(t.dir, 'end.png'), 'utf8'), 'HIDDEN');
  } finally {
    t.cleanup();
  }
});

test('no final capture is taken after an evaluate timed out, on screen or off', async () => {
  const running = [{ step: 1, label: 'evaluate', ok: false, error: 'the script did not finish', scriptRunning: true }];
  const t = service({
    act: async () => running,
    actOffscreen: async () => ({ outcomes: running, png: Buffer.from('HIDDEN'), problems: [] }),
  });
  try {
    const steps = [{ do: 'evaluate', script: 'new Promise(() => {})' }];
    await t.run('open', { targets: ['site/a.html'] });
    const shown = await t.run('act', { tab: 'v1', output: 'shown.png', steps });
    writeFileSync(join(t.dir, 'site', 'b.html'), '<p>b</p>');
    await t.run('open', { targets: ['site/b.html'], verify: true });
    const hidden = await t.run('act', { tab: 'v2', output: 'hidden.png', steps });
    assert.equal(t.calls.capture, 0);
    for (const [result, name] of [
      [shown, 'shown.png'],
      [hidden, 'hidden.png'],
    ]) {
      assert.match(
        result.text,
        /No final capture written to .*: the timed-out script may still be changing the page\./
      );
      assert.equal(result.path, undefined);
      assert.equal(existsSync(join(t.dir, name)), false);
    }
  } finally {
    t.cleanup();
  }
});

test('act refuses tabs without an HTML page and outputs outside the project', async () => {
  const t = service();
  try {
    await t.run('open', { targets: ['site/pic.png'] });
    await t.run('open', { targets: ['site/a.html'] });
    const click = [{ do: 'click', selector: '#go' }];
    await assert.rejects(t.run('act', { tab: 'v1', steps: click }), /act works on HTML pages only; tab v1/);
    await assert.rejects(t.run('act', { tab: 'v2', pane: 2, steps: click }), /tab v2 has 1 pane, no pane 2/);
    await assert.rejects(
      t.run('act', { tab: 'v2', output: '../outside.png', steps: click }),
      /output is outside the working directory/
    );
    assert.equal(t.calls.act.length, 0);
  } finally {
    t.cleanup();
  }
});
