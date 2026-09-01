// Local retrieval tools: list, grep, glob, find — output contracts, argument
// guards, and CC/Grok parity boundaries.
import './_env.mjs';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './_env.mjs';
import { assertOk } from './_helpers.mjs';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { executeFuzzyFindTool } from '../../src/runtime/agent/orchestrator/tools/builtin/list-tool.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, validateBuiltinArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { executeCodeGraphTool } from '../../src/runtime/agent/orchestrator/tools/code-graph.mjs';

test('list output, meta columns, hidden filtering, and argument guards', async () => {
  const listOut = await executeBuiltinTool('list', { path: 'scripts', head_limit: 20 }, root);
  assertOk('list', listOut, /smoke\.mjs/);
  const listArrayErr = validateBuiltinArgs('list', { path: ['scripts'] });
  if (!/must be string/.test(String(listArrayErr))) {
    throw new Error(`list path array must be rejected: ${listArrayErr}`);
  }
  const listBlankPathArgs = { path: ' ' };
  const listBlankPathErr = validateBuiltinArgs('list', listBlankPathArgs);
  if (listBlankPathErr || Object.prototype.hasOwnProperty.call(listBlankPathArgs, 'path')) {
    throw new Error(`list blank optional path must normalize to omission: err=${listBlankPathErr} args=${JSON.stringify(listBlankPathArgs)}`);
  }
  for (const key of ['hidden', 'meta']) {
    const err = validateBuiltinArgs('list', { path: 'scripts', [key]: 'false' });
    if (!/must be a boolean/.test(String(err))) {
      throw new Error(`list ${key} string must be rejected: ${err}`);
    }
  }
  for (const offset of [-1, 1.5]) {
    const err = validateBuiltinArgs('list', { path: 'scripts', offset });
    if (!/non-negative integer/.test(String(err))) {
      throw new Error(`list invalid offset must be rejected: ${err}`);
    }
  }

  // list meta: opt-in stat columns (size bytes, UTC mtime, octal mode) close
  // the `ls -la` metadata gap while the default contract stays path + type.
  const listMetaOut = await executeBuiltinTool('list', { path: 'scripts', head_limit: 0, meta: true }, root);
  assertOk('list meta', listMetaOut, /smoke\.mjs\tfile\t\d+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t[0-7]{3,4}/);
  const listFileMetaOut = await executeBuiltinTool('list', { path: 'package.json', meta: true }, root);
  assertOk('list file meta', listFileMetaOut, /package\.json\tfile\t\d+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t[0-7]{3,4}/);

  // list hidden: dotfiles are opt-in via the exposed `hidden` flag (`ls -a`
  // parity); default listings keep them filtered.
  const listHiddenOut = await executeBuiltinTool('list', { path: '.', hidden: true, head_limit: 0 }, root);
  assertOk('list hidden', listHiddenOut, /\.gitignore\tfile/);
  const listRootDefaultOut = await executeBuiltinTool('list', { path: '.', head_limit: 0 }, root);
  if (/\.gitignore\tfile/.test(listRootDefaultOut)) {
    throw new Error('default list must keep dotfiles filtered (hidden defaults false)');
  }
});

