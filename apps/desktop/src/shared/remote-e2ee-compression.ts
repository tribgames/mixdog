// Compression belongs inside the authenticated envelope, never on ciphertext.
const E2EE_PLAINTEXT_DEFLATED = 0x01;
const E2EE_COMPRESS_MIN_BYTES = 512;

// Bound decoded JSON independently of the encrypted transport frame. Match the
// relay's 64 MiB single-frame policy, including uncompressed legacy messages.
export const MAX_E2EE_PLAINTEXT_BYTES = 64 * 1024 * 1024;

interface ByteTransformStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

let compressionSupport: boolean | null = null;

/** Peers without raw-deflate streams continue exchanging plain JSON. */
export function relayE2EECompressionSupported(): boolean {
  if (compressionSupport !== null) return compressionSupport;
  try {
    void new CompressionStream('deflate-raw');
    void new DecompressionStream('deflate-raw');
    compressionSupport = true;
  } catch {
    compressionSupport = false;
  }
  return compressionSupport;
}

function requirePlaintextSize(size: number, limit: number): void {
  if (size > limit) throw new RangeError(`Relay plaintext exceeds ${limit} bytes.`);
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      requirePlaintextSize(total + value.byteLength, maxOutputBytes);
      chunks.push(value);
      total += value.byteLength;
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (error) {
    // Cancellation propagates through pipeThrough to the producer. Preserve
    // the original error even if a transform has already failed.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read and write concurrently; stop the producer as soon as output is too big. */
export function runBoundedByteTransform(
  bytes: Uint8Array,
  stream: ByteTransformStream,
  maxOutputBytes = MAX_E2EE_PLAINTEXT_BYTES,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return collectStream(source.pipeThrough(stream), maxOutputBytes);
}

/** `[0x01][deflate-raw bytes]` when smaller, otherwise legacy raw JSON bytes. */
export async function packPlaintext(body: Uint8Array, compress: boolean): Promise<Uint8Array> {
  requirePlaintextSize(body.byteLength, MAX_E2EE_PLAINTEXT_BYTES);
  if (!compress || body.byteLength < E2EE_COMPRESS_MIN_BYTES) return body;
  let deflated: Uint8Array;
  try {
    deflated = await runBoundedByteTransform(
      body,
      new CompressionStream('deflate-raw') as unknown as ByteTransformStream,
    );
  } catch {
    return body;
  }
  if (deflated.byteLength + 1 >= body.byteLength) return body;
  const framed = new Uint8Array(deflated.byteLength + 1);
  framed[0] = E2EE_PLAINTEXT_DEFLATED;
  framed.set(deflated, 1);
  return framed;
}

export async function unpackPlaintext(bytes: Uint8Array): Promise<Uint8Array> {
  requirePlaintextSize(bytes.byteLength, MAX_E2EE_PLAINTEXT_BYTES);
  if (bytes.byteLength === 0 || bytes[0] !== E2EE_PLAINTEXT_DEFLATED) return bytes;
  return runBoundedByteTransform(
    bytes.subarray(1),
    new DecompressionStream('deflate-raw') as unknown as ByteTransformStream,
  );
}
