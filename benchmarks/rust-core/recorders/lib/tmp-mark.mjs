// Declared normalisation of this machine's roots: in the string values at the paths `matches(path)` accepts, the checkout
// (process.cwd()), the OS temp dir and the user's home become <CWD>, <TMP> and <HOME> in every spelling the text carries them
// (as Node produced it, forward slashes, JSON-escaped backslashes, URL-encoded, and each lower-cased); whatever follows the
// root, separators included, is kept. Nothing else is touched.
import { homedir, tmpdir } from 'node:os';

export const TMP_MARKER = '<TMP>';

const spellings = (root) => {
  const forward = root.replaceAll('\\', '/');
  const list = [
    ['as written', root],
    ['forward slashes', forward],
    ['JSON-escaped', root.replaceAll('\\', '\\\\')],
    ['URL-encoded', encodeURIComponent(root)],
    ['URL-encoded forward slashes', encodeURIComponent(forward)],
  ];
  const all = [...list, ...list.map(([name, text]) => [`${name}, lower-case`, text.toLowerCase()])];
  const seen = new Set();
  return all.filter(([, text]) => text && !seen.has(text) && seen.add(text));
};

/** Roots in the order they are replaced: the longest first, so a checkout under the home dir is <CWD>, not <HOME>/... */
export function machineRoots() {
  return [['<CWD>', process.cwd()], ['<TMP>', tmpdir()], ['<HOME>', homedir()]]
    .sort((a, b) => b[1].length - a[1].length)
    .flatMap(([label, root]) => spellings(root).map(([spelling, text]) => ({ label, spelling, text })));
}

/** The text with the roots replaced, and per label (spelling when not as written) its original length and count. */
export function markMachineText(text) {
  const rewrites = {};
  let out = text;
  for (const { label, spelling, text: root } of machineRoots()) {
    const count = out.split(root).length - 1;
    if (!count) continue;
    out = out.split(root).join(label);
    rewrites[spelling === 'as written' ? label : `${label} (${spelling})`] = { originalLength: root.length, count };
  }
  return { text: out, rewrites };
}

export function markMachine(value, matches, path = []) {
  if (typeof value === 'string') return matches(path) ? markMachineText(value).text : value;
  if (Array.isArray(value)) return value.map((item, index) => markMachine(item, matches, [...path, String(index)]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markMachine(item, matches, [...path, key])]));
  return value;
}

export const markTmp = markMachine;