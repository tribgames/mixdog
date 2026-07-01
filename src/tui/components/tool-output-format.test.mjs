import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExpandedResult,
  wrapExpandedResultLines,
  expandedResultBodyWidth,
  inferLangFamily,
  stripUnderlineAnsi,
  linkifyUrls,
  tryFormatJson,
} from './tool-output-format.mjs';
import stringWidth from 'string-width';
import { displayWidthWith } from '../display-width.mjs';

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

function withRenderLineCap(cap, fn) {
  const prev = process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES;
  const legacy = process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS;
  process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES = String(cap);
  delete process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES;
    else process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES = prev;
    if (legacy === undefined) delete process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS;
    else process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS = legacy;
  }
}

test('inferLangFamily maps known extensions, null otherwise', () => {
  assert.equal(inferLangFamily('src/x.mjs'), 'js');
  assert.equal(inferLangFamily('a.py'), 'py');
  assert.equal(inferLangFamily('x.json'), 'json');
  assert.equal(inferLangFamily('run.sh'), 'sh');
  assert.equal(inferLangFamily('readme'), null);
  assert.equal(inferLangFamily(''), null);
});

test('read line-number gutter is split into a dim column and body is highlighted', () => {
  const read = '900\u2192function f() {\n901\u2192  return 1;\n902\u2192}';
  const out = formatExpandedResult(read, { pathArg: 'a.mjs' });
  assert.equal(out.length, 3);
  // gutter text survives, body keyword colored (output carries SGR escapes).
  assert.ok(stripAnsi(out[0]).startsWith('900\u2192function f() {'));
  assert.ok(out[0].includes('\x1b['), 'first line carries color escapes');
});

test('non-ANSI tool output expands tabs so width math matches the terminal', () => {
  // A raw \t is ZERO-width to string-width, so wrapExpandedResultLines would
  // under-wrap a tab-bearing line and the terminal-expanded tab would bleed
  // the row through the bottom prompt box on scroll. formatExpandedResult must
  // normalize tabs to spaces for non-ANSI output.
  const out = formatExpandedResult('\tindented line', { pathArg: 'a.txt' });
  const plain = stripAnsi(out.join('\n'));
  assert.ok(!plain.includes('\t'), 'no raw tab survives non-ANSI tool output');
  const body = plain.split('\n').find((l) => l.includes('indented line'));
  assert.ok(body, 'body line present');
  assert.equal(stringWidth(body), body.length, 'visible width equals char length');
});

test('shell ANSI output keeps raw control bytes (not normalized)', () => {
  // ANSI/shell output legitimately carries control bytes in escape sequences;
  // normalization must be skipped so those survive verbatim.
  const sh = '\x1b[31mred\x1b[0m';
  const out = formatExpandedResult(sh, { isShell: true });
  assert.ok(out.join('').includes('\x1b['), 'escape sequences preserved');
});

test('colored shell output still expands visible tabs (ANSI-aware normalize)', () => {
  // A colored line with a raw \t in its VISIBLE text: the SGR escapes must be
  // preserved verbatim while the tab is expanded, so the visible width matches
  // the terminal and the row cannot bleed through the prompt box on scroll.
  const sh = '\x1b[32m\tgreen tabbed\x1b[0m';
  const out = formatExpandedResult(sh, { isShell: true });
  const joined = out.join('\n');
  assert.ok(joined.includes('\x1b['), 'color escapes preserved');
  assert.ok(!joined.includes('\t'), 'visible tab expanded even in colored output');
  const body = stripAnsi(joined).split('\n').find((l) => l.includes('green tabbed'));
  assert.ok(body, 'body line present');
  assert.equal(stringWidth(body), body.length, 'visible width equals char length');
});

