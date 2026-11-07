// Records Node's phone one-file grant flow (remote-methods.ts createSelectedFileGrants): minting, redeeming, the hour of
// life, the cap of 100, the conversation binding and the refusal texts. A fake `Date.now` drives the clock.
// node --experimental-transform-types --import <ts resolver> record.mjs > corpus.json
//
// remote-methods.ts pulls the whole desktop service in; the grant store is one self-contained part of it. It is cut out
// verbatim (from its interface to the comment that follows it) into a probe module beside it, with the imports it uses.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/desktop/src/main');
const source = readFileSync(join(main, 'remote-methods.ts'), 'utf8');
const from = source.indexOf('/** Permissions this bridge issued for paths outside every registered project. */');
const to = source.indexOf('// Remote access is a transport client');
const probe = join(main, 'grants-probe.ts');
writeFileSync(
  probe,
  [
    "import { randomUUID } from 'node:crypto';",
    "import { basename as pathBasename, dirname as pathDirname, resolve as resolvePath } from 'node:path';",
    "import { SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';",
    "import { requiredString } from './ipc-validation';",
    "import { MAX_SELECTED_FILE_GRANTS, sameGrantedPath, selectedFileGrantKey } from './selected-file-grants';",
    source.slice(from, to),
  ].join('\n')
);
const { createSelectedFileGrants } = await import(pathToFileURL(probe).href);
rmSync(probe);
let now = 1_700_000_000_000;
Date.now = () => now;
const removed = new Set();
const grants = createSelectedFileGrants((sessionId) => removed.has(sessionId));
const base = resolve('/work/outside');
const file = (name) => resolve(base, name);
const steps = [];
const tokens = {};
const outcome = (run) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: { name: error.name, message: error.message, code: error.code ?? null } };
  }
};
const step = (label, run) => {
  const answered = outcome(run);
  steps.push({ label, ...answered });
  return answered;
};
const mint = (name, path, sessionId) => {
  const token = grants.rememberFileGrant(path, sessionId);
  tokens[name] = token;
  return { token: 'T:' + name };
};
const same = (a, b) => tokens[a] === tokens[b];
const redeem = (name, project, rel) => {
  const found = grants.grantedFile(name in tokens ? tokens[name] : name, project, rel);
  return { root: found.root, rel: found.rel, absolute: found.absolute };
};

step('mint a.txt for no conversation', () => mint('a', file('a.txt'), ''));
step('mint a.txt again: the same token', () => ({ same: (mint('a2', file('a.txt'), ''), same('a', 'a2')) }));
step('mint a.txt for a conversation: another token', () => ({ same: (mint('a-s1', file('a.txt'), 's1'), same('a', 'a-s1')) }));
step('mint a.txt for that conversation again: its token', () => ({ same: (mint('a-s1b', file('a.txt'), 's1'), same('a-s1', 'a-s1b')) }));
step('redeem with the folder and name', () => redeem('a', base, 'a.txt'));
step('redeem with the folder and the name in another case', () => redeem('a', base, 'A.TXT'));
step('redeem with a relative path inside the folder', () => redeem('a', base, 'sub/../a.txt'));
step('redeem for another file', () => redeem('a', base, 'b.txt'));
step('redeem for the parent folder', () => redeem('a', resolve(base, '..'), 'outside/a.txt'));
step('redeem an unknown token', () => redeem('no-such-token', base, 'a.txt'));
step('redeem an empty token', () => redeem('', base, 'a.txt'));
step('redeem a token longer than 128', () => redeem('x'.repeat(129), base, 'a.txt'));
step('redeem a token that is not a string', () => grants.grantedFile(42, base, 'a.txt'));
step('redeem with an empty project path', () => redeem('a', '', 'a.txt'));
step('redeem with an empty rel path', () => redeem('a', base, ''));
now += 59 * 60 * 1000;
step('redeem after 59 minutes', () => redeem('a', base, 'a.txt'));
step('mint a.txt again at 59 minutes: the same token, one more hour', () => ({ same: (mint('a3', file('a.txt'), ''), same('a', 'a3')) }));
now += 59 * 60 * 1000;
step('redeem 118 minutes in: alive through the renewal', () => redeem('a', base, 'a.txt'));
now += 61 * 60 * 1000;
step('redeem past the hour after the renewal', () => redeem('a', base, 'a.txt'));
step('redeem it again: the grant was deleted', () => redeem('a', base, 'a.txt'));
step('mint a.txt after it expired: a new token', () => ({ same: (mint('a4', file('a.txt'), ''), same('a', 'a4')) }));
mint('a-s1', file('a.txt'), 's1');
step('redeem the conversation token while its conversation lives', () => redeem('a-s1', base, 'a.txt'));
removed.add('s1');
step('redeem the conversation token once the conversation is gone', () => redeem('a-s1', base, 'a.txt'));
step('mint for the gone conversation: a new token', () => ({ same: (mint('a-s1c', file('a.txt'), 's1'), same('a-s1', 'a-s1c')) }));
removed.delete('s1');
// the cap: 100 grants, the oldest go first
for (let i = 0; i < 100; i += 1) mint('f' + i, file('f' + i + '.txt'), '');
step('the newest hundred are held: the first of them', () => redeem('f0', base, 'f0.txt'));
step('the newest hundred are held: the last of them', () => redeem('f99', base, 'f99.txt'));
step('a grant older than those hundred is gone', () => redeem('a4', base, 'a.txt'));
mint('f100', file('f100.txt'), '');
step('one more evicts the oldest remaining (f0)', () => redeem('f0', base, 'f0.txt'));
step('and the next oldest is held', () => redeem('f1', base, 'f1.txt'));
step('and the one just minted is held', () => redeem('f100', base, 'f100.txt'));console.log(JSON.stringify({ node: process.version, platform: process.platform, base, steps }, null, 1));
