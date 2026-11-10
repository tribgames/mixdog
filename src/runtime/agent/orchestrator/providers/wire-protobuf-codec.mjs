// Schema-driven protobuf wire codec shared by the handwritten provider wires.
//
// A schema table maps message type names to `protobufFields([...])` rows of
// `[name, fieldNo, type, options]`. Types are scalars ('string', 'bytes',
// 'raw', 'bool', 'int', 'uint', 'double', 'float'), another message type name
// from the same table, or `mapOf(keyType, valueType)`. Options:
//   repeated  — the field is an array (numeric ones packed only when the
//               codec is created with `packed: true`).
//   presence  — explicit presence (proto3 `optional` / oneof member): the value
//               is written even when it equals the type default.
// 'int' covers int32/int64/enum (two's-complement varint); 'uint' covers
// uint32/uint64. Both decode to number.
// Width-specific varint types follow protobuf's per-width rules instead:
//   'int32' / 'enum' — integer number, truncated to 32 bits; decodes to number.
//   'uint32'         — non-negative integer number, truncated to 32 bits; a
//                      varint longer than 5 bytes is rejected; decodes to number.
//   'int64'          — bigint, integer number or decimal string, truncated to
//                      64 bits; decodes to a signed bigint.
//   'uint64'         — as int64 but negative input is rejected; decodes to an
//                      unsigned bigint.
// Decoded objects carry only fields seen on the wire, plus `$unknown` for
// unrecognised fields.

export function protobufFields(entries) {
  return Object.fromEntries(entries.map(([name, no, type, options = {}]) => [no, { name, no, type, ...options }]));
}

export const mapOf = (key, value) => ({ map: [key, value] });
export const repeated = Object.freeze({ repeated: true });
export const presence = Object.freeze({ presence: true });

const textEncoder = new TextEncoder();
const WIDTH_TYPES = new Set(['int32', 'enum', 'uint32', 'int64', 'uint64']);
const PACKABLE_TYPES = new Set(['bool', 'int', 'uint', 'double', 'float', ...WIDTH_TYPES]);

export function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodeVarint(value) {
  let current = BigInt(value ?? 0);
  if (current < 0) current = BigInt.asUintN(64, current);
  const bytes = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Uint8Array.from(bytes);
}

export function encodeTag(no, wireType) {
  return encodeVarint((BigInt(no) << 3n) | BigInt(wireType));
}

function isDefaultScalar(value) {
  if (value === 0 || value === 0n || value === false || value === '') return true;
  return value instanceof Uint8Array && value.length === 0;
}