test('block syntax highlight skips tokenizer for over-long lines (index aligned)', () => {
  // MAX_HIGHLIGHT_LINE_CHARS is 2000 in tool-output-format.mjs
  const giant = 'x'.repeat(2001);
  const read = `1\u2192const a = 1;\n2\u2192${giant}\n3\u2192const b = 2;`;
  const out = formatExpandedResult(read, { pathArg: 'a.mjs' });
  assert.equal(out.length, 3);
  assert.ok(out[0].includes('\x1b['), 'short line before giant is highlighted');
  assert.ok(out[2].includes('\x1b['), 'short line after giant is highlighted');
  const plainMid = stripAnsi(out[1]);
  assert.ok(plainMid.startsWith('2\u2192'), 'gutter preserved on giant line');
  assert.ok(plainMid.endsWith(giant), 'giant body preserved');
  const hljsSpans = (out[1].match(/\x1b\[[0-9;]*m/g) || []).length;
  const shortSpans = (out[0].match(/\x1b\[[0-9;]*m/g) || []).length;
  assert.ok(hljsSpans <= shortSpans + 2, 'giant line not fully tokenized like normal code');
});

test('grep file:line: gutter is split too', () => {
  const grep = 'src/a.mjs:5581:  value: foo,';
  const out = formatExpandedResult(grep, { pathArg: 'src/a.mjs' });
  assert.equal(out.length, 1);
  assert.ok(stripAnsi(out[0]).startsWith('src/a.mjs:5581:'));
});

test('grep Windows absolute path:line: gutter is split', () => {
  const grep = 'C:\\Project\\mixdog\\src\\App.jsx:12: const x = 1;';
  const out = formatExpandedResult(grep, { pathArg: 'src/App.jsx' });
  assert.equal(out.length, 1);
  const plain = stripAnsi(out[0]);
  assert.ok(plain.startsWith('C:\\Project\\mixdog\\src\\App.jsx:12:'));
  assert.ok(plain.includes('const x = 1;'), 'body preserved after gutter');
  assert.ok(out[0].includes('\x1b['), 'body carries highlight escapes');
});

test('grep bare line-number gutter still works', () => {
  const grep = '12:  return null;';
  const out = formatExpandedResult(grep, { pathArg: 'a.mjs' });
  assert.equal(out.length, 1);
  assert.ok(stripAnsi(out[0]).startsWith('12:'));
});

test('https URLs are not treated as grep path:line: gutters', () => {
  const line = 'see https://example.com:443/path for docs';
  const out = formatExpandedResult(line, {});
  assert.equal(out.length, 1);
  assert.equal(stripAnsi(out[0]), line);
});

test('JSON result is auto pretty-printed (size-capped, precision-safe)', () => {
  const out = formatExpandedResult('{"a":1,"b":[2,3]}', {});
  assert.ok(out.length > 1, 'single-line JSON expands to multiple rows');
  assert.equal(stripAnsi(out[0]), '{');
  // precision loss → keep original line
  const big = '{"id":123456789012345678901234567890}';
  assert.equal(tryFormatJson(big), big);
});

test('JSON with markdown-like string values stays JSON (no markdown lexer)', () => {
  const raw = '["**literal**","`code`"]';
  const out = formatExpandedResult(raw, {});
  const visible = out.map(stripAnsi).join('\n');
  assert.ok(visible.includes('**literal**'), 'array string keeps ** delimiters');
  assert.ok(visible.includes('`code`'), 'array string keeps backticks');
});

test('JSON object with markdown-like values is not rendered as markdown', () => {
  const raw = '{"msg":"**bold**","x":"`y`"}';
  const out = formatExpandedResult(raw, {});
  const visible = out.map(stripAnsi).join('\n');
  assert.ok(visible.includes('**bold**'));
  assert.ok(visible.includes('`y`'));
});

test('shell output keeps color ANSI but strips underline and never highlights', () => {
  const sh = 'PASS \x1b[32mok\x1b[0m\n\x1b[4mfile.js\x1b[24m done';
  const out = formatExpandedResult(sh, { isShell: true });
  assert.ok(out[0].includes('\x1b[32m'), 'color ANSI preserved');
  assert.ok(!out[1].includes('\x1b[4m'), 'underline stripped');
  assert.equal(stripAnsi(out[1]), 'file.js done');
});

test('unified diff is colored by line class', () => {
  const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n ctx';
  const out = formatExpandedResult(diff, {});
  assert.equal(out.length, 5);
  assert.ok(out.every((l) => l.includes('\x1b[')), 'every diff line colored');
});

test('oversize output is capped with a truncation marker', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n');
  const out = formatExpandedResult(many, {});
  assert.ok(out.length <= 4001, 'logical cap keeps at most MAX_EXPANDED_LINES plus marker');
  assert.ok(/truncated/.test(stripAnsi(out[out.length - 1])));

  const sixHundred = Array.from({ length: 600 }, (_, i) => `row${i}`).join('\n');
  const out600 = formatExpandedResult(sixHundred, {});
  assert.equal(out600.length, 600, 'normal expanded output is not truncated at 80 logical lines');

  const huge = 'x'.repeat(300 * 1024);
  const out2 = formatExpandedResult(huge, {});
  assert.ok(/truncated/.test(stripAnsi(out2[out2.length - 1])));
});

test('stripUnderlineAnsi removes only underline SGR', () => {
  assert.equal(stripUnderlineAnsi('a\x1b[4mu\x1b[24mb'), 'aub');
  assert.equal(stripUnderlineAnsi('a\x1b[32mg\x1b[0mb'), 'a\x1b[32mg\x1b[0mb');
  assert.equal(stripUnderlineAnsi('x\x1b[4;31my'), 'x\x1b[31my');
  assert.equal(stripUnderlineAnsi('x\x1b[42my'), 'x\x1b[42my');
  assert.equal(stripUnderlineAnsi('x\x1b[31;4my'), 'x\x1b[31my');
});

test('linkifyUrls wraps bare URLs in OSC 8', () => {
  const out = linkifyUrls('see https://x.com/y here');
  assert.ok(out.includes('\x1b]8;;https://x.com/y\x07'));
  assert.equal(linkifyUrls('no url here'), 'no url here');
});

test('linkifyUrls keeps ANSI out of OSC 8 URL targets', () => {
  const colored = 'go \x1b[31mhttps://example.com/a\x1b[0m end';
  const out = linkifyUrls(colored);
  const m = /\x1b]8;;([^\x07]+)\x07/.exec(out);
  assert.ok(m, 'OSC 8 opener present');
  assert.equal(m[1], 'https://example.com/a');
  assert.ok(!m[1].includes('\x1b'), 'target URL has no escape bytes');
});

