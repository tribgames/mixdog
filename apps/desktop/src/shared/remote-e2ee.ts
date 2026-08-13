const E2EE_VERSION = 1 as const;
const E2EE_CONTEXT = 'mixdog-relay-e2ee-v1';
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
}

export interface RelayE2EEHello {
  type: 'e2ee-hello';
  version: typeof E2EE_VERSION;
  challenge: string;
  clientPublicKey: string;
  proof: string;
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
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
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

function proofPayload(
  challenge: string,
  serverPublicKey: string,
  clientPublicKey: string,
): Uint8Array {
  return encoder.encode(`${E2EE_CONTEXT}\0hello\0${challenge}\0${serverPublicKey}\0${clientPublicKey}`);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey(
    'raw',
    arrayBuffer(base64UrlDecode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function helloProof(
  secret: string,
  challenge: string,
  serverPublicKey: string,
  clientPublicKey: string,
): Promise<string> {
  const signature = await cryptoApi().subtle.sign(
    'HMAC',
    await importHmacKey(secret),
    arrayBuffer(proofPayload(challenge, serverPublicKey, clientPublicKey)),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyHelloProof(
  identity: RelayE2EEServerIdentity,
  hello: RelayE2EEHello,
): Promise<boolean> {
  return cryptoApi().subtle.verify(
    'HMAC',
    await importHmacKey(identity.pairingSecret),
    arrayBuffer(base64UrlDecode(hello.proof)),
    arrayBuffer(proofPayload(hello.challenge, identity.serverPublicKey, hello.clientPublicKey)),
  );
}

async function importPublicKey(raw: string): Promise<CryptoKey> {
  const bytes = base64UrlDecode(raw);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error('Invalid P-256 public key.');
  return cryptoApi().subtle.importKey(
    'raw',
    arrayBuffer(bytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
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
  const sharedBits = await cryptoApi().subtle.deriveBits(
    {
      name: 'ECDH',
      public: await importPublicKey(input.peerPublicKey),
    },
    input.privateKey,
    256,
  );
  const keyMaterial = await cryptoApi().subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const info = encoder.encode(
    `${E2EE_CONTEXT}\0key\0${input.challenge}\0${input.serverPublicKey}\0${input.clientPublicKey}`,
  );
  return cryptoApi().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: arrayBuffer(base64UrlDecode(input.pairingSecret)),
      info: arrayBuffer(info),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function isBox(value: unknown): value is RelayE2EEBox {
  const row = value as Partial<RelayE2EEBox> | null;
  return row?.type === 'e2ee-box'
    && row.version === E2EE_VERSION
    && Number.isSafeInteger(row.sequence)
    && Number(row.sequence) > 0
    && typeof row.nonce === 'string'
    && /^[A-Za-z0-9_-]{16}$/u.test(row.nonce)
    && typeof row.ciphertext === 'string'
    && /^[A-Za-z0-9_-]{22,}$/u.test(row.ciphertext)
    && row.ciphertext.length % 4 !== 1;
}

export class RelayE2EEChannel {
  private sendSequence = 0;
  private receiveSequence = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly key: CryptoKey,
    private readonly role: 'client' | 'server',
  ) {}

  encryptJson(value: unknown): Promise<string> {
    let resolveResult!: (value: string) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.sendQueue = this.sendQueue.then(async () => {
      const sequence = ++this.sendSequence;
      const nonce = randomBytes(12);
      const direction = this.role === 'client' ? 'client-to-server' : 'server-to-client';
      const ciphertext = await cryptoApi().subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: arrayBuffer(nonce),
          additionalData: arrayBuffer(
            encoder.encode(`${E2EE_CONTEXT}\0${direction}\0${sequence}`),
          ),
        },
        this.key,
        arrayBuffer(encoder.encode(JSON.stringify(value))),
      );
      resolveResult(JSON.stringify({
        type: 'e2ee-box',
        version: E2EE_VERSION,
        sequence,
        nonce: base64UrlEncode(nonce),
        ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
      } satisfies RelayE2EEBox));
    }).catch(rejectResult);
    return result;
  }

  decryptJson(raw: unknown): Promise<unknown> {
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.receiveQueue = this.receiveQueue.then(async () => {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
      if (!isBox(parsed)) throw new Error('Expected an encrypted relay frame.');
      if (parsed.sequence <= this.receiveSequence) throw new Error('Rejected replayed relay frame.');
      const nonce = base64UrlDecode(parsed.nonce);
      if (nonce.byteLength !== 12) throw new Error('Invalid relay frame nonce.');
      const direction = this.role === 'client' ? 'server-to-client' : 'client-to-server';
      const plaintext = await cryptoApi().subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: arrayBuffer(nonce),
          additionalData: arrayBuffer(
            encoder.encode(`${E2EE_CONTEXT}\0${direction}\0${parsed.sequence}`),
          ),
        },
        this.key,
        arrayBuffer(base64UrlDecode(parsed.ciphertext)),
      );
      const value = JSON.parse(decoder.decode(plaintext)) as unknown;
      this.receiveSequence = parsed.sequence;
      resolveResult(value);
    }).catch(rejectResult);
    return result;
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
  return row?.type === 'e2ee-challenge'
    && row.version === E2EE_VERSION
    && typeof row.challenge === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(row.challenge);
}

export function isRelayE2EEHello(value: unknown): value is RelayE2EEHello {
  const row = value as Partial<RelayE2EEHello> | null;
  return row?.type === 'e2ee-hello'
    && row.version === E2EE_VERSION
    && typeof row.challenge === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(row.challenge)
    && typeof row.clientPublicKey === 'string'
    && /^[A-Za-z0-9_-]{87}$/u.test(row.clientPublicKey)
    && typeof row.proof === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(row.proof);
}

export async function generateRelayE2EEServerIdentity(): Promise<RelayE2EEServerIdentity> {
  const pair = await cryptoApi().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const [privateKeyJwk, publicKeyJwk, publicKeyRaw] = await Promise.all([
    cryptoApi().subtle.exportKey('jwk', pair.privateKey),
    cryptoApi().subtle.exportKey('jwk', pair.publicKey),
    cryptoApi().subtle.exportKey('raw', pair.publicKey),
  ]);
  return {
    version: E2EE_VERSION,
    serverPublicKey: base64UrlEncode(new Uint8Array(publicKeyRaw)),
    pairingSecret: base64UrlEncode(randomBytes(32)),
    privateKeyJwk,
    publicKeyJwk,
  };
}

export async function validateRelayE2EEServerIdentity(
  value: RelayE2EEServerIdentity,
): Promise<boolean> {
  try {
    if (
      value.version !== E2EE_VERSION
      || typeof value.serverPublicKey !== 'string'
      || typeof value.pairingSecret !== 'string'
      || !value.privateKeyJwk
      || !value.publicKeyJwk
    ) return false;
    const publicKey = await cryptoApi().subtle.importKey(
      'jwk',
      value.publicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    );
    await cryptoApi().subtle.importKey(
      'jwk',
      value.privateKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const raw = await cryptoApi().subtle.exportKey('raw', publicKey);
    return base64UrlEncode(new Uint8Array(raw)) === value.serverPublicKey
      && base64UrlDecode(value.pairingSecret).byteLength === 32;
  } catch {
    return false;
  }
}

export function relayE2EEPairingMaterial(
  identity: RelayE2EEServerIdentity,
): RelayE2EEPairingMaterial {
  return {
    version: E2EE_VERSION,
    serverPublicKey: identity.serverPublicKey,
    pairingSecret: identity.pairingSecret,
  };
}

export async function createRelayE2EEClientHandshake(
  pairing: RelayE2EEPairingMaterial,
  challenge: RelayE2EEChallenge,
): Promise<{ hello: RelayE2EEHello; channel: RelayE2EEChannel }> {
  if (pairing.version !== E2EE_VERSION || !isRelayE2EEChallenge(challenge)) {
    throw new Error('Unsupported relay encryption handshake.');
  }
  const pair = await cryptoApi().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const clientPublicKey = base64UrlEncode(new Uint8Array(
    await cryptoApi().subtle.exportKey('raw', pair.publicKey),
  ));
  const hello: RelayE2EEHello = {
    type: 'e2ee-hello',
    version: E2EE_VERSION,
    challenge: challenge.challenge,
    clientPublicKey,
    proof: await helloProof(
      pairing.pairingSecret,
      challenge.challenge,
      pairing.serverPublicKey,
      clientPublicKey,
    ),
  };
  const key = await deriveChannelKey({
    privateKey: pair.privateKey,
    peerPublicKey: pairing.serverPublicKey,
    pairingSecret: pairing.pairingSecret,
    challenge: challenge.challenge,
    serverPublicKey: pairing.serverPublicKey,
    clientPublicKey,
  });
  return { hello, channel: new RelayE2EEChannel(key, 'client') };
}

export async function acceptRelayE2EEClientHello(
  identity: RelayE2EEServerIdentity,
  expectedChallenge: RelayE2EEChallenge,
  hello: RelayE2EEHello,
): Promise<RelayE2EEChannel> {
  if (
    !isRelayE2EEHello(hello)
    || hello.challenge !== expectedChallenge.challenge
    || !(await verifyHelloProof(identity, hello))
  ) {
    throw new Error('Relay encryption authentication failed.');
  }
  const privateKey = await cryptoApi().subtle.importKey(
    'jwk',
    identity.privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const key = await deriveChannelKey({
    privateKey,
    peerPublicKey: hello.clientPublicKey,
    pairingSecret: identity.pairingSecret,
    challenge: hello.challenge,
    serverPublicKey: identity.serverPublicKey,
    clientPublicKey: hello.clientPublicKey,
  });
  return new RelayE2EEChannel(key, 'server');
}
