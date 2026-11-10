// The expanded aggregate card: numbered rows are rebuilt for the read members of the joined raw result only.
import { readRowsForDisplay } from '../../../packages/protocol-client/src/rows/read-row-numbers.mjs';
import { normalizeToolName } from '../../../packages/protocol-client/src/rows/tool-surface.mjs';

export function aggregateRawResultForDisplay(text) {
  if (typeof text !== 'string' || !/^\[lines \d+-\d+\]$/m.test(text)) return text;
  const lines = text.split('\n');
  const out = [];
  let member = [];
  let inRead = false;
  const flush = () => {
    if (member.length) out.push(inRead ? readRowsForDisplay(member.join('\n')) : member.join('\n'));
    member = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const header = (i === 0 || lines[i - 1] === '') && /^\d+\. (.+)$/.exec(lines[i]);
    if (!header) {
      member.push(lines[i]);
      continue;
    }
    flush();
    out.push(lines[i]);
    inRead = normalizeToolName(header[1]) === 'read';
  }
  flush();
  return out.join('\n');
}
