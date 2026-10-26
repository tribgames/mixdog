import { packPlaintext, relayE2EECompressionSupported, unpackPlaintext } from './remote-e2ee-compression';
export { relayE2EECompressionSupported } from './remote-e2ee-compression';

const E2EE_VERSION = 1 as const;
const E2EE_CONTEXT = 'mixdog-relay-e2ee-v1';
const E2EE_BINARY_MAGIC = new Uint8Array([0x4d, 0x58, 0x45, 0x01]);
const E2EE_BINARY_HEADER_BYTES = 24;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RelayE2EEPairingMaterial {
  version: typeof E2EE_VERSION;
  serverPublicKey: string;
  pairingSecret: string;
}

export interface RelayE2EEServerIdentity extends RelayE2EEPairingMaterial {
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

export interface RelayE2EEChallenge {
  type: 'e2ee-challenge';
  version: typeof E2EE_VERSION;
  challenge: string;
  binaryFrames?: 1;
  listDelta?: 1;
  /** The desktop can deflate payloads; the browser echoes it when it can
   *  inflate them. An older peer on either side simply omits it. */
  deflate?: 1;
  /** Compact transcript frames: unchanged patch sections are omitted and the
   *  envelope is addressed by session handle instead of by name. */
  compactWire?: 1;
  /** Transcripts open on a bounded tail and page older history on demand
   *  (`transcriptHasOlder`); a browser that does not echo it keeps the
   *  512-item page. */
  transcriptPaging?: 1;
  /** An older-history page travels as a prepend patch (only the revealed
   *  rows); a browser that does not echo it receives the whole list. */
  transcriptPrepend?: 1;
  /** This host serves this release's remote methods (previews, PR calls,
   *  updater, trash, ...). Absent on an older host. */
  remoteParity?: 1;
  /** This host serves the remote browser pane's tabs, history, saved-login
   *  fill and profile import. Absent on an older host. */
  browserParity?: 1;
  /** This host takes the remote browser pane's `viewport` control: the
   *  streamed page renders at the phone's size as a mobile page. Absent on an
   *  older host, which rejects that control. */
  browserDrive?: 1;
  /** This host streams a conversation browser's tab strip in its frames and
   *  takes the `new-tab`, `select-tab` and `close-tab` controls. Absent on an
   *  older host: the phone offers no new tab there. */
  browserSessionTabs?: 1;
  /** This host honors the terminal size-owner protocol (the 4th `termResize`
   *  argument: phone claims, the 0x0 release). Absent on an older host, which
   *  would resize the PTY to those grids: the phone sends only plain fits. */
  termSizeOwner?: 1;
  /** This host serves `listHostDirectories` (the project-less host folder
   *  browser). Absent on an older host. */
  hostDirectories?: 1;
  /** This host journals workspace edits and serves project recovery requests. */
  projectRecovery?: 1;
  /** This host serves the HTTP media lane as end-to-end encrypted frames
   *  (shared/remote-media-crypto.ts) under keys derived from this session. */
  mediaE2ee?: 1;
  /** This host accepts `registerNativePush` (APNs/FCM through a relay that
   *  holds the credentials). Absent on an older host or an unable relay. */
  nativePush?: 1;
  /** This host accepts per-route Auto reasoning (`autoEffort` in model
   *  selections, `+noauto` automation refs). Absent on an older host. */
  routeAutoEffort?: 1;
  /** This host serves the agent visualize panel (`visualizeState`,
   *  `visualizeCommand`, pane reads, the visualize push lane). Absent on an
   *  older host. */
  visualize?: 1;
  /** This host serves host file downloads (shared/file-downloads.ts:
   *  `fileDownloadAuthorize`/`Begin`/`Range`/`Finish`/`Abort`) and confines
   *  `resolveLocalPaths`/`readLocalFile` to project and assistant-linked
   *  files. Absent on an older host: downloads report `host-too-old`. */
  fileDownloads?: 1;
  /** This host serves the live view over WebRTC (shared/remote-webrtc.ts,
   *  value = REMOTE_WEBRTC_VERSION). Absent on an older host: JPEG only. */
  browserWebrtc?: 1;
  /** This host fits a take-over's page (`fit` on the stream request) and marks
   *  frames of the fitted layout `fitSettled: true` (shared/remote-webrtc.ts
   *  REMOTE_BROWSER_FIT_CAPABILITY). Absent on an older host: `fit` is ignored
   *  and no frame is ever marked, so a phone must not wait for one. */
  browserFit?: 1;
  /** This host carries the session's traffic as the carrier-independent
   *  stream of shared/remote-transport.ts (value REMOTE_TRANSPORT_VERSION):
   *  directional per-domain keys, sequenced records, authenticated acks.
   *  Effective only when the browser echoes it AND both sides use binary
   *  frames; otherwise the session is legacy, byte for byte. */
  transportWebrtc?: 1;
}

interface RelayE2EEHello {
  type: 'e2ee-hello';
  version: typeof E2EE_VERSION;
  challenge: string;
  clientPublicKey: string;
  proof: string;
  binaryFrames?: 1;
  listDelta?: 1;
  deflate?: 1;
  compactWire?: 1;
  transcriptPaging?: 1;
  transcriptPrepend?: 1;
  viewSync?: 1;
  transportWebrtc?: 1;
}

interface RelayE2EEBox {
  type: 'e2ee-box';
  version: typeof E2EE_VERSION;
  sequence: number;
  nonce: string;
  ciphertext: string;
}

function cryptoApi(): Crypto {
  const value = globalThis.crypto;
  if (!value?.subtle) throw new Error('Web Crypto is unavailable.');
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  return cryptoApi().getRandomValues(new Uint8Array(length));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function binaryBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function encodeBinaryBox(sequence: number, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(E2EE_BINARY_HEADER_BYTES + ciphertext.byteLength);
  output.set(E2EE_BINARY_MAGIC, 0);
  new DataView(output.buffer).setBigUint64(4, BigInt(sequence), false);
  output.set(nonce, 12);
  output.set(ciphertext, E2EE_BINARY_HEADER_BYTES);
  return output;
}

function decodeBinaryBox(value: unknown): {
  sequence: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} | null {
  const bytes = binaryBytes(value);
  if (!bytes || bytes.byteLength < E2EE_BINARY_HEADER_BYTES + 16) return null;
  if (E2EE_BINARY_MAGIC.some((byte, index) => bytes[index] !== byte)) return null;
  const rawSequence = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(4, false);
  if (rawSequence < 1n || rawSequence > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    sequence: Number(rawSequence),
    nonce: bytes.slice(12, 24),
    ciphertext: bytes.slice(E2EE_BINARY_HEADER_BYTES),
  };
}

/** `transcript` is set only on the transport proof: the legacy proof is the
 *  original payload, byte for byte. */
function proofPayload(
  challenge: string,
  serverPublicKey: string,
  clientPublicKey: string,
  transcript: string | null = null
): Uint8Array {
  const legacy = `${E2EE_CONTEXT}\0hello\0${challenge}\0${serverPublicKey}\0${clientPublicKey}`;
  return encoder.encode(transcript === null ? legacy : `${legacy}\0transport\0${transcript}`);
}

/** Stable JSON: object keys sorted, `undefined` members dropped (as
 *  JSON.stringify drops them on the wire). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .filter((key) => fields[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The handshake transcript: SHA-256 over the challenge exactly as offered
 *  and the hello exactly as sent (without its proof), canonical JSON. Every
 *  capability either side offered or selected — binary framing and the
 *  transport flag included — is in it, so a relay that adds, strips or
 *  alters one makes the two ends compute different transcripts. */
async function handshakeTranscript(challenge: object, hello: object): Promise<string> {
  const unsigned: Record<string, unknown> = { ...(hello as Record<string, unknown>) };
  delete unsigned.proof;
  const digest = await cryptoApi().subtle.digest(
    'SHA-256',
    arrayBuffer(encoder.encode(`${E2EE_CONTEXT}\0transcript\0${canonicalJson(challenge)}\0${canonicalJson(unsigned)}`))
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey(
    'raw',
    arrayBuffer(base64UrlDecode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function helloProof(
  secret: string,
  challenge: string,
  serverPublicKey: string,
  clientPublicKey: string,
  transcript: string | null = null
): Promise<string> {
  const signature = await cryptoApi().subtle.sign(
    'HMAC',
    await importHmacKey(secret),
    arrayBuffer(proofPayload(challenge, serverPublicKey, clientPublicKey, transcript))
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyHelloProof(
  identity: RelayE2EEServerIdentity,
  hello: RelayE2EEHello,
  transcript: string | null = null
): Promise<boolean> {
  return cryptoApi().subtle.verify(
    'HMAC',
    await importHmacKey(identity.pairingSecret),
    arrayBuffer(base64UrlDecode(hello.proof)),
    arrayBuffer(proofPayload(hello.challenge, identity.serverPublicKey, hello.clientPublicKey, transcript))
  );
}

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function importPublicKey(raw: string): Promise<CryptoKey> {
  const bytes = base64UrlDecode(raw);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error('Invalid P-256 public key.');
  return cryptoApi().subtle.importKey('raw', arrayBuffer(bytes), ECDH_P256, false, []);
}

async function importEcdhPrivateKey(jwk: JsonWebKey, extractable: boolean): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey('jwk', jwk, ECDH_P256, extractable, ['deriveBits']);
}

async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await cryptoApi().subtle.generateKey(ECDH_P256, true, ['deriveBits'])) as CryptoKeyPair;
}

async function exportRawPublicKey(key: CryptoKey): Promise<string> {
  return base64UrlEncode(new Uint8Array(await cryptoApi().subtle.exportKey('raw', key)));
}

/** ECDH shared secret → HKDF-SHA-256 → non-extractable AES-GCM-256 key. */
async function deriveAesGcmKey(
  privateKey: CryptoKey,
  peerPublicKey: string,
  salt: Uint8Array,
  info: Uint8Array
): Promise<CryptoKey> {
  const sharedBits = await cryptoApi().subtle.deriveBits(
    { name: 'ECDH', public: await importPublicKey(peerPublicKey) },
    privateKey,
    256
  );
  const keyMaterial = await cryptoApi().subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return cryptoApi().subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: arrayBuffer(salt), info: arrayBuffer(info) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveChannelKey(input: {
  privateKey: CryptoKey;
  peerPublicKey: string;
  pairingSecret: string;
  challenge: string;
  serverPublicKey: string;
  clientPublicKey: string;
}): Promise<CryptoKey> {
  return deriveAesGcmKey(
    input.privateKey,
    input.peerPublicKey,
    base64UrlDecode(input.pairingSecret),
    encoder.encode(`${E2EE_CONTEXT}\0key\0${input.challenge}\0${input.serverPublicKey}\0${input.clientPublicKey}`)
  );
}

function isBox(value: unknown): value is RelayE2EEBox {
  const row = value as Partial<RelayE2EEBox> | null;
  return (
    row?.type === 'e2ee-box' &&
    row.version === E2EE_VERSION &&
    Number.isSafeInteger(row.sequence) &&
    Number(row.sequence) > 0 &&
    typeof row.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16}$/u.test(row.nonce) &&
    typeof row.ciphertext === 'string' &&
    /^[A-Za-z0-9_-]{22,}$/u.test(row.ciphertext) &&
    row.ciphertext.length % 4 !== 1
  );
}

/** A second key from the same ECDH secret, separated by its HKDF info: it
 *  protects HTTP media bytes and never touches the relay. Non-extractable, so
 *  it can be handed to the service worker (structured clone) but not read. */
async function deriveMediaKey(input: {
  privateKey: CryptoKey;
  peerPublicKey: string;
  pairingSecret: string;
  challenge: string;
  serverPublicKey: string;
  clientPublicKey: string;
}): Promise<CryptoKey> {
  return deriveAesGcmKey(
    input.privateKey,
    input.peerPublicKey,
    base64UrlDecode(input.pairingSecret),
    encoder.encode(`${E2EE_CONTEXT}\0media\0${input.challenge}\0${input.serverPublicKey}\0${input.clientPublicKey}`)
  );
}

/** Transport sessions (shared/remote-transport.ts) split traffic into two
 *  ordering domains, each with its own key PER DIRECTION:
 *    app      the sequenced application stream; the stream core releases it
 *             in order, so the high-water rule below still holds,
 *    control  signaling, acks and liveness; one sequence space across
 *             carriers, replay-checked per FIFO lane (RelayE2EEControlLane).
 *  A record sealed in one domain or direction never opens in another: the key
 *  differs, and the AAD names domain, direction and sequence as well. */
export type RelayE2EEDomain = 'app' | 'control';
type Direction = 'client-to-server' | 'server-to-client';

export interface RelayE2EETransportKeys {
  appSend: CryptoKey;
  appReceive: CryptoKey;
  controlSend: CryptoKey;
  controlReceive: CryptoKey;
}

/** A control lane: one FIFO carrier of control boxes — the relay, or one
 *  direct peer connection's ordered control channel, named by its
 *  `connectionId` and its EPOCH: the signaling `generation` of the offer that
 *  first created that connection (an ICE restart raises the generation but
 *  keeps the connection, and so its epoch). The lane is bound into the AAD
 *  at seal time, so a box opens only on the lane it was sealed for. Replay
 *  is checked per lane against its high-water mark: within a FIFO lane no
 *  genuine box can be overtaken, so the reorder window is 0, and across
 *  lanes no order is assumed (docs/remote-transport.md §10). */
export type RelayE2EEControlLane =
  | { kind: 'relay' }
  | { kind: 'direct'; epoch: number; connectionId: string };

export const RELAY_E2EE_RELAY_LANE: RelayE2EEControlLane = Object.freeze({ kind: 'relay' });

type DirectLane = Extract<RelayE2EEControlLane, { kind: 'direct' }>;
interface ControlLaneState {
  highWater: number;
}
interface DirectLaneState extends ControlLaneState {
  epoch: number;
  connectionId: string;
}

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function controlLane(value: unknown): RelayE2EEControlLane {
  const lane = value as { kind?: unknown; epoch?: unknown; connectionId?: unknown } | null | undefined;
  if (lane?.kind === 'relay') return RELAY_E2EE_RELAY_LANE;
  if (
    lane?.kind === 'direct' &&
    typeof lane.epoch === 'number' &&
    Number.isSafeInteger(lane.epoch) &&
    lane.epoch >= 1 &&
    typeof lane.connectionId === 'string' &&
    CONNECTION_ID_PATTERN.test(lane.connectionId)
  ) {
    return { kind: 'direct', epoch: lane.epoch, connectionId: lane.connectionId };
  }
  throw new Error('Expected a control lane.');
}

function controlLaneLabel(lane: RelayE2EEControlLane): string {
  return lane.kind === 'relay' ? 'relay' : `direct\0${lane.epoch}\0${lane.connectionId}`;
}

function sameDirectLane(state: DirectLaneState | null, lane: DirectLane): state is DirectLaneState {
  return state !== null && state.epoch === lane.epoch && state.connectionId === lane.connectionId;
}
const E2EE_CONTROL_MAGIC = new Uint8Array([0x4d, 0x58, 0x43, 0x01]);
/** Largest application plaintext ONE transport record carries, before and
 *  after deflate: the sender refuses a larger body before a sequence is
 *  assigned, the receiver inflates no further. 1 MiB is the unit the phone
 *  already takes in one piece on the media lane (public/sw-media.js
 *  WINDOW_BYTES, main/remote-relay-media.ts MEDIA_WINDOW_MAX_BYTES). Larger
 *  payloads are split above the record layer (remote-transport.ts
 *  `splitRemoteTransportPayload`). Legacy sessions keep
 *  MAX_E2EE_PLAINTEXT_BYTES. */
export const RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES = 1024 * 1024;
/** One transport box: header, the plaintext (deflate keeps a body only when
 *  smaller), tag. */
export const RELAY_E2EE_TRANSPORT_MAX_BOX_BYTES = E2EE_BINARY_HEADER_BYTES + RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES + 16;

function transportInfo(
  domain: RelayE2EEDomain,
  direction: Direction,
  input: { challenge: string; serverPublicKey: string; clientPublicKey: string }
): Uint8Array {
  return encoder.encode(
    `${E2EE_CONTEXT}\0transport\0${domain}\0${direction}\0${input.challenge}\0${input.serverPublicKey}\0${input.clientPublicKey}`
  );
}

async function deriveTransportKeys(
  input: {
    privateKey: CryptoKey;
    peerPublicKey: string;
    pairingSecret: string;
    challenge: string;
    serverPublicKey: string;
    clientPublicKey: string;
  },
  role: 'client' | 'server'
): Promise<RelayE2EETransportKeys> {
  const salt = base64UrlDecode(input.pairingSecret);
  const derive = (domain: RelayE2EEDomain, direction: Direction): Promise<CryptoKey> =>
    deriveAesGcmKey(input.privateKey, input.peerPublicKey, salt, transportInfo(domain, direction, input));
  const send: Direction = role === 'client' ? 'client-to-server' : 'server-to-client';
  const receive: Direction = role === 'client' ? 'server-to-client' : 'client-to-server';
  const [appSend, appReceive, controlSend, controlReceive] = await Promise.all([
    derive('app', send),
    derive('app', receive),
    derive('control', send),
    derive('control', receive),
  ]);
  return { appSend, appReceive, controlSend, controlReceive };
}

/** Whether a hello settles a transport session for the challenge it answers. */
export function relayE2EETransportNegotiated(challenge: RelayE2EEChallenge, hello: RelayE2EEHello): boolean {
  return (
    challenge.transportWebrtc === 1 &&
    challenge.binaryFrames === 1 &&
    hello.transportWebrtc === 1 &&
    hello.binaryFrames === 1
  );
}

export type RelayE2EEControlOpen = { stale: false; sequence: number; value: unknown } | { stale: true; sequence: number };

/** Handshake confirmation state of one channel.
 *  `send`    (server) the transcript to put in `e2ee-ready`; present exactly
 *            when the server offered `transportWebrtc`.
 *  `expect`  (client that opted into transport) the transcript it computed
 *            and whether its challenge carried the offer. Until
 *            `confirmHandshake` accepts the server's `e2ee-ready`, the
 *            channel seals nothing. */
interface RelayE2EEHandshakeState {
  send?: string;
  expect?: { transcript: string; offered: boolean };
}

export class RelayE2EEChannel {
  private sendSequence = 0;
  private receiveSequence = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private controlSendSequence = 0;
  /** Authorized control lanes, bounded: the relay, the current direct
   *  connection and at most one pending one. `laneEpochFloor` is the highest
   *  direct epoch ever registered; nothing at or below it can be registered
   *  again, so a retired connection never comes back at high-water 0. */
  private readonly relayLane: ControlLaneState = { highWater: 0 };
  private currentLane: DirectLaneState | null = null;
  private pendingLane: DirectLaneState | null = null;
  private laneEpochFloor = 0;
  /** Seals resolve, and opens run, one at a time in call order, so boxes
   *  reach a lane in sequence order and a lane's high-water never races. */
  private controlSealQueue: Promise<unknown> = Promise.resolve();
  private controlOpenQueue: Promise<unknown> = Promise.resolve();
  /** A transport seal failed after its sequence was assigned: that sequence
   *  can never be delivered, so the stream (and session) is over. */
  private sendBroken = false;
  private confirmed: boolean;

  constructor(
    private readonly key: CryptoKey,
    private readonly role: 'client' | 'server',
    /** Set when the handshake proved BOTH peers can deflate/inflate. */
    private readonly compression = false,
    /** Key for the encrypted HTTP media lane of THIS session. */
    readonly mediaKey: CryptoKey | null = null,
    /** Present only on a negotiated transport session; null keeps the legacy
     *  key and AAD for every frame. */
    private readonly transport: RelayE2EETransportKeys | null = null,
    private readonly handshake: RelayE2EEHandshakeState = {}
  ) {
    this.confirmed = handshake.expect === undefined;
  }

  /** Whether this session speaks shared/remote-transport.ts. */
  get transportEnabled(): boolean {
    return this.transport !== null;
  }

  /** Server: the fields to add to `e2ee-ready` (authenticated by this
   *  channel). Empty unless this server offered transport, so a session where
   *  neither side offers sends exactly the legacy `e2ee-ready`. */
  handshakeConfirmation(): { transcript?: string } {
    return this.handshake.send === undefined ? {} : { transcript: this.handshake.send };
  }

  /** Client: checks the server's decrypted `e2ee-ready` against the transcript
   *  this client saw; must run before anything is sent. A ready with a
   *  transcript must match it. A ready without one is the authenticated word
   *  of a host that offered nothing (an older or gated host): accepted only
   *  when this client saw no offer either. Throws on any mismatch: the relay
   *  altered the handshake, and the session must not be used. */
  confirmHandshake(ready: unknown): void {
    const expect = this.handshake.expect;
    if (!expect || this.confirmed) return;
    const transcript =
      ready && typeof ready === 'object' ? (ready as { transcript?: unknown }).transcript : undefined;
    if (transcript === undefined ? expect.offered : transcript !== expect.transcript) {
      throw new Error('Relay encryption handshake transcript mismatch.');
    }
    this.confirmed = true;
  }

  private assertSendable(): void {
    if (!this.confirmed) throw new Error('Relay encryption handshake is not confirmed.');
    if (this.sendBroken) throw new Error('Relay transport stream is broken.');
  }

  private direction(sending: boolean): Direction {
    return (this.role === 'client') === sending ? 'client-to-server' : 'server-to-client';
  }

  private appAad(direction: Direction, sequence: number): Uint8Array {
    return encoder.encode(
      this.transport
        ? `${E2EE_CONTEXT}\0app\0${direction}\0${sequence}`
        : `${E2EE_CONTEXT}\0${direction}\0${sequence}`
    );
  }

  private encrypt(value: unknown, binary: boolean): Promise<string | Uint8Array<ArrayBuffer>> {
    let resolveResult!: (value: string | Uint8Array<ArrayBuffer>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<string | Uint8Array<ArrayBuffer>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.sendQueue = this.sendQueue
      .then(async () => {
        this.assertSendable();
        // Transport: everything that can refuse runs BEFORE the sequence is
        // assigned, so a refusal never leaves a hole in the stream. Legacy
        // keeps its original order (holes are accepted there).
        let packed: Uint8Array | null = null;
        if (this.transport) {
          const body = encoder.encode(JSON.stringify(value));
          if (body.byteLength > RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES) {
            throw new RangeError(`Relay transport record exceeds ${RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES} bytes.`);
          }
          packed = await packPlaintext(body, this.compression);
        }
        const sequence = ++this.sendSequence;
        let ciphertext: ArrayBuffer;
        const nonce = randomBytes(12);
        try {
          ciphertext = await cryptoApi().subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: arrayBuffer(nonce),
              additionalData: arrayBuffer(this.appAad(this.direction(true), sequence)),
            },
            this.transport ? this.transport.appSend : this.key,
            arrayBuffer(packed ?? (await packPlaintext(encoder.encode(JSON.stringify(value)), this.compression)))
          );
        } catch (error) {
          if (this.transport) this.sendBroken = true;
          throw error;
        }
        const encrypted = new Uint8Array(ciphertext);
        resolveResult(
          binary
            ? encodeBinaryBox(sequence, nonce, encrypted)
            : JSON.stringify({
                type: 'e2ee-box',
                version: E2EE_VERSION,
                sequence,
                nonce: base64UrlEncode(nonce),
                ciphertext: base64UrlEncode(encrypted),
              } satisfies RelayE2EEBox)
        );
      })
      .catch(rejectResult);
    return result;
  }

  encryptJson(value: unknown): Promise<string> {
    return this.encrypt(value, false) as Promise<string>;
  }

  encryptBinary(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    return this.encrypt(value, true) as Promise<Uint8Array<ArrayBuffer>>;
  }

  decryptJson(raw: unknown): Promise<unknown> {
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.receiveQueue = this.receiveQueue
      .then(async () => {
        const binary = decodeBinaryBox(raw);
        let sequence: number;
        let nonce: Uint8Array;
        let ciphertext: Uint8Array;
        if (binary) {
          sequence = binary.sequence;
          nonce = binary.nonce;
          ciphertext = binary.ciphertext;
        } else {
          const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
          if (!isBox(parsed)) throw new Error('Expected an encrypted relay frame.');
          sequence = parsed.sequence;
          nonce = base64UrlDecode(parsed.nonce);
          ciphertext = base64UrlDecode(parsed.ciphertext);
        }
        if (sequence <= this.receiveSequence) throw new Error('Rejected replayed relay frame.');
        if (nonce.byteLength !== 12) throw new Error('Invalid relay frame nonce.');
        if (this.transport && ciphertext.byteLength > RELAY_E2EE_TRANSPORT_MAX_BOX_BYTES - E2EE_BINARY_HEADER_BYTES) {
          throw new Error('Relay transport record exceeds its bound.');
        }
        const plaintext = await cryptoApi().subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: arrayBuffer(nonce),
            additionalData: arrayBuffer(this.appAad(this.direction(false), sequence)),
          },
          this.transport ? this.transport.appReceive : this.key,
          arrayBuffer(ciphertext)
        );
        // Compression is decided per frame by the sender, so the encoding is
        // read off the plaintext rather than assumed from the handshake.
        const value = JSON.parse(
          decoder.decode(
            this.transport
              ? await unpackPlaintext(new Uint8Array(plaintext), RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES)
              : await unpackPlaintext(new Uint8Array(plaintext))
          )
        ) as unknown;
        this.receiveSequence = sequence;
        resolveResult(value);
      })
      .catch(rejectResult);
    return result;
  }

  private transportKeys(): RelayE2EETransportKeys {
    if (!this.transport) throw new Error('This relay session has no transport control domain.');
    return this.transport;
  }

  private controlAad(direction: Direction, lane: RelayE2EEControlLane, sequence: number): ArrayBuffer {
    return arrayBuffer(
      encoder.encode(`${E2EE_CONTEXT}\0control\0${direction}\0${controlLaneLabel(lane)}\0${sequence}`)
    );
  }

  /** The state of an authorized lane; 'retired' for a direct epoch at or
   *  below the floor that is no longer current or pending. Throws for a lane
   *  never registered. */
  private laneState(lane: RelayE2EEControlLane): ControlLaneState | 'retired' {
    if (lane.kind === 'relay') return this.relayLane;
    if (sameDirectLane(this.currentLane, lane)) return this.currentLane;
    if (sameDirectLane(this.pendingLane, lane)) return this.pendingLane;
    if (lane.epoch <= this.laneEpochFloor) return 'retired';
    throw new Error('Control lane is not registered.');
  }

  /** Authorizes a new direct connection's lane as PENDING (from signaling:
   *  its `connectionId` and the `generation` of the offer that created it).
   *  Its epoch must exceed every epoch ever registered, so a superseded or
   *  retired connection can never be registered again; a previous pending
   *  lane is retired by it. Registering the current or pending lane again is
   *  a no-op. */
  registerControlLane(value: RelayE2EEControlLane): void {
    const lane = controlLane(value);
    if (lane.kind !== 'direct') throw new Error('Only a direct control lane is registered.');
    if (sameDirectLane(this.currentLane, lane) || sameDirectLane(this.pendingLane, lane)) return;
    if (lane.epoch <= this.laneEpochFloor) throw new Error('Control lane epoch is retired.');
    this.pendingLane = { epoch: lane.epoch, connectionId: lane.connectionId, highWater: 0 };
    this.laneEpochFloor = lane.epoch;
  }

  /** The pending lane became the current one (promotion); the previous
   *  current lane is retired. */
  activateControlLane(value: RelayE2EEControlLane): void {
    const lane = controlLane(value);
    if (lane.kind !== 'direct') throw new Error('Only a direct control lane is activated.');
    if (sameDirectLane(this.currentLane, lane)) return;
    if (!sameDirectLane(this.pendingLane, lane)) throw new Error('Control lane is not pending.');
    this.currentLane = this.pendingLane;
    this.pendingLane = null;
  }

  /** The connection closed: its lane (current or pending) is retired. */
  retireControlLane(value: RelayE2EEControlLane): void {
    const lane = controlLane(value);
    if (lane.kind !== 'direct') throw new Error('The relay control lane is never retired.');
    if (sameDirectLane(this.currentLane, lane)) this.currentLane = null;
    if (sameDirectLane(this.pendingLane, lane)) this.pendingLane = null;
  }

  /** Retained lane state (diagnostics, tests): at most three lanes. */
  controlLaneState(): { lanes: number; epochFloor: number } {
    return {
      lanes: 1 + (this.currentLane ? 1 : 0) + (this.pendingLane ? 1 : 0),
      epochFloor: this.laneEpochFloor,
    };
  }

  /** Seals one control message (signaling, ack, liveness) in its own domain
   *  for `lane`: `MXC\x01 | u64 sequence | nonce(12) | ciphertext`, the lane
   *  bound into the AAD. Never compressed. The lane must be the relay or a
   *  registered (current or pending) direct lane. Results resolve in
   *  sequence order; hand each box to its lane as soon as it resolves, so
   *  every lane carries ascending sequences. */
  async sealControl(value: unknown, laneValue: RelayE2EEControlLane): Promise<Uint8Array<ArrayBuffer>> {
    const keys = this.transportKeys();
    // A broken app stream may still say `close` on the control domain.
    if (!this.confirmed) throw new Error('Relay encryption handshake is not confirmed.');
    const lane = controlLane(laneValue);
    if (this.laneState(lane) === 'retired') throw new Error('Control lane epoch is retired.');
    const sequence = ++this.controlSendSequence;
    const nonce = randomBytes(12);
    const sealing = cryptoApi().subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: this.controlAad(this.direction(true), lane, sequence) },
      keys.controlSend,
      arrayBuffer(encoder.encode(JSON.stringify(value)))
    );
    // Observed here so a failure is never unhandled while it waits its turn.
    sealing.catch(() => undefined);
    const result = this.controlSealQueue.then(async () => {
      const output = encodeBinaryBox(sequence, nonce, new Uint8Array(await sealing));
      output.set(E2EE_CONTROL_MAGIC, 0);
      return output;
    });
    this.controlSealQueue = result.catch(() => undefined);
    return result;
  }

