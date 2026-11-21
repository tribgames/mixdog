const MODULE_SPECIFIER =
  /(\bimport\s*\(\s*|\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]+?\s*from\s*)(["'])([^"'\n]+)\2/y;

/** A relative or root module specifier (or import map address); anything
 *  else is a bare name or a full URL. */
export const RELATIVE_SPECIFIER = /^(?:\.{1,2}\/|\/)/;

/** Where the import map's `imports` send bare `specifier`: its exact key,
 *  else the longest matching `/`-ending prefix key; '' when none does. */
export function mappedSpecifier(imports: Record<string, unknown>, specifier: string): string {
  const exact = imports[specifier];
  if (Object.hasOwn(imports, specifier)) return typeof exact === 'string' ? exact : '';
  let prefix = '';
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && specifier.startsWith(key) && key.length > prefix.length) prefix = key;
  }
  const target = prefix ? imports[prefix] : '';
  return typeof target === 'string' && target ? target + specifier.slice(prefix.length) : '';
}

/** Words after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Real module specifiers in `source`: a lexer skips strings, template
 *  literals, comments and regex literals, so import-looking text inside them
 *  never matches. */
export function moduleSpecifiers(source: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const braces: boolean[] = [];
  const n = source.length;
  let i = 0;
  let regexOk = true;
  const skipQuoted = (quote: string): void => {
    i += 1;
    while (i < n && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
    i += 1;
  };
  const templateText = (): void => {
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') i += 2;
      else if (source[i] === '$' && source[i + 1] === '{') {
        braces.push(true);
        i += 2;
        regexOk = true;
        return;
      } else i += 1;
    }
    i += 1;
    regexOk = false;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (/\s/.test(c)) i += 1;
    else if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      skipQuoted(c);
      regexOk = false;
    } else if (c === '`') {
      i += 1;
      templateText();
    } else if (c === '/' && regexOk) {
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      regexOk = false;
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      let match: RegExpExecArray | null = null;
      if (word === 'import' || word === 'export') {
        let before = start - 1;
        while (before >= 0 && /\s/.test(source[before])) before -= 1;
        if (source[before] !== '.') {
          MODULE_SPECIFIER.lastIndex = start;
          match = MODULE_SPECIFIER.exec(source);
        }
      }
      if (match) {
        found.push(match);
        i = start + match[0].length;
        regexOk = false;
      } else regexOk = REGEX_AFTER_WORD.has(word);
    } else if (/\d/.test(c)) {
      while (i < n && /[\w.]/.test(source[i])) i += 1;
      regexOk = false;
    } else {
      i += 1;
      if (c === '{') {
        braces.push(false);
        regexOk = true;
      } else if (c === '}' && braces.pop()) templateText();
      else regexOk = c !== ')' && c !== ']';
    }
  }
  return found;
}
