// Records to_primitive.json: [input, string, number] rows for a JSON text `input`, where string is
// {"ok": String(JSON.parse(input))} or {"err": message} when String throws, and number is
// {"ok": the IEEE bits of Number(JSON.parse(input)) in hex, or "nan"} or {"err": message}.
// Run: node to_primitive.mjs > to_primitive.json
const owns = [];
for (const key of ['toString', 'valueOf']) {
  for (const value of ['null', '"x"', '"7"', '{}', '[]', '7', 'true', '{"toString":null}']) owns.push(`{"${key}":${value}}`);
}
for (const [a, b] of [['null', 'null'], ['"x"', '"7"'], ['{}', '{}'], ['"7"', 'null']]) {
  owns.push(`{"toString":${a},"valueOf":${b}}`, `{"valueOf":${b},"toString":${a}}`);
}
owns.push('{"a":{"toString":null}}', '{"tostring":null}', '{"__proto__":{"toString":null}}', '{"toString":null,"x":1}');
const inputs = [
  'null', 'true', 'false', '0', '-0', '1.5', '"7"', '" 0x10 "', '{}', '[]', '[null]', '[[]]', '[{}]', '[1,[2,null],{}]', '["1"]', '[[3]]',
  ...owns,
  ...owns.map((own) => `[${own}]`),
  ...owns.map((own) => `[[${own}]]`),
  ...owns.map((own) => `[1,[2,${own}]]`),
  ...owns.map((own) => `[null,${own}]`),
];
const bits = (number) => {
  if (Number.isNaN(number)) return 'nan';
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, number);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const attempt = (convert) => {
  try {
    return { ok: convert() };
  } catch (error) {
    return { err: `${error.constructor.name}: ${error.message}` };
  }
};
const rows = inputs.map((input) => {
  const value = JSON.parse(input);
  return [input, attempt(() => String(value)), attempt(() => bits(Number(value)))];
});
console.log(JSON.stringify(rows, null, 1));
