import { readFileSync, writeFileSync } from 'node:fs';
const [,, nodeFile, rustFile, outFile] = process.argv;
const N = JSON.parse(readFileSync(nodeFile, 'utf8'));
const R = JSON.parse(readFileSync(rustFile, 'utf8'));
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const canon = (v) => JSON.stringify(sortKeys(v));
// One wire tool as { name, description, schema, extra }: the three providers spell the schema key differently
// (parameters / input_schema / inputSchema), and that spelling is representation, not content.
const SCHEMA_KEYS = ['parameters', 'input_schema', 'inputSchema'];
function shape(tool) {
  if (tool.functionDeclarations) return tool.functionDeclarations.map(shape).flat();
  const schemaKey = SCHEMA_KEYS.find((k) => k in tool);
  const { name, description, type, strict, ...rest } = tool;
  const schema = schemaKey ? rest[schemaKey] : undefined;
  if (schemaKey) delete rest[schemaKey];
  return [{ name, description, schema, extra: rest, type, strict }];
}
const flat = (tools) => tools.flatMap(shape);
const out = [];
for (const n of N) {
  out.push(`## ${n.provider} ${n.model}`);
  const r = R.find((x) => x.provider === n.provider);
  if (!r || r.error) { out.push(`rust snapshot unavailable: ${r?.error ?? 'missing'}`); continue; }
  const nt = flat(n.providerTools), rt = flat(r.snapshot.body.tools ?? r.snapshot.body.request?.tools ?? []);
  const nn = nt.map((t) => t.name), rn = rt.map((t) => t.name);
  out.push(`tool names: node ${nn.length}, rust ${rn.length}; only-node=[${nn.filter((x) => !rn.includes(x))}] only-rust=[${rn.filter((x) => !nn.includes(x))}]`);
  out.push(`order same on common names: ${canon(nn.filter((x) => rn.includes(x))) === canon(rn.filter((x) => nn.includes(x)))}`);
  for (const t of nt) {
    const m = rt.find((x) => x.name === t.name);
    if (!m) continue;
    const diffs = [];
    if (t.description !== m.description) diffs.push(`description node=${JSON.stringify(t.description)?.slice(0, 140)} rust=${JSON.stringify(m.description)?.slice(0, 140)}`);
    if (canon(t.schema) !== canon(m.schema)) diffs.push(`schema node=${canon(t.schema)?.slice(0, 200)} rust=${canon(m.schema)?.slice(0, 200)}`);
    if (canon(t.extra) !== canon(m.extra)) diffs.push(`extra node=${canon(t.extra)?.slice(0, 160)} rust=${canon(m.extra)?.slice(0, 160)}`);
    out.push(`  ${t.name}: ${diffs.length ? '' : 'same'}${diffs.join(' | ')}`);
  }
  const b = r.snapshot.body;
  out.push(`rust body keys: ${Object.keys(b)}; headers/url: ${r.snapshot.method} ${r.snapshot.url}`);
}
writeFileSync(outFile, out.join('\n') + '\n');
