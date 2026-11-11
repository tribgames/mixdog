// Normalisation of a recording at declared places: every string value is rewritten by the given replacements and the JSON path of each
// string that changed is returned, so a manifest lists exactly where a per-run value (a temp path, a generated name) was replaced.
// A replacement of a text is applied to its raw and its JSON-escaped form (a path inside a stored JSON text).
export function normalisePaths(doc, { replaceInText = [], replaceRegex = [] }) {
  const paths = [];
  const apply = (s) => {
    let out = s;
    for (const [from, to] of replaceInText) out = out.replaceAll(from, to).replaceAll(JSON.stringify(from).slice(1, -1), to);
    for (const [pattern, to] of replaceRegex) out = out.replace(pattern, to);
    return out;
  };
  const walk = (v, p) => {
    if (typeof v === 'string') { const n = apply(v); if (n !== v) paths.push(p); return n; }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${p}.${k}`)]));
    return v;
  };
  return { doc: walk(doc, '$'), paths };
}