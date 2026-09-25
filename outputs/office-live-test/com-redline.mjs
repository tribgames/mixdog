// Live Word parity: a tracked replace marks only the words between the shared ends.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};
await mkdir('outputs/office-live-test/com', { recursive: true });
const path = 'outputs/office-live-test/com/redline.docx';
const created = value(
  await executeOfficeTool(
    {
      action: 'create',
      path,
      overwrite: true,
      mode: 'background',
      operations: [
        { op: 'append_text', text: '2분기 영업이익은 86억 원으로 돌아섰고, 비용은 22% 낮아졌습니다.' },
        { op: 'track_changes', enabled: true },
        { op: 'replace_text', find: '86억 원으로', replace: '86억 원(잠정)으로', author: '재무검토' },
        { op: 'replace_text', find: '22% 낮아졌습니다', replace: '21.6% 낮아졌습니다', author: '재무검토' },
      ],
    },
    { cwd }
  )
);
console.log(created.backend, JSON.stringify(created.batch?.results?.slice(-2)));
await executeOfficeTool({ action: 'close', session: created.session, save: true }, { cwd });
const zip = await JSZip.loadAsync(await readFile(path));
const document = await zip.file('word/document.xml').async('string');
for (const match of document.matchAll(/<w:(del|ins) [^>]*>[\s\S]*?<\/w:\1>/g)) console.log(match[1], match[0].replace(/<[^>]+>/g, ''));
