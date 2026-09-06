const WIDTHS = new Map([[0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8]]);
const needMore = () => Object.assign(new Error('GGUF metadata exceeds the inspected prefix'), { code: 'GGUF_NEED_MORE' });

// Only metadata is parsed. Tensor data and unneeded token arrays stay outside
// the retained result; all counts and prefix reads have explicit bounds.
export function parseGgufHeader(buffer) {
  let offset = 0;
  const need = (bytes) => { if (offset + bytes > buffer.length) throw needMore(); };
  const u32 = () => { need(4); const n = buffer.readUInt32LE(offset); offset += 4; return n; };
  const u64 = () => {
    need(8); const n = Number(buffer.readBigUInt64LE(offset)); offset += 8;
    if (!Number.isSafeInteger(n)) throw new Error('GGUF count exceeds safe integer range');
    return n;
  };
  const str = (retain = true) => {
    const length = u64();
    if (length > 16 * 1024 * 1024) throw new Error('GGUF string exceeds metadata limit');
    need(length);
    const value = retain ? buffer.toString('utf8', offset, offset + length) : null;
    offset += length;
    return value;
  };
  const value = (type, retain = true, depth = 0) => {
    if (depth > 1) throw new Error('GGUF nested arrays are unsupported');
    if (type === 8) return str(retain);
    if (type === 9) {
      const element = u32(), count = u64();
      if (count > 1_000_000) throw new Error('GGUF array exceeds metadata limit');
      if (WIDTHS.has(element)) { const bytes = count * WIDTHS.get(element); need(bytes); offset += bytes; }
      else for (let i = 0; i < count; i++) value(element, false, depth + 1);
      return null;
    }
    const width = WIDTHS.get(type);
    if (!width) throw new Error(`Unsupported GGUF metadata type ${type}`);
    need(width);
    let result = null;
    if (retain) {
      if (type === 4) result = buffer.readUInt32LE(offset);
      else if (type === 5) result = buffer.readInt32LE(offset);
      else if (type === 10) result = Number(buffer.readBigUInt64LE(offset));
      else if (type === 7) result = buffer[offset] !== 0;
      else if (type === 6) result = buffer.readFloatLE(offset);
    }
    offset += width;
    return result;
  };
  need(4);
  if (buffer.toString('ascii', 0, 4) !== 'GGUF') throw new Error('Selected file is not GGUF');
  offset = 4;
  const version = u32();
  if (version !== 2 && version !== 3) throw new Error(`Unsupported GGUF version ${version}`);
  const tensorCount = u64(), count = u64();
  if (tensorCount <= 0 || count > 100_000) throw new Error('Invalid GGUF model metadata counts');
  const metadata = {};
  for (let i = 0; i < count; i++) {
    const key = str();
    if (key.length > 1024) throw new Error('GGUF key exceeds metadata limit');
    const retain = key === 'general.architecture' || /\.(context_length|block_count|embedding_length|head_count|head_count_kv|key_length|value_length)$/.test(key);
    const item = value(u32(), retain);
    if (retain) metadata[key] = item;
  }
  const architecture = metadata['general.architecture'];
  if (architecture && ['context_length', 'block_count', 'embedding_length', 'attention.head_count', 'attention.head_count_kv']
    .every((name) => Number.isFinite(metadata[`${architecture}.${name}`]))) return { version, architecture, metadata };
  throw new Error('This GGUF lacks the attention metadata needed for a supported memory estimate; auxiliary or unsupported architecture files cannot be registered.');
}

export function ggufMemoryPlan(header, fileSize, requestedContext = 8192) {
  if (!Number.isSafeInteger(requestedContext) || requestedContext < 512 || requestedContext > 32768) {
    throw new Error('contextWindow must be between 512 and 32768 tokens.');
  }
  const { architecture, metadata } = header;
  if (!/^[a-z0-9_]+$/.test(architecture || '')) throw new Error('Invalid GGUF architecture');
  const positive = (name) => {
    const value = metadata[`${architecture}.${name}`];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GGUF ${name} is not a positive integer`);
    return value;
  };
  const modelContext = positive('context_length');
  const contextWindow = Math.min(requestedContext, modelContext);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 512 || contextWindow > 32768) throw new Error('contextWindow must be between 512 and 32768 tokens.');
  const dimension = positive('embedding_length') / positive('attention.head_count');
  const key = metadata[`${architecture}.attention.key_length`] || dimension;
  const val = metadata[`${architecture}.attention.value_length`] || dimension;
  if (![key, val].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Unsupported GGUF attention dimensions');
  // q8_0 K/V cache: 34 bytes per 32 values; reserve runtime working memory.
  const kvBytes = Math.ceil(contextWindow * positive('block_count') * positive('attention.head_count_kv') * (key + val) * 34 / 32);
  const estimatedVramBytes = fileSize + kvBytes + 1024 ** 3;
  if (!Number.isSafeInteger(estimatedVramBytes)) throw new Error('GGUF memory estimate exceeds safe range');
  return { architecture, contextWindow, maxContextWindow: modelContext, estimatedVramBytes, minimumVramBytes: estimatedVramBytes,
    memoryEstimate: { weightsBytes: fileSize, kvBytes, runtimeReserveBytes: 1024 ** 3, basis: 'weights + q8_0 attention KV + runtime reserve; estimate, not load verification' } };
}
