import test from 'node:test';
import assert from 'node:assert/strict';
import { RICH_MARKDOWN_MAX_BYTES, richMarkdownSupport } from './rich-markdown-support.ts';

const supported = (text) => richMarkdownSupport(text);
const reason = (text) => {
  const result = richMarkdownSupport(text);
  assert.equal(result.ok, false, `expected unsupported: ${JSON.stringify(text)}`);
  return result.reason;
};

test('ordinary GFM documents are supported', () => {
  for (const text of [
    '',
    '# Title\n\nSome *em*, **strong**, ~~gone~~ and `code`.\n',
    '- [ ] todo\n- [x] done\n\n1. one\n2. two\n',
    '| a | b |\n| :-- | --: |\n| 1 | 2 |\n',
    '```html\n<div>code may hold HTML</div>\n```\n\nInline `<b>` too.\n',
    'Inline $x^2$ and\n\n$$\nE = mc^2\n$$\n',
    '[docs](docs/a.md), <https://example.com> and ![img](./i.png)\n',
    'a &amp; b &lt;c&gt; &quot;d&quot;\n',
    '<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>\n',
    '<details open>\n<summary>Open</summary>\n\nBody\n\n</details>\n',
    // A table cell's line break.
    '| a | b |\n| --- | --- |\n| one<br>two | 2 |\n',
  ]) {
    assert.deepEqual(supported(text), { ok: true }, JSON.stringify(text));
  }
});

test('front matter is always fine, even when it looks like unsupported syntax', () => {
  assert.deepEqual(supported('---\ntitle: <b>x</b>\nref: "[a]: b"\n---\n# Body\n'), { ok: true });
  assert.deepEqual(supported('+++\ntitle = "x"\n+++\nBody\n'), { ok: true });
});

test('raw HTML blocks, inline HTML and comments are rejected', () => {
  assert.match(reason('<div>raw</div>\n'), /HTML/);
  assert.match(reason('a <kbd>b</kbd> c\n'), /HTML/);
  assert.match(reason('text\n\n<!-- note -->\n'), /HTML/);
  assert.match(reason('- item with <br> break\n'), /HTML/);
});

test('reference-style definitions and footnotes are rejected', () => {
  assert.match(reason('[a][r]\n\n[r]: https://example.com\n'), /Reference-style/);
  assert.match(reason('Text[^1].\n\n[^1]: the note\n'), /Footnotes/);
  assert.match(reason('Text[^note].\n\n[^note]: https://example.com\n'), /Footnotes/);
});

test('entities that would be rewritten are rejected', () => {
  assert.match(reason('&copy; 2024\n'), /entities/);
  assert.match(reason('a&nbsp;b\n'), /entities/);
  assert.match(reason('| x |\n| - |\n| &#169; |\n'), /entities/);
});

test('files over the size limit are rejected', () => {
  assert.equal(RICH_MARKDOWN_MAX_BYTES > 0, true);
  assert.deepEqual(supported('a'.repeat(RICH_MARKDOWN_MAX_BYTES)), { ok: true });
  assert.match(reason('a'.repeat(RICH_MARKDOWN_MAX_BYTES + 1)), /too large/);
  // Measured in UTF-8 bytes, not characters.
  assert.match(reason('가'.repeat(Math.ceil(RICH_MARKDOWN_MAX_BYTES / 3) + 1)), /too large/);
});
