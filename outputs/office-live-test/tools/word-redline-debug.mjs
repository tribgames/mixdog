// Times each step of the live redline test in background Word, to find which operation hangs.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => {
  const started = Date.now();
  const text = (await executeOfficeTool(args, { cwd })).content[0].text;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { error: text };
  }
  console.log(`${args.action}${args.operations ? ' ' + args.operations.map((o) => o.op + (o.find ? `:${o.find}` : '')).join(',') : ''} ${Date.now() - started}ms ${result.error ? 'ERR ' + String(result.error).slice(0, 200) : 'ok'}`);
  return result;
};
const dir = await mkdtemp(join(tmpdir(), 'redline-debug-'));
const word = await call({ action: 'create', path: join(dir, 'redline.docx'), format: 'docx', mode: 'background' });
const session = word.session;
await call({ action: 'batch', session, operations: [{ op: 'append_text', text: 'Alpha one.' }, { op: 'append_text', text: 'Beta two.' }, { op: 'add_table', values: [['Item', 'Price'], ['Widget', 'old']] }] });
await call({ action: 'batch', session, operations: [{ op: 'track_changes', enabled: true }] });
await call({ action: 'batch', session, operations: [{ op: 'replace_text', find: 'one', replace: 'uno', author: 'Alice' }] });
await call({ action: 'batch', session, operations: [{ op: 'replace_text', find: 'two', replace: 'dos', author: 'Bob' }] });
await call({ action: 'batch', session, operations: [{ op: 'replace_text', find: 'old', replace: 'new', author: 'Bob' }] });
await call({ action: 'batch', session, operations: [{ op: 'track_changes', enabled: false }] });
await call({ action: 'close', session });
