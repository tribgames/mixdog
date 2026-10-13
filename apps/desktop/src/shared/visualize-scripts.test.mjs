import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { htmlRunsScripts, remotePageGate, withoutMetaRefresh } from './visualize-scripts.ts';

// The renderer's parser; the gate runs where DOMParser exists.
globalThis.DOMParser = new JSDOM('').window.DOMParser;

test('pages that can run script are detected, inert markup is not', () => {
  const runs = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC="app.js"></SCRIPT>',
    '<script type="module">import "./a.js"</script>',
    '<script data-type="application/json">alert(1)</script>',
    '<script type="application/json">{}</script>',
    '<iframe src="x.html"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x.svg">',
    '<script\n  defer src=x.js></script>',
    '<button onclick="go()">go</button>',
    '<svg/onload=alert(1)></svg>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="  JaVa\tScRiPt:alert(1)">x</a>',
    '<a href="java&#115;cript&colon;alert(1)">x</a>',
    '<a href="&#x6A;avascript:alert(1)">x</a>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    "<meta content='5' http-equiv=Refresh>",
  ];
  for (const html of runs) assert.equal(htmlRunsScripts(html), true, html);

  const inert = [
    '<h1>Dashboard</h1><p>Static mockup</p>',
    '<style>.a:hover{color:red}</style><a href="#top">top</a>',
    '<input value="one" disabled><p>Don’t click</p>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width">',
  ];
  for (const html of inert) assert.equal(htmlRunsScripts(html), false, html);
});

test('meta refresh redirects are removed from a page shown without script', () => {
  const metas = (html) => [...new JSDOM(withoutMetaRefresh(html)).window.document.querySelectorAll('meta')];
  const clean = withoutMetaRefresh('<head><meta http-equiv="refresh" content="0;url=https://evil.example/"><title>t</title></head>');
  assert.match(clean, /<title>t<\/title>/);
  assert.doesNotMatch(clean, /meta|evil/i);
  assert.equal(metas('<meta charset="utf-8"><p>x</p>').length, 1, 'other metas stay');
  for (const html of [
    // a quoted `>` before http-equiv defeated the old tag regex
    '<meta content="0;url=https://example.org/?value=>" http-equiv="refresh"><p>a</p>',
    '<meta http-equiv="&#114;efresh" content="0;url=//x.example"><p>a</p>',
    '<META HTTP-EQUIV=Refresh CONTENT="0;url=//x.example"><p>a</p>',
    '<meta\nhttp-equiv\n=\n"refresh"\ncontent="0;url=//x.example">',
    '<meta http-equiv=refresh content=0;url=//x.example/>',
    '<head><meta content=\'a>b\' HTTP-equiv=\'refresh\'></head>',
  ]) {
    const out = withoutMetaRefresh(html);
    assert.equal(metas(html).length, 0, html);
    assert.doesNotMatch(out, /x\.example|example\.org/i, html);
  }
  // Without a parser nothing of the page is passed on.
  const saved = globalThis.DOMParser;
  globalThis.DOMParser = undefined;
  assert.equal(withoutMetaRefresh('<p>a</p>'), '');
  globalThis.DOMParser = saved;
});

test('a remote page never runs scripts before the Run tap, whatever detection finds', () => {
  // Detection misses nothing here, but the gate must not depend on it.
  for (const html of [
    '<script data-type="application/json">window.ran = true</script>',
    '<p>plain</p>',
    '<svg><a href="x"><text>hi</text></a></svg>',
  ]) {
    const before = remotePageGate(html, false);
    assert.equal(before.runScripts, false, html);
  }
  assert.equal(remotePageGate('<script data-type="application/json">1</script>', false).prompt, 'scripts');
  assert.equal(remotePageGate('<p>plain</p>', false).prompt, null, 'no prompt, still no scripts');
  assert.doesNotMatch(remotePageGate('<meta http-equiv=refresh content="0;url=//x"><p>a</p>', false).srcdoc, /meta|\/\/x/);
  const after = remotePageGate('<script>1</script>', true);
  assert.deepEqual(after, { runScripts: true, prompt: null, srcdoc: '<script>1</script>' });
});

test('the Run bar also appears for data-choice pages and when Comment mode is on', () => {
  // (a) picks need the page's feedback script, though the page has no script of its own.
  const choices = '<button data-choice="a">A</button><button data-choice="b">B</button>';
  const picks = remotePageGate(choices, false);
  assert.equal(picks.prompt, 'scripts');
  assert.equal(picks.runScripts, false, 'the gate itself is unchanged: nothing runs yet');
  // (b) commenting on a page that is not running yet explains why it must run.
  const plain = '<h1>Static</h1>';
  assert.equal(remotePageGate(plain, false, false).prompt, null);
  const commenting = remotePageGate(plain, false, true);
  assert.deepEqual([commenting.prompt, commenting.runScripts], ['comments', false]);
  assert.equal(remotePageGate('<script>1</script>', false, true).prompt, 'scripts', 'a script page keeps the script wording');
  // After the Run tap the bar is gone and the page runs, commenting or not.
  for (const html of [choices, plain]) {
    assert.deepEqual(
      [remotePageGate(html, true, true).prompt, remotePageGate(html, true, true).runScripts],
      [null, true]
    );
  }
});
