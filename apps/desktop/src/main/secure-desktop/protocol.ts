/**
 * TypeScript mirror of the secure-desktop IPC wire contract. Kept in lock-step
 * with `native/mixdog-secure-desktop/src/protocol.rs` and documented in
 * `native/mixdog-secure-desktop/docs/ipc-spec.md`. Pure (no Electron/Node I/O)
 * so it can be unit-tested directly.
 *
 * Frame layout:
 *   u32 LE bodyLen   bytes that follow (kind + payload)
 *   u8     kind       1 = control (JSON), 2 = video frame (binary)
 *   payload
 * Video payload: u32 LE headerLen, headerLen bytes of JSON, then raw BGRA.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** v2: mutual HMAC-SHA256 challenge-response replaced the plaintext-secret hello.
 *  v3: `desktop` is the input desktop's real object name, not a kind enum.
 *  v4: input and `sas` need a live control grant signed by the paired phone
 *  (`grant-challenge` / `grant` / `video-run`); `sas`; `locked` on
 *  `server-hello` / `desktop-changed`. */
export const PROTOCOL_VERSION = 4;

/** Longest desktop name the helper can report (its 256-unit `UOI_NAME` buffer). */
export const MAX_DESKTOP_NAME = 256;

/** The helper's per-frame total deadline (`FRAME_DEADLINE` in helper.rs): an
 *  inbound frame not dispatched, or an outbound write not completed (pipe
 *  backpressure — there are no frame acks), within it ends the connection. */
export const FRAME_DEADLINE_MS = 10_000;

/** Handshake nonce length in bytes (matches `security::NONCE_BYTES`). */
export const NONCE_BYTES = 16;

export const KIND_CONTROL = 1;
export const KIND_VIDEO = 2;

export const MAX_CONTROL_LEN = 1 << 20; // 1 MiB
export const MAX_VIDEO_LEN = 192 << 20; // 192 MiB

/**
 * The input desktop's object name exactly as Windows reports it — `Default`
 * for the ordinary desktop, `Winlogon` for the secure desktop (UAC consent,
 * Ctrl+Alt+Del, and the lock / sign-in screen all render there), or another
 * name such as `Screen-saver`. Compare case-insensitively.
 */
export type DesktopName = string;
export type PointerButton = 'left' | 'right' | 'middle';

