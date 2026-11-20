// The subset of TOML the tracked Cargo manifests and nextest.toml use: tables, arrays of tables, dotted keys, strings (basic, literal,
// multi-line), booleans, integers, arrays (multi-line) and inline tables. Anything else throws: a manifest this cannot read is an
// inventory error, never a guess.

function skipSpace(text, at, { newlines = false } = {}) {
  let i = at;
  for (;;) {
    const char = text[i];
    if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) i += 1;
    else if (newlines && char === '#') while (i < text.length && text[i] !== '\n') i += 1;
    else return i;
  }
}

function readString(text, at) {
  const quote = text[at];
  if (text.startsWith(quote.repeat(3), at)) {
    const end = text.indexOf(quote.repeat(3), at + 3);
    if (end < 0) throw new Error('unterminated multi-line string');
    let body = text.slice(at + 3, end);
    if (body.startsWith('\n')) body = body.slice(1);
    return [quote === '"' ? unescapeBasic(body) : body, end + 3];
  }
  let i = at + 1;
  let raw = '';
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\n') throw new Error('unterminated string');
    if (quote === '"' && text[i] === '\\') {
      raw += text[i] + text[i + 1];
      i += 2;
    } else raw += text[i++];
  }
  if (text[i] !== quote) throw new Error('unterminated string');
  return [quote === '"' ? unescapeBasic(raw) : raw, i + 1];
}

function unescapeBasic(raw) {
  return raw.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/gs, (_, hex, char) =>
    hex
      ? String.fromCharCode(Number.parseInt(hex, 16))
      : ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[char] ?? char)
  );
}

function readValue(text, at) {
  let i = skipSpace(text, at);
  const char = text[i];
  if (char === '"' || char === "'") return readString(text, i);
  if (char === '[') {
    const out = [];
    i += 1;
    for (;;) {
      i = skipSpace(text, i, { newlines: true });
      if (text[i] === ']') return [out, i + 1];
      const [value, next] = readValue(text, i);
      out.push(value);
      i = skipSpace(text, next, { newlines: true });
      if (text[i] === ',') i += 1;
      else if (text[i] !== ']') throw new Error(`bad array near ${JSON.stringify(text.slice(i, i + 20))}`);
    }
  }
  if (char === '{') {
    const out = {};
    i += 1;
    for (;;) {
      i = skipSpace(text, i);
      if (text[i] === '}') return [out, i + 1];
      const [path, next] = readKey(text, i);
      i = skipSpace(text, next);
      if (text[i] !== '=') throw new Error('inline table key without =');
      const [value, after] = readValue(text, i + 1);
      assign(out, path, value);
      i = skipSpace(text, after);
      if (text[i] === ',') i += 1;
      else if (text[i] !== '}') throw new Error('bad inline table');
    }
  }
  const word = /^[^\s,\]}#]+/.exec(text.slice(i))?.[0];
  if (word === 'true' || word === 'false') return [word === 'true', i + word.length];
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(word ?? '')) return [Number(word.replaceAll('_', '')), i + word.length];
  throw new Error(`unsupported value ${JSON.stringify(word)}`);
}

function readKey(text, at) {
  const path = [];
  let i = skipSpace(text, at);
  for (;;) {
    if (text[i] === '"' || text[i] === "'") {
      const [value, next] = readString(text, i);
      path.push(value);
      i = next;
    } else {
      const word = /^[A-Za-z0-9_-]+/.exec(text.slice(i))?.[0];
      if (!word) throw new Error(`bad key near ${JSON.stringify(text.slice(i, i + 20))}`);
      path.push(word);
      i += word.length;
    }
    i = skipSpace(text, i);
    if (text[i] === '.') i = skipSpace(text, i + 1);
    else return [path, i];
  }
}

function assign(target, path, value) {
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    cursor[part] ??= {};
    cursor = Array.isArray(cursor[part]) ? cursor[part].at(-1) : cursor[part];
  }
  cursor[path.at(-1)] = value;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  let i = 0;
  while (i < text.length) {
    i = skipSpace(text, i, { newlines: true });
    if (i >= text.length) break;
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      const [path, next] = readKey(text, i + (array ? 2 : 1));
      let j = skipSpace(text, next);
      if (text.slice(j, j + (array ? 2 : 1)) !== (array ? ']]' : ']')) throw new Error('bad table header');
      j += array ? 2 : 1;
      let cursor = root;
      for (const part of path.slice(0, -1)) {
        cursor[part] ??= {};
        cursor = Array.isArray(cursor[part]) ? cursor[part].at(-1) : cursor[part];
      }
      const last = path.at(-1);
      if (array) {
        cursor[last] ??= [];
        const entry = {};
        cursor[last].push(entry);
        table = entry;
      } else {
        cursor[last] ??= {};
        table = cursor[last];
      }
      i = j;
    } else {
      const [path, next] = readKey(text, i);
      const j = skipSpace(text, next);
      if (text[j] !== '=') throw new Error(`expected = near ${JSON.stringify(text.slice(i, i + 30))}`);
      const [value, after] = readValue(text, j + 1);
      assign(table, path, value);
      i = after;
    }
    const rest = skipSpace(text, i);
    if (text[rest] === '#') {
      i = rest;
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (text[rest] !== '\n' && rest < text.length)
      throw new Error(`trailing text near ${JSON.stringify(text.slice(rest, rest + 20))}`);
    else i = rest;
  }
  return root;
}
