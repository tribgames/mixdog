import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { overlayHtml, overlayScript } from './content.ts';

function fixture(t, locale = 'ko') {
  const dom = new JSDOM(overlayHtml(locale), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  const presses = [];
  dom.window.mixdogComputerControl = async (request) => {
    const copy = JSON.parse(JSON.stringify(request));
    (copy.action === 'press' ? presses : calls).push(copy);
    return { accepted: true };
  };
  dom.window.eval(overlayScript(locale));
  const document = dom.window.document;
  return {
    window: dom.window,
    document,
    calls,
    presses,
    publish: dom.window.mixdogComputerOverlay,
    stop: document.getElementById('stop'),
    title: () => document.getElementById('title').textContent,
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a silent status mark follows the pause state the stylesheet rests it on', (t) => {
  const f = fixture(t);
  assert.equal(f.document.getElementById('mark').getAttribute('aria-hidden'), 'true');
  for (const [index, paused] of [false, true, false].entries()) {
    f.publish({ paused, generation: 1, renderRevision: index + 1 });
    assert.equal(f.document.body.dataset.paused, String(paused));
  }
});

test('Stop is in every state, an icon with a spoken name, never disabled; Resume joins it only while paused', async (t) => {
  for (const locale of ['ko', 'en']) {
    const f = fixture(t, locale);
    const label = locale === 'ko' ? '중단' : 'Stop';
    const states = [
      { title: 'Running', paused: false, resumable: false },
      { title: 'Paused', paused: true, resumable: true },
      { title: 'Check', paused: true, resumable: true, attention: true },
    ];
    for (const [index, state] of states.entries()) {
      f.publish({ ...state, generation: 7, renderRevision: index + 1 });
      assert.deepEqual(
        [...f.document.querySelectorAll('button')].filter((button) => !button.hidden).map((button) => button.id),
        state.resumable ? ['resume', 'stop'] : ['stop']
      );
      assert.equal(f.document.getElementById('resume').getAttribute('aria-label'), locale === 'ko' ? '재개' : 'Resume');
      assert.equal(f.stop.getAttribute('aria-label'), label);
      assert.equal(f.stop.textContent, '');
      assert.equal(f.stop.disabled, false);
      assert.equal(f.title(), state.title);
      assert.equal(f.document.body.dataset.error, String(state.attention === true));
    }
    assert.equal(f.stop.title, `${label} (Ctrl+Alt+Esc)`);
    f.stop.click();
    await settle();
    assert.deepEqual(f.calls, [{ action: 'stop', generation: 7 }]);
    f.publish({ title: 'stale', paused: false, generation: 6, renderRevision: 1 });
    assert.equal(f.title(), 'Check');
  }
});

test('a pause that starts while the user reaches for Stop never changes what Stop does', async (t) => {
  const f = fixture(t);
  f.publish({ paused: false, generation: 1, renderRevision: 1 });
  f.stop.dispatchEvent(new f.window.Event('pointerdown'));
  f.publish({ title: '일시정지', paused: true, generation: 2, renderRevision: 2 });
  f.stop.click();
  await settle();
  assert.deepEqual(f.calls, [{ action: 'stop', generation: 2 }]);
});

test('an undelivered Stop says so without private detail, stays pressable, and clears once the host moves on', async (t) => {
  const f = fixture(t);
  f.publish({ paused: false, generation: 1, renderRevision: 1 });
  f.window.mixdogComputerControl = async () => {
    throw new Error('private channel error');
  };
  f.stop.click();
  await settle();
  assert.equal(f.title(), '실패');
  assert.equal(f.document.body.dataset.error, 'true');
  assert.equal(f.document.body.textContent.includes('private'), false);
  assert.equal(f.stop.disabled, false);
  f.publish({ paused: false, generation: 2, renderRevision: 2 });
  assert.equal(f.title(), '컴퓨터 사용 중');
  assert.equal(f.document.body.dataset.error, 'false');
});

test('the page starts with, and falls back to, the working title in each language', (t) => {
  for (const [locale, working] of [
    ['ko', '컴퓨터 사용 중'],
    ['en', 'Computer in use'],
  ]) {
    const f = fixture(t, locale);
    assert.equal(f.title(), working);
    f.publish({ title: 'Other', paused: false, generation: 1, renderRevision: 1 });
    assert.equal(f.title(), 'Other');
    f.publish({ paused: false, generation: 1, renderRevision: 2 });
    assert.equal(f.title(), working);
  }
});

test('a rejected Stop remains visible even though Stop moves the generation', async (t) => {
  const f = fixture(t);
  f.window.mixdogComputerControl = async (request) => {
    assert.equal(request.action, 'stop');
    f.publish({ paused: true, generation: 4, renderRevision: 2 });
    return { accepted: true, error: 'cleanup' };
  };
  f.publish({ paused: false, generation: 3, renderRevision: 1 });
  f.stop.click();
  assert.equal(f.stop.getAttribute('aria-busy'), 'true');
  assert.equal(f.title(), '중단 중');
  await settle();
  assert.equal(f.title(), '실패');
  assert.equal(f.document.body.dataset.error, 'true');
  assert.equal(f.stop.getAttribute('aria-busy'), 'false');
  assert.equal(f.stop.disabled, false);
});

test('Resume sends the generation the user saw, and a refusal says so while the pill stays usable', async (t) => {
  const f = fixture(t);
  f.publish({ title: '일시정지', paused: true, resumable: true, generation: 5, renderRevision: 1 });
  const resume = f.document.getElementById('resume');
  resume.click();
  await settle();
  assert.deepEqual(f.calls, [{ action: 'resume', generation: 5 }]);
  f.window.mixdogComputerControl = async () => ({ accepted: true, error: 'failed' });
  resume.click();
  await settle();
  assert.equal(f.title(), '실패');
  assert.equal(resume.disabled, false);
  assert.equal(f.stop.disabled, false);
});

test('a pointer press on Stop is reported without sending a control request', async (t) => {
  const f = fixture(t);
  f.publish({ paused: true, generation: 1, renderRevision: 1 });
  f.stop.dispatchEvent(new f.window.Event('pointerdown'));
  await settle();
  assert.deepEqual(f.presses, [{ action: 'press', control: 'stop' }]);
  assert.deepEqual(f.calls, []);
});

test('the pill carries the desktop face inline, and its policy admits no other font source', () => {
  const html = overlayHtml('ko');
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'none'"/);
  const face =
    /@font-face\{font-family:"Mixdog Overlay";font-weight:500;[^}]*src:url\(data:font\/woff2;base64,([A-Za-z0-9+/]+=*)\)/.exec(
      html
    );
  assert.ok(face, 'the pill declares its own face');
  const shipped = createRequire(import.meta.url).resolve(
    'pretendard/dist/web/static/woff2-subset/Pretendard-Medium.subset.woff2'
  );
  assert.equal(face[1], readFileSync(shipped).toString('base64'));
  assert.match(html, /:root \{[^}]*font-family:"Mixdog Overlay"/);
});
