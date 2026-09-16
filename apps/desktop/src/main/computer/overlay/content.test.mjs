import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { overlayHtml, overlayScript } from './content.ts';

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
  } finally { dom.window.close(); }
});

test('only Stop shows while running; Resume and the detail line appear with user control', () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only', url: 'https://fixture.invalid' });
  try {
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    const { document } = dom.window;
    const resume = document.getElementById('resume');
    const detail = document.getElementById('detail');
    publish({ title: 'Mixdog 사용 중', detail: '', paused: false, canResume: false, generation: 6, renderRevision: 1 });
    assert.equal(resume.hidden, true);
    assert.equal(detail.hidden, true);
    assert.equal(document.getElementById('stop').disabled, false);
    publish({ title: '확인 필요', detail: '입력 정리를 확인하지 못했습니다.', attention: true, paused: true, canResume: false, generation: 7, renderRevision: 2 });
    assert.equal(document.getElementById('title').textContent, '확인 필요');
    assert.equal(detail.hidden, false);
    assert.equal(detail.textContent, '입력 정리를 확인하지 못했습니다.');
    assert.equal(document.body.dataset.error, 'true');
    assert.equal(resume.hidden, false);
    assert.equal(resume.disabled, true);
    publish({ title: 'stale', paused: false, canResume: true, generation: 6, renderRevision: 1 });
    assert.equal(document.getElementById('title').textContent, '확인 필요');
    assert.equal(resume.disabled, true);
    publish({ title: '사용자 조작 중', detail: '재개하면 새 화면을 확인하고 이어갑니다.', paused: true, canResume: true, generation: 7, renderRevision: 3 });
    assert.equal(resume.disabled, false);
    assert.equal(document.body.dataset.error, 'false');
    publish({ title: '사용자 조작 중', paused: true, canResume: true, generation: 7, renderRevision: 4, busy: true });
    assert.equal(resume.disabled, true);
    assert.equal(document.getElementById('stop').getAttribute('aria-busy'), 'true');
  } finally { dom.window.close(); }
});

test('Resume retains its pointer-down generation and a failed request says so on the pill', async () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    const calls = [];
    dom.window.mixdogComputerControl = async (request) => { calls.push(request); return { accepted: true }; };
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    const resume = dom.window.document.getElementById('resume');
    publish({ paused: true, canResume: true, generation: 8, renderRevision: 1 });
    resume.dispatchEvent(new dom.window.Event('pointerdown'));
    publish({ paused: true, canResume: true, generation: 9, renderRevision: 2 });
    resume.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ action: 'resume', generation: 8 }]);
    dom.window.mixdogComputerControl = async () => { throw new Error('channel unavailable'); };
    resume.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.document.getElementById('title').textContent, '요청 실패');
    assert.equal(dom.window.document.getElementById('detail').textContent, '요청을 완료하지 못했습니다. 다시 눌러 주세요.');
    assert.equal(dom.window.document.body.dataset.error, 'true');
    assert.equal(resume.disabled, false);
  } finally { dom.window.close(); }
});

test('a rejected Stop is reported even though Stop itself moves the generation', async () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    const publish = () => {};
    dom.window.mixdogComputerControl = async (request) => {
      assert.equal(request.action, 'stop');
      dom.window.mixdogComputerOverlay({ title: '중지 중', paused: true, canResume: false, generation: 4, renderRevision: 2 });
      return { accepted: true, error: 'cleanup' };
    };
    dom.window.eval(overlayScript('ko'));
    publish();
    dom.window.mixdogComputerOverlay({ paused: false, canResume: false, generation: 3, renderRevision: 1 });
    const stop = dom.window.document.getElementById('stop');
    stop.click();
    assert.equal(stop.getAttribute('aria-busy'), 'true');
    assert.equal(dom.window.document.getElementById('title').textContent, '중지 중');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.document.getElementById('title').textContent, '요청 실패');
    assert.equal(dom.window.document.body.dataset.error, 'true');
    assert.equal(stop.getAttribute('aria-busy'), 'false');
    assert.equal(stop.disabled, false);
  } finally { dom.window.close(); }
});

test('the Stop button remains usable during pending resume and cleanup failure', async () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    const calls = [];
    let finish;
    dom.window.mixdogComputerControl = (request) => {
      calls.push(request.action);
      return request.action === 'resume'
        ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ accepted: true });
    };
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    publish({ paused: true, canResume: true, generation: 2, renderRevision: 1 });
    dom.window.document.getElementById('resume').click();
    publish({ title: '확인 필요', attention: true, paused: true, canResume: false, generation: 3, renderRevision: 2 });
    dom.window.document.getElementById('stop').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['resume', 'stop']);
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.document.body.dataset.error, 'true');
    assert.equal(dom.window.document.getElementById('resume').disabled, true);
  } finally { dom.window.close(); }
});