  /** Opens a control box that arrived on `lane`. Throws on a malformed or
   *  unauthentic box — including one sealed for another lane or epoch (the
   *  AAD differs) — and for a lane never registered. A sequence at or below
   *  the lane's high-water mark, or any box on a retired lane, is `stale`
   *  (a replay, or a late copy from a replaced connection), never an error.
   *  Opens run one at a time in call order. */
  async openControl(raw: unknown, lane: RelayE2EEControlLane): Promise<RelayE2EEControlOpen> {
    const result = this.controlOpenQueue.then(() => this.openControlNow(raw, lane));
    this.controlOpenQueue = result.catch(() => undefined);
    return result;
  }

  private async openControlNow(raw: unknown, laneValue: RelayE2EEControlLane): Promise<RelayE2EEControlOpen> {
    const keys = this.transportKeys();
    const lane = controlLane(laneValue);
    const bytes = binaryBytes(raw);
    if (!bytes || E2EE_CONTROL_MAGIC.some((byte, index) => bytes[index] !== byte)) {
      throw new Error('Expected a transport control box.');
    }
    const copy = bytes.slice();
    copy.set(E2EE_BINARY_MAGIC, 0);
    const box = decodeBinaryBox(copy);
    if (!box) throw new Error('Expected a transport control box.');
    const { sequence } = box;
    const state = this.laneState(lane);
    if (state === 'retired' || sequence <= state.highWater) return { stale: true, sequence };
    const plaintext = await cryptoApi().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(box.nonce),
        additionalData: this.controlAad(this.direction(false), lane, sequence),
      },
      keys.controlReceive,
      arrayBuffer(box.ciphertext)
    );
    const value = JSON.parse(decoder.decode(new Uint8Array(plaintext))) as unknown;
    // The lane may have been retired while this decrypted.
    const after = this.laneState(lane);
    if (after === 'retired' || sequence <= after.highWater) return { stale: true, sequence };
    after.highWater = sequence;
    return { stale: false, sequence, value };
  }
}

