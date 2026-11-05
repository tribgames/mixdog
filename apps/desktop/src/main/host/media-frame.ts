/**
 * X17 host media frame (SPEC §4.1): 16-byte big-endian header, then the
 * payload. Layout mirrors `mixdog-app-protocol::media`.
 */
export const MEDIA_HEADER_LEN = 16;
export const MEDIA_PURPOSE_BROWSER_VIEW = 1;
export const MEDIA_FORMAT_JPEG = 1;
export const MEDIA_FLAG_FIT_SETTLED = 0b01;
export const MEDIA_FLAG_FIT_FAILED = 0b10;

export interface MediaFrameHeader {
  flags: number;
  streamId: number;
  width: number;
  height: number;
}

export function encodeMediaFrame(header: MediaFrameHeader, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(MEDIA_HEADER_LEN + payload.length);
  const view = new DataView(out.buffer);
  out[0] = MEDIA_PURPOSE_BROWSER_VIEW;
  out[1] = header.flags;
  view.setUint32(2, header.streamId);
  view.setUint16(6, header.width);
  view.setUint16(8, header.height);
  out[10] = MEDIA_FORMAT_JPEG;
  out.set(payload, MEDIA_HEADER_LEN);
  return out;
}
