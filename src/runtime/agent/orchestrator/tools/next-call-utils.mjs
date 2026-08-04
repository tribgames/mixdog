function parseJsonNextCalls(text) {
  const input = String(text ?? '');
  if (!input.includes('next_call:')) return [];
  const out = [];
  const re = /next_call:\s*([A-Za-z_][\w]*)\(/g;
  for (const match of input.matchAll(re)) {
    const parsed = parseNextCallArgs(input, match.index + match[0].length);
    if (!parsed) continue;
    out.push({ tool: match[1], args: parsed.args, start: match.index, end: parsed.end });
  }
  return out;
}

export function countJsonNextCalls(text) {
  return parseJsonNextCalls(text).length;
}

function parseNextCallArgs(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1).trim();
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== ')') return null;
        try { return { args: JSON.parse(raw), end: j + 1 }; }
        catch { return null; }
      }
    }
  }
  return null;
}
