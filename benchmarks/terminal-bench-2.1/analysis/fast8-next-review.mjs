// Bounded raw event view for manual review; omissions are explicit, not verdicts.
// Usage: node analysis/fast8-next-review.mjs <jobs-dir> [task-id ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [root, ...tasks] = process.argv.slice(2);
const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
const clip = (text, limit) => text.length <= limit ? text
  : `${text.slice(0, Math.floor(limit / 2))} ...[${text.length - limit} chars omitted]... ${text.slice(-Math.ceil(limit / 2))}`;
for (const entry of readdirSync(report.paths.runDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.includes('__')) continue;
  const task = entry.name.split('__')[0];
  if (tasks.length && !tasks.includes(task)) continue;
  console.log(`\n## ${task}`);
  const events = readFileSync(join(report.paths.runDir, entry.name, 'agent/mixdog.txt'), 'utf8')
    .split(/\r?\n/).filter(s => s.trim()).map(JSON.parse);
  let request = 0;
  for (const event of events) {
    if (event.type === 'model.request.started') request++;
    if (event.type === 'model.request.failed') console.log(JSON.stringify(event));
    if (event.type !== 'item.completed') continue;
    const item = event.item;
    if (item?.type === 'tool_call') {
      const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      const output = typeof item.output === 'string' ? item.output
        : (item.output?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      console.log(JSON.stringify({ request, name: item.name, status: item.status,
        args: clip(JSON.stringify(args), tasks.length ? 14000 : args.patch ? 220 : 650),
        output: clip(output, tasks.length ? 1800 : 140) }));
    } else if (item?.type === 'agent_message') {
      console.log(JSON.stringify({ request, final: clip(item.text ?? '', 220) }));
    }
  }
}
