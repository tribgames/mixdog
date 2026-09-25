// A review taken at a custom render width is accepted by finalize on an opened (not owned) PDF.
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (result) => JSON.parse(result.content[0].text);
const opened = value(
  await executeOfficeTool(
    { action: 'open', path: 'outputs/office-live-test/pdf/invoice.v2.pdf', output: 'outputs/office-live-test/pdf/invoice.v2.repro.pdf', operations: [{ op: 'highlight', find: '합계' }] },
    { cwd }
  )
);
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session, maxWidth: 1000 }, { cwd }));
const finalized = value(
  await executeOfficeTool(
    {
      action: 'finalize',
      session: opened.session,
      review: true,
      design: { reviewed: true, reviewToken: rendered.reviewToken, critique: [{ page: 1, verdict: 'pass', note: '합계 행에 형광펜이 걸렸고 표와 금액의 가독성은 그대로 유지된다. 페이지 여백과 순서도 원본과 같다.' }] },
    },
    { cwd }
  )
);
console.log(`ownership ${opened.ownership} finalized ${finalized.finalized ?? finalized.ok} ${finalized.reason || ''} ${JSON.stringify(finalized.visualReview?.blockers || [])}`);
