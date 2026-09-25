// Template pages into an existing deck through the working-tree runtime: use_template_page by role, then render.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => JSON.parse(result.content[0].text);
const template = 'src/runtime/office/design/library/templates/mixdog-executive.pptx';
const deck = 'outputs/office-live-test/template/moapay-with-template.pptx';
await copyFile('outputs/office-live-test/pptx/moapay-ir.pptx', deck);
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path: deck,
      mode: 'portable',
      operations: [
        { op: 'use_template_page', path: template, after: 2, role: 'metrics', title: '세 지표가 모두 흑자 전환을 가리킨다', items: [{ value: '4.2배', label: 'LTV / CAC' }, { value: '81%', label: '12개월 유지율' }, { value: '14개월', label: '회수 기간' }] },
        { op: 'use_template_page', path: template, after: 6, role: 'comparison', title: '광고 대신 송금 링크로 사용자를 모았다', items: [{ title: '광고 유입', body: '획득 비용 3만 8천 원 · 12개월 유지율 42%' }, { title: '송금 링크 유입', body: '획득 비용 8천 4백 원 · 12개월 유지율 81%' }] },
      ],
    },
    { cwd }
  )
);
console.log(JSON.stringify(opened.batch?.results ?? opened, null, 1).slice(0, 3500));
console.log(`audit ${JSON.stringify(opened.batch?.audit?.top ?? [])}`.slice(0, 2000));
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session, pages: [3, 8] }, { cwd }));
for (const image of rendered.images || []) console.log(`page ${image.page}: ${image.path}`);
await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
