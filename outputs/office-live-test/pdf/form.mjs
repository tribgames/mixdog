// A fillable PDF form (pdf skill: field / fieldRow blocks), filled afterwards with Korean values, then rendered.
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};
const path = 'outputs/office-live-test/pdf/pilot-form.pdf';
const created = value(
  await executeOfficeTool(
    {
      action: 'create',
      path,
      format: 'pdf',
      overwrite: true,
      properties: { title: 'Orbit 파일럿 신청서', pageSize: 'a4', margin: 56 },
      blocks: [
        { type: 'cover', eyebrow: 'ORBIT · PILOT Q4', title: '파일럿 신청서', subtitle: '10월 17일까지 제출해 주십시오.', meta: ['문의: pilot@orbit.example'] },
        { type: 'heading', text: '1. 신청 팀', level: 2 },
        { type: 'fieldRow', items: [{ name: 'team', label: '팀 이름', type: 'text' }, { name: 'lead', label: '담당 리더', type: 'text' }] },
        { type: 'fieldRow', items: [{ name: 'size', label: '팀 인원', type: 'text' }, { name: 'tool', label: '현재 도구', type: 'dropdown' }] },
        { type: 'heading', text: '2. 도입 범위', level: 2 },
        { type: 'field', name: 'scope', label: '파일럿에서 옮길 프로젝트와 기간', fieldType: 'text', height: 72, multiline: true },
        { type: 'fieldRow', items: [{ name: 'import', label: '기존 이슈 가져오기', type: 'checkbox' }, { name: 'rules', label: '자동 분류 규칙 사용', type: 'checkbox' }] },
        { type: 'callout', label: '안내', text: '신청이 확정되면 담당 리더에게 설정 일정을 메일로 보냅니다.' },
      ],
      fields: [],
    },
    { cwd }
  )
);
console.log(`created fields=${created.fields} form=${JSON.stringify(created.form ?? created.formIssues ?? '').slice(0, 400)}`);
await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path,
      output: 'outputs/office-live-test/pdf/pilot-form.filled.pdf',
      operations: [{ op: 'fill_form', values: { team: '결제플랫폼팀', lead: '김하늘', size: '12명', scope: '결제 API v3 이관 (2026년 10월–11월, 6주)', import: true, rules: true } }],
    },
    { cwd }
  )
);
console.log(JSON.stringify(opened.batch?.results).slice(0, 600));
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session }, { cwd }));
for (const image of rendered.images) console.log(image.path);
await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
