// A second Mixdog process on the test's data dir (session-writer-claim.test.mjs),
// driven by one JSON command per stdin line and answering one JSON line each.
import { createInterface } from 'node:readline';

const { deleteSession, getSessionLifecycleCommitError, loadSession, saveSession } = await import('../store.mjs');

const held = new Map();
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function save(session) {
  try {
    saveSession(session, { sync: true });
    return { saved: true };
  } catch (error) {
    return { saved: false, code: error?.code ?? null, message: String(error?.message ?? error) };
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const { op, id, text } = JSON.parse(line);
  if (op === 'exit') break;
  if (op === 'load') {
    const session = loadSession(id);
    held.set(id, session);
    reply({ messages: session?.messages?.length ?? null });
  } else if (op === 'append') {
    const session = held.get(id);
    session.messages.push({ role: 'user', content: text });
    reply(save(session));
  } else if (op === 'delete') {
    const deleted = deleteSession(id);
    reply({ deleted, code: getSessionLifecycleCommitError(id)?.code ?? null });
  } else if (op === 'create') {
    reply(save({ id, generation: 0, closed: false, messages: [{ role: 'user', content: text }] }));
  }
}
process.exit(0);
