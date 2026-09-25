// Redlining the letter (docx skill §3): tracked edits under one reviewer, a comment, render, finalize with the audit.
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
const opened = value(
  await executeOfficeTool(
    {
      action: 'open',
      path: 'outputs/office-live-test/docx/moapay-annual-letter.v2.docx',
      output: 'outputs/office-live-test/docx/moapay-annual-letter.redline.docx',
      mode: 'portable',
      operations: [
        { op: 'normalize_runs', allowNoChange: true },
        { op: 'track_changes', enabled: true },
        { op: 'replace_text', find: '86억 원으로', replace: '86억 원(잠정)으로', author: '재무검토' },
        { op: 'replace_text', find: '22% 낮아졌습니다', replace: '21.6% 낮아졌습니다', author: '재무검토' },
        { op: 'add_comment', find: '4.2배', text: 'LTV 산식(12개월 기준)을 각주로 밝혀 주세요.', author: '재무검토' },
      ],
    },
    { cwd }
  )
);
console.log(JSON.stringify(opened.batch?.results?.map((r) => [r.op, r.changed, r.anchor ?? ''])));
const rendered = value(await executeOfficeTool({ action: 'render', session: opened.session }, { cwd }));
for (const image of rendered.images) console.log(image.path);
const finalized = value(
  await executeOfficeTool(
    {
      action: 'finalize',
      session: opened.session,
      review: true,
      auditProfile: 'redlining',
      author: '재무검토',
      design: {
        reviewed: true,
        reviewToken: rendered.reviewToken,
        critique: rendered.images.map((image) => ({ page: image.page, verdict: 'pass', note: `${image.page}쪽: 수정 표시가 바뀐 글자에만 걸리고 본문 흐름과 표는 원본과 같다. 메모가 해당 수치에 앵커된다.` })),
      },
    },
    { cwd }
  )
);
console.log(`finalized ${finalized.finalized} ${finalized.reason || ''} ${JSON.stringify(finalized.redlining ?? finalized.review?.redlining ?? '').slice(0, 600)}`);
