import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ruleBody = (css, selector) => {
  const escaped = selector.replace(/[.>*[\]()]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  assert.ok(match, `missing rule ${selector}`);
  return match[1];
};
const px = (body, prop) => {
  const match = body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*(\\d+)px`));
  assert.ok(match, `missing ${prop}`);
  return Number(match[1]);
};

test('a session entry cover draws the brand mark at the New Task watermark size', () => {
  const surface = ruleBody(read('./desktop/18-surface-states.css'), '.pane-surface-cover .window-loading-mark');
  const watermark = ruleBody(read('./desktop/12-transcript.css'), '.thread-welcome-task .welcome-logo');
  assert.equal(px(surface, 'width'), px(watermark, 'width'), 'entry mark matches the New Task logo width');
  assert.equal(px(surface, 'height'), px(watermark, 'height'), 'entry mark matches the New Task logo height');
  assert.ok(px(surface, 'width') > 40, 'the 40px boot-size mark no longer stands in for the pane cover');
});
