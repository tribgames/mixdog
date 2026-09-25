// Filling the bundled template with real-length Korean copy: a two-line title and long step details, to see whether
// the page keeps its type inside its boxes.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const template = fileURLToPath(new URL('../../../src/runtime/office/design/library/templates/mixdog-executive.pptx', import.meta.url));
const mode = process.argv[2] || 'portable';
const out = `outputs/office-live-test/template/long-title-${mode}.pptx`;
const created = await call({ action: 'create', path: out, format: 'pptx', mode, overwrite: true });
const session = created.session;
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'use_template_page', path: template, after: 0, role: 'process', title: '야간 출고 전환은 네 단계로, 허브별 파일럿을 거쳐 전국으로 확대한다', items: [
      { title: '진단', body: '허브별 출고 대기와 반품 기간을 4주 측정' },
      { title: '파일럿', body: '평택에서 6주 시범 운영' },
      { title: '확대', body: '대전·인천에 반품 라인과 함께 적용' },
      { title: '정착', body: '운영 기준 문서화, 분기 점검' },
    ] },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => r.op)));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 1800));
const rendered = await call({ action: 'render', session });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session });
