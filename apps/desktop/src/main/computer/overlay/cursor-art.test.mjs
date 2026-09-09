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
  } finally { dom.window.close(); }
});