function osc8UrlTargets(text) {
  const targets = [];
  const bel = /\x1b]8;;([^\x07]+)\x07/g;
  const st = /\x1b]8;;((?:[^\x1b]|\x1b(?![\\]))+)\x1b\\/g;
  let m;
  while ((m = bel.exec(text)) !== null) targets.push(m[1]);
  while ((m = st.exec(text)) !== null) targets.push(m[1]);
  return targets;
}

test('linkifyUrls does not re-linkify existing BEL OSC 8 hyperlinks', () => {
  const belLink = '\x1b]8;;https://a.test\x07label\x1b]8;;\x07';
  const out = linkifyUrls(belLink);
  assert.equal(out, belLink);
  assert.equal((out.match(/\x1b]8;;/g) || []).length, 2, 'single open/close pair');
  for (const target of osc8UrlTargets(out)) {
    assert.ok(!target.includes('\x1b'), 'target has no escape bytes');
    assert.ok(!target.includes('\x1b]8;;'), 'no nested OSC in target');
  }
});

test('linkifyUrls does not re-linkify existing ST OSC 8 hyperlinks', () => {
  const stLink = '\x1b]8;;https://a.test\x1b\\label\x1b]8;;\x1b\\';
  const out = linkifyUrls(stLink);
  assert.equal(out, stLink);
  assert.equal((out.match(/\x1b]8;;/g) || []).length, 2, 'single open/close pair');
  for (const target of osc8UrlTargets(out)) {
    assert.ok(!target.includes('\x1b'), 'target has no escape bytes');
    assert.ok(!target.includes('\x1b]8;;'), 'no nested OSC in target');
  }
});

test('empty input yields no lines', () => {
  assert.deepEqual(formatExpandedResult('', {}), []);
});

