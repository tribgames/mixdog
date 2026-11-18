#!/usr/bin/env node
// ADVISORY. A test that returns early without reporting a skip passes without testing anything, and no runner reports it: node:test counts it
// as a pass, so scripts/ci/check-skips.mjs cannot see it. This scan points at the two shapes that usually are one, in the tracked test files:
//
//   guard   `if (!existsSync(...)) return;` (or `statSync` / `accessSync` / `existsSync` negated) anywhere in a test body
//   early   a bare `return` before the body's first assertion (a call to `assert*` / `expect*` / `t.assert*`), unless a `skip` call stands
//           right before it (`t.skip('why'); return;` reports a skip, which check-skips.mjs reviews)
//
// It reads source text (the tokenizer of check-clean-checkout.mjs), so it misses a guard written another way and flags a legitimate early
// return of a helper-less test; it never fails the gate on its own. Hits are printed as `path:line: kind`, and as GitHub warnings in Actions.
//
// Usage: node scripts/ci/scan-silent-returns.mjs [--fail]      (from anywhere inside the repository; --fail exits 1 on any hit)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tokenize } from './check-clean-checkout.mjs';

const TEST_FILE = /\.test\.(?:mjs|ts)$/;
const CALLS = new Set(['test', 'it']);
const GUARDS = new Set(['existsSync', 'statSync', 'accessSync', 'lstatSync']);
const isAssertion = (word) => /^(?:assert|expect|strictEqual|deepEqual|ok|equal|notEqual|throws|rejects|doesNotMatch|match)/.test(word);

// The index of the token that closes the bracket opened at `open`.
function closing(tokens, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'punct') continue;
    if (pairs[token.value]) stack.push(pairs[token.value]);
    else if (token.value === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** `[{ line, kind }]` of the silent-return shapes in the test bodies of `source`. */
export function silentReturns(source) {
  const tokens = tokenize(source);
  const hits = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const callee = token.kind === 'word' && CALLS.has(token.value) && tokens[i - 1]?.value !== '.';
    if (!callee || tokens[i + 1].value !== '(') continue;
    const end = closing(tokens, i + 1);
    // the body: the first `{` after the first `=>` or `function (...)` among the arguments
    let at = -1;
    for (let j = i + 2; j < end; j += 1) {
      if ((tokens[j].value === '=' && tokens[j + 1]?.value === '>') || (tokens[j].kind === 'word' && tokens[j].value === 'function')) {
        at = tokens.findIndex((candidate, index) => index > j && index < end && candidate.value === '{');
        break;
      }
    }
    if (at < 0) continue;
    const bodyEnd = closing(tokens, at);
    // A guard anywhere in the body, nested callbacks and helpers included.
    for (let j = at + 1; j < bodyEnd; j += 1) {
      const t = tokens[j];
      if (!(t.kind === 'word' && t.value === 'if' && tokens[j + 1]?.value === '(')) continue;
      const close = closing(tokens, j + 1);
      const condition = tokens.slice(j + 2, close);
      const guarded = condition[0]?.value === '!' && condition.some((c) => c.kind === 'word' && GUARDS.has(c.value));
      const next = tokens[close + 1];
      const returns = next?.value === 'return' || (next?.value === '{' && tokens[close + 2]?.value === 'return');
      if (guarded && returns) hits.push({ line: t.line, kind: 'guard' });
    }
    let asserted = false;
    for (let j = at + 1; j < bodyEnd; j += 1) {
      const t = tokens[j];
      // A nested function (a callback, a helper) is not the test: its returns are its own, its assertions still count.
      if ((t.value === '=' && tokens[j + 1]?.value === '>') || (t.kind === 'word' && t.value === 'function')) {
        const open = tokens.findIndex((candidate, index) => index > j && index < bodyEnd && candidate.value === '{');
        const arrowExpression = t.value === '=' && tokens[j + 2]?.value !== '{';
        if (open >= 0 && !arrowExpression) {
          for (let k = j; k < closing(tokens, open); k += 1) if (tokens[k].kind === 'word' && isAssertion(tokens[k].value) && tokens[k + 1]?.value === '(') asserted = true;
          j = closing(tokens, open);
        }
        continue;
      }
      if (t.kind === 'word' && isAssertion(t.value) && tokens[j + 1]?.value === '(') asserted = true;
      if (t.kind === 'word' && t.value === 'return' && ['', ';', '}'].includes(tokens[j + 1]?.value ?? '') && !asserted) {
        const reported = tokens.slice(Math.max(at + 1, j - 12), j).some((c) => c.kind === 'word' && c.value === 'skip');
        if (!reported && !hits.some((hit) => hit.line === t.line)) hits.push({ line: t.line, kind: 'early' });
      }
    }
    i = end;
  }
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter((path) => TEST_FILE.test(path) && existsSync(join(root, path)));
  const found = [];
  for (const path of files) for (const hit of silentReturns(readFileSync(join(root, path), 'utf8'))) found.push({ path, ...hit });
  for (const { path, line, kind } of found) {
    console.log(`${path}:${line}: ${kind === 'guard' ? 'returns when a file is absent' : 'returns before its first assertion'}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning file=${path},line=${line}::a test that returns early passes without testing (scripts/ci/scan-silent-returns.mjs)`);
  }
  console.log(`${found.length} advisory hit(s) in ${files.length} test files`);
  if (process.argv.includes('--fail') && found.length > 0) process.exit(1);
}
