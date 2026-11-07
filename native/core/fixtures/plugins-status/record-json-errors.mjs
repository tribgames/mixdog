// Records, from today's Node product, the messages `loadPluginMcpDeclarations` (plugin-mcp.mjs
// `readJsonFile`/`jsonErrorMessage`) puts in a plugin's declaration errors for a `.mcp.json` of each
// kind of damage: the bytes of the file (hex) and the error messages that came back. A row with
// `directory: true` makes `.mcp.json` a folder.
// Usage: node record-json-errors.mjs <repo-root> <scratch-dir>   (the golden JSON goes to stdout)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, scratch] = process.argv.slice(2);
const { loadPluginMcpDeclarations } = await import(pathToFileURL(join(root, 'src', 'runtime', 'agent', 'orchestrator', 'runtime-core', 'plugin-mcp.mjs')).href);

const text = (value) => Buffer.from(value, 'utf8');
const cases = [];
const add = (name, bytes, extra = {}) => cases.push({ name, bytes: Buffer.from(bytes), ...extra });
const word = (value) => add(JSON.stringify(value), text(value));
// Unexpected token / end / string / number, at the start and further in.
for (const value of [
  '', ' ', '\n\n', '{', '[', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":{', '{"a":[', '{"a":[1', '{"a":[1,',
  '"abc', '"abc\\', '"a\\u12', '{"a":"x', 'tru', 'nul', 'fals', 'truex', 'nulll',
  '{,}', '{a:1}', "{'a':1}", '{"a" 1}', '{"a":1 "b":2}', '{"a":1,}', '{"a":1,,"b":2}', '[1,]', '[,1]', '[1 2]', '[1,,2]', '[}', '{]', '}', ']', ',', ':',
  '{"a":}', '{"a":,}', '{"a"::1}', '{"a":1}}', '{} {}', '[] []', '{}x', '{} x', 'null null',
  '"a\\qb"', '"a\\x41"', '"a\\u12g4"', '"a\\u"', '"a\\\'b"', '"tab\there"', '"line\nbreak"', '"nul\u0000x"', '"\u001f"',
  '01', '00', '-', '-x', '--1', '+1', '1.', '1.e5', '.5', '1e', '1e+', '1E-', '0x10', '1a', '-0.', '1.5.5', '12abc',
  'NaN', 'Infinity', '-Infinity', 'undefined', '[object Object]', 'True', 'NULL', 'abc', 'xyz', '<html>', '<!DOCTYPE html>', 'Not Found',
  '{"mcpServers":{"a":{"command":"x"},}}', '{"mcpServers":{"a":{"command":"x"}}', '{"mcpServers":{"a":{"command":"x"}}}}',
  '{\n  "mcpServers": {\n    "a": {\n      "command": "x",\n    }\n  }\n}', '{\r\n  "a": 1,\r\n  b\r\n}', '{\r  "a": 1,\r  b\r}',
  '\ufeff{"mcpServers":{}}', ' \u00a0{}', '{"a":\u00e9}', '{"\u00e9":1,}', '\u00e9', '\ud83d\ude00', '{"a":"\ud83d\ude00",}', '[\ud83d\ude00]',
  // A damaged text that itself reads like V8's location or end-of-input phrase.
  'line 1 column 2 xyz', 'xx line 7 column 9 yy', 'abcdefghij line 3 column 4 klmnop', 'a position 12 b', 'at position 99 of the text', 'end of JSON input', 'x end of data input',
  // Long texts: the context window around the token (start, middle, end).
  'x'.repeat(40), `{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8 "i":9}`, `${'['.repeat(30)}1,]`, `{"k":"${'v'.repeat(30)}"}x`, `${' '.repeat(25)}#${' '.repeat(25)}`,
  // Valid JSON that is not a server map.
  '[]', '1', '"s"', 'null', 'true', '{"mcpServers":1}', '{"mcpServers":{"a":{"command":"x"}}}', '{"a":"\\ud800"}', '{"__proto__":{"command":"x"}}', '{"a":1e999}',
]) word(value);
add('invalid UTF-8 byte in a string', [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
add('invalid UTF-8 byte outside a string', [0x7b, 0xff, 0x7d]);
add('truncated UTF-8 sequence', [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2, 0x82]);
add('the file is a folder', [], { directory: true });

const out = [];
for (const [index, row] of cases.entries()) {
  const dir = join(scratch, String(index));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (row.directory) mkdirSync(join(dir, '.mcp.json'));
  else writeFileSync(join(dir, '.mcp.json'), row.bytes);
  const { errors } = loadPluginMcpDeclarations(dir);
  out.push({ name: row.name, hex: row.bytes.toString('hex'), directory: row.directory === true, errors: errors.map((error) => error.message) });
}
console.log(JSON.stringify({ node: process.version, rows: out }, null, 1));
process.exit(0);