test('wrapExpandedResultLines splits long logical rows to body width', () => {
  const columns = 48;
  const maxW = expandedResultBodyWidth(columns);
  const longBody = 'alpha_beta_gamma_delta '.repeat(6).trimEnd();
  const logical = formatExpandedResult(`900\u2192${longBody}`, { pathArg: 'a.mjs' });
  assert.equal(logical.length, 1);
  const physical = wrapExpandedResultLines(logical, columns);
  assert.ok(physical.length > 1, 'long read line becomes multiple physical rows');
  for (const row of physical) {
    assert.ok(
      stringWidth(stripAnsi(row)) <= maxW,
      `row width ${stringWidth(stripAnsi(row))} exceeds budget ${maxW}`,
    );
  }
  for (let i = 1; i < physical.length; i++) {
    assert.ok(/^\s+/.test(stripAnsi(physical[i])), 'wrapped continuations are indented');
  }
});

test('expanded markdown prose renders headings and emphasis (not raw #/**)', () => {
  const md = '# Title\n\nSome **bold** and `inline`.\n';
  const out = formatExpandedResult(md, {});
  const visible = out.map(stripAnsi).join('\n');
  assert.ok(!visible.includes('# Title'), 'ATX heading marker not shown raw');
  assert.ok(visible.includes('Title'), 'heading text preserved');
  assert.ok(visible.includes('bold'), 'strong text preserved');
  assert.ok(!visible.includes('**'), 'emphasis delimiters stripped');
  assert.ok(out.some((l) => l.includes('\x1b[')), 'markdown path applies theme colors');
});

test('expanded fenced code in markdown path is highlighted', () => {
  const md = '```js\nconst x = 1;\n```\n';
  const out = formatExpandedResult(md, {});
  const visible = out.map(stripAnsi).join('\n');
  assert.ok(visible.includes('const x = 1;'), 'fence body preserved');
  assert.ok(out.some((l) => l.includes('\x1b[')), 'fenced block carries ANSI');
});

test('read gutter lines skip markdown mode and keep syntax highlight', () => {
  const read = '1\u2192# not a heading\n2\u2192const y = 2;\n';
  const out = formatExpandedResult(read, { pathArg: 'a.mjs' });
  const visible = out.map(stripAnsi);
  assert.ok(visible.some((l) => l.includes('1\u2192# not a heading')), 'source # kept on read lines');
  assert.ok(visible.some((l) => l.includes('const y = 2;')), 'read body preserved');
  assert.ok(out.some((l) => stripAnsi(l).includes('const y = 2;') && l.includes('\x1b[')), 'code line still highlighted');
});

test('shell physical cap keeps newest rows across logical lines', () => {
  withRenderLineCap(5, () => {
    const long = 'W'.repeat(240);
    const logical = formatExpandedResult(`${long}\nNEWEST_TAIL_LINE`, { isShell: true });
    const physical = wrapExpandedResultLines(logical, 32, { isShell: true });
    const visible = physical.map(stripAnsi);
    assert.ok(visible.some((l) => l.includes('NEWEST_TAIL_LINE')), 'newest logical line survives rolling cap');
    assert.ok(physical.length <= 5);
    assert.ok(visible.some((l) => /omitted above/i.test(l)));
  });
});

test('exact physical cap row count is not truncated', () => {
  withRenderLineCap(10, () => {
    const logical = Array.from({ length: 10 }, (_, i) => `row-${i}`).map((l) => formatExpandedResult(l, { isShell: true })[0]);
    const physical = wrapExpandedResultLines(logical, 80, { isShell: true });
    assert.equal(physical.length, 10);
    assert.ok(!physical.some((l) => /omitted above/i.test(stripAnsi(l))));
  });
});

test('physical cap of 1 never returns more than one row', () => {
  withRenderLineCap(1, () => {
    const physical = wrapExpandedResultLines(formatExpandedResult('a\nb\nc', { isShell: true }), 80, { isShell: true });
    assert.ok(physical.length <= 1);
    const physicalNonShell = wrapExpandedResultLines(formatExpandedResult('a\nb\nc', {}), 80, { isShell: false });
    assert.ok(physicalNonShell.length <= 1);
  });
});

