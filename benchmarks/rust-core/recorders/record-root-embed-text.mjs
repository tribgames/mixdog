// Records `rootEmbedText` (memory-embed.mjs): the text a root entry is embedded from.
// Usage: node record-root-embed-text.mjs --tree <mixdog checkout> --out <golden.json>
// Pure function; the data dir is a fresh temp dir set before any Mixdog import.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const data = mkdtempSync(join(tmpdir(), 'rootembed-'));
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
const embed = await import(pathToFileURL(join(arg('--tree'), 'src/runtime/memory/lib/memory-embed.mjs')).href);

const long = 'x'.repeat(9000);
const rows = [
  { name: 'element and summary only', element: 'el', summary: 'sum', role: null, content: null },
  { name: 'summary only', element: null, summary: 'sum', role: 'user', content: '' },
  { name: 'element only', element: 'el', summary: null, role: 'assistant', content: '   ' },
  { name: 'empty strings are skipped', element: '', summary: 'sum', role: 'user', content: 'hello' },
  { name: 'both empty', element: '', summary: '', role: 'user', content: 'hello' },
  { name: 'both null', element: null, summary: null, role: 'user', content: 'hello' },
  { name: 'user content joins', element: 'el', summary: 'sum', role: 'user', content: '  hello there \n' },
  { name: 'assistant content joins', element: null, summary: 'sum', role: 'Assistant', content: 'hi' },
  { name: 'role is trimmed and lowered', element: 'el', summary: null, role: ' USER ', content: 'hey' },
  { name: 'tool role is not embedded', element: 'el', summary: 'sum', role: 'tool', content: 'out' },
  { name: 'system role is not embedded', element: 'el', summary: 'sum', role: 'system', content: 'out' },
  { name: 'tool_call content', element: 'el', summary: 'sum', role: 'user', content: '[tool_call x]' },
  { name: 'tool_result content', element: 'el', summary: 'sum', role: 'assistant', content: ' [tool_result] x' },
  { name: 'runtime content', element: 'el', summary: 'sum', role: 'user', content: '[mixdog-runtime] note' },
  { name: 'async finished', element: 'el', summary: 'sum', role: 'user', content: 'Async job finished.' },
  { name: 'background task', element: 'el', summary: 'sum', role: 'user', content: 'Background task done' },
  { name: 'task notification', element: 'el', summary: 'sum', role: 'user', content: '<task-notification>x' },
  { name: 'bracketed system on a user row', element: 'el', summary: 'sum', role: 'user', content: '[system] hi' },
  { name: 'bracketed system on another role', element: 'el', summary: 'sum', role: 'note', content: '[Info] hi' },
  { name: 'other role plain content', element: 'el', summary: 'sum', role: 'note', content: 'plain' },
  { name: 'missing role', element: 'el', summary: 'sum', role: null, content: 'plain' },
  { name: 'non-breaking space around content', element: 'el', summary: null, role: 'user', content: '\u00a0hi\u00a0' },
  { name: 'unicode', element: '요소', summary: '요약', role: 'user', content: '안녕 😀' },
  { name: 'long content is not cut here', element: 'el', summary: 'sum', role: 'user', content: long },
];
const cases = rows.map((row) => ({ ...row, text: embed.rootEmbedText(row) }));
writeFileSync(arg('--out'), `${JSON.stringify({ node: process.version, cases }, null, 2)}\n`);
rmSync(data, { recursive: true, force: true });
console.log(`recorded ${cases.length} cases`);
process.exit(0);
