// Records the durable feedback records the Node relay writes (apps/relay/lib/feedback.mjs) so the Rust service can load,
// hash and mail them. Usage: node record.mjs --tree <checkout holding apps/relay> (read only; nothing is written there).
// Writes records.json beside this script. The clock is fixed, so the output is the same on every run.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const treeAt = args.indexOf('--tree');
if (treeAt < 0 || !args[treeAt + 1]) throw new Error('usage: node record.mjs --tree <checkout>');
const tree = resolve(args[treeAt + 1]);
const { createFeedbackService } = await import(pathToFileURL(join(tree, 'apps/relay/lib/feedback.mjs')).href);

const NOW = 1_700_000_000_000;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const attachment = { name: 'shot.png', mimeType: 'image/png', data: png.toString('base64') };

const cases = [
  { name: 'failed-plain', id: '11111111-1111-4111-8111-111111111111', body: { kind: 'bug', message: '  it broke  ' }, fail: 'ETIMEDOUT' },
  {
    name: 'failed-attachment',
    id: '22222222-2222-4222-8222-222222222222',
    body: { kind: 'suggestion', message: 'with a picture', replyTo: ' who@example.com ', attachments: [attachment] },
    fail: 'ECONNECTION',
  },
  { name: 'delivered', id: '33333333-3333-4333-8333-333333333333', body: { kind: 'other', message: 'thanks' }, fail: null },
  { name: 'lone-surrogate', id: '44444444-4444-4444-8444-444444444444', body: { kind: 'bug', message: 'cut \ud83d here' }, fail: 'EAUTH' },
  { name: 'no-code', id: '55555555-5555-4555-8555-555555555555', body: { kind: 'bug', message: 'plain failure' }, fail: '' },
];

const out = [];
for (const c of cases) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedback-record-'));
  try {
    const sent = [];
    const service = await createFeedbackService({
      dataDir,
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => {},
      sender: async (mail) => {
        sent.push(mail);
        if (c.fail !== null) throw Object.assign(new Error('scripted'), c.fail ? { code: c.fail } : {});
      },
    });
    await service.submit({ id: c.id, ...c.body });
    const file = join(dataDir, 'feedback', `${c.id}.json`);
    for (let i = 0; i < 400; i++) {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.sentAt || record.attempts) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await service.close();
    if (readdirSync(join(dataDir, 'feedback')).length !== 1) throw new Error('unexpected files');
    const text = readFileSync(file, 'utf8');
    const record = JSON.parse(text);
    const mail = sent[0];
    out.push({
      name: c.name,
      file: `${c.id}.json`,
      submitted: { id: c.id, ...c.body },
      text,
      sent: {
        from: mail.from,
        to: mail.to,
        replyTo: mail.replyTo ?? null,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        attachments: (mail.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, base64: a.content.toString('base64') })),
      },
      hash: record.hash,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      sentAt: record.sentAt,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
const target = join(fileURLToPath(new URL('.', import.meta.url)), 'records.json');
writeFileSync(target, `${JSON.stringify({ nowMs: NOW, cases: out }, null, 2)}\n`);