export function createRelayE2EEChallenge(): RelayE2EEChallenge {
  return {
    type: 'e2ee-challenge',
    version: E2EE_VERSION,
    challenge: base64UrlEncode(randomBytes(32)),
  };
}

export function isRelayE2EEChallenge(value: unknown): value is RelayE2EEChallenge {
  const row = value as Partial<RelayE2EEChallenge> | null;
  return (
    row?.type === 'e2ee-challenge' &&
    row.version === E2EE_VERSION &&
    typeof row.challenge === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(row.challenge)
  );
}

export function isRelayE2EEHello(value: unknown): value is RelayE2EEHello {
  const row = value as Partial<RelayE2EEHello> | null;
  return (
    row?.type === 'e2ee-hello' &&
    row.version === E2EE_VERSION &&
    typeof row.challenge === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(row.challenge) &&
    typeof row.clientPublicKey === 'string' &&
    /^[A-Za-z0-9_-]{87}$/u.test(row.clientPublicKey) &&
    typeof row.proof === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(row.proof)
  );
}

export async function generateRelayE2EEServerIdentity(): Promise<RelayE2EEServerIdentity> {
  const pair = await generateEcdhKeyPair();
  const [privateKeyJwk, publicKeyJwk, serverPublicKey] = await Promise.all([
    cryptoApi().subtle.exportKey('jwk', pair.privateKey),
    cryptoApi().subtle.exportKey('jwk', pair.publicKey),
    exportRawPublicKey(pair.publicKey),
  ]);
  return {
    version: E2EE_VERSION,
    serverPublicKey,
    pairingSecret: base64UrlEncode(randomBytes(32)),
    privateKeyJwk,
    publicKeyJwk,
  };
}

