import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tokens = css('../desktop/01-tokens.css');
const skin = css('../desktop/33-skin.css');

/** (ids, classes + attributes + pseudo-classes, types) of a simple selector without :is/:not. */
function specificity(selector) {
  const attrs = (selector.match(/\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.replace(/\[[^\]]*\]|:[\w-]+/g, '').match(/[a-z]+/gi) ?? []).length;
  return [0, attrs, types];
}
const beats = (a, b) => a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]);

test('a skin accent fill outranks the light theme block (light skins used the built-in blue)', () => {
  const rule = /(:root\[data-mixdog-skin\]\[data-mixdog-theme\]) \{([^}]*)\}/.exec(skin);
  assert.ok(rule, 'skin accent rule');
  assert.match(rule[2], /--mx-accent-bg: var\(--mx-skin-accent\);/);
  assert.match(rule[2], /--mx-accent-fg: var\(--mx-skin-on-accent\);/);
  const light = ':root[data-mixdog-theme="light"]';
  assert.match(tokens.slice(tokens.indexOf(`${light} {`)), /--mx-accent-bg: #1967d2;/);
  assert.ok(beats(specificity(rule[1]), specificity(light)), `${rule[1]} beats ${light}`);
  // The old (0,1,1) declaration is gone, so nothing else claims the accent fill under a skin.
  const root = skin.slice(skin.indexOf('html[data-mixdog-skin] {'));
  assert.doesNotMatch(root.slice(0, root.indexOf('}')), /--mx-accent-bg/);
});

test('primary buttons on the accent fill use the accent-text token; unset it is the same white', () => {
  assert.match(tokens, /--mx-grey-50: #fff;/);
  assert.doesNotMatch(tokens, /^\s*--mx-accent-fg:/m, 'no default: consumers fall back to white');
  const island = css('../desktop/15-composer.css');
  const at = island.indexOf('.composer-island-button-primary,\n.composer-island-button-primary:hover {');
  assert.ok(at >= 0);
  assert.match(island.slice(at, island.indexOf('}', at)), /color: var\(--mx-accent-fg, var\(--mx-grey-50\)\);/);
  const approval = css('../desktop/15-approval-prompt.css');
  const primary = approval.indexOf('.approval-button[data-tone="primary"] {');
  assert.match(
    approval.slice(primary, approval.indexOf('}', primary)),
    /color: var\(--mx-accent-fg, var\(--mx-grey-50\)\);/
  );
  const kbd = approval.indexOf('.approval-button[data-tone="primary"] .approval-kbd {');
  assert.match(approval.slice(kbd, approval.indexOf('}', kbd)), /color: var\(--mx-accent-fg, var\(--mx-grey-50\)\);/);
});
