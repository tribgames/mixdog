// Writes native/core/fixtures/phone-chat/MANIFEST.json after record.mjs wrote host.json:
//   node benchmarks/rust-core/recorders/phone-chat-host/write-manifest.mjs --tree D:\mixdog-build\tmp\mmr\nb6r
import { join } from 'node:path';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, writeSetManifest } from '../lib/common.mjs';

const tree = resolveTree(parseArgs());
writeSetManifest(join(FIXTURES_ROOT, 'phone-chat'), {
  set: 'phone-chat',
  recorder: 'benchmarks/rust-core/recorders/phone-chat-host/record.mjs',
  command: 'node benchmarks/rust-core/recorders/phone-chat-host/record.mjs <tree> native/core/fixtures/phone-chat/host.json; node benchmarks/rust-core/recorders/phone-chat-host/write-manifest.mjs --tree <tree>',
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
