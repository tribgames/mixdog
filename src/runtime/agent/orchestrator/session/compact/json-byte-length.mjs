// UTF-8 byte length of JSON.stringify(value), computed without building the
// string. Plain objects and arrays are walked exactly as JSON.stringify
// serializes them: own enumerable string keys in Object.keys order, members
// whose value is undefined/function/symbol skipped in objects and written as
// null in arrays, and well-formed string escaping. Every other value — a
// toJSON owner, Date, Map, class instance, boxed primitive, BigInt — is
// measured through JSON.stringify itself under the same key. Returns
// undefined where JSON.stringify returns undefined and throws where it
// throws (cycles, BigInt).

const WALKED_PROTOTYPES = new Set([Object.prototype, Array.prototype, null]);

function quotedStringBytes(text) {
  let bytes = 2;
  const length = text.length;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      if (code >= 0x20) bytes += code === 0x22 || code === 0x5c ? 2 : 1;
      else bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6; // lone surrogate: \uXXXX
      }
    } else {
      bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
    }
  }
  return bytes;
}

// JSON.stringify's own answer for `value` as the member `key` of a holder,
// so toJSON(key) sees the same key it would inside the whole document.
function nativeBytes(value, key) {
  const json = JSON.stringify({ [key]: value });
  if (json === '{}') return undefined;
  return Buffer.byteLength(json, 'utf8') - quotedStringBytes(key) - 3;
}

function measure(value, key, stack) {
  switch (typeof value) {
    case 'string':
      return quotedStringBytes(value);
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4;
    case 'boolean':
      return value ? 4 : 5;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      return nativeBytes(value, key);
    default:
      break;
  }
  if (value === null) return 4;
  if (typeof value.toJSON === 'function' || !WALKED_PROTOTYPES.has(Object.getPrototypeOf(value))) {
    return nativeBytes(value, key);
  }
  if (stack.has(value)) throw new TypeError('Converting circular structure to JSON');
  stack.add(value);
  let bytes;
  if (Array.isArray(value)) {
    bytes = value.length ? 1 + value.length : 2;
    for (let index = 0; index < value.length; index += 1) {
      bytes += measure(value[index], String(index), stack) ?? 4;
    }
  } else {
    bytes = 2;
    let members = 0;
    for (const member of Object.keys(value)) {
      const memberBytes = measure(value[member], member, stack);
      if (memberBytes === undefined) continue;
      bytes += quotedStringBytes(member) + 1 + memberBytes;
      members += 1;
    }
    if (members > 1) bytes += members - 1;
  }
  stack.delete(value);
  return bytes;
}

/** Byte length of JSON.stringify(value) as the member `key` of its holder. */
export function jsonByteLength(value, key = '') {
  return measure(value, String(key), new Set());
}