export async function validateRelayE2EEServerIdentity(value: RelayE2EEServerIdentity): Promise<boolean> {
  try {
    if (
      value.version !== E2EE_VERSION ||
      typeof value.serverPublicKey !== 'string' ||
      typeof value.pairingSecret !== 'string' ||
      !value.privateKeyJwk ||
      !value.publicKeyJwk
    )
      return false;
    const publicKey = await cryptoApi().subtle.importKey('jwk', value.publicKeyJwk, ECDH_P256, true, []);
    await importEcdhPrivateKey(value.privateKeyJwk, false);
    return (
      (await exportRawPublicKey(publicKey)) === value.serverPublicKey &&
      base64UrlDecode(value.pairingSecret).byteLength === 32
    );
  } catch {
    return false;
  }
}

export function relayE2EEPairingMaterial(identity: RelayE2EEServerIdentity): RelayE2EEPairingMaterial {
  return {
    version: E2EE_VERSION,
    serverPublicKey: identity.serverPublicKey,
    pairingSecret: identity.pairingSecret,
  };
}

/** Approval handoff. An installed web app starts with an empty storage
 *  container: it has no pairing to present and no way to be handed one over a
 *  relay that must never learn the secret. It generates a throwaway key pair
 *  instead, and the desktop seals the pairing material to that public key once
 *  the user approves on the PC. The relay only ever forwards this box. */