export type InputEvent =
  | { kind: 'pointer-move'; x: number; y: number }
  | { kind: 'pointer-button'; button: PointerButton; down: boolean; x: number; y: number }
  | { kind: 'pointer-wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; down: boolean; vk: number; scan: number; extended: boolean }
  | { kind: 'text'; text: string };

export type ControlMessage =
  | { type: 'client-hello'; protocol: number; clientNonce: string }
  | { type: 'server-auth'; protocol: number; serverNonce: string; mac: string }
  | { type: 'client-auth'; mac: string }
  /** `locked`: the session's WTS lock state; absent when Windows reports it
   *  unknown. */
  | { type: 'server-hello'; protocol: number; version: string; session: number; desktop: DesktopName; locked?: boolean }
  | { type: 'desktop-changed'; desktop: DesktopName; session: number; locked?: boolean }
  | { type: 'input'; event: InputEvent }
  | { type: 'control'; active: boolean }
  /** The video run (the app's run epoch) the phone is shown. */
  | { type: 'video-run'; epoch: number }
  /** A one-shot challenge for the phone to sign: `nonce` is the connection's
   *  handshake server nonce; both base64 of 16 bytes. */
  | { type: 'grant-challenge'; nonce: string; challenge: string }
  /** The phone's base64 P-256 `r ‖ s` signature over the grant payload
   *  (shared/secure-desktop-grant.ts). */
  | { type: 'grant'; challenge: string; epoch: number; signature: string }
  /** Ctrl+Alt+Del through the service; needs active control and a live grant. */
  | { type: 'sas' }
  | { type: 'error'; code: string; message: string };

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameHeader {
  seq: number;
  width: number;
  height: number;
  stride: number;
  format: string;
  timestampMs: number;
  originX: number;
  originY: number;
  desktop: DesktopName;
  dirty: DirtyRect[];
}

export type DecodedFrame =
  | { kind: 'control'; message: ControlMessage }
  | { kind: 'video'; header: FrameHeader; pixels: Buffer };

// ---- Mutual challenge-response (mirrors security.rs) ----------------------

/** A fresh base64 handshake nonce. */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

/** Decode a base64 nonce, accepting only the exact nonce length. */
export function decodeNonce(encoded: unknown): Buffer | undefined {
  if (typeof encoded !== 'string') return undefined;
  const bytes = Buffer.from(encoded.trim(), 'base64');
  // Re-encode check rejects non-canonical / non-base64 input that Node would
  // otherwise decode leniently.
  if (bytes.length !== NONCE_BYTES || bytes.toString('base64') !== encoded.trim()) return undefined;
  return bytes;
}

function authTag(secretB64: string, label: string, first: Buffer, second: Buffer): string {
  return createHmac('sha256', Buffer.from(secretB64.trim(), 'base64'))
    .update(Buffer.from(label, 'ascii'))
    .update(first)
    .update(second)
    .digest('base64');
}

/** `HMAC(secret, "server" ‖ clientNonce ‖ serverNonce)` — the server's proof. */
export function serverAuthTag(secretB64: string, clientNonce: Buffer, serverNonce: Buffer): string {
  return authTag(secretB64, 'server', clientNonce, serverNonce);
}

/** `HMAC(secret, "client" ‖ serverNonce ‖ clientNonce)` — the client's proof. */
export function clientAuthTag(secretB64: string, serverNonce: Buffer, clientNonce: Buffer): string {
  return authTag(secretB64, 'client', serverNonce, clientNonce);
}

/** Constant-time comparison of two base64 tags. */
export function tagsMatch(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Schema validation ----------------------------------------------------

const POINTER_BUTTONS: readonly string[] = ['left', 'right', 'middle'];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Integer in [min, max]. Bounds are the Rust field types (u16/u32/i32/u64-safe). */
function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const U16 = 0xffff;
const U32 = 0xffff_ffff;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

function isDesktop(value: unknown): value is DesktopName {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DESKTOP_NAME;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** A video-run epoch: the helper's u64, bounded here to what JSON numbers
 *  carry exactly. */
function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validInput(event: unknown): boolean {
  if (!isObject(event)) return false;
  const xy = isInt(event.x, I32_MIN, I32_MAX) && isInt(event.y, I32_MIN, I32_MAX);
  switch (event.kind) {
    case 'pointer-move':
      return xy;
    case 'pointer-button':
      return xy && typeof event.down === 'boolean' && isString(event.button) && POINTER_BUTTONS.includes(event.button);
    case 'pointer-wheel':
      return xy && isInt(event.dx, I32_MIN, I32_MAX) && isInt(event.dy, I32_MIN, I32_MAX);
    case 'key':
      return (
        typeof event.down === 'boolean' &&
        isInt(event.vk, 0, U16) &&
        isInt(event.scan, 0, U16) &&
        typeof event.extended === 'boolean'
      );
    case 'text':
      return isString(event.text);
    default:
      return false;
  }
}

/**
 * Validate a parsed control payload against the message schema. Throws on
 * anything malformed (e.g. `null`, a missing/mistyped field, an unknown type),
 * so the parser's caller closes the connection instead of dispatching it.
 */
export function validateControl(value: unknown): ControlMessage {
  if (!isObject(value)) throw new Error('control message is not an object');
  const m = value;
  let ok: boolean;
  switch (m.type) {
    case 'client-hello':
      ok = isInt(m.protocol, 0, U32) && isString(m.clientNonce);
      break;
    case 'server-auth':
      ok = isInt(m.protocol, 0, U32) && isString(m.serverNonce) && isString(m.mac);
      break;
    case 'client-auth':
      ok = isString(m.mac);
      break;
    case 'server-hello':
      ok =
        isInt(m.protocol, 0, U32) &&
        isString(m.version) &&
        isInt(m.session, 0, U32) &&
        isDesktop(m.desktop) &&
        isOptionalBoolean(m.locked);
      break;
    case 'desktop-changed':
      ok = isDesktop(m.desktop) && isInt(m.session, 0, U32) && isOptionalBoolean(m.locked);
      break;
    case 'input':
      ok = validInput(m.event);
      break;
    case 'control':
      ok = typeof m.active === 'boolean';
      break;
    case 'video-run':
      ok = isEpoch(m.epoch);
      break;
    case 'grant-challenge':
      ok = isString(m.nonce) && isString(m.challenge);
      break;
    case 'grant':
      ok = isString(m.challenge) && isEpoch(m.epoch) && isString(m.signature);
      break;
    case 'sas':
      ok = true;
      break;
    case 'error':
      ok = isString(m.code) && isString(m.message);
      break;
    default:
      throw new Error('unknown control message type');
  }
  if (!ok) throw new Error(`malformed ${String(m.type)} message`);
  return m as unknown as ControlMessage;
}

/**
 * Validate a video header: schema, the BGRA format, and dimensions whose
 * `stride * height` cannot overflow and whose stride covers a full row.
 */
export function validateHeader(value: unknown): FrameHeader {
  if (!isObject(value)) throw new Error('video header is not an object');
  const h = value;
  const fieldsOk =
    Number.isSafeInteger(h.seq) && (h.seq as number) >= 0 &&
    isInt(h.width, 1, U32) &&
    isInt(h.height, 1, U32) &&
    isInt(h.stride, 1, U32) &&
    h.format === 'bgra' &&
    Number.isSafeInteger(h.timestampMs) && (h.timestampMs as number) >= 0 &&
    isInt(h.originX, I32_MIN, I32_MAX) &&
    isInt(h.originY, I32_MIN, I32_MAX) &&
    isDesktop(h.desktop) &&
    Array.isArray(h.dirty);
  if (!fieldsOk) throw new Error('malformed video header');
  const width = h.width as number;
  const height = h.height as number;
  const stride = h.stride as number;
  if (stride < width * 4) throw new Error('video stride smaller than a BGRA row');
  if (stride * height > MAX_VIDEO_LEN) throw new Error('video dimensions exceed the maximum frame size');
  for (const rect of h.dirty as unknown[]) {
    if (
      !isObject(rect) ||
      !isInt(rect.x, I32_MIN, I32_MAX) ||
      !isInt(rect.y, I32_MIN, I32_MAX) ||
      !isInt(rect.width, 0, U32) ||
      !isInt(rect.height, 0, U32)
    ) {
      throw new Error('malformed dirty rect');
    }
  }
  return h as unknown as FrameHeader;
}

function wrap(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

/** Encode a control message into a complete wire frame. */
export function encodeControl(message: ControlMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const payload = Buffer.allocUnsafe(1 + json.length);
  payload[0] = KIND_CONTROL;
  json.copy(payload, 1);
  return wrap(payload);
}

/** Encode a video frame. Only used by tests and tooling; the app never sends video. */
export function encodeVideo(header: FrameHeader, pixels: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const payload = Buffer.allocUnsafe(1 + 4 + json.length + pixels.length);
  payload[0] = KIND_VIDEO;
  payload.writeUInt32LE(json.length, 1);
  json.copy(payload, 5);
  pixels.copy(payload, 5 + json.length);
  return wrap(payload);
}

/** Decode a frame body (kind byte + payload). Throws on malformed input. */
export function decodeBody(body: Buffer): DecodedFrame {
  if (body.length < 1) throw new Error('empty frame body');
  const kind = body[0];
  const payload = body.subarray(1);
  if (kind === KIND_CONTROL) {
    if (payload.length > MAX_CONTROL_LEN) throw new Error('control message too large');
    return { kind: 'control', message: validateControl(JSON.parse(payload.toString('utf8'))) };
  }
  if (kind === KIND_VIDEO) {
    if (payload.length < 4) throw new Error('video frame missing header length');
    const headerLen = payload.readUInt32LE(0);
    if (headerLen > payload.length - 4) throw new Error('video header length out of range');
    const header = validateHeader(JSON.parse(payload.subarray(4, 4 + headerLen).toString('utf8')));
    const pixels = payload.subarray(4 + headerLen);
    const expected = header.stride * header.height;
    if (pixels.length !== expected) {
      throw new Error(`frame pixel length ${pixels.length} does not match stride*height ${expected}`);
    }
    return { kind: 'video', header, pixels: Buffer.from(pixels) };
  }
  throw new Error(`unknown frame kind ${kind}`);
}

/**
 * Streaming decoder: feed it socket chunks, get back whole frames. The pipe is
 * a byte stream, so a chunk may hold several frames or a partial one; this
 * buffers until each length-prefixed frame is complete.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.buffer.length >= 4) {
      const bodyLen = this.buffer.readUInt32LE(0);
      if (bodyLen === 0) throw new Error('empty frame');
      if (bodyLen > MAX_VIDEO_LEN) throw new Error('frame exceeds the maximum size');
      if (this.buffer.length < 4 + bodyLen) break;
      const body = this.buffer.subarray(4, 4 + bodyLen);
      frames.push(decodeBody(body));
      this.buffer = this.buffer.subarray(4 + bodyLen);
    }
    return frames;
  }
}
