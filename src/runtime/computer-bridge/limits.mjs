/** Shared transport budgets. Oversized/invalid replies never authorize a retry. */
export const MAX_COMPUTER_REQUEST_BYTES = 256 * 1024;
export const MAX_COMPUTER_INTERNAL_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_COMPUTER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_COMPUTER_TEXT_CHARS = 1_000_000;
export const MAX_COMPUTER_IMAGE_CHARS = 24 * 1024 * 1024;

export function validateComputerReply(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.text !== 'string' || value.text.length > MAX_COMPUTER_TEXT_CHARS) {
    throw new Error('computer bridge returned invalid or oversized text');
  }
  if (value.image !== undefined && (!value.image || typeof value.image.data !== 'string'
    || value.image.data.length > MAX_COMPUTER_IMAGE_CHARS
    || !['image/jpeg', 'image/png'].includes(value.image.mimeType))) {
    throw new Error('computer bridge returned an invalid or oversized image');
  }
}

export async function readComputerBridgeJson(response, maximum = MAX_COMPUTER_RESPONSE_BYTES) {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new Error('computer bridge response exceeds byte limit');
  }
  if (!response.body) throw new Error('computer bridge returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error('computer bridge response exceeds byte limit');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

export function createComputerLineDecoder(onLine, maximum = MAX_COMPUTER_RESPONSE_BYTES) {
  let pieces = [];
  let bytes = 0;
  return (chunk) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf('\n', start);
      const piece = chunk.slice(start, end < 0 ? undefined : end);
      bytes += Buffer.byteLength(piece);
      if (bytes > maximum) {
        pieces = [];
        throw new Error('computer_response_too_large: worker output exceeded byte limit');
      }
      pieces.push(piece);
      if (end < 0) return;
      const line = pieces.join('').replace(/\r$/, '');
      pieces = [];
      bytes = 0;
      onLine(line);
      start = end + 1;
    }
  };
}
