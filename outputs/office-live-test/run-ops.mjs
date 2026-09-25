// Working-tree harness: node outputs/office-live-test/run-ops.mjs <spec.json>
// spec: { path, format?, create?: {...extra create args}, operations: [...], render?: true, finalize?: { critique } }
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';

const value = (result) => JSON.parse(result.content[0].text);
const spec = process.argv[2].endsWith('.mjs')
  ? (await import(`file://${resolve(process.argv[2])}`)).default
  : JSON.parse(await readFile(process.argv[2], 'utf8'));
const cwd = resolve('.');
const created = value(
  await executeOfficeTool(
    { action: 'create', path: spec.path, overwrite: true, mode: 'portable', operations: spec.operations, ...(spec.create || {}) },
    { cwd }
  )
);
if (!created.session) {
  console.log(JSON.stringify(created, null, 1).slice(0, 3000));
  process.exit(2);
}
const audit = created.batch?.audit;
console.log(`created ${spec.path} session ${created.session} audit ${audit?.status} ${JSON.stringify(audit?.top || [])}`);
if (spec.render !== false) {
  const rendered = value(await executeOfficeTool({ action: 'render', session: created.session }, { cwd }));
  console.log(`rendered ${rendered.pageCount} pages (${rendered.renderer}) token ${rendered.reviewToken}`);
  for (const image of rendered.images || []) console.log(`  page ${image.page}: ${image.path}`);
  if (spec.finalize) {
    const finalized = value(
      await executeOfficeTool(
        { action: 'finalize', session: created.session, review: true, design: { reviewed: true, reviewToken: rendered.reviewToken, critique: spec.finalize.critique } },
        { cwd }
      )
    );
    console.log(`finalize: ${finalized.ok !== false ? 'ok' : 'failed'} ${JSON.stringify(finalized.error || finalized.issues?.slice?.(0, 5) || '')}`.slice(0, 2000));
  } else await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
}
const issues = value(
  await executeOfficeTool({ action: 'issues', path: spec.path, mode: 'portable', ...(spec.auditProfile ? { auditProfile: spec.auditProfile } : {}) }, { cwd })
);
console.log(`issues: ${JSON.stringify(issues.issues?.map((i) => `${i.code} ${i.path || ''} ${i.message || ''}`) ?? issues).slice(0, 2500)}`);
if (issues.session) await executeOfficeTool({ action: 'close', session: issues.session }, { cwd });
