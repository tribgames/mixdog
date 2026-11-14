// The page-world sources the Rust browser engine includes with include_str!
// (native/core/crates/mixdog-browser-engine/assets/page/) are copies of the
// strings the TypeScript modules export. This test keeps the two from drifting:
// each asset, with its placeholders filled in, is the exact text of the
// TypeScript export. stable-rect.ts stays in TypeScript for the host
// snapshot-scripts, so its asset stays guarded after the TypeScript runner goes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { BROWSER_BOUND_DROP_GUARD_INSTALL, BROWSER_BOUND_DROP_GUARD_TAKE, BROWSER_DROP_GUARD_AIM, BROWSER_DROP_GUARD_INSTALL, BROWSER_DROP_GUARD_TAKE } from './file-drop.ts';
import { BROWSER_DOCUMENT_ROOTS } from './documents.ts';
import { BROWSER_EDITABILITY_CHECK } from './editability.ts';
import { BROWSER_FRAME_HAS_TRANSFORM } from './frame-transform.ts';
import { PAYMENT_EVIDENCE_EXPRESSION, PAYMENT_PROCESSOR_FRAME_HOSTS } from './payment-evidence.ts';
import { BROWSER_REF_RECT, browserRefRectExpression } from './ref-rect.ts';
import { browserScrollTextApplyExpression, browserScrollTextMatchExpression } from './scroll-text.ts';
import { BROWSER_STABLE_RECT } from './stable-rect.ts';
import { browserVisualLocatorExpression } from './visual-locator.ts';

const ASSETS = new URL('../../../../../native/core/crates/mixdog-browser-engine/assets/page/', import.meta.url);

const asset = (name) => fs.readFileSync(new URL(name, ASSETS), 'utf8');

/** A file holding several sources starts each with a `//@@ <export name>` line. */
function sections(name) {
  const parts = asset(name).split(/^\/\/@@ (\S+)\n/m);
  assert.equal(parts[0], '', `${name} starts with a section marker`);
  const result = {};
  for (let index = 1; index < parts.length; index += 2) result[parts[index]] = parts[index + 1].replace(/\n$/, '');
  return result;
}

function fill(text, values) {
  let result = text;
  for (const [placeholder, value] of Object.entries(values)) {
    assert.ok(result.includes(placeholder), `placeholder ${placeholder} is used`);
    result = result.split(placeholder).join(value);
  }
  assert.equal(/__MIXDOG_[A-Z_]+__/.test(result), false, 'no placeholder is left unfilled');
  return result;
}

// ref-point-probe.ts keeps its source private: read it out of the file.
function refPointProbeSource() {
  const text = fs.readFileSync(new URL('./ref-point-probe.ts', import.meta.url), 'utf8');
  const match = text.match(/const REF_POINT_PROBE = `([\s\S]*?)`;\n\nasync function/);
  assert.ok(match, 'REF_POINT_PROBE is found');
  return new Function('BROWSER_STABLE_RECT', 'BROWSER_FRAME_HAS_TRANSFORM', `return \`${match[1]}\``)(
    BROWSER_STABLE_RECT,
    BROWSER_FRAME_HAS_TRANSFORM
  );
}

test('editability, stable-rect, frame-transform and document-roots assets equal the TypeScript sources', () => {
  assert.equal(asset('editability.js'), BROWSER_EDITABILITY_CHECK);
  assert.equal(asset('stable-rect.js'), BROWSER_STABLE_RECT);
  assert.equal(asset('frame-transform.js'), BROWSER_FRAME_HAS_TRANSFORM);
  assert.equal(asset('document-roots.js'), BROWSER_DOCUMENT_ROOTS);
});

test('file-drop asset equals every drop guard source', () => {
  assert.deepEqual(sections('file-drop.js'), {
    BROWSER_DROP_GUARD_INSTALL,
    BROWSER_BOUND_DROP_GUARD_INSTALL,
    BROWSER_DROP_GUARD_AIM,
    BROWSER_BOUND_DROP_GUARD_TAKE,
    BROWSER_DROP_GUARD_TAKE,
  });
});

test('ref-rect asset equals the rect function and the ref expression', () => {
  const parts = sections('ref-rect.js');
  assert.equal(fill(parts.BROWSER_REF_RECT, { __MIXDOG_STABLE_RECT__: BROWSER_STABLE_RECT }), BROWSER_REF_RECT);
  assert.equal(
    fill(parts.browserRefRectExpression, {
      __MIXDOG_REF_RECT__: BROWSER_REF_RECT,
      __MIXDOG_REF__: JSON.stringify('e12'),
    }),
    browserRefRectExpression('e12')
  );
});

test('scroll-text asset equals the match and apply expressions', () => {
  const parts = sections('scroll-text.js');
  for (const wanted of ['Hello World', 'quote " and \ slash']) {
    assert.equal(
      fill(parts.browserScrollTextMatchExpression, {
        __MIXDOG_DOCUMENT_ROOTS__: BROWSER_DOCUMENT_ROOTS,
        __MIXDOG_WANTED__: JSON.stringify(wanted.toLowerCase()),
      }),
      browserScrollTextMatchExpression(wanted)
    );
  }
  assert.equal(
    fill(parts.browserScrollTextApplyExpression, { __MIXDOG_TOKEN__: JSON.stringify('t:1') }),
    browserScrollTextApplyExpression('t:1')
  );
});

test('visual-locator asset equals the expression for every query and maximum', () => {
  const text = asset('visual-locator.js');
  for (const [query, maximum] of [['Red Button', 20], ['  파란 버튼 ', 3], ['', 500], ['x', 0]]) {
    const clamped = Math.min(50, Math.max(1, Math.trunc(maximum)));
    assert.equal(
      fill(text, {
        __MIXDOG_QUERY__: JSON.stringify(query.trim().toLowerCase()),
        __MIXDOG_MAXIMUM__: String(clamped),
      }),
      browserVisualLocatorExpression(query, maximum)
    );
  }
});

test('payment-evidence asset equals the expression with the processor host list', () => {
  assert.equal(
    fill(asset('payment-evidence.js'), { __MIXDOG_HOSTS__: JSON.stringify(PAYMENT_PROCESSOR_FRAME_HOSTS) }),
    PAYMENT_EVIDENCE_EXPRESSION
  );
});

test('ref-point-probe asset equals the probe function of ref-point-probe.ts', () => {
  assert.equal(
    fill(asset('ref-point-probe.js'), {
      __MIXDOG_STABLE_RECT__: BROWSER_STABLE_RECT,
      __MIXDOG_FRAME_HAS_TRANSFORM__: BROWSER_FRAME_HAS_TRANSFORM,
    }),
    refPointProbeSource()
  );
});

test('every asset parses as page JavaScript once its placeholders are filled', () => {
  const filled = (text) => text.replace(/__MIXDOG_[A-Z_]+__/g, '(function() {})');
  const files = fs.readdirSync(ASSETS).filter((name) => name.endsWith('.js'));
  assert.equal(files.length, 18);
  for (const name of files) {
    const bodies = asset(name).includes('//@@ ') ? Object.values(sections(name)) : [asset(name)];
    for (const body of bodies) {
      assert.doesNotThrow(() => new vm.Script(`(async () => (${filled(body)}))`), `${name} parses`);
    }
  }
});
