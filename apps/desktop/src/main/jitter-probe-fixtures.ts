const WORDS = ['transcript', 'virtualizer', 'anchors', 'the', 'bottom', 'while',
  'markdown', 'reflows', 'and', 'tool', 'cards', 'append', 'mid', 'stream'];

export function paragraph(seed: number, sentences: number): string {
  let out = '';
  for (let s = 0; s < sentences; s++) {
    const length = 6 + ((seed * 7 + s * 13) % 14);
    const words: string[] = [];
    for (let w = 0; w < length; w++) words.push(WORDS[(seed + s * 5 + w * 3) % WORDS.length]);
    out += `${words.join(' ')}. `;
  }
  return out.trim();
}

export function assistantMarkdown(seed: number): string {
  const kind = seed % 4;
  if (kind === 0) return paragraph(seed, 1);
  if (kind === 1) return `${paragraph(seed, 4)}\n\n${paragraph(seed + 1, 5)}`;
  if (kind === 2) {
    return `${paragraph(seed, 2)}\n\n${Array.from({ length: 5 }, (_, i) => `- item ${i}: ${paragraph(seed + i, 1)}`).join('\n')}`;
  }
  const codeLines = 8 + (seed % 9) + (seed % 7 === 0 ? 220 : 0);
  return `${paragraph(seed, 2)}\n\n\`\`\`ts\n${Array.from({ length: codeLines }, (_, i) => `const line${i} = probe(${seed}, ${i});`).join('\n')}\n\`\`\``;
}

export function probeItems(count: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 2) {
    items.push({ id: `probe-user-${i}`, kind: 'user', text: `probe question ${i}: ${paragraph(i, 1)}` });
    items.push({ id: `probe-assistant-${i}`, kind: 'assistant', text: assistantMarkdown(i) });
  }
  return items;
}

export function coldHistoryItems(count: number, stamp: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const startedAt = Date.now() - 60_000;
  for (let i = 0; i < count; i += 3) {
    items.push({
      id: `cold-${stamp}-user-${i}`,
      kind: 'user',
      text: `cold entry question ${i}: ${paragraph(i + stamp, 1)}`,
    });
    items.push({
      id: `cold-${stamp}-tool-${i}`,
      kind: 'tool',
      name: 'shell',
      args: { command: `npm run probe -- case-${i}` },
      result: `probe tool output ${i}\n${paragraph(i + stamp + 3, 2)}`,
      count: 1,
      startedAt,
      completedAt: startedAt + 1_200 + i,
    });
    items.push({
      id: `cold-${stamp}-assistant-${i}`,
      kind: 'assistant',
      text: `${assistantMarkdown(i + stamp)}

세션을 처음 열 때 한글 글꼴과 코드가 준비되어도 화면이 위아래로 움직이지 않아야 합니다.`,
    });
  }
  items.push({
    id: `cold-${stamp}-tool-tail`,
    kind: 'tool',
    name: 'shell',
    args: { command: 'npm run probe -- tail' },
    result: `probe tail output\n${paragraph(stamp + 11, 2)}`,
    count: 1,
    startedAt,
    completedAt: startedAt + 2_400,
  });
  return items;
}