// `label` prefixes every error ("Cursor protobuf"). `strict` rejects wire-type
// mismatches, field number 0, malformed UTF-8, varints longer than 10 bytes and
// truncated fixed-width values instead of decoding them leniently.
// `omitDefaults` skips proto3 implicit-presence fields that hold their type
// default, which yields canonical proto3 bytes; repeated elements are always
// written, defaults included. `packed` encodes repeated numeric fields packed
// and decodes them from either packed or unpacked wire form.
export function createProtobufCodec(
  schemas,
  { label = 'protobuf', strict = false, omitDefaults = false, packed = false } = {}
) {
  // A protobuf string is data, not a text document with a disposable BOM.
  const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: strict });

  const isMessageType = (type) => typeof type === 'string' && Object.hasOwn(schemas, type);

  function wireTypeFor(type) {
    if (type === 'double') return 1;
    if (type === 'float') return 5;
    if (type?.map || ['string', 'bytes', 'raw'].includes(type) || isMessageType(type)) return 2;
    return 0;
  }

  function scalarBytes(type, value) {
    if (type === 'string') return textEncoder.encode(String(value));
    if (type === 'bytes' || type === 'raw') return value instanceof Uint8Array ? value : new Uint8Array(value);
    if (type === 'double' || type === 'float') {
      const size = type === 'double' ? 8 : 4;
      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      if (size === 8) view.setFloat64(0, Number(value), true);
      else view.setFloat32(0, Number(value), true);
      return new Uint8Array(buffer);
    }
    if (type === 'bool') return encodeVarint(value ? 1 : 0);
    if (type === 'int' || type === 'uint') return encodeVarint(value);
    if (WIDTH_TYPES.has(type)) return encodeVarint(BigInt.asUintN(64, BigInt(widthValue(type, value))));
    if (isMessageType(type)) return encodeMessage(type, value);
    throw new Error(`Unknown ${label} type: ${type}`);
  }

  // Validated, width-truncated value of a width-specific varint field.
  function widthValue(type, value) {
    if (type === 'int64' || type === 'uint64') {
      let big;
      if (typeof value === 'bigint') big = value;
      else if (typeof value === 'number' && Number.isInteger(value)) big = BigInt(value);
      else if (typeof value === 'string') {
        try {
          big = BigInt(value);
        } catch {
          // Reported below with the field type.
        }
      }
      if (big === undefined) throw new Error(`Invalid ${label} ${type} value: ${typeof value}`);
      if (type === 'uint64' && big < 0n) throw new Error(`Invalid ${label} uint64 value: negative`);
      return big;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`Invalid ${label} ${type} value: ${typeof value}`);
    }
    if (type === 'uint32') {
      if (value < 0) throw new Error(`Invalid ${label} uint32 value: negative`);
      return value >>> 0;
    }
    return value | 0;
  }

  function shouldWrite(type, value) {
    if (value == null) return false;
    if (WIDTH_TYPES.has(type)) return !(omitDefaults && BigInt(widthValue(type, value)) === 0n);
    if (type === 'string') return value !== '';
    if (omitDefaults && !isMessageType(type)) return !isDefaultScalar(value);
    return true;
  }

  function encodeField(no, type, value) {
    const wireType = wireTypeFor(type);
    const payload = scalarBytes(type, value);
    if (wireType === 2) return concatBytes([encodeTag(no, wireType), encodeVarint(payload.length), payload]);
    return concatBytes([encodeTag(no, wireType), payload]);
  }

  function encodeMapField(no, [keyType, valueType], value) {
    const parts = [];
    for (const [key, entryValue] of Object.entries(value || {})) {
      const entry = concatBytes([encodeField(1, keyType, key), encodeField(2, valueType, entryValue)]);
      parts.push(concatBytes([encodeTag(no, 2), encodeVarint(entry.length), entry]));
    }
    return parts;
  }

  function encodeMessage(type, value = {}) {
    const schema = schemas[type];
    if (!schema) throw new Error(`Unknown ${label} message: ${type}`);
    const parts = [];
    for (const descriptor of Object.values(schema)) {
      const fieldValue = value[descriptor.name];
      if (descriptor.type?.map) {
        parts.push(...encodeMapField(descriptor.no, descriptor.type.map, fieldValue));
        continue;
      }
      let values = [fieldValue];
      if (descriptor.repeated) {
        values = Array.isArray(fieldValue) ? fieldValue : [];
        if (packed && PACKABLE_TYPES.has(descriptor.type)) {
          if (values.length) {
            const payload = concatBytes(values.map((item) => scalarBytes(descriptor.type, item)));
            parts.push(concatBytes([encodeTag(descriptor.no, 2), encodeVarint(payload.length), payload]));
          }
          continue;
        }
      }
      for (const item of values) {
        // A oneof's explicit empty string is a value, not an absent field;
        // canonical proto3 keeps every repeated element.
        const explicit = descriptor.presence || (omitDefaults && descriptor.repeated);
        if ((explicit && item != null) || shouldWrite(descriptor.type, item)) {
          parts.push(encodeField(descriptor.no, descriptor.type, item));
        }
      }
    }
    return concatBytes(parts);
  }

  class ProtoReader {
    constructor(bytes) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.offset = 0;
    }

    get done() {
      return this.offset >= this.bytes.length;
    }

    varint() {
      let value = 0n;
      let shift = 0n;
      while (!this.done) {
        const byte = this.bytes[this.offset++];
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7n;
        if (shift > (strict ? 63n : 70n)) throw new Error(`Invalid ${label} varint`);
      }
      throw new Error(`Truncated ${label} varint`);
    }

    // A 32-bit varint: at most 5 bytes, bits past 32 dropped.
    varint32() {
      let value = 0n;
      for (let index = 0; index < 5; index++) {
        if (this.done) throw new Error(`Truncated ${label} varint`);
        const byte = this.bytes[this.offset++];
        value |= BigInt(byte & 0x7f) << BigInt(7 * index);
        if ((byte & 0x80) === 0) return Number(value & 0xffffffffn);
      }
      throw new Error(`Invalid ${label} 32-bit varint`);
    }

    take(length) {
      const end = this.offset + length;
      if (end > this.bytes.length) throw new Error(`Truncated ${label} field`);
      const value = this.bytes.subarray(this.offset, end);
      this.offset = end;
      return value;
    }

    bytesValue() {
      return this.take(Number(this.varint()));
    }

    skip(wireType) {
      if (wireType === 0) this.varint();
      else if (wireType === 1) this.take(8);
      else if (wireType === 2) this.bytesValue();
      else if (wireType === 5) this.take(4);
      else throw new Error(`Unsupported ${label} wire type: ${wireType}`);
    }
  }

  function decodeString(bytes) {
    try {
      return textDecoder.decode(bytes);
    } catch (error) {
      throw new Error(`Invalid ${label} UTF-8 string`, { cause: error });
    }
  }

  function decodeScalar(reader, type, wireType) {
    if (type === 'string') return decodeString(reader.bytesValue());
    if (type === 'bytes' || type === 'raw') return new Uint8Array(reader.bytesValue());
    if (type === 'double') {
      if (wireType !== 1) throw new Error(`Invalid ${label} double`);
      if (strict) {
        const bytes = reader.take(8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
      }
      // Lenient read: the view is bounded by the backing buffer only.
      const value = new DataView(reader.bytes.buffer, reader.bytes.byteOffset + reader.offset, 8).getFloat64(0, true);
      reader.offset += 8;
      return value;
    }
    if (type === 'float') {
      if (wireType !== 5) throw new Error(`Invalid ${label} float`);
      const bytes = reader.take(4);
      return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
    }
    if (type === 'bool') return reader.varint() !== 0n;
    if (type === 'int') return Number(BigInt.asIntN(64, reader.varint()));
    if (type === 'uint') return Number(reader.varint());
    if (type === 'int32' || type === 'enum') return Number(BigInt.asIntN(32, reader.varint()));
    if (type === 'uint32') return reader.varint32();
    if (type === 'int64') return BigInt.asIntN(64, reader.varint());
    if (type === 'uint64') return BigInt.asUintN(64, reader.varint());
    if (isMessageType(type)) return decodeMessage(type, reader.bytesValue());
    throw new Error(`Unknown ${label} type: ${type}`);
  }

  function checkWireType(descriptorName, type, wireType) {
    if (strict && wireType !== wireTypeFor(type)) {
      throw new Error(`Invalid ${label} wire type ${wireType} for ${descriptorName}`);
    }
  }

  function decodeMapEntry(bytes, [keyType, valueType]) {
    const reader = new ProtoReader(bytes);
    let key = '';
    let value = valueType === 'string' ? '' : undefined;
    while (!reader.done) {
      const tag = reader.varint();
      const no = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (no === 1) {
        checkWireType('map key', keyType, wireType);
        key = decodeScalar(reader, keyType, wireType);
      } else if (no === 2) {
        checkWireType('map value', valueType, wireType);
        value = decodeScalar(reader, valueType, wireType);
      } else reader.skip(wireType);
    }
    return [String(key), value];
  }

  function decodePacked(bytes, type) {
    const reader = new ProtoReader(bytes);
    const wireType = wireTypeFor(type);
    const values = [];
    while (!reader.done) values.push(decodeScalar(reader, type, wireType));
    return values;
  }

  function decodeMessage(type, bytes) {
    const schema = schemas[type];
    if (!schema) throw new Error(`Unknown ${label} message: ${type}`);
    const reader = new ProtoReader(bytes);
    const output = {};
    while (!reader.done) {
      const tag = reader.varint();
      const no = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (strict && no === 0) throw new Error(`Invalid ${label} field number 0`);
      const descriptor = schema[no];
      if (!descriptor) {
        const start = reader.offset;
        reader.skip(wireType);
        output.$unknown ||= [];
        output.$unknown.push({
          no,
          wireType,
          data: new Uint8Array(reader.bytes.subarray(start, reader.offset)),
        });
        continue;
      }
      if (descriptor.type?.map) {
        checkWireType(descriptor.name, descriptor.type, wireType);
        const [key, value] = decodeMapEntry(reader.bytesValue(), descriptor.type.map);
        output[descriptor.name] ||= {};
        output[descriptor.name][key] = value;
        continue;
      }
      if (packed && descriptor.repeated && wireType === 2 && PACKABLE_TYPES.has(descriptor.type)) {
        output[descriptor.name] ||= [];
        output[descriptor.name].push(...decodePacked(reader.bytesValue(), descriptor.type));
        continue;
      }
      checkWireType(descriptor.name, descriptor.type, wireType);
      const value = decodeScalar(reader, descriptor.type, wireType);
      if (descriptor.repeated) {
        output[descriptor.name] ||= [];
        output[descriptor.name].push(value);
      } else {
        output[descriptor.name] = value;
      }
    }
    return output;
  }

  return { encodeMessage, decodeMessage, encodeField, ProtoReader };
}
