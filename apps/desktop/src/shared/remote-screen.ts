/**
 * Screen-source helpers shared by the phone and the sender renderer
 * (docs/remote-screen.md). The wire types — `screen-input`, `screen-status`,
 * the capture plan and its constraints — are owned by remote-webrtc.ts; this
 * module adds only the phone's key table and the sender's track opener.
 */
import { remoteScreenCaptureConstraints, type RemoteScreenCapturePlan, type RemoteScreenKey } from './remote-webrtc';

// ---------------------------------------------------------------------------
// Keys: KeyboardEvent.code → virtual key + scan code (US physical layout)
// ---------------------------------------------------------------------------

const key = (vk: number, scan: number, extended = false): RemoteScreenKey => ({ vk, scan, extended });

const LETTER_SCANS = [
  0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f,
  0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
];
const NUMPAD_SCANS = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];

const KEY_TABLE: ReadonlyMap<string, RemoteScreenKey> = new Map<string, RemoteScreenKey>([
  ...LETTER_SCANS.map((scan, index): [string, RemoteScreenKey] => [
    `Key${String.fromCharCode(65 + index)}`,
    key(0x41 + index, scan),
  ]),
  ...Array.from({ length: 9 }, (_, index): [string, RemoteScreenKey] => [
    `Digit${index + 1}`,
    key(0x31 + index, 0x02 + index),
  ]),
  ['Digit0', key(0x30, 0x0b)],
  ...NUMPAD_SCANS.map((scan, index): [string, RemoteScreenKey] => [`Numpad${index}`, key(0x60 + index, scan)]),
  ...Array.from({ length: 10 }, (_, index): [string, RemoteScreenKey] => [
    `F${index + 1}`,
    key(0x70 + index, 0x3b + index),
  ]),
  ['F11', key(0x7a, 0x57)],
  ['F12', key(0x7b, 0x58)],
  ['Enter', key(0x0d, 0x1c)],
  ['NumpadEnter', key(0x0d, 0x1c, true)],
  ['Escape', key(0x1b, 0x01)],
  ['Backspace', key(0x08, 0x0e)],
  ['Tab', key(0x09, 0x0f)],
  ['Space', key(0x20, 0x39)],
  ['Minus', key(0xbd, 0x0c)],
  ['Equal', key(0xbb, 0x0d)],
  ['BracketLeft', key(0xdb, 0x1a)],
  ['BracketRight', key(0xdd, 0x1b)],
  ['Backslash', key(0xdc, 0x2b)],
  ['Semicolon', key(0xba, 0x27)],
  ['Quote', key(0xde, 0x28)],
  ['Backquote', key(0xc0, 0x29)],
  ['Comma', key(0xbc, 0x33)],
  ['Period', key(0xbe, 0x34)],
  ['Slash', key(0xbf, 0x35)],
  ['IntlBackslash', key(0xe2, 0x56)],
  ['CapsLock', key(0x14, 0x3a)],
  ['PrintScreen', key(0x2c, 0x37, true)],
  ['ScrollLock', key(0x91, 0x46)],
  ['Pause', key(0x13, 0x45)],
  ['Insert', key(0x2d, 0x52, true)],
  ['Home', key(0x24, 0x47, true)],
  ['PageUp', key(0x21, 0x49, true)],
  ['Delete', key(0x2e, 0x53, true)],
  ['End', key(0x23, 0x4f, true)],
  ['PageDown', key(0x22, 0x51, true)],
  ['ArrowRight', key(0x27, 0x4d, true)],
  ['ArrowLeft', key(0x25, 0x4b, true)],
  ['ArrowDown', key(0x28, 0x50, true)],
  ['ArrowUp', key(0x26, 0x48, true)],
  ['NumLock', key(0x90, 0x45, true)],
  ['NumpadDivide', key(0x6f, 0x35, true)],
  ['NumpadMultiply', key(0x6a, 0x37)],
  ['NumpadSubtract', key(0x6d, 0x4a)],
  ['NumpadAdd', key(0x6b, 0x4e)],
  ['NumpadDecimal', key(0x6e, 0x53)],
  ['ShiftLeft', key(0xa0, 0x2a)],
  ['ShiftRight', key(0xa1, 0x36)],
  ['ControlLeft', key(0xa2, 0x1d)],
  ['ControlRight', key(0xa3, 0x1d, true)],
  ['AltLeft', key(0xa4, 0x38)],
  ['AltRight', key(0xa5, 0x38, true)],
  ['MetaLeft', key(0x5b, 0x5b, true)],
  ['MetaRight', key(0x5c, 0x5c, true)],
  ['ContextMenu', key(0x5d, 0x5d, true)],
  // Korean IME keys: Han/Yeong and Hanja go by virtual key only.
  ['Lang1', key(0x15, 0)],
  ['Lang2', key(0x19, 0)],
]);

/** The key for a KeyboardEvent.code, or null for a code with no fixed key
 *  (the phone sends that character as `screen-text`). */
export function remoteScreenKeyForCode(code: string): RemoteScreenKey | null {
  const found = KEY_TABLE.get(code);
  return found ? { ...found } : null;
}

// ---------------------------------------------------------------------------
// Capture (hidden sender renderer)
// ---------------------------------------------------------------------------

/** Opens the plan's video track in the sender renderer; `contentHint`
 *  `detail` keeps text sharp under bandwidth pressure. */
export async function openRemoteScreenCaptureTrack(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  plan: RemoteScreenCapturePlan
): Promise<MediaStreamTrack> {
  const stream = await mediaDevices.getUserMedia(remoteScreenCaptureConstraints(plan));
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error('remote screen capture produced no video track');
  track.contentHint = 'detail';
  return track;
}
