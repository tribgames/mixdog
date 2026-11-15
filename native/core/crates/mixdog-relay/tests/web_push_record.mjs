// Records the files the Node relay writes for web push, for tests/web_push.rs (`node_written_files_*`).
// Run: node web_push_record.mjs <apps/relay/lib directory of a Node checkout> <scratch directory>
// It prints one JSON object: the vapid file Node minted, the subscriptions file after two binds, and the subscriptions
// file Node writes when it loads that file and marks one more device capable. The Rust test embeds the output.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [lib, scratch] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(lib, 'web-push.mjs')).href);
mkdirSync(scratch, { recursive: true });
const sealed = (tag) => ({
  version: 1,
  ephemeralPublicKey: `B${tag.repeat(86)}`.slice(0, 87),
  nonce: 'n'.repeat(16),
  ciphertext: tag.repeat(40),
});
const keys = mod.loadOrCreateVapidKeys(scratch);
const registry = mod.createWebPushRegistry({ dataDir: scratch });
const endpointA = 'https://fcm.googleapis.com/fcm/send/subscription-1';
const endpointB = 'https://updates.push.services.mozilla.com/wpush/v2/subscription-2';
registry.bind('pc-a', 'aaaaaaaa', endpointA, sealed('a'));
registry.bind('pc-b', 'bbbbbbbb', endpointA, sealed('b'));
registry.bind('pc-a', 'aaaaaaaa', endpointB, sealed('c'));
registry.markCapable('pc-a');
const vapid = readFileSync(join(scratch, mod.VAPID_FILE), 'utf8');
const subscriptions = readFileSync(join(scratch, mod.SUBSCRIPTIONS_FILE), 'utf8');
const second = mod.createWebPushRegistry({ dataDir: scratch });
second.markCapable('pc-b');
const rewritten = readFileSync(join(scratch, mod.SUBSCRIPTIONS_FILE), 'utf8');
process.stdout.write(JSON.stringify({ publicKey: keys.publicKey, vapid, subscriptions, rewritten }));
