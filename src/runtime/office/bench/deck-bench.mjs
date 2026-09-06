// Score finished decks against the local rubric so a round leaves a number behind.
//   node src/runtime/office/bench/deck-bench.mjs .tmp/intro-deck-v3.pptx [more.pptx] [--history <file>]
// Each deck is opened, rendered, read into a composition receipt and a measured review, then scored
// (quality/pptx-deck-rubric.mjs). The run appends to a history file and prints the delta against the
// last entry for the same deck: the point is the movement between rounds, not the absolute number.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeOfficeTool } from '../index.mjs';
import { sessions } from '../core/office-core.mjs';
import { snapshot } from '../core/office-sessions.mjs';
import { render } from '../core/office-actions.mjs';
import { attachRenderedAir, compositionReceipt } from '../authoring/pptx-receipt.mjs';
import { renderedAirByPage } from '../quality/render-air.mjs';
import { isAdvisoryOfficeIssue } from '../quality/quality-pipeline.mjs';
import { scoreDeck } from '../quality/pptx-deck-rubric.mjs';

const value = (result) => JSON.parse(result.content[0].text);

async function benchDeck(path, { cwd = process.cwd() } = {}) {
  const opened = value(await executeOfficeTool({ action: 'open', path }, { cwd }));
  if (!opened.session) throw new Error(`open failed for ${path}`);
  const session = sessions.get(opened.session);
  try {
    // The same reading the author gets after a render: the full snapshot (never the paginated one),
    // the pixel air and balance of every page, and the measured half of the review.
    const current = await snapshot(session, { includeStyles: true, limit: 100, maxChars: 100_000 }, { full: true });
    const receipt = compositionReceipt(current?.document);
    const rendered = await render(session, {}, cwd);
    const byPage = await renderedAirByPage(rendered._images).catch(() => null);
    if (byPage) attachRenderedAir(receipt, byPage);
    const review = value(await executeOfficeTool({ action: 'qa', session: opened.session }, { cwd }));
    const issues = (review.issuesAfter || review.issues || []).filter((issue) => !isAdvisoryOfficeIssue(issue));
    return {
      deck: path,
      at: new Date().toISOString(),
      ...scoreDeck({ receipt, issues }),
      issues: issues.map((issue) => `${issue.code} ${issue.path || ''}`.trim()),
    };
  } finally {
    await executeOfficeTool({ action: 'close', session: opened.session, save: false }, { cwd }).catch(() => {});
  }
}

async function readHistory(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
}

async function main() {
  const argv = process.argv.slice(2);
  const historyAt = argv.indexOf('--history');
  const history = historyAt >= 0 ? argv[historyAt + 1] : '.tmp/pptx-deck-bench.json';
  const decks = argv.filter((arg, index) => !arg.startsWith('--') && !(historyAt >= 0 && index === historyAt + 1));
  if (!decks.length) {
    console.error('usage: node src/runtime/office/bench/deck-bench.mjs <deck.pptx> [more.pptx] [--history <file>]');
    process.exit(1);
  }
  const cwd = resolve('.');
  const past = await readHistory(history);
  const results = [];
  for (const deck of decks) {
    const result = await benchDeck(deck, { cwd });
    const previous = [...past].reverse().find((entry) => entry.deck === deck);
    const delta = previous && typeof previous.score === 'number' ? result.score - previous.score : null;
    results.push(result);
    console.log(`\n${deck}  score ${result.score}${delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta} vs ${previous.at.slice(0, 16).replace('T', ' ')})`}  ${result.slides} slides`);
    for (const check of result.checks) {
      const bar = '█'.repeat(Math.round(check.score * 10)).padEnd(10, '·');
      console.log(`  ${check.id.padEnd(20)} ${bar} ${check.score.toFixed(2)}  ${String(check.value).padEnd(6)} ${check.reads}`);
    }
    if (result.issues.length) console.log(`  measured defects: ${result.issues.join(' | ')}`);
  }
  await mkdir(dirname(resolve(history)), { recursive: true }).catch(() => {});
  await writeFile(history, JSON.stringify([...past, ...results], null, 2));
  console.log(`\nhistory → ${history} (${past.length + results.length} entries)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
