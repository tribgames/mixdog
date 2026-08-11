import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramProvider } from "./telegram.mjs";

test("Telegram voice messages expose and download audio attachments", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "mixdog-telegram-"));
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    const provider = new TelegramProvider({
      token: "test-token",
      mainChannelId: "42",
      accessMode: "static",
      access: { dmPolicy: "allowlist", channels: {} },
    }, stateDir);
    let inbound = null;
    provider.onMessage = (message) => {
      inbound = message;
    };
    provider._handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: 42 },
        from: { id: 9, username: "voice-user" },
        voice: {
          file_id: "download-id",
          file_unique_id: "stable-id",
          file_size: 4,
          duration: 1,
        },
      },
    });

    assert.equal(inbound?.attachments?.length, 1);
    assert.deepEqual(inbound.attachments[0], {
      id: "stable-id",
      name: "voice-7.ogg",
      contentType: "audio/ogg",
      size: 4,
    });

    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/getFile")) {
        assert.deepEqual(JSON.parse(options.body), { file_id: "download-id" });
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: "voice/file 7.oga" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from("OggS"), { status: 200 });
    };

    const downloaded = await provider.downloadAttachment("42", "7", {
      timeoutMs: 1000,
    });
    assert.equal(downloaded.length, 1);
    assert.equal(downloaded[0].id, "stable-id");
    assert.equal(downloaded[0].contentType, "audio/ogg");
    assert.equal(await readFile(downloaded[0].path, "utf8"), "OggS");
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/file\/bottest-token\/voice\/file%207\.oga$/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(stateDir, { recursive: true, force: true });
  }
});
