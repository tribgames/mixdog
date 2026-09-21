import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectProviderEvidence } from './evidence-union.mjs';
import { executeBuiltinTool } from '../tools/builtin.mjs';

function call(id, name, args = {}) {
  return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] };
}

function result(id, content) {
  return { role: 'tool', toolCallId: id, toolKind: 'normal', content };
}

test('requested read windows retain every line after overlapping grep context and reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-evidence-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = Array.from({ length: 450 }, (_, index) => `line ${index + 1}: ${'source '.repeat(8)}`);
  const file = join(root, 'tool.mjs');
  await writeFile(file, source.join('\n'));
  const grepArgs = { path: file, pattern: 'line (193|302):', context: 2 };
  const grep = await executeBuiltinTool('grep', grepArgs, root);
  const messages = [call('grep_1', 'grep', grepArgs), result('grep_1', grep)];
  for (const [offset, limit] of [
    [300, 130],
    [185, 21],
    [192, 4],
  ]) {
    const args = { file_path: file, offset, limit };
    const id = `read_${offset}`;
    const body = await executeBuiltinTool('read', args, root);
    messages.push(call(id, 'read', args), result(id, body));
    const projected = projectProviderEvidence(messages);
    const delivered = projected.messages.at(-1).content;
    const rows = delivered.split('\n').filter((line) => /^\d+[→│\t]/.test(line));
    assert.deepEqual(
      rows,
      source.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}→${line}`)
    );
    assert.match(delivered, new RegExp(`\\[lines ${offset}-${offset + limit - 1} of 450`));
    assert.equal(delivered, body);
    assert.deepEqual(projected.messages, messages);
    assert.equal(projected.stats.afterBytes, projected.stats.beforeBytes);
  }
});

test('repeated source results, listings, and long paths are delivered verbatim', () => {
  const path = `src/${'nested/'.repeat(10)}feature.mjs`;
  const source = `export const value = "${'한글'.repeat(60)}";`;
  const bodies = [
    ['read', `read 1\n\n${path} [ok]\n1→${source}\n[lines 1-1 of 1]`],
    ['grep', `# grep pattern:"value"\n# ${path}:1 [lines 1-1]\n${source}`],
    ['code_graph', `${path}:1-1:1 (javascript, export variable)\n1: ${source}`],
    ...['list', 'glob', 'find', 'find_files'].map((name) => [name, `${path}\n${'src/item.mjs\n'.repeat(40)}`]),
  ];
  const messages = bodies.flatMap(([name, body]) =>
    [1, 2].flatMap((n) => [call(`${name}_${n}`, name, { file_path: path }), result(`${name}_${n}`, body)])
  );
  for (const options of [undefined, { apply: false }, { enabled: false }, { pathAliases: true }]) {
    const projected = projectProviderEvidence(messages, options);
    assert.deepEqual(projected.messages, messages);
    assert.equal(projected.stats.changedToolResults, 0);
    assert.equal(projected.stats.afterBytes, projected.stats.beforeBytes);
  }
});