interface SealedRelayE2EEPairing {
  version: typeof E2EE_VERSION;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface RelayClaimKeyPair {
  publicKey: string;
  privateKey: CryptoKey;
}

const E2EE_CLAIM_CONTEXT = `${E2EE_CONTEXT}\0claim`;

export function isRelayClaimPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86,88}$/u.test(value);
}

async function claimSealKey(input: {
  privateKey: CryptoKey;
  peerPublicKey: string;
  clientPublicKey: string;
  ephemeralPublicKey: string;
}): Promise<CryptoKey> {
  return deriveAesGcmKey(
    input.privateKey,
    input.peerPublicKey,
    new Uint8Array(32),
    encoder.encode(`${E2EE_CLAIM_CONTEXT}\0${input.clientPublicKey}\0${input.ephemeralPublicKey}`)
  );
}

export async function generateRelayClaimKeyPair(): Promise<RelayClaimKeyPair> {
  const pair = await generateEcdhKeyPair();
  return {
    publicKey: await exportRawPublicKey(pair.publicKey),
    privateKey: pair.privateKey,
  };
}

/** A pending approval has to survive the asking app being reloaded: a phone
 *  OS discards a backgrounded web app freely, and losing the key would mean
 *  asking the user to approve all over again. The private key is exported for
 *  that container's own storage and never leaves it. */
