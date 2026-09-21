import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('wide tables strip header styles and label empty or missing headers with a dash', () => {
  const source = '| \x1b[31mName\x1b[0m | |\n| --- | --- |\n| abcdefghijklmnopqrstuv | tail | extra |';
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const script = `
    import { renderMarkdown } from ${JSON.stringify(new URL('./markdown.mjs', import.meta.url).href)};
    process.stdout.write(renderMarkdown(${JSON.stringify(source)}, { width: 20 }));
  `;
  const rendered = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(rendered, 'Name: abcdefghijklmnopqrstuv\n-: tail\n-: extra');
});