test('grep content matches, ENOENT redirect, and redundant globs', async () => {
  const grepOut = await executeBuiltinTool('grep', {
    pattern: 'standalone mixdog CLI/TUI coding agent|smoke passed',
    path: 'scripts',
    glob: '*.mjs',
    output_mode: 'content_with_context',
    head_limit: 10,
  }, root);
  assertOk('grep', grepOut, /smoke\.mjs/);

  const grepRedirectOut = await executeBuiltinTool('grep', {
    pattern: 'assertOk',
    path: 'bogus/wrong/prefix/scripts/tool-contracts/search-tools.test.mjs',
    head_limit: 3,
  }, root);
  if (!/^\[redirected from/.test(grepRedirectOut) || !/assertOk/.test(grepRedirectOut)) {
    throw new Error(`grep ENOENT should auto-redirect on unique suffix hit:\n${grepRedirectOut.slice(0, 800)}`);
  }

  const redundantAllFilesGlobGrepOut = await executeBuiltinTool('grep', {
    pattern: 'standalone mixdog CLI/TUI coding agent',
    glob: '**/*',
    head_limit: 10,
  }, root);
  assertOk('grep redundant all-files glob', redundantAllFilesGlobGrepOut, /scripts[\\/](?:boot-smoke|smoke)\.mjs|src[\\/]help\.mjs/);
});

test('glob patterns, arrays, refs exclusion, and argument guards', async () => {
  const implicitRefsGlobOut = await executeBuiltinTool('glob', {
    pattern: '**/agent-session.ts',
    head_limit: 20,
  }, root);
  if (/refs[\\/]/i.test(String(implicitRefsGlobOut))) {
    throw new Error(`glob default search must exclude refs unless explicitly targeted:\n${implicitRefsGlobOut}`);
  }

  const explicitSrcGlobOut = await executeBuiltinTool('glob', {
    pattern: '**/runner.mjs',
    path: 'src',
    head_limit: 20,
  }, root);
  assertOk('glob explicit src', explicitSrcGlobOut, /src[\\/].*runner\.mjs/i);

  const globPatternArrayOut = await executeBuiltinTool('glob', {
    pattern: ['package.json', '**/runner.mjs'],
    path: '.',
    sort: 'natural',
    head_limit: 20,
  }, root);
  assertOk('glob pattern array', globPatternArrayOut, /package\.json/i);
  if (!/src[\\/].*runner\.mjs/i.test(String(globPatternArrayOut))) {
    throw new Error(`glob pattern array must include every requested pattern:\n${globPatternArrayOut}`);
  }
  const globPathArrayErr = validateBuiltinArgs('glob', { pattern: '*.mjs', path: ['src'] });
  if (!/must be string/.test(String(globPathArrayErr))) {
    throw new Error(`glob path array must be rejected: ${globPathArrayErr}`);
  }
  const globInvalidPatternArrayErr = validateBuiltinArgs('glob', { pattern: ['*.mjs', {}] });
  if (!/string or string\[\]/.test(String(globInvalidPatternArrayErr))) {
    throw new Error(`glob non-string pattern array entry must be rejected: ${globInvalidPatternArrayErr}`);
  }
  const globBlankPatternErr = validateBuiltinArgs('glob', { pattern: ' ' });
  if (!/non-empty string/.test(String(globBlankPatternErr))) {
    throw new Error(`glob blank pattern must be rejected: ${globBlankPatternErr}`);
  }
  for (const key of ['path', 'root']) {
    const args = { pattern: '*.mjs', [key]: ' ' };
    const err = validateBuiltinArgs('glob', args);
    if (err || Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`glob blank optional ${key} must normalize to omission: err=${err} args=${JSON.stringify(args)}`);
    }
  }
  for (const sort of ['recent', true]) {
    const err = validateBuiltinArgs('glob', { pattern: '*.mjs', sort });
    if (!/natural\|mtime/.test(String(err))) {
      throw new Error(`glob invalid sort must be rejected: ${err}`);
    }
  }

  const globPathOnlyOut = await executeBuiltinTool('glob', {
    path: 'scripts',
    // scripts/ holds well over 200 entries and glob ordering tracks mtime, so a
    // tight cap makes membership of any one file boundary-flaky. 0 = unlimited.
    head_limit: 0,
  }, root);
  assertOk('glob path-only default *', globPathOnlyOut, /smoke\.mjs/i);

  const grepNoPatternGlobOut = await executeBuiltinTool('grep', {
    path: 'scripts',
    glob: 'smoke.mjs',
    head_limit: 5,
  }, root);
  assertOk('grep without pattern routes to glob', grepNoPatternGlobOut, /smoke\.mjs/i);
});

