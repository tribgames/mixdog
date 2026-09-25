// Renders a file through Microsoft Office (background mode) for a side-by-side with the LibreOffice preview.
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => JSON.parse((await executeOfficeTool(args, { cwd })).content[0].text);
const [file, pages = ''] = process.argv.slice(2);
const opened = await call({ action: 'open', path: file, mode: 'background' });
console.log('open', opened.session, opened.backend, opened.error || '');
const rendered = await call({ action: 'render', session: opened.session, ...(pages ? { pages: pages.split(',').map(Number) } : {}) });
console.log('render', rendered.renderer, rendered.pageCount, rendered.error || '', (rendered.images || []).map((i) => i.path).join('\n  '));
await call({ action: 'close', session: opened.session });