interface StoredRelayClaimKeyPair {
  publicKey: string;
  privateKeyJwk: JsonWebKey;
}

export async function exportRelayClaimKeyPair(keyPair: RelayClaimKeyPair): Promise<StoredRelayClaimKeyPair> {
  return {
    publicKey: keyPair.publicKey,
    privateKeyJwk: await cryptoApi().subtle.exportKey('jwk', keyPair.privateKey),
  };
}

export async function importRelayClaimKeyPair(stored: unknown): Promise<RelayClaimKeyPair | null> {
  try {
    const value = stored as Partial<StoredRelayClaimKeyPair> | null;
    if (!value || !isRelayClaimPublicKey(value.publicKey) || !value.privateKeyJwk) return null;
    return {
      publicKey: value.publicKey,
      privateKey: await importEcdhPrivateKey(value.privateKeyJwk, true),
    };
  } catch {
    return null;
  }
}

export async function sealRelayE2EEPairingMaterial(
  material: RelayE2EEPairingMaterial,
  clientPublicKey: string
): Promise<SealedRelayE2EEPairing> {
  if (!isRelayClaimPublicKey(clientPublicKey)) {
    throw new Error('Invalid approval key.');
  }
  const pair = await generateEcdhKeyPair();
  const ephemeralPublicKey = await exportRawPublicKey(pair.publicKey);
  const key = await claimSealKey({
    privateKey: pair.privateKey,
    peerPublicKey: clientPublicKey,
    clientPublicKey,
    ephemeralPublicKey,
  });
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(
    await cryptoApi().subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBuffer(nonce) },
      key,
      arrayBuffer(
        encoder.encode(
          JSON.stringify({
            version: material.version,
            serverPublicKey: material.serverPublicKey,
            pairingSecret: material.pairingSecret,
          })
        )
      )
    )
  );
  return {
    version: E2EE_VERSION,
    ephemeralPublicKey,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

/** null for anything that does not open: a forged or corrupted box is a
 *  refused approval, never a half-applied pairing. */
export async function openSealedRelayE2EEPairingMaterial(
  sealed: unknown,
  keyPair: RelayClaimKeyPair
): Promise<RelayE2EEPairingMaterial | null> {
  try {
    const box = sealed as Partial<SealedRelayE2EEPairing> | null;
    if (!box || box.version !== E2EE_VERSION || !isRelayClaimPublicKey(box.ephemeralPublicKey)) {
      return null;
    }
    const key = await claimSealKey({
      privateKey: keyPair.privateKey,
      peerPublicKey: box.ephemeralPublicKey,
      clientPublicKey: keyPair.publicKey,
      ephemeralPublicKey: box.ephemeralPublicKey,
    });
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBuffer(base64UrlDecode(String(box.nonce || ''))) },
      key,
      arrayBuffer(base64UrlDecode(String(box.ciphertext || '')))
    );
    const parsed = JSON.parse(decoder.decode(new Uint8Array(plaintext))) as Partial<RelayE2EEPairingMaterial>;
    if (
      parsed.version !== E2EE_VERSION ||
      !/^[A-Za-z0-9_-]{87}$/u.test(String(parsed.serverPublicKey || '')) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(String(parsed.pairingSecret || ''))
    )
      return null;
    return {
      version: E2EE_VERSION,
      serverPublicKey: parsed.serverPublicKey as string,
      pairingSecret: parsed.pairingSecret as string,
    };
  } catch {
    return null;
  }
}

