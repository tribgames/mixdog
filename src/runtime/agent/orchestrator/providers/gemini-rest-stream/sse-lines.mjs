// SSE `data:` line framing of the Gemini REST stream.

// The payload of one `data:` line; '' for other lines, blanks and [DONE].
export function sseDataPayload(line) {
  if (!line.startsWith('data: ')) return '';
  const data = line.slice(6).trim();
  return data === '[DONE]' ? '' : data;
}

// Every complete `data:` payload in the buffer; the incomplete tail stays.
export function drainSseDataLines(buffer) {
  const payloads = [];
  let rest = buffer;
  for (let lineEnd = rest.indexOf('\n'); lineEnd >= 0; lineEnd = rest.indexOf('\n')) {
    const line = rest.slice(0, lineEnd).replace(/\r$/, '');
    rest = rest.slice(lineEnd + 1);
    const data = sseDataPayload(line);
    if (data) payloads.push(data);
  }
  return { payloads, rest };
}
