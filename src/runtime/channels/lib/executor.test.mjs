import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateFilter } from './executor.mjs';

test('event filters combine == and != conditions with && inside || groups', () => {
  const data = { event: 'push', branch: 'main', author: '' };
  const cases = [
    ['event == "push"', true],
    ["event == 'pull_request'", false],
    ['event != "push"', false],
    ['event != "pull_request"', true],
    ['event == "push" && branch == "main"', true],
    ['event == "push" && branch == "dev"', false],
    ['event == "pr" || branch == "main"', true],
    ['event == "pr" || branch == "dev"', false],
    ['  event == "push"  &&  branch != "dev"  ', true],
    ['author == ""', true],
    ['missing == ""', true],
    ['missing != ""', false],
    ['event = "push"', false],
    ['event == "push" && garbage', false],
    ['garbage || event == "push"', true],
    ['', false],
  ];
  for (const [expr, expected] of cases) assert.equal(evaluateFilter(expr, data), expected, expr);
});
