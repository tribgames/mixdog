import { resolve } from 'node:path';
import { executeOfficeTool, resetOfficeSessionsForTest } from '../src/runtime/office/index.mjs';

function value(result) {
  if (result?.isError) throw new Error(result?.content?.[0]?.text || 'Office Use failed');
  return JSON.parse(result.content[0].text);
}

const cwd = process.cwd();
const output = resolve(cwd, process.argv[2] || 'Office-Use-Optimization-Report-v3.pptx');
const preview = resolve(cwd, process.argv[3] || 'Office-Use-Optimization-Report-v3.mixdog-preview.pdf');

const design = {
  profile: 'technical',
  intent: 'Show why semantic Office composition reduces orchestration overhead without sacrificing correctness.',
  audience: 'Product and engineering leaders',
  tone: 'decisive, precise, modern',
  density: 'light',
  palette: {
    canvas: 'F7FAFC',
    ink: '102A43',
    muted: '627D98',
    accent: '008C8C',
    accent2: 'E0A526',
    surface: 'E8F1F5',
    inverse: '0B1F33',
  },
  signature: 'operation traces, large numeric proof, and a clear input-to-output flow',
};

const operations = [
  {
    op: 'compose_slide',
    kind: 'cover',
    eyebrow: 'MIXDOG OFFICE USE',
    title: 'Office Use\nOptimization Report',
    subtitle: 'A semantic design system that turns multi-call choreography into one native document workflow.',
    meta: ['Runtime design review', 'August 2026'],
  },
  {
    op: 'compose_slide',
    kind: 'statement',
    eyebrow: 'BEFORE',
    title: 'The bottleneck was orchestration—not capability.',
    subtitle: 'A 21-operation report required 22 tool calls because layout, review, and polish were disconnected.',
    metric: { value: '22', label: 'tool calls' },
  },
  {
    op: 'compose_slide',
    kind: 'process',
    title: 'One contract replaces the choreography',
    steps: [
      { title: 'Brief', detail: 'Intent, audience, content, evidence' },
      { title: 'Compose', detail: 'Semantic layouts map to native Office objects' },
      { title: 'Render', detail: 'Every slide becomes inspectable evidence' },
      { title: 'Polish', detail: 'Critique feeds one deterministic repair batch' },
    ],
  },
  {
    op: 'compose_slide',
    kind: 'metrics',
    title: 'Less overhead. Same correctness.',
    subtitle: 'The optimized workflow preserves the result while reducing runtime and interaction cost.',
    metrics: [
      { value: '22 → 3', label: 'tool calls', detail: '−86% interaction overhead' },
      { value: '−44.6%', label: 'runtime', detail: 'fewer round trips and snapshots' },
      { value: '100%', label: 'accuracy', detail: 'native structure and QA retained' },
    ],
  },
  {
    op: 'compose_slide',
    kind: 'closing',
    eyebrow: 'DESIGN SYSTEM',
    title: 'One contract.\nMore work per turn.',
    subtitle: 'Brief → semantic composition → native formatting → render → critique → polish.',
    visualText: '3',
    visualLabel: 'calls',
  },
];

let session = '';
try {
  const created = value(await executeOfficeTool({
    action: 'create',
    path: output,
    format: 'pptx',
    mode: 'background',
    overwrite: true,
    design,
    operations,
  }, { cwd }));
  session = created.session;
  const rendered = value(await executeOfficeTool({
    action: 'render',
    session,
    output: preview,
  }, { cwd }));
  const finalized = value(await executeOfficeTool({
    action: 'finalize',
    session,
    design: { reviewed: true },
  }, { cwd }));
  process.stdout.write(`${JSON.stringify({
    ok: finalized.ok,
    reason: finalized.reason,
    blockingIssues: finalized.blockingIssues,
    nextAction: finalized.nextAction,
    validation: finalized.validation,
    output,
    preview,
    pageCount: rendered.pageCount,
    visualCoverage: rendered.visualCoverage,
    design: created.batch?.design,
    semanticOperations: created.batch?.semanticOperations,
    review: finalized.review?.review?.design,
    stepMetrics: finalized.stepMetrics,
  }, null, 2)}\n`);
} finally {
  resetOfficeSessionsForTest();
}