/** A browser's Web Push key material (PushSubscription.toJSON().keys), sealed
 *  to ONE paired desktop. The relay holds the subscription endpoint and
 *  forwards this box to that desktop; it cannot open it, and only a browser
 *  holding the desktop's pairing secret can make one the desktop accepts. The
 *  endpoint is authenticated as associated data, so a box cannot be replayed
 *  under another subscription. */
export interface SealedRelayWebPushKeys {
  version: typeof E2EE_VERSION;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface RelayWebPushKeys {
  p256dh: string;
  auth: string;
}

const E2EE_WEB_PUSH_CONTEXT = `${E2EE_CONTEXT}\0webpush`;

async function webPushSealKey(input: {
  privateKey: CryptoKey;
  peerPublicKey: string;
  pairingSecret: string;
  serverPublicKey: string;
  ephemeralPublicKey: string;
}): Promise<CryptoKey> {
  return deriveAesGcmKey(
    input.privateKey,
    input.peerPublicKey,
    base64UrlDecode(input.pairingSecret),
    encoder.encode(`${E2EE_WEB_PUSH_CONTEXT}\0${input.serverPublicKey}\0${input.ephemeralPublicKey}`)
  );
}

export async function sealRelayWebPushKeys(
  pairing: RelayE2EEPairingMaterial,
  endpoint: string,
  keys: RelayWebPushKeys
): Promise<SealedRelayWebPushKeys> {
  const pair = await generateEcdhKeyPair();
  const ephemeralPublicKey = await exportRawPublicKey(pair.publicKey);
  const key = await webPushSealKey({
    privateKey: pair.privateKey,
    peerPublicKey: pairing.serverPublicKey,
    pairingSecret: pairing.pairingSecret,
    serverPublicKey: pairing.serverPublicKey,
    ephemeralPublicKey,
  });
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(
    await cryptoApi().subtle.encrypt(
      { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(encoder.encode(endpoint)) },
      key,
      arrayBuffer(encoder.encode(JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth })))
    )
  );
  return {
    version: E2EE_VERSION,
    ephemeralPublicKey,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

/** null for anything that does not open: a box sealed for another desktop,
 *  another endpoint, or by someone without the pairing secret. */
export async function openRelayWebPushKeys(
  identity: RelayE2EEServerIdentity,
  endpoint: string,
  sealed: unknown
): Promise<RelayWebPushKeys | null> {
  try {
    const box = sealed as Partial<SealedRelayWebPushKeys> | null;
    if (!box || box.version !== E2EE_VERSION || !/^[A-Za-z0-9_-]{87}$/u.test(String(box.ephemeralPublicKey || ''))) {
      return null;
    }
    const key = await webPushSealKey({
      privateKey: await importEcdhPrivateKey(identity.privateKeyJwk, false),
      peerPublicKey: box.ephemeralPublicKey as string,
      pairingSecret: identity.pairingSecret,
      serverPublicKey: identity.serverPublicKey,
      ephemeralPublicKey: box.ephemeralPublicKey as string,
    });
    const plaintext = await cryptoApi().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(base64UrlDecode(String(box.nonce || ''))),
        additionalData: arrayBuffer(encoder.encode(endpoint)),
      },
      key,
      arrayBuffer(base64UrlDecode(String(box.ciphertext || '')))
    );
    const parsed = JSON.parse(decoder.decode(new Uint8Array(plaintext))) as Partial<RelayWebPushKeys>;
    const p256dh = String(parsed.p256dh || '');
    const auth = String(parsed.auth || '');
    if (!/^[A-Za-z0-9_-]{87}$/u.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/u.test(auth)) return null;
    return { p256dh, auth };
  } catch {
    return null;
  }
}

