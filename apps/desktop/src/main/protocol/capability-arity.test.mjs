// No capability may be callable with more arguments than the protocol method it routes to declares: the desktop's
// argument validation (ipc-validation.ts CAPABILITY_ARITY) would let such a call through and `routeCapability` would
// then refuse it with "session action X takes at most N arguments" (a project-editor save did exactly that).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveAction } from '../../../../../packages/protocol-client/src/actions/action-route.mjs';

import { DESKTOP_CAPABILITIES } from '../../shared/contract-capabilities.ts';
import { CAPABILITY_ARITY } from '../ipc-validation.ts';
import { routeCapability } from './capability-route.ts';

test('no capability accepts more arguments than its protocol method declares', () => {
  const tooMany = [];
  for (const capability of DESKTOP_CAPABILITIES) {
    const max = CAPABILITY_ARITY[capability]?.[1];
    if (max === undefined || max === 0) continue;
    try {
      routeCapability(capability, Array.from({ length: max }, () => 'x'), 'thread-1');
    } catch (error) {
      if (/takes at most/.test(String(error?.message))) tooMany.push(`${capability}: ${error.message}`);
    }
  }
  assert.deepEqual(tooMany, []);
});
// The terminal UI reaches the same table through `store_call("action", json!([args...]))` (session-view `resolve_action`),
// so a literal argument list there is held to the same limit.
test('no terminal UI store_call passes more arguments than its protocol method declares', () => {
  const root = new URL('../../../../../native/core/crates/mixdog-tui/src/', import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith('.rs'));
  const tooMany = [];
  let seen = 0;
  for (const name of files) {
    const text = readFileSync(new URL(name, root), 'utf8');
    for (const match of text.matchAll(/store_call\(\s*"(\w+)"\s*,\s*json!\(\[/g)) {
      let depth = 1;
      let count = 0;
      let content = false;
      for (let i = match.index + match[0].length; depth > 0 && i < text.length; i += 1) {
        const char = text[i];
        if (char === '"') {
          content = true;
          for (i += 1; text[i] !== '"'; i += text[i] === '\\' ? 2 : 1);
        } else if ('([{'.includes(char)) {
          content = true;
          depth += 1;
        } else if (')]}'.includes(char)) depth -= 1;
        else if (char === ',' && depth === 1) count += 1;
        else if (!/\s/.test(char)) content = true;
      }
      const args = content ? count + 1 : 0;
      seen += 1;
      try {
        resolveAction(match[1], Array.from({ length: args }, () => 'x'), { threadId: 'thread-1' });
      } catch (error) {
        if (/takes at most/.test(String(error?.message))) tooMany.push(`${name}: ${error.message}`);
      }
    }
  }
  assert.ok(seen > 20, 'the scan finds the terminal UI calls');
  assert.deepEqual(tooMany, []);
});
