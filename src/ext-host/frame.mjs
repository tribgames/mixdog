// Wire frames between the core's `mixdog-exthost` pool and one worker process.
// Mirror of native/core/crates/mixdog-exthost/src/frame.rs: change both together.
//
//   frame := len:u32be | kind:u8 | id:u32be | body
//
// `len` counts everything after itself (kind + id + body). `id` is the call id,
// 0 for frames that belong to no call.

export const Kind = Object.freeze({
  // core -> worker
  CALL: 1, // body: JSON {method, params, paths, thread, cwd}
  CANCEL: 2,
  CREDIT: 3, // body: u32be bytes of chunk window returned
  BROWSER: 4, // body: JSON {ws} | {error}; the answer to NEED_BROWSER
  BYE: 5,
  // worker -> core
  READY: 16, // the worker holds credit for one call; sent once at start
  CHUNK: 17, // body: raw bytes
  RESULT: 18, // body: JSON {ok, pin} | {err:{code,message}, pin}; returns the call credit
  NEED_BROWSER: 19,
});

export const HEADER_BYTES = 9;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Bytes of chunk data a call may have outstanding before the core consumes them. */
export const CALL_WINDOW_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;

const EMPTY = Buffer.alloc(0);

export function encodeFrame(kind, id = 0, body = EMPTY) {
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(5 + body.length, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32BE(id, 5);
  body.copy(out, HEADER_BYTES);
  return out;
}

export const encodeJsonFrame = (kind, id, value) => encodeFrame(kind, id, Buffer.from(JSON.stringify(value ?? null)));

/** Incremental decoder: feed raw bytes, get whole frames. */
export class FrameDecoder {
  #pending = EMPTY;

  push(bytes) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, bytes]) : bytes;
    const frames = [];
    for (;;) {
      if (this.#pending.length < 4) break;
      const length = this.#pending.readUInt32BE(0);
      if (length < 5 || length > MAX_FRAME_BYTES) throw new Error(`ext-host frame length ${length} is invalid`);
      if (this.#pending.length < 4 + length) break;
      frames.push({
        kind: this.#pending.readUInt8(4),
        id: this.#pending.readUInt32BE(5),
        body: this.#pending.subarray(HEADER_BYTES, 4 + length),
      });
      this.#pending = this.#pending.subarray(4 + length);
    }
    return frames;
  }
}
