import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { overlayHtml, overlayScript } from './content.ts';

test('status text follows pause and cleanup while stale generations cannot replace it', () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only', url: 'https://fixture.invalid' });
  try {
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    publish({ title: '사용자 조작 중', detail: '입력을 정리하고 있습니다.', paused: true, canResume: false, generation: 7, renderRevision: 2 });
    const resume = dom.window.document.getElementById('toggle');
    assert.equal(dom.window.document.getElementById('title').textContent, '사용자 조작 중');
    assert.equal(dom.window.document.body.textContent.includes('입력을 정리하고 있습니다.'), false);
    assert.equal(dom.window.document.getElementById('stop').disabled, false);
    assert.equal(resume.getAttribute('aria-label'), '재개');
    assert.equal(resume.disabled, true);
    publish({ title: 'stale', paused: false, canResume: true, generation: 6, renderRevision: 1 });
    assert.equal(dom.window.document.getElementById('title').textContent, '사용자 조작 중');
    assert.equal(resume.disabled, true);
    publish({ title: '사용자 조작 중', paused: true, canResume: true, generation: 7, renderRevision: 3, busy: true });
    assert.equal(resume.disabled, false);
    assert.equal(resume.getAttribute('aria-label'), '일시중지');
    publish({ title: '사용자 조작 중', paused: true, canResume: true, generation: 7, renderRevision: 4 });
    assert.equal(resume.disabled, false);
    assert.equal(dom.window.document.getElementById('title').textContent, '사용자 조작 중');
  } finally { dom.window.close(); }
});

test('toggle retains its pointer-down generation and explains control failure', async () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    const calls = [];
    dom.window.mixdogComputerControl = async (request) => { calls.push(request); return { accepted: true }; };
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    const resume = dom.window.document.getElementById('toggle');
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
    assert.equal(dom.window.document.getElementById('status').textContent, '요청 실패');
    assert.equal(dom.window.document.body.dataset.error, 'true');
    assert.equal(resume.disabled, false);
  } finally { dom.window.close(); }
});

test('active toggle pauses rather than ending the task; pending resume remains cancellable', async () => {
  const dom = new JSDOM(overlayHtml('ko'), { runScripts: 'outside-only' });
  try {
    const calls = [];
    let finish;
    dom.window.mixdogComputerControl = (request) => {
      calls.push(request);
      if (request.action === 'resume') return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve({ accepted: true });
    };
    dom.window.eval(overlayScript('ko'));
    const publish = dom.window.mixdogComputerOverlay;
    const button = dom.window.document.getElementById('toggle');
    publish({ paused: false, canResume: false, generation: 0, renderRevision: 1 });
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls[0].action, 'pause');
    publish({ paused: true, canResume: true, generation: 1, renderRevision: 2 });
    button.click();
    assert.equal(button.getAttribute('aria-label'), '일시중지');
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((entry) => entry.action), ['pause', 'resume', 'pause']);
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(button.getAttribute('aria-label'), '재개');
    assert.equal(button.getAttribute('aria-busy'), 'false');
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
    dom.window.document.getElementById('toggle').click();
    publish({ title: '확인 필요', attention: true, paused: true, canResume: false, generation: 3, renderRevision: 2 });
    dom.window.document.getElementById('stop').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['resume', 'stop']);
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.document.body.dataset.error, 'true');
    assert.equal(dom.window.document.getElementById('toggle').disabled, true);
  } finally { dom.window.close(); }
});