export async function createRelayE2EEClientHandshake(
  pairing: RelayE2EEPairingMaterial,
  challenge: RelayE2EEChallenge,
  /** `transportWebrtc`: this browser runs the transport stream core. It
   *  selects transport only on a challenge offering it with binary frames,
   *  and in every case requires `channel.confirmHandshake(e2ee-ready)` before
   *  it sends. `helloFields`: further hello members (viewSync, ...), added
   *  here so the transcript covers the hello exactly as it is sent. Without
   *  either, the hello and its proof are the legacy ones, byte for byte. */
  options: { transportWebrtc?: boolean; helloFields?: Record<string, unknown> } = {}
): Promise<{ hello: RelayE2EEHello; channel: RelayE2EEChannel }> {
  if (pairing.version !== E2EE_VERSION || !isRelayE2EEChallenge(challenge)) {
    throw new Error('Unsupported relay encryption handshake.');
  }
  const pair = await generateEcdhKeyPair();
  const clientPublicKey = await exportRawPublicKey(pair.publicKey);
  const selectTransport =
    options.transportWebrtc === true && challenge.transportWebrtc === 1 && challenge.binaryFrames === 1;
  const hello: RelayE2EEHello & Record<string, unknown> = {
    type: 'e2ee-hello',
    version: E2EE_VERSION,
    challenge: challenge.challenge,
    clientPublicKey,
    // Filled below; declared here so the member order stays the legacy one.
    proof: '',
    ...(challenge.binaryFrames === 1 ? { binaryFrames: 1 as const } : {}),
    ...(challenge.listDelta === 1 ? { listDelta: 1 as const } : {}),
    // Echoed only when this browser can also inflate what it asks for.
    ...(challenge.deflate === 1 && relayE2EECompressionSupported() ? { deflate: 1 as const } : {}),
    ...(challenge.compactWire === 1 ? { compactWire: 1 as const } : {}),
    ...(challenge.transcriptPaging === 1 ? { transcriptPaging: 1 as const } : {}),
    ...(challenge.transcriptPrepend === 1 ? { transcriptPrepend: 1 as const } : {}),
    ...(selectTransport ? { transportWebrtc: 1 as const } : {}),
  };
  for (const [name, value] of Object.entries(options.helloFields ?? {})) {
    if (!Object.hasOwn(hello, name)) hello[name] = value;
  }
  const transcript = options.transportWebrtc === true ? await handshakeTranscript(challenge, hello) : null;
  hello.proof = await helloProof(
    pairing.pairingSecret,
    challenge.challenge,
    pairing.serverPublicKey,
    clientPublicKey,
    selectTransport ? transcript : null
  );
  const material = {
    privateKey: pair.privateKey,
    peerPublicKey: pairing.serverPublicKey,
    pairingSecret: pairing.pairingSecret,
    challenge: challenge.challenge,
    serverPublicKey: pairing.serverPublicKey,
    clientPublicKey,
  };
  const key = await deriveChannelKey(material);
  const mediaKey = challenge.mediaE2ee === 1 ? await deriveMediaKey(material) : null;
  const transport = selectTransport ? await deriveTransportKeys(material, 'client') : null;
  const handshake: RelayE2EEHandshakeState =
    transcript === null ? {} : { expect: { transcript, offered: challenge.transportWebrtc === 1 } };
  return { hello, channel: new RelayE2EEChannel(key, 'client', hello.deflate === 1, mediaKey, transport, handshake) };
}

export async function acceptRelayE2EEClientHello(
  identity: RelayE2EEServerIdentity,
  expectedChallenge: RelayE2EEChallenge,
  hello: RelayE2EEHello
): Promise<RelayE2EEChannel> {
  if (!isRelayE2EEHello(hello) || hello.challenge !== expectedChallenge.challenge) {
    throw new Error('Relay encryption authentication failed.');
  }
  // A hello that selects transport must answer an offer of it, with binary
  // frames on both sides, and prove the whole transcript; one that does not
  // is the legacy (older browser) path, proven the legacy way. A relay that
  // strips or adds the selection breaks the proof; one that strips the OFFER
  // is caught by the client against `handshakeConfirmation()`.
  const offered = expectedChallenge.transportWebrtc === 1;
  const selected = hello.transportWebrtc !== undefined;
  if (selected && !relayE2EETransportNegotiated(expectedChallenge, hello)) {
    throw new Error('Relay encryption authentication failed.');
  }
  const transcript = offered || selected ? await handshakeTranscript(expectedChallenge, hello) : null;
  if (!(await verifyHelloProof(identity, hello, selected ? transcript : null))) {
    throw new Error('Relay encryption authentication failed.');
  }
  const privateKey = await importEcdhPrivateKey(identity.privateKeyJwk, false);
  const material = {
    privateKey,
    peerPublicKey: hello.clientPublicKey,
    pairingSecret: identity.pairingSecret,
    challenge: hello.challenge,
    serverPublicKey: identity.serverPublicKey,
    clientPublicKey: hello.clientPublicKey,
  };
  const key = await deriveChannelKey(material);
  const mediaKey = expectedChallenge.mediaE2ee === 1 ? await deriveMediaKey(material) : null;
  const transport = selected ? await deriveTransportKeys(material, 'server') : null;
  return new RelayE2EEChannel(
    key,
    'server',
    hello.deflate === 1 && relayE2EECompressionSupported(),
    mediaKey,
    transport,
    offered && transcript !== null ? { send: transcript } : {}
  );
}
