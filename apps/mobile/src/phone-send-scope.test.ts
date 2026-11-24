import assert from 'node:assert/strict';
import test from 'node:test';
import { firstFrame, scopeClient } from './phone-send-scope.ts';

test("an upload's last chunk is its call's frame, and each accepted chunk is its progress", async () => {
  // As the protocol client's putBlob does: every chunk accepted is reported, the last chunk's frame goes to the claim.
  const client = {
    putBlob: async (
      _bytes: Uint8Array,
      _mediaType: string,
      options?: { sent?(frame: Promise<void>): void; onChunkAccepted?(): void }
    ) => {
      options?.onChunkAccepted?.();
      options?.sent?.(Promise.resolve());
      options?.onChunkAccepted?.();
      return {};
    },
  };
  const frames: Array<Promise<void>> = [];
  let progress = 0;
  const scoped = scopeClient(
    client,
    firstFrame((sent) => void frames.push(sent)),
    () => void (progress += 1)
  );
  await scoped.putBlob(new Uint8Array(1), 'application/octet-stream');
  assert.equal(frames.length, 1, 'the call learns its upload has left, so its silence probe can start');
  assert.equal(progress, 2);
});
