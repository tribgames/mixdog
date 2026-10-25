import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import postcss from 'postcss';
import { cssSubjectBuckets, expandSubjectIs, specificity, splitTopLevel } from './css-subject-buckets.ts';

test('a bare :is() subject is spelled out per argument, each arm at the :is() specificity', () => {
  assert.deepEqual(expandSubjectIs('html[data-mixdog-mobile-tabs] :is(.a, .b.c):hover::after'), [
    'html[data-mixdog-mobile-tabs] .a:not(.mx:where(:not(.mx))):hover::after',
    'html[data-mixdog-mobile-tabs] .b.c:hover::after',
  ]);
  assert.deepEqual(expandSubjectIs(':is(button, input[type="checkbox"], [role="tab"])'), [
    'button:not(.mx:where(:not(.mx)))',
    'input[type="checkbox"]',
    '[role="tab"]:not(mx:where(:not(mx)))',
  ]);
});

test('arguments with combinators are spelled out only where that is exact', () => {
  // Under the root prefix: their top compound can never be <html>.
  assert.deepEqual(expandSubjectIs('html[x] :is(.a > .b, .c)'), [
    'html[x] .a > .b',
    'html[x] .c:not(.mx:where(:not(.mx)))',
  ]);
  // An attribute-only top compound could be <html> itself: kept in an :is().
  assert.deepEqual(expandSubjectIs('html[x] :is([data-y] .b, .c)'), [
    'html[x] .c:not(.mx:where(:not(.mx)))',
    'html[x] :is([data-y] .b)',
  ]);
  // Under any other prefix the ancestor in the argument may sit above it.
  assert.deepEqual(expandSubjectIs('.m :is(h1 strong, em)'), ['.m em:not(mx:where(:not(mx)))', '.m :is(h1 strong)']);
  // With no prefix the :is() is the whole selector.
  assert.deepEqual(expandSubjectIs(':is(.a .b, .c)'), ['.a .b', '.c:not(.mx:where(:not(.mx)))']);
});

test('subjects already keyed, single arguments and unpaddable lists are left alone', () => {
  assert.equal(expandSubjectIs('.x:is(.a, .b)'), null);
  assert.equal(expandSubjectIs('html :is(.a)'), null);
  assert.equal(expandSubjectIs(':is(.a, .b) .c'), null);
  // (0,1,0) vs (0,0,2): the type count cannot be padded down.
  assert.equal(expandSubjectIs(':is(.a, div span)'), null);
});

const sheets = [new URL('../src/renderer/desktop/', import.meta.url), new URL('../src/renderer/', import.meta.url)];

test('every rewritten arm of the app stylesheets keeps its selector specificity and rule order', () => {
  let rewritten = 0;
  for (const directory of sheets) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(new URL(file, directory), 'utf8');
      const before = [];
      postcss.parse(css).walkRules((rule) => before.push(rule.selector));
      const after = [];
      postcss([cssSubjectBuckets()])
        .process(css, { from: undefined })
        .root.walkRules((rule) => after.push(rule.selector));
      assert.equal(after.length, before.length, file);
      after.forEach((selector, index) => {
        if (selector === before[index]) return;
        rewritten += 1;
        for (const original of splitTopLevel(before[index])) {
          const arms = expandSubjectIs(original) ?? [original];
          for (const arm of arms) {
            assert.deepEqual(specificity(arm), specificity(original), `${file}: ${arm}`);
            assert.ok(splitTopLevel(selector).includes(arm), `${file}: ${arm}`);
          }
        }
      });
    }
  }
  assert.ok(rewritten > 50, `${rewritten} rules rewritten`);
});

/** Deterministic PRNG (mulberry32): the same adversarial trees every run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tree built from the selector's own names, plus elements carrying every
 *  name the padding uses (and the reserved names of earlier versions). */
