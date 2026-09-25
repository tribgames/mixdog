// Opens third-party files, reads their snapshot and issues, and renders them: whatever the audit reports on a file
// nobody here wrote is either the file's own fault or a false alarm to fix.
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => {
  const text = (await executeOfficeTool(args, { cwd })).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};
for (const path of process.argv.slice(2)) {
  const opened = await call({ action: 'open', path, mode: 'portable' });
  if (opened.error) {
    console.log(path, 'open failed', opened.error.slice(0, 300));
    continue;
  }
  const issues = await call({ action: 'issues', session: opened.session });
  console.log(path, JSON.stringify((issues.issues || []).map((i) => `${i.severity} ${i.code} ${i.path} ${String(i.message).slice(0, 110)}`), null, 1).slice(0, 2500));
  const rendered = await call({ action: 'render', session: opened.session });
  console.log('  render', rendered.error || `${rendered.pageCount} pages ${(rendered.images || []).slice(0, 3).map((i) => i.path).join(' ')}`);
  await call({ action: 'close', session: opened.session });
}
