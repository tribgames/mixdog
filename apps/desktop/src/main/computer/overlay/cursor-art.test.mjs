import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cursorHtml, cursorScript } from './cursor-art.ts';

test('cursor renders no labels, and movement does not announce a click', () => {
  const dom = new JSDOM(cursorHtml(), { runScripts: 'outside-only' });
  try {
    dom.window.eval(cursorScript());
    dom.window.mixdogAgentCursor({ effect: 'move', badge: 'private session', context: 'Background' });
    assert.equal(dom.window.document.body.textContent.trim(), '');
    assert.equal(dom.window.document.getElementById('surface').className, 'visible move');
    dom.window.mixdogAgentCursor({ effect: 'click' });
    assert.equal(dom.window.document.getElementById('surface').className, 'visible click');
    dom.window.mixdogAgentCursor({ effect: 'move' });
    assert.equal(dom.window.document.getElementById('surface').className, 'visible move');
    const shown = (id) => dom.window.getComputedStyle(dom.window.document.getElementById(id)).display !== 'none';
    for (const mode of ['background', 'foreground']) {
      dom.window.mixdogAgentCursor({ mode, effect: 'move' });
      assert.equal(shown('arrow'), mode === 'background');
      assert.equal(shown('typing'), false);
      dom.window.mixdogAgentCursor({ mode, effect: 'type', text: 'private input' });
      assert.equal(shown('typing'), true);
      assert.equal(dom.window.document.body.textContent.trim(), '');
    }
  } finally {
    dom.window.close();
  }
});

test('ongoing input stays visible in both delivery modes until its lifecycle changes', async () => {
  const views = ['background', 'foreground'].map((mode) => {
    const dom = new JSDOM(cursorHtml(), { runScripts: 'outside-only' });
    dom.window.eval(cursorScript());
    dom.window.mixdogAgentCursor({ mode, effect: 'type' });
    return { dom, mode };
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (const { dom, mode } of views) {
      const surface = dom.window.document.getElementById('surface');
      const typing = dom.window.document.getElementById('typing');
      assert.ok(surface.classList.contains('visible'), `${mode} hid an ongoing input`);
      assert.notEqual(dom.window.getComputedStyle(typing).display, 'none');
      dom.window.mixdogAgentCursor({ mode, effect: 'move' });
      assert.equal(dom.window.getComputedStyle(typing).display, 'none');
    }
  } finally {
    for (const { dom } of views) dom.window.close();
  }
});
