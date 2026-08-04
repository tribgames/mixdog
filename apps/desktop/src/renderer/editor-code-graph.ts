export type EditorCodeGraphMode = "find_symbol" | "references" | "symbols";

export interface EditorGraphLocation {
  rel: string;
  line: number;
  endLine: number;
  column: number;
}

export interface EditorGraphSymbol {
  kind: string;
  name: string;
  line: number;
  endLine: number;
}

/** Parse the stable path:line[-end][:column] anchors emitted by code_graph. */
export function parseCodeGraphLocations(text: string): EditorGraphLocation[] {
  const seen = new Set<string>();
  const out: EditorGraphLocation[] = [];
  for (const match of String(text || "").matchAll(
    /([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9_]+):(\d+)(?:-(\d+))?(?::(\d+))?/g,
  )) {
    const rel = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const line = Number(match[2]);
    const endLine = Math.max(line, Number(match[3] || line));
    const column = Math.max(1, Number(match[4] || 1));
    const key = `${rel}:${line}:${endLine}:${column}`;
    if (!line || rel.includes("node_modules") || seen.has(key)) continue;
    seen.add(key);
    out.push({ rel, line, endLine, column });
  }
  return out;
}

/** Parse code_graph's file-outline rows, e.g. "function save (L89-104)". */
export function parseCodeGraphSymbols(text: string): EditorGraphSymbol[] {
  const seen = new Set<string>();
  const out: EditorGraphSymbol[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)\s+(.+?)\s+\(L(\d+)(?:-(\d+))?\)\s*$/.exec(raw.trim());
    if (!match) continue;
    const kind = match[1];
    const name = match[2].trim();
    const line = Number(match[3]);
    const endLine = Math.max(line, Number(match[4] || line));
    const key = `${kind}:${name}:${line}:${endLine}`;
    if (!name || !line || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name, line, endLine });
  }
  return out;
}