function grepCountTotalMatches(body) {
  const m = String(body).match(/\[total (\d+) match/i);
  return m ? Number(m[1]) : null;
}

test('grep count mode and -C chunk context headers', async () => {
  const grepCountSingleOut = await executeBuiltinTool('grep', {
    pattern: 'spawnSync',
    path: 'scripts/smoke.mjs',
    output_mode: 'count',
  }, root);
  const singleCountTotal = grepCountTotalMatches(grepCountSingleOut);
  if (singleCountTotal == null || singleCountTotal < 1) {
    throw new Error(`grep count baseline failed:\n${grepCountSingleOut.slice(0, 400)}`);
  }

  const grepChunkContextOut = await executeBuiltinTool('grep', {
    pattern: 'grepCountTotalMatches',
    path: 'scripts/tool-contracts',
    glob: 'search-tools.test.mjs',
    '-C': 1,
    head_limit: 30,
  }, root);
  if (!/^# scripts\/tool-contracts\/search-tools\.test\.mjs:\d+ \[lines \d+-\d+\]$/m.test(String(grepChunkContextOut))) {
    throw new Error(`scalar -C must emit patch-ready range headers:\n${grepChunkContextOut.slice(0, 800)}`);
  }
  const prefixedChunkContextLines = String(grepChunkContextOut)
    .split(/\r?\n/)
    .filter((line) => /^scripts\/tool-contracts\/search-tools\.test\.mjs(?::\d+:|-\d+-)/.test(line));
  if (prefixedChunkContextLines.some((line) => !/\[lines \d+-\d+\]$/.test(line))) {
    throw new Error(`scalar -C must strip rg prefixes except compact anchors with neutral ranges:\n${grepChunkContextOut.slice(0, 800)}`);
  }
  const ctxBodyLines = String(grepChunkContextOut).split('\n').filter((l) => l && !/^\[/.test(l) && !/^\(no matches\)/.test(l));
  const orphanLineOnlyContext = ctxBodyLines.some((l) => /^\d+-/.test(l));
  if (orphanLineOnlyContext) {
    throw new Error(`scalar -C must not leave line-only context orphans:\n${grepChunkContextOut.slice(0, 800)}`);
  }
  if (!/function grepCountTotalMatches/.test(String(grepChunkContextOut))) {
    throw new Error(`scalar -C should include match span:\n${grepChunkContextOut.slice(0, 800)}`);
  }
});

test('find fuzzy lookup, argument guards, and bounded timeout partial', async () => {
  const findOut = await executeBuiltinTool('find', {
    query: 'boot smoke',
    path: '.',
    head_limit: 10,
  }, root);
  assertOk('find', findOut, /scripts[\\/]boot-smoke\.mjs/i);

  const findQueryArrayErr = validateBuiltinArgs('find', { query: ['boot smoke', 'smoke'], path: '.' });
  if (!/non-empty string/.test(String(findQueryArrayErr))) {
    throw new Error(`find query array must be rejected: ${findQueryArrayErr}`);
  }
  const findPathArrayErr = validateBuiltinArgs('find', { query: 'boot smoke', path: ['.'] });
  if (!/must be a string/.test(String(findPathArrayErr))) {
    throw new Error(`find path array must be rejected: ${findPathArrayErr}`);
  }
  const findBlankPathArgs = { query: 'boot smoke', path: ' ' };
  const findBlankPathErr = validateBuiltinArgs('find', findBlankPathArgs);
  if (findBlankPathErr || Object.prototype.hasOwnProperty.call(findBlankPathArgs, 'path')) {
    throw new Error(`find blank optional path must normalize to omission: err=${findBlankPathErr} args=${JSON.stringify(findBlankPathArgs)}`);
  }
  const findNoiseTypeErr = validateBuiltinArgs('find', { query: 'boot smoke', include_noise: 'false' });
  if (!/must be a boolean/.test(String(findNoiseTypeErr))) {
    throw new Error(`find include_noise string must be rejected: ${findNoiseTypeErr}`);
  }

  const timeout = Object.assign(
    new Error('native fuzzy search timed out after 20000ms. Fuzzy ranking requires a complete file inventory; narrow cwd or set max depth.'),
    { code: 'NATIVE_SEARCH_TIMEOUT' },
  );
  const out = await executeFuzzyFindTool(
    { query: 'tool-contracts-timeout', path: '.', head_limit: 5 },
    root,
    {
      __tryServeFuzzySearch: async () => { throw timeout; },
    },
  );
  // A deadline before any fuzzy response returns the bounded native partial.
  // It never starts a second filesystem walk with different semantics.
  if (/^Error[\s:[]/.test(String(out).trimStart())
      || !/no fuzzy match yet/.test(String(out))
      || !/inventory (?:is still building|was incomplete)/.test(String(out))) {
    throw new Error(`find fuzzy timeout must return one bounded native partial:\n${out}`);
  }
});

// Shared exploration fixture: CC/Grok parity boundaries across all six local
// retrieval tools. It intentionally combines exact-file operands, glob/type
// filters, hidden/noise handling, Unicode + spaces, windows, and no-match/ENOENT.
test('exploration fixture parity across the six retrieval tools', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mixdog-exploration-tools-'));
  try {
    mkdirSync(join(fixtureRoot, 'src', '공백 폴더'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'node_modules', 'noise'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(
      join(fixtureRoot, 'src', 'alpha.mjs'),
      'export const needleAlpha = 1;\nsecond line\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'src', '공백 폴더', '한글 파일.mjs'),
      'export const unicodeNeedle = 2;\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'src', '.hidden.mjs'),
      'export const hiddenNeedle = 3;\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'node_modules', 'noise', 'noise.mjs'),
      'export const noiseNeedle = 4;\n',
      'utf8',
    );

    const defaultList = await executeBuiltinTool('list', {
      path: join(fixtureRoot, 'src'),
      hidden: false,
      head_limit: 0,
    }, fixtureRoot);
    if (/\.hidden\.mjs/.test(String(defaultList)) || !/alpha\.mjs/.test(String(defaultList))) {
      throw new Error(`list hidden=false contract failed:\n${defaultList}`);
    }
    const hiddenList = await executeBuiltinTool('list', {
      path: join(fixtureRoot, 'src'),
      hidden: true,
      head_limit: 0,
    }, fixtureRoot);
    assertOk('list hidden fixture', hiddenList, /\.hidden\.mjs/);

    const unicodeGlob = await executeBuiltinTool('glob', {
      pattern: '**/한글 파일.mjs',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('glob unicode + space', unicodeGlob, /공백 폴더[\\/]한글 파일\.mjs/);
    const noiseGlob = await executeBuiltinTool('glob', {
      pattern: '**/noise.mjs',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk(
      'glob explicit pattern overrides dependency noise exclusion',
      noiseGlob,
      /node_modules[\\/]noise[\\/]noise\.mjs/,
    );

    const exactFile = join(fixtureRoot, 'src', 'alpha.mjs');
    const exactGlobGrep = await executeBuiltinTool('grep', {
      pattern: 'needleAlpha',
      path: exactFile,
      glob: '*.mjs',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    assertOk('grep exact file + glob', exactGlobGrep, /needleAlpha/);
    const exactTypeGrep = await executeBuiltinTool('grep', {
      pattern: 'needleAlpha',
      path: exactFile,
      type: 'js',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    assertOk('grep exact file + type', exactTypeGrep, /needleAlpha/);
    const noMatchGrep = await executeBuiltinTool('grep', {
      pattern: 'definitelyAbsentNeedle',
      path: exactFile,
      glob: '*.mjs',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    if (!/^\(no matches\)/.test(String(noMatchGrep)) || /^Error/.test(String(noMatchGrep))) {
      throw new Error(`grep no-match must remain a successful empty result:\n${noMatchGrep}`);
    }
    const invalidRegexFallback = await executeBuiltinTool('grep', {
      pattern: '(',
      path: exactFile,
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    if (!/^\[regex parse fallback: fixed-string terms\]\n\(no matches\)/.test(String(invalidRegexFallback))) {
      throw new Error(`grep invalid-regex fallback must retain its no-match body:\n${invalidRegexFallback}`);
    }

    const unicodeFind = await executeBuiltinTool('find', {
      query: '한글 파일',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('find unicode + space', unicodeFind, /공백 폴더[\\/]한글 파일\.mjs/);
    const quietNoiseFind = await executeBuiltinTool('find', {
      query: 'noise.mjs',
      path: fixtureRoot,
      include_noise: false,
      head_limit: 10,
    }, fixtureRoot);
    if (/node_modules[\\/]noise[\\/]noise\.mjs/.test(String(quietNoiseFind))) {
      throw new Error(`find include_noise=false leaked dependency noise:\n${quietNoiseFind}`);
    }
    const noisyFind = await executeBuiltinTool('find', {
      query: 'noise.mjs',
      path: fixtureRoot,
      include_noise: true,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('find include_noise=true', noisyFind, /node_modules[\\/]noise[\\/]noise\.mjs/);

    const readWindow = await executeBuiltinTool('read', {
      path: exactFile,
      offset: 0,
      limit: 1,
    }, fixtureRoot);
    if (!/^1→export const needleAlpha/m.test(String(readWindow))
      || /second line/.test(String(readWindow))) {
      throw new Error(`read line window contract failed:\n${readWindow}`);
    }
    const missingRead = await executeBuiltinTool('read', {
      path: join(fixtureRoot, 'missing.mjs'),
    }, fixtureRoot);
    // Conclusive absence is the read's ANSWER, not a tool failure (see
    // read-single-tool.mjs and absence-absorption.test.mjs): `[path absent]`
    // is the current envelope, and only a non-conclusive failure keeps
    // `Error:`. Either shape must still name the cause.
    if (!/^(?:Error|\[path absent\])/.test(String(missingRead))
      || !/ENOENT|does not exist|not found/i.test(String(missingRead))) {
      throw new Error(`read ENOENT contract failed:\n${missingRead}`);
    }

    const graphUnicode = await executeCodeGraphTool('code_graph', {
      mode: 'find_symbol',
      files: ['src/공백 폴더/한글 파일.mjs'],
      symbols: ['unicodeNeedle'],
    }, fixtureRoot);
    assertOk('code_graph unicode path', graphUnicode, /unicodeNeedle/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('grep pattern shapes, packed paths, and context lead policy', async () => {
  const legacyEscapedAlternationErr = validateBuiltinArgs('grep', { pattern: 'state\\.items\\.map\\|items\\.map', path: root });
  if (legacyEscapedAlternationErr) {
    throw new Error(`grep legacy \\| alternation should be accepted: ${legacyEscapedAlternationErr}`);
  }
  const legacyEscapedAlternationOut = await executeBuiltinTool('grep', {
    pattern: 'standalone mixdog CLI/TUI coding agent\\|smoke passed',
    path: 'scripts',
    glob: '*.mjs',
    head_limit: 10,
  }, root);
  assertOk('grep legacy \\| alternation', legacyEscapedAlternationOut, /smoke\.mjs/);
  // pattern string[] is the supported independent fan-out shape (schema anyOf);
  // entries must still each be strings.
  const literalBackslashPipeArray = validateBuiltinArgs('grep', {
    pattern: ['contains \\\\|', 'conflicting window args'],
    path: root,
  });
  if (literalBackslashPipeArray) {
    throw new Error(`grep pattern string[] (fan-out) must be accepted: ${literalBackslashPipeArray}`);
  }
  // Scalar-coercible entries (numbers/booleans) are absorbed by design;
  // object entries have no string form and must still be rejected.
  const nonStringPatternEntry = validateBuiltinArgs('grep', { pattern: [{}], path: root });
  if (!/must be string/.test(String(nonStringPatternEntry))) {
    throw new Error(`grep pattern array with object entry must be rejected: ${nonStringPatternEntry}`);
  }
  for (const [key, value] of [['path', [root]], ['glob', ['*.mjs']]]) {
    const args = { pattern: 'smoke', [key]: value };
    const err = validateBuiltinArgs('grep', args);
    if (!/must be string/.test(String(err))) {
      throw new Error(`grep ${key} array must be rejected: ${err}`);
    }
  }
  for (const key of ['path', 'root']) {
    const args = { pattern: 'smoke', [key]: ' ' };
    const err = validateBuiltinArgs('grep', args);
    if (err || Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`grep blank optional ${key} must normalize to omission: err=${err} args=${JSON.stringify(args)}`);
    }
  }

  const grepContextPolicyArgs = { pattern: 'smoke', path: root, context: GREP_CONTEXT_MAX + 999 };
  applyGrepContextLeadPolicy(grepContextPolicyArgs);
  if (grepContextPolicyArgs.context !== GREP_CONTEXT_MAX || Object.prototype.hasOwnProperty.call(grepContextPolicyArgs, '-C')) {
    throw new Error(`grep context policy must canonicalize and clamp explicit context: ${JSON.stringify(grepContextPolicyArgs)}`);
  }

  const multiGrepPathArgs = {
    pattern: 'providerStatus',
    path: 'C:\\Project\\mixdog\\src\\tui C:\\Project\\mixdog\\src\\mixdog-session-runtime.mjs',
  };
  const multiGrepPathErr = validateBuiltinArgs('grep', multiGrepPathArgs);
  if (!/contains multiple absolute paths/.test(String(multiGrepPathErr)) || typeof multiGrepPathArgs.path !== 'string') {
    throw new Error(`grep packed multi-path string must be rejected without array coercion: err=${multiGrepPathErr} path=${JSON.stringify(multiGrepPathArgs.path)}`);
  }

  // Lookaround/backrefs are no longer rejected at validation time: search-tool
  // routes them to rg --pcre2 at runtime (arg-guard.mjs comment near globKeys).
  const lookaroundGrepErr = validateBuiltinArgs('grep', {
    pattern: 'C:\\\\Project(?!\\\\mixdog)',
    path: root,
  });
  if (lookaroundGrepErr) {
    throw new Error(`grep lookaround pattern should pass validation (PCRE2 runtime routing): ${lookaroundGrepErr}`);
  }
});
