// Differential contract for pruneOffloadSession: over randomized sidecar
// layouts (ages, archive chains, path/name/missing references, unserializable
// transcripts) it must delete exactly the files the former implementation
// deleted.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeOutputPath } from '../tools/builtin/path-utils.mjs';
import { persistToolResultArtifactSync, pruneOffloadSession } from './tool-result-offload.mjs';

// Frozen copy of the former implementation (simple session ids only).
async function legacyPruneOffloadSession(sessionId, getMessages) {
  const dir = join(process.env.MIXDOG_DATA_DIR, 'tool-results', sessionId);
  if (!existsSync(dir)) return;
  let candidates;
  try {
    const entries = await readdir(dir);
    candidates = (
      await Promise.all(
        entries
          .filter((name) => name.endsWith('.txt'))
          .map(async (name) => {
            const filePath = join(dir, name);
            try {
              const fileStat = await stat(filePath);
              if (Date.now() - fileStat.mtimeMs < 10 * 60 * 1000) return null;
              return { name, filePath };
            } catch {
              return null;
            }
          })
      )
    ).filter(Boolean);
  } catch {}
  if (!candidates) return;
  let serialized;
  try {
    serialized = JSON.stringify(getMessages());
  } catch {
    return;
  }
  const haystack = process.platform === 'win32' ? serialized.toLowerCase() : serialized;
  const reachable = new Set(haystack.match(/\b[a-f0-9]{64}\.txt\b/g) || []);
  const pending = [...reachable];
  for (let i = 0; i < pending.length; i += 1) {
    let text;
    try {
      text = await readFile(join(dir, pending[i]), 'utf8');
    } catch {
      return;
    }
    for (const name of text.match(/\b[a-f0-9]{64}\.txt\b/g) || []) {
      if (reachable.has(name)) continue;
      reachable.add(name);
      pending.push(name);
    }
  }
  await Promise.all(
    candidates
      .filter(({ name, filePath }) => {
        if (reachable.has(name)) return false;
        const needles = [normalizeOutputPath(filePath), name];
        return !needles.some((needle) => {
          const value = process.platform === 'win32' ? needle.toLowerCase() : needle;
          return haystack.includes(value);
        });
      })
      .map(({ filePath }) => unlink(filePath).catch(() => {}))
  );
}

let seed = 424242;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const MISSING = `${'f'.repeat(64)}.txt`;

// A deterministic scenario description; `build` materializes it identically.
function scenario() {
  const files = Array.from({ length: 1 + (random() % 7) }, (_, index) => ({
    old: random() % 3 !== 0,
    refs: index ? Array.from({ length: random() % 3 }, () => random() % index) : [],
    refStyle: random() % 3,
    missing: random() % 9 === 0,
  }));
  const mentions = files.map(() => random() % 6);
  return { files, mentions, missingMention: random() % 12 === 0, unserializable: random() % 20 === 0, stray: random() % 4 === 0 };
}

function build(spec, sessionId) {
  const dir = join(process.env.MIXDOG_DATA_DIR, 'tool-results', sessionId);
  rmSync(dir, { recursive: true, force: true });
  const artifacts = [];
  spec.files.forEach((file, index) => {
    const refs = file.refs.map((target) => {
      const artifact = artifacts[target];
      return file.refStyle === 0 ? artifact.path : file.refStyle === 1 ? normalizeOutputPath(artifact.path) : artifact.path.split(/[\\/]/).pop();
    });
    if (file.missing) refs.push(MISSING);
    const content = refs.length ? JSON.stringify({ archive: index, refs }) : `evidence ${index}`;
    artifacts.push(persistToolResultArtifactSync({ sessionId, toolCallId: `call_${index}`, content }));
  });
  if (spec.stray) writeFileSync(join(dir, 'notes.log'), 'not a sidecar');
  const old = new Date(Date.now() - 3_600_000);
  spec.files.forEach((file, index) => {
    if (file.old) utimesSync(artifacts[index].path, old, old);
  });
  const content = [];
  spec.mentions.forEach((mention, index) => {
    const { path } = artifacts[index];
    if (mention === 0) content.push(path);
    else if (mention === 1) content.push(normalizeOutputPath(path));
    else if (mention === 2) content.push(normalizeOutputPath(path).toUpperCase());
    else if (mention === 3) content.push(`see ${path.split(/[\\/]/).pop()}`);
  });
  if (spec.missingMention) content.push(MISSING);
  const messages = [{ role: 'user', content: content.join('\n') }, { role: 'assistant', content: 'ok' }];
  if (spec.unserializable) messages.push({ role: 'tool', content: 10n });
  return { dir, getMessages: () => [messages, [], []] };
}

test('pruning deletes exactly what the former implementation deleted', async (t) => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-offload-prune-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  let deleted = 0;
  let retainedOld = 0;
  for (let index = 0; index < 300; index += 1) {
    const spec = scenario();
    const sessionId = `prune_${index}`;
    const legacy = build(spec, sessionId);
    const before = readdirSync(legacy.dir).sort();
    await legacyPruneOffloadSession(sessionId, legacy.getMessages);
    const expected = readdirSync(legacy.dir).sort();
    const current = build(spec, sessionId);
    assert.deepEqual(readdirSync(current.dir).sort(), before, 'layout rebuilds identically');
    await pruneOffloadSession(sessionId, current.getMessages);
    assert.deepEqual(readdirSync(current.dir).sort(), expected, JSON.stringify(spec));
    deleted += before.length - expected.length;
    retainedOld += spec.files.filter((file) => file.old).length - (before.length - expected.length);
  }
  assert.ok(deleted > 0 && retainedOld > 0, 'the corpus both deletes and retains old sidecars');
});

test('pruning without an old sidecar never serializes the transcript', async (t) => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-offload-prune-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const recent = persistToolResultArtifactSync({ sessionId: 'recent', toolCallId: 'c', content: 'fresh output' });
  let reads = 0;
  await pruneOffloadSession('recent', () => {
    reads += 1;
    return [];
  });
  assert.equal(reads, 0);
  assert.ok(existsSync(recent.path));
});
