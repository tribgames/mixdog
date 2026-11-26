import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('a narrow chat-pane inside a wide mixdog-pane keeps the 12px conversation inset', async () => {
  const css = await readFile(new URL('./desktop/12-transcript.css', import.meta.url), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Evaluate base and @container rules in source cascade order for a selector.
  const evaluateTokens = (targetSelector, containers) => {
    const tokens = {};
    const applyDecls = (body) => {
      for (const match of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
        tokens[match[1]] = match[2].trim();
      }
    };
    const matchesTarget = (selectorList) =>
      selectorList
        .split(',')
        .map((selector) => selector.trim())
        .includes(targetSelector);
    const matchesQuery = (name, condition) => {
      const width = containers[name];
      if (width === undefined) return false;
      const min = condition.match(/min-width:\s*(\d+)px/);
      const max = condition.match(/max-width:\s*(\d+)px/);
      if (min && width < Number(min[1])) return false;
      if (max && width > Number(max[1])) return false;
      return true;
    };

    const walk = (source) => {
      let cursor = 0;
      while (cursor < source.length) {
        const brace = source.indexOf('{', cursor);
        if (brace < 0) break;
        const prelude = source.slice(cursor, brace).trim();
        let index = brace + 1;
        let depth = 1;
        while (index < source.length && depth > 0) {
          if (source[index] === '{') depth += 1;
          else if (source[index] === '}') depth -= 1;
          index += 1;
        }
        const body = source.slice(brace + 1, index - 1);
        cursor = index;
        if (prelude.startsWith('@container ')) {
          const parsed = prelude.match(/^@container\s+([\w-]+)\s*\(([^)]+)\)$/);
          if (parsed && matchesQuery(parsed[1], parsed[2])) walk(body);
        } else if (!prelude.startsWith('@') && matchesTarget(prelude)) {
          applyDecls(body);
        }
      }
    };
    walk(stripped);
    return tokens;
  };

  for (const selector of ['.conversation', '.workspace > .session-header']) {
    const narrow = evaluateTokens(selector, { 'chat-pane': 360, 'mixdog-pane': 1000 });
    assert.equal(narrow['--pane-inset'], '12px', `${selector}: 360px chat-pane inside 1000px mixdog-pane keeps 12px`);
    assert.equal(
      narrow['--pane-column'],
      '100%',
      `${selector}: narrow chat-pane does not inherit wide mixdog-pane column`
    );

    const medium = evaluateTokens(selector, { 'chat-pane': 500, 'mixdog-pane': 1000 });
    assert.equal(medium['--pane-inset'], '20px', `${selector}: 500px chat-pane keeps 20px inset`);
    assert.equal(medium['--pane-column'], '100%', `${selector}: 500px chat-pane keeps 100% column`);

    const wide = evaluateTokens(selector, { 'chat-pane': 820, 'mixdog-pane': 1000 });
    assert.equal(wide['--pane-inset'], '24px', `${selector}: 820px chat-pane uses 24px inset`);
  }
  const wideConversation = evaluateTokens('.conversation', { 'chat-pane': 820, 'mixdog-pane': 1000 });
  assert.equal(wideConversation['--pane-column'], 'clamp(800px, 80cqi, 848px)');
});
