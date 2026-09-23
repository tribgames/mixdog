import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { overlayHtml, overlayScript } from './content.ts';

function fixture(t, locale = 'ko') {
  const dom = new JSDOM(overlayHtml(locale), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.mixdogComputerControl = async (request) => {
    calls.push(JSON.parse(JSON.stringify(request)));
    return { accepted: true };
  };
  dom.window.eval(overlayScript(locale));
  return {
    window: dom.window,
    document: dom.window.document,
    calls,
    publish: dom.window.mixdogComputerOverlay,
    button: dom.window.document.querySelector('button'),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('outline glow disappears while paused and returns on resume without hiding the track', () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    const highlight = dom.window.document.querySelector('#outline .highlight');
    const track = dom.window.document.querySelector('#outline .track');
    for (const [index, paused] of [false, true, false].entries()) {
      publish({ paused, generation: 1, renderRevision: index + 1 });
      assert.equal(dom.window.getComputedStyle(highlight).display === 'none', paused);
      assert.notEqual(dom.window.getComputedStyle(track).display, 'none');
    }
  } finally {
    dom.window.close();
  }
});

test('one toggle changes between Pause and Resume; both controls stay live in every state', async (t) => {
  for (const locale of ['ko', 'en']) {
    const f = fixture(t, locale);
    const stop = f.document.getElementById('stop');
    const liveControls = () =>
      [...f.document.querySelectorAll('button')].filter((button) => !button.hidden && !button.disabled).length;
    f.publish({ title: 'Running', paused: false, canResume: false, generation: 6, renderRevision: 1 });
    assert.equal(liveControls(), 2);
    assert.equal(f.button.getAttribute('aria-label'), locale === 'ko' ? '중단' : 'Pause');
    const pauseIcon = f.button.querySelector('path').getAttribute('d');
    f.publish({ title: 'Check', attention: true, paused: true, canResume: false, generation: 7, renderRevision: 2 });
    assert.equal(f.button.getAttribute('aria-label'), locale === 'ko' ? '재개' : 'Resume');
    assert.notEqual(f.button.querySelector('path').getAttribute('d'), pauseIcon);
    assert.match(f.button.title, /Ctrl\+Alt\+Esc/);
    assert.equal(f.document.body.dataset.error, 'true');
    // A latched check state takes neither control away: the toggle still
    // delivers its press and Stop is always one click away.
    assert.equal(liveControls(), 2);
    f.button.click();
    await settle();
    stop.click();
    await settle();
    assert.deepEqual(f.calls, [
      { action: 'resume', generation: 7 },
      { action: 'stop', generation: 7 },
    ]);
    f.publish({ title: 'stale', paused: false, generation: 6, renderRevision: 1 });
    assert.equal(f.document.getElementById('title').textContent, 'Check');
    f.publish({ paused: true, canResume: true, generation: 7, renderRevision: 3 });
    assert.equal(f.document.body.dataset.error, 'false');
    assert.equal(liveControls(), 2);
  }
});

test('the same button pauses and resumes without sending task cancellation or dismissal', async (t) => {
  const f = fixture(t);
  f.publish({ paused: false, generation: 1, renderRevision: 1 });
  f.button.click();
  f.button.click();
  await settle();
  f.publish({ paused: true, canResume: true, generation: 2, renderRevision: 2 });
  f.button.click();
  await settle();
  // The toggle never swallows a press: a repeated Pause reaches the host,
  // which owns the duplicate, and it never becomes a cancellation.
  assert.deepEqual(f.calls, [
    { action: 'pause', generation: 1 },
    { action: 'pause', generation: 1 },
    { action: 'resume', generation: 2 },
  ]);
});

test('a takeover between pointer down and up cannot turn a Pause click into Resume', async (t) => {
  const f = fixture(t);
  f.publish({ paused: false, generation: 8, renderRevision: 1 });
  f.button.dispatchEvent(new f.window.Event('pointerdown'));
  f.publish({ paused: true, canResume: false, generation: 9, renderRevision: 2 });
  assert.equal(f.button.getAttribute('aria-label'), '중단');
  assert.equal(f.button.disabled, false);
  f.button.click();
  await settle();
  assert.deepEqual(f.calls, [{ action: 'pause', generation: 8 }]);
  assert.equal(f.button.getAttribute('aria-label'), '재개');
  assert.equal(f.button.disabled, false);
});

test('Resume retains the generation from pointer or keyboard activation and reports delivery failure', async (t) => {
  for (const input of ['pointerdown', 'keydown']) {
    const f = fixture(t);
    f.publish({ paused: true, canResume: true, generation: 8, renderRevision: 1 });
    f.button.dispatchEvent(
      input === 'pointerdown' ? new f.window.Event(input) : new f.window.KeyboardEvent(input, { key: 'Enter' })
    );
    f.publish({ paused: true, canResume: true, generation: 9, renderRevision: 2 });
    f.button.click();
    await settle();
    assert.deepEqual(f.calls, [{ action: 'resume', generation: 8 }]);
    f.window.mixdogComputerControl = async () => {
      throw new Error('private channel error');
    };
    f.button.click();
    await settle();
    assert.equal(f.document.getElementById('title').textContent, '실패');
    assert.equal(f.document.body.textContent.includes('private'), false);
    assert.equal(f.button.disabled, false);
  }
});

test('a rejected Pause remains visible even though Pause moves the generation', async (t) => {
  const f = fixture(t);
  f.window.mixdogComputerControl = async (request) => {
    assert.equal(request.action, 'pause');
    f.publish({ paused: true, canResume: false, generation: 4, renderRevision: 2 });
    return { accepted: true, error: 'cleanup' };
  };
  f.publish({ paused: false, generation: 3, renderRevision: 1 });
  f.button.click();
  assert.equal(f.button.getAttribute('aria-busy'), 'true');
  assert.equal(f.document.getElementById('title').textContent, '중단 중');
  await settle();
  assert.equal(f.document.getElementById('title').textContent, '실패');
  assert.equal(f.document.body.dataset.error, 'true');
  assert.equal(f.button.getAttribute('aria-busy'), 'false');
  assert.equal(f.button.disabled, false);
});

test('pending Resume can be interrupted using the same button without cancelling the task', async (t) => {
  const f = fixture(t);
  const calls = [];
  let finishResume;
  f.window.mixdogComputerControl = (request) => {
    calls.push(request.action);
    return request.action === 'resume'
      ? new Promise((resolve) => {
          finishResume = resolve;
        })
      : Promise.resolve({ accepted: true });
  };
  f.publish({ paused: true, canResume: true, generation: 2, renderRevision: 1 });
  f.button.click();
  f.publish({ paused: true, canResume: true, busy: true, generation: 2, renderRevision: 2 });
  assert.equal(f.button.getAttribute('aria-label'), '중단');
  assert.equal(f.button.disabled, false);
  f.button.click();
  f.publish({ title: '확인 필요', attention: true, paused: true, canResume: false, generation: 3, renderRevision: 3 });
  await settle();
  finishResume({ accepted: true });
  await settle();
  assert.deepEqual(calls, ['resume', 'pause']);
  assert.equal(f.button.getAttribute('aria-label'), '재개');
  assert.equal(f.button.disabled, false);
  assert.equal(f.document.body.dataset.error, 'true');
});

test('a cancelled pointer gesture releases its old toggle intent without sending input', (t) => {
  const f = fixture(t);
  f.publish({ paused: false, generation: 1, renderRevision: 1 });
  f.button.dispatchEvent(new f.window.Event('pointerdown'));
  f.publish({ paused: true, canResume: true, generation: 2, renderRevision: 2 });
  f.button.dispatchEvent(new f.window.Event('pointercancel'));
  assert.equal(f.button.getAttribute('aria-label'), '재개');
  assert.deepEqual(f.calls, []);
});

test('a press dropped while another control runs is not a failure and leaves the control pressable', async (t) => {
  const f = fixture(t);
  f.window.mixdogComputerControl = async () => ({ accepted: false, busy: true, error: 'busy' });
  f.publish({ paused: true, canResume: true, generation: 4, renderRevision: 1 });
  assert.equal(f.button.disabled, false);
  f.button.click();
  await settle();
  // The host owns the running request; the drop is neither an error the user
  // must read nor a reason to take the button away.
  assert.equal(f.document.body.dataset.error, 'false');
  assert.equal(f.button.getAttribute('aria-busy'), 'false');
  assert.equal(f.button.disabled, false);
  f.publish({ paused: true, canResume: true, generation: 4, renderRevision: 2 });
  assert.equal(f.button.disabled, false);
});
