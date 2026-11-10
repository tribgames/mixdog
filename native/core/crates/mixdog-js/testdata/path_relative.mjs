// Records path_relative.json: what Node's `path.win32.relative(from, to)` answers where its case-insensitive comparison meets
// characters whose lower case has another length (`İ` lowers to two UTF-16 units), characters outside the BMP (two units each), and the
// ordinary prefixes around them. Absolute inputs only: the answers do not depend on the working directory.
// Run: node path_relative.mjs > path_relative.json
import { win32 } from 'node:path';

const pairs = [
  ['C:\\a\\b', 'C:\\a\\b\\c'],
  ['C:\\A\\B', 'c:\\a\\b\\c'],
  ['C:\\\u0130', 'C:\\\u0130\\x'],
  ['C:\\\u0130\\a', 'C:\\i\u0307\\a\\b'],
  ['C:\\i\u0307', 'C:\\\u0130\\x'],
  ['C:\\\u0130STANBUL\\x', 'C:\\\u0130STANBUL\\x\\y\\z'],
  ['C:\\\u0130\u0130\u0130', 'C:\\\u0130\u0130\u0130\\deep\\er'],
  ['C:\\a', 'C:\\\u0130\\b'],
  ['C:\\\u0130\\a', 'C:\\b'],
  ['C:\\\u0130\\a\\b', 'C:\\\u0130\\c'],
  ['C:\\x\\\u0130', 'C:\\x\\\u0130\u0130'],
  ['C:\\\u{1d400}', 'C:\\\u{1d400}\\x'],
  ['C:\\\u{1d400}\\a', 'C:\\\u{1d400}\\b'],
  ['C:\\\u{10400}', 'C:\\\u{10428}\\x'],
  ['C:\\\u03a3', 'C:\\\u03c3\\x'],
  ['C:\\A\u03a3', 'C:\\a\u03c2\\x'],
  ['C:\\\u1e9e', 'C:\\\u00df\\x'],
  ['C:\\\u212a', 'C:\\k\\x'],
  ['C:\\', 'C:\\\u0130\\x'],
  ['\\\\srv\\sh\\\u0130', '\\\\srv\\sh\\\u0130\\x'],
  ['C:\\a', 'D:\\\u0130'],
];
const rows = pairs.map(([from, to]) => ({ from, to, relative: win32.relative(from, to) }));
process.stdout.write(`${JSON.stringify({ node: process.version, rows }, null, 1)}\n`);
