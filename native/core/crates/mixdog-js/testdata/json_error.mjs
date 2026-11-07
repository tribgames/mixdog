// Records json_error.json: [input, message] rows, where message is the text of the SyntaxError
// JSON.parse(input) throws on the recording Node (process.version is the first row's input),
// or null when the input parses. Inputs: hand-picked cases, then for several documents every
// prefix, every one-character substitution and every one-character insertion. Inputs with a lone
// surrogate are left out and messages are made well-formed (a Rust string cannot hold one).
// Run: node json_error.mjs > json_error.json
const docs = ['{"a":1,"b":[true,false,null,"x\\n\\u00e9"],"c":{"d":-1.5e+3}}', '[1,2,{"k":"v"}]', '"str\\"ing"', '[ 1 ,\n 2 ]', '{"日本":"😀"}', '-0.5', '{}', '[]', '1e5'];
const muts = ['x', '"', ',', '}', ']', '{', '[', ':', '\\', '-', '.', 'e', '1', '0', '\n', '\r', '\u0001', '😀', 'é', ' ', 't', 'n', 'u'];
const inputs = new Set(['oops', 'undefined', 'NaN', 'Infinity', '[object Object]', '', '  ', 'trux', 'nulx', 'fals', 'tr ue', 't', 'n', 'f', '-01', '-', '\r\n\r\nx', 'a\rb\nc', '\u2028x', '"\\', '"\\u', '"\\u12', '1e+', '{"a":1}\r\n\r\n}', '[1,2,3] x', ' x', 'x ', 'xxxxxxxxxxxxxxxxxxxx', 'xxxxxxxxxxxxxxxxxxxxx', '0123456789012345678x', '[0,0,0,0,0,0,0,0,0,0,0,0x]', '日本語日本語日本語日本語日本語日本語', '😀😀😀😀😀😀😀😀😀😀😀x', '<html>', '<!doctype html><html><body>Bad gateway</body></html>', 'Internal Server Error', '{"error":"x"}garbage']);
for (const d of docs) {
  for (let i = 0; i <= d.length; i += 1) {
    inputs.add(d.slice(0, i));
    for (const m of muts) {
      inputs.add(d.slice(0, i) + m + d.slice(i + 1));
      inputs.add(d.slice(0, i) + m + d.slice(i));
    }
  }
  inputs.add(`${d}x`);
  inputs.add(`${d} ,`);
}
const rows = [[process.version, null]];
for (const input of inputs) {
  if (!input.isWellFormed()) continue;
  let message = null;
  try {
    JSON.parse(input);
  } catch (error) {
    message = error.message.toWellFormed();
  }
  rows.push([input, message]);
}
console.log(JSON.stringify(rows));