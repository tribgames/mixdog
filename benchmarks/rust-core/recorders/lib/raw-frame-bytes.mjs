// The exact bytes a phone seals, including bytes no JavaScript string can produce through `TextEncoder` (invalid UTF-8, a BOM before
// the frame). The phone's E2EE channel (apps/desktop/src/shared/remote-e2ee.ts) seals `encoder.encode(JSON.stringify(value))` with a
// module-level `TextEncoder`; this replaces `TextEncoder.prototype.encode` for the process so that:
//  - a string holding `\uE001` followed by two hex digits is encoded with that byte in place of the three characters (a private-use
//    character no frame of the product holds, kept as it is by JSON.parse and JSON.stringify, so it rides through any re-serialization);
//  - a string holding `\uE002` is encoded without it and with a UTF-8 BOM (EF BB BF) before the first byte;
//  - `JSON.stringify(frame(text))` (a sealed frame given whole) is encoded as `text` alone, its markers resolved: a frame that is not
//    JSON at all (truncated, a lone byte) can be sealed as it stands.
// Every other string is encoded as before.
const BYTE = '\uE001';
const BOM = '\uE002';
const WHOLE = '\uE000';

const whole = new Map();
const original = TextEncoder.prototype.encode;

/** The text `text` with the byte `hex` (two hex digits) at that place once encoded. */
export const byte = (hex) => `${BYTE}${hex}`;
/** A marker anywhere in a frame: the frame's bytes start with a BOM. */
export const bom = BOM;

/** A value whose sealing gives exactly `text`'s bytes (markers resolved), for a frame that is not a JSON value. */
export function frame(text) {
  const key = `${WHOLE}${whole.size}`;
  whole.set(JSON.stringify(key), text);
  return key;
}

function bytesOf(text) {
  const prefix = text.includes(BOM) ? [0xef, 0xbb, 0xbf] : [];
  const parts = text.replaceAll(BOM, '').split(new RegExp(`${BYTE}([0-9a-f]{2})`));
  const out = [...prefix];
  parts.forEach((part, index) => {
    if (index % 2 === 1) out.push(Number.parseInt(part, 16));
    else out.push(...original.call(new TextEncoder(), part));
  });
  return new Uint8Array(out);
}

TextEncoder.prototype.encode = function encode(input = '') {
  const text = String(input);
  const given = whole.get(text);
  if (given !== undefined) return bytesOf(given);
  if (text.includes(BYTE) || text.includes(BOM)) return bytesOf(text);
  return original.call(this, text);
};
