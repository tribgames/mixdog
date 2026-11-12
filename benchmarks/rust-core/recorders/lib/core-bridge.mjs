// The client half of a replay whose core half is a Rust test (mixdog-core-session client_chain_replay_tests.rs): each request goes out
// as one JSON line on stdout and its answer comes back as one on stdin; the replay ends with `{"done": {"failures": [...]}}`.
// Nothing else may be written to stdout: diagnostics go to stderr.
import { createInterface } from 'node:readline';

export function coreBridge() {
  const lines = createInterface({ input: process.stdin });
  const waiting = new Map();
  let next = 0;
  lines.on('line', (line) => {
    const answer = JSON.parse(line);
    const wait = waiting.get(answer.id);
    waiting.delete(answer.id);
    if (Object.hasOwn(answer, 'error')) wait.reject(new Error(answer.error));
    else wait.resolve(answer.result);
  });
  return {
    call(call, args = {}) {
      const id = ++next;
      process.stdout.write(`${JSON.stringify({ id, call, ...args })}\n`);
      return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    },
    done(failures) {
      process.stdout.write(`${JSON.stringify({ done: { failures } })}\n`);
      lines.close();
    },
  };
}
