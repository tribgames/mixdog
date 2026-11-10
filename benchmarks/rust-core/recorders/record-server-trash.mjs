#!/usr/bin/env node
// What Node's server trash does (server-file-operations.ts `trashInfo` / `trashEntry`, b6f10295a), recorded from an exact export on this host:
// the freedesktop.org trash under XDG_DATA_HOME (a folder the run owns), entries whose names need encodeURI in the `.trashinfo` `Path=`,
// the local-time `DeletionDate` at fixed instants in a zone with daylight saving (TZ is set before anything reads the clock), a second
// entry of one name, a permanent delete, the project folder itself and a missing entry. Paths are written back as `{root}` / `{trash}`
// (and `{rootUri}`, the root as encodeURI writes it).
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-server-trash.mjs --tree <git archive of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const ZONE = 'America/New_York';
process.env.TZ = ZONE;
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'server-trash');
const tree = resolveTree(parseArgs());

const base = mkdtempSync(join(realpathSync(tmpdir()), 'trash-'));
const root = join(base, 'proj');
const trash = join(base, 'data', 'Trash');
// The trash of a data folder that is a file (the unavailable case).
const blocked = join(base, 'not-a-folder', 'data', 'Trash');
mkdirSync(join(root, 'sub'), { recursive: true });
process.env.XDG_DATA_HOME = join(base, 'data');

// Names a Windows folder can hold too (no `?`, `*`, `:`).
const NAMES = ['plain.txt', 'with space.txt', 'per%cent#hash.txt', 'é 한글 😀.txt', "sym;,@&=+$-_.!~'()[].txt"];
// 2024-01-15T12:34:56Z (standard time) and 2024-07-04T03:05:07Z (daylight time, the day before in New York).
const INSTANTS = [Date.UTC(2024, 0, 15, 12, 34, 56), Date.UTC(2024, 6, 4, 3, 5, 7)];
let instant = INSTANTS[0];
const { createServerFileOperations } = await importFrom(tree, 'apps/desktop/src/main/server-file-operations.ts');
const ops = createServerFileOperations({ userDataPath: join(base, 'user-data'), now: () => new Date(instant) });

// Each folder as is and as a JSON string body (an answer is tokenized in its JSON text).
const inJson = (text) => JSON.stringify(text).slice(1, -1);
const token = (text) =>
  [[inJson(blocked), '{blockedTrash}'], [encodeURI(root), '{rootUri}'], [inJson(trash), '{trash}'], [trash, '{trash}'], [inJson(root), '{root}'], [root, '{root}']].reduce((out, [folder, name]) => out.replaceAll(folder, name), text);
const run = async (args) => {
  try {
    return { result: JSON.parse(token(JSON.stringify(await ops.invoke('serverTrashEntry', args)))) };
  } catch (error) {
    return { error: { message: token(error.message), ...(error.code ? { code: error.code } : {}) } };
  }
};
const infoFile = (name) => token(readFileSync(join(trash, 'info', `${name}.trashinfo`), 'utf8'));

const steps = [];
steps.push({ op: 'info', answer: JSON.parse(token(JSON.stringify(await ops.invoke('serverTrashInfo', [root])))) });
for (const [index, name] of NAMES.entries()) {
  instant = INSTANTS[index % INSTANTS.length];
  writeFileSync(join(root, name), name);
  const answer = await run([root, name, false]);
  steps.push({ op: 'trash', rel: name, at: instant, answer, info: answer.result ? infoFile(name) : null });
}
// The same name again: `<name>.2`.
instant = INSTANTS[1];
writeFileSync(join(root, NAMES[0]), 'again');
const again = await run([root, NAMES[0], false]);
steps.push({ op: 'trash', rel: NAMES[0], at: instant, answer: again, info: again.result ? infoFile(`${NAMES[0]}.2`) : null });
// A folder, permanently.
writeFileSync(join(root, 'sub', 'inner.txt'), 'x');
steps.push({ op: 'delete', rel: 'sub', answer: await run([root, 'sub', true]) });
steps.push({ op: 'delete', rel: '', answer: await run([root, '', true]) });
steps.push({ op: 'trash', rel: 'missing.txt', at: instant, answer: await run([root, 'missing.txt', false]), info: null });
// A trash that cannot be made (its data folder is a file): unavailable, and a move to it is refused with TRASH_UNAVAILABLE.
writeFileSync(join(base, 'not-a-folder'), '');
process.env.XDG_DATA_HOME = join(base, 'not-a-folder', 'data');
writeFileSync(join(root, 'kept.txt'), 'kept');
steps.push({ op: 'info', home: 'blocked', answer: JSON.parse(token(JSON.stringify(await ops.invoke('serverTrashInfo', [root])))) });
steps.push({ op: 'trash', home: 'blocked', rel: 'kept.txt', at: instant, answer: await run([root, 'kept.txt', false]), info: null });
process.env.XDG_DATA_HOME = join(base, 'data');
// A permanent delete of a folder whose child another process holds open without delete sharing: the failure names the call and the
// child (`node:internal/fs/rimraf`). The holder says `held` once the file is open and is ended after the step.
mkdirSync(join(root, 'locked'));
writeFileSync(join(root, 'locked', 'child.txt'), 'held');
const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$f=[IO.File]::Open('${join(root, 'locked', 'child.txt')}','Open','Read','None'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const holderExit = new Promise((resolve) => holder.once('exit', resolve));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the holder did not open the child within 60000 ms')), 60_000);
    holder.stdout.setEncoding('utf8').on('data', (text) => text.includes('held') && (clearTimeout(timer), resolve()));
    holder.once('exit', (code) => (clearTimeout(timer), reject(new Error(`the holder exited (${code}) before it held the child`))));
  });
  steps.push({ op: 'delete', held: 'locked/child.txt', rel: 'locked', answer: await run([root, 'locked', true]) });
} finally {
  // Ended on every path: asked to close its file, and killed if it has not exited within 30000 ms.
  holder.stdin.end('\n');
  let timer;
  const ended = await Promise.race([holderExit.then(() => true), new Promise((resolve) => (timer = setTimeout(() => resolve(false), 30_000)))]);
  clearTimeout(timer);
  if (!ended) {
    // The holder's whole tree, as the phone-terminal recorder ends its child's.
    spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
    throw new Error('the holder did not exit within 30000 ms of being told to close its file; it was killed');
  }
}

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node's server trash with XDG_DATA_HOME set and TZ=" + ZONE + ': `{root}` is the project folder, `{trash}` the trash, `{rootUri}` the root as encodeURI writes it; `at` is the instant (ms) `now` gave.',
  zone: ZONE,
  steps,
});
writeSetManifest(out, {
  set: 'server-trash',
  recorder: 'benchmarks/rust-core/recorders/record-server-trash.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-server-trash.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { steps: steps.length, zone: ZONE },
});
commitStage(out, FIXTURES);
rmSync(base, { recursive: true, force: true });
console.log(`server-trash: ${steps.length} steps`);
process.exit(0);
