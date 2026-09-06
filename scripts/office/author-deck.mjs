// Author a deck from the working tree's office runtime (the installed app runs its own copy):
//   node scripts/office/author-deck.mjs <script.js> <deck.pptx> [--mode portable|auto] [--render] [--critique critique.json] [--out result.json]
// author (measured, no render) → qa → measured issues; --render adds the page images, contact sheet, receipt,
// and reviewToken; --critique finalizes with the critique file (its reviewToken is filled from the render).
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';
import { isAdvisoryOfficeIssue } from '../../src/runtime/office/quality/quality-pipeline.mjs';

const value = (result) => JSON.parse(result.content[0].text);
const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : null; };
const positional = argv.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && argv[index - 1].startsWith('--') && !['--render'].includes(argv[index - 1])));
const [scriptPath, deckPath] = positional;
if (!scriptPath || !deckPath) {
  console.error('usage: node scripts/office/author-deck.mjs <script.js> <deck.pptx> [--mode portable|auto] [--render] [--critique critique.json] [--out result.json]');
  process.exit(1);
}
const cwd = resolve('.');
const script = await readFile(scriptPath, 'utf8');
const mode = flag('--mode') || 'portable';
const authored = value(await executeOfficeTool({ action: 'author', path: deckPath, script, mode, overwrite: true, render: false }, { cwd }));
if (!authored.ok) {
  console.error(`author failed: ${authored.error?.message}\n  line ${authored.error?.line}\n${authored.error?.excerpt || ''}`);
  process.exit(2);
}
const session = authored.session;
console.log(`authored ${deckPath} (${authored.backend}, kit ${authored.kit}, gradients ${authored.nativeGradients || 0}, ${authored.elapsedMs} ms)`);
const qa = value(await executeOfficeTool({ action: 'qa', session, render: false }, { cwd }));
const issues = (qa.issuesAfter || qa.issues || []);
const measured = issues.filter((issue) => !isAdvisoryOfficeIssue(issue));
console.log(`qa: ${measured.length} measured, ${issues.length - measured.length} advisory`);
for (const issue of issues) console.log(`  ${measured.includes(issue) ? '!' : '·'} ${issue.code} ${issue.path || ''} ${issue.message || ''}`);
const result = { deck: deckPath, session, authored: { kit: authored.kit, nativeGradients: authored.nativeGradients || 0, bytes: authored.bytes }, issues };
if (argv.includes('--render') || flag('--critique')) {
  const rendered = value(await executeOfficeTool({ action: 'render', session }, { cwd }));
  result.render = { output: rendered.output, pageCount: rendered.pageCount, reviewToken: rendered.reviewToken, images: (rendered.images || []).map((image) => image.path), contactSheet: rendered.contactSheet?.path || rendered.contactSheet };
  result.receipt = rendered.receipt;
  console.log(`rendered ${rendered.pageCount} pages → ${rendered.output}`);
  for (const image of rendered.images || []) console.log(`  page ${image.page}: ${image.path}`);
  if (rendered.contactSheet?.path) console.log(`  contact sheet: ${rendered.contactSheet.path}`);
  if (rendered.receipt?.deck?.rhythm) console.log(`  rhythm: ${JSON.stringify(rendered.receipt.deck.rhythm)}`);
}
const critiquePath = flag('--critique');
if (critiquePath) {
  const critique = JSON.parse(await readFile(critiquePath, 'utf8'));
  const finalized = value(await executeOfficeTool({ action: 'finalize', session, design: { reviewed: true, reviewToken: result.render.reviewToken, critique } }, { cwd }));
  result.finalize = finalized;
  console.log(`finalize: ${finalized.ok ? 'ok' : 'blocked'} ${JSON.stringify(finalized.summary || finalized.reason || finalized.issues?.slice(0, 5) || '')}`);
  if (!finalized.ok) for (const issue of finalized.issues || []) console.log(`  ! ${issue.code} ${issue.path || ''} ${issue.message || ''}`);
} else {
  await executeOfficeTool({ action: 'close', session, save: false }, { cwd }).catch(() => {});
}
const out = flag('--out');
if (out) await writeFile(out, JSON.stringify(result, null, 2));
process.exit(critiquePath && !result.finalize?.ok ? 3 : measured.length ? 4 : 0);
