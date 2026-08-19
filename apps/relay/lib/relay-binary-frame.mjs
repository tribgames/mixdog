const MAGIC = Buffer.from([0x4d, 0x58, 0x52, 0x01]);
const HEADER_BYTES = 6;

export function encodeRelayBinaryFrame({ clientId, data, droppable = false }) {
  const id = Buffer.from(String(clientId || ''), 'utf8');
  const payload = Buffer.from(data);
  if (id.length < 1 || id.length > 64) throw new TypeError('clientId is invalid.');
  const frame = Buffer.allocUnsafe(HEADER_BYTES + id.length + payload.length);
  MAGIC.copy(frame, 0);
  frame[4] = droppable ? 1 : 0;
  frame[5] = id.length;
  id.copy(frame, HEADER_BYTES);
  payload.copy(frame, HEADER_BYTES + id.length);
  return frame;
}

export function decodeRelayBinaryFrame(raw) {
  const frame = Buffer.from(raw);
  if (frame.length < HEADER_BYTES + 1 || !frame.subarray(0, 4).equals(MAGIC)) return null;
  const idLength = frame[5];
  if (idLength < 1 || idLength > 64 || frame.length < HEADER_BYTES + idLength) return null;
  const clientId = frame.subarray(HEADER_BYTES, HEADER_BYTES + idLength).toString('utf8');
  if (!/^[0-9a-f-]{8,64}$/u.test(clientId)) return null;
  return {
    clientId,
    droppable: (frame[4] & 1) === 1,
    data: frame.subarray(HEADER_BYTES + idLength),
  };
}