function adversarialTree(window, selector, seed) {
  const { document } = window;
  const pick = random(seed);
  const unique = (values) => [...new Set(values)];
  const classes = unique([...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]).concat('mx', 'mx-spec-pad'));
  const ids = unique([...selector.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]).concat('mx', 'mx-spec-pad'));
  const attributes = unique(
    [...selector.matchAll(/\[([\w-]+)(?:[~|^$*]?=\s*["']?([^"'\]]*)["']?)?\]/g)].map(
      (m) => `${m[1]}\u0001${m[2] ?? ''}`
    )
  );
  const tags = unique(
    [...selector.matchAll(/(?:^|[\s>+~(,])([a-zA-Z][\w-]*)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((tag) => !['is', 'not', 'where', 'has', 'html'].includes(tag))
      .concat('div', 'span', 'button', 'mx', 'mx-spec-pad')
  );
  const html = document.documentElement;
  for (const attribute of attributes) {
    const [name, value] = attribute.split('\u0001');
    if (pick() < 0.7) html.setAttribute(name, value);
  }
  document.body.replaceChildren();
  const decorate = (element) => {
    for (const name of classes) if (pick() < 0.3) element.classList.add(name);
    if (pick() < 0.15) element.id = ids[Math.floor(pick() * ids.length)];
    for (const attribute of attributes) {
      const [name, value] = attribute.split('\u0001');
      if (pick() < 0.25) element.setAttribute(name, value);
    }
  };
  const grow = (parent, depth) => {
    const count = depth === 0 ? 6 : 1 + Math.floor(pick() * 3);
    for (let index = 0; index < count; index += 1) {
      const child = document.createElement(tags[Math.floor(pick() * tags.length)]);
      decorate(child);
      parent.append(child);
      if (depth < 4) grow(child, depth + 1);
    }
  };
  grow(document.body, 0);
  // Every padding name on one element, as id, class and tag at once.
  for (const name of ['mx', 'mx-spec-pad']) {
    const element = document.createElement(name);
    element.id = name;
    element.className = 'mx mx-spec-pad';
    document.body.append(element);
  }
  return [html, document.body, ...document.body.querySelectorAll('*')];
}

/** Pseudo-elements and user-action states do not change which element the
 *  selector picks, and the DOM under test cannot have them. */
const matchable = (selector) =>
  splitTopLevel(selector)
    .map((part) =>
      part.replace(
        /::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|-webkit-[\w-]+)\b/gi,
        ''
      )
    )
    .join(', ');

test('every rewritten rule of the app stylesheets matches exactly the elements it matched before', async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><head></head><body></body></html>').window;
  let rules = 0;
  let positives = 0;
  for (const directory of sheets) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(new URL(file, directory), 'utf8');
      const before = [];
      postcss.parse(css).walkRules((rule) => before.push(rule.selector));
      const after = [];
      postcss([cssSubjectBuckets()])
        .process(css, { from: undefined })
        .root.walkRules((rule) => after.push(rule.selector));
      after.forEach((selector, index) => {
        if (selector === before[index]) return;
        const original = matchable(before[index]);
        const rewritten = matchable(selector);
        rules += 1;
        for (let seed = 1; seed <= 6; seed += 1) {
          for (const attribute of [...window.document.documentElement.attributes]) {
            window.document.documentElement.removeAttribute(attribute.name);
          }
          for (const element of adversarialTree(window, before[index], seed * 7919 + index)) {
            const was = element.matches(original);
            if (was) positives += 1;
            assert.equal(element.matches(rewritten), was, `${file}: ${before[index]}\n -> ${selector}`);
          }
        }
      });
    }
  }
  window.close();
  assert.ok(rules > 50, `${rules} rules compared`);
  // The trees really exercise the rules: a comparison of misses only proves nothing.
  assert.ok(positives > rules, `${positives} matching elements over ${rules} rules`);
});

test('the specificity padding matches every element, whatever names it carries', async () => {
  const { JSDOM } = await import('jsdom');
  const { document } = new JSDOM(
    '<!doctype html><html><body><mx id="mx" class="mx mx-spec-pad"></mx><mx-spec-pad id="mx-spec-pad" class="mx"></mx-spec-pad><button class="mx-spec-pad"></button><p></p></body></html>'
  ).window;
  const elements = [...document.body.children];
  // Padding of each kind of weight: class (#a), id (.d), type (em).
  const lists = { ':is(#a, #b.c, .d)': ['#a', '#b.c', '.d'], ':is(em, p em)': ['em', 'p em'] };
  let pads = 0;
  for (const [list, args] of Object.entries(lists)) {
    const arms = expandSubjectIs(list);
    assert.ok(arms, list);
    arms.forEach((arm, index) => {
      const pad = arm.slice(args[index].length);
      if (!pad) return;
      pads += 1;
      for (const element of elements) assert.ok(element.matches(`*${pad}`), `${arm} on ${element.outerHTML}`);
    });
  }
  assert.ok(pads >= 3);
  // The case that failed review: a button carrying the old reserved class.
  const arms = expandSubjectIs(':is(button, input[type="checkbox"], [role="tab"])');
  assert.ok(document.querySelector('button').matches(arms.find((arm) => arm.startsWith('button'))));
});