test('shell physical cap omitted count includes marker slot', () => {
  withRenderLineCap(5, () => {
    const logical = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'].map((l) => formatExpandedResult(l, { isShell: true })[0]);
    const physical = wrapExpandedResultLines(logical, 80, { isShell: true });
    const visible = physical.map(stripAnsi);
    assert.equal(physical.length, 5);
    assert.match(visible[0], /2 lines omitted above/);
    assert.deepEqual(visible.slice(1), ['r2', 'r3', 'r4', 'r5']);
  });
  withRenderLineCap(1, () => {
    const logical = Array.from({ length: 6 }, (_, i) => `row${i}`).map((l) => formatExpandedResult(l, { isShell: true })[0]);
    const physical = wrapExpandedResultLines(logical, 80, { isShell: true });
    assert.equal(physical.length, 1);
    assert.match(stripAnsi(physical[0]), /6 lines omitted above/);
  });
});

test('shell logical truncation marker precedes retained tail', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n');
  const out = formatExpandedResult(many, { isShell: true });
  const visible = out.map(stripAnsi);
  assert.ok(visible.length <= 4001);
  assert.ok(/omitted above/i.test(visible[0]), 'shell marker is first row');
  assert.ok(visible[visible.length - 1].includes('line4999'), 'newest logical line is last');
  assert.ok(!visible[visible.length - 1].includes('re-read a narrower range'));
});

test('wide policy OFF: displayWidth is byte-for-byte identical to string-width for arrow lines', () => {
  // Guards the "non-WT terminals unchanged" invariant: with the policy OFF
  // (default in this test process — no WT_SESSION, no override), the arrow is
  // still 1 cell, so wrap output must be identical to the string-width world.
  const arrowLine = '  12\u2192const x = 1; \u2190 done';
  assert.equal(displayWidthWith(arrowLine, false), stringWidth(arrowLine),
    'policy OFF must equal plain string-width');
  const logical = formatExpandedResult(arrowLine, { pathArg: 'a.mjs' });
  const physical = wrapExpandedResultLines(logical, 40);
  const maxW = expandedResultBodyWidth(40);
  for (const row of physical) {
    assert.ok(stringWidth(stripAnsi(row)) <= maxW,
      `row width ${stringWidth(stripAnsi(row))} exceeds ${maxW} (policy OFF)`);
  }
});

test('wide policy ON (forced): every emitted arrow row fits the display-width budget', async () => {
  // The policy is resolved ONCE at module load, so forcing it requires a fresh
  // process. Spawn a child with MIXDOG_TUI_AMBIGUOUS_WIDE=1 and assert that
  // every wrapped read row (containing U+2192) measures <= expandedResultBodyWidth
  // under the SAME wide policy the terminal will use. Without the clamp,
  // string-width accepts arrow rows as fitting while the terminal renders them
  // one cell wider, bleeding into the prompt box.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const modUrl = new URL('./tool-output-format.mjs', import.meta.url).href;
  const dwUrl = new URL('../display-width.mjs', import.meta.url).href;
  const script = `
    import { formatExpandedResult, wrapExpandedResultLines, expandedResultBodyWidth } from ${JSON.stringify(modUrl)};
    import { displayWidth, AMBIGUOUS_WIDE } from ${JSON.stringify(dwUrl)};
    const strip = (s) => String(s).replace(/\\x1b\\[[0-9;]*m/g, '').replace(/\\x1b\\]8;;[^\\x07]*\\x07/g, '');
    if (AMBIGUOUS_WIDE !== true) { console.log('POLICY_OFF'); process.exit(2); }
    const columns = 30;
    // Many arrows so a naive string-width fit accepts an over-wide row.
    const body = 'x'.repeat(24) + ' ' + '\\u2192'.repeat(12) + ' tail';
    const logical = formatExpandedResult('42\\u2192' + body, { pathArg: 'a.mjs' });
    const physical = wrapExpandedResultLines(logical, columns);
    const maxW = expandedResultBodyWidth(columns);
    let bad = 0;
    for (const row of physical) {
      if (displayWidth(strip(row)) > maxW) bad++;
    }
    console.log(bad === 0 ? 'OK ' + physical.length : 'BAD ' + bad);
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MIXDOG_TUI_AMBIGUOUS_WIDE: '1', WT_SESSION: '' },
    encoding: 'utf8',
  }).trim();
  assert.ok(out.startsWith('OK'), `expected all rows within budget, got: ${out}`);
});
