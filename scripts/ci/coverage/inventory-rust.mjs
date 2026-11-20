// The Rust sources of the tracked tree (docs/testing.md, "Release coverage"): the packages and their targets from the manifests, the
// source files each target reaches through `mod`, `#[path]` and `include!`, and the rustdoc blocks of the lib targets. No test is
// named here: which tests exist is what nextest lists and reports at run time. A `.rs` file no target reaches is an orphan, and a
// doctest nextest does not run is unassigned, unless the plan classifies the file.
import { posix } from 'node:path';

import { parseToml } from './toml-lite.mjs';

const ITEM_SKIP_TO_END = new Set([
  'impl',
  'trait',
  'struct',
  'enum',
  'union',
  'static',
  'type',
  'use',
  'extern',
  'const',
]);

export function tokenize(text) {
  const tokens = [];
  const docs = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const push = (t, v, extra = {}) => tokens.push({ t, v, line, ...extra });
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') i += 1;
    else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      const body = text.slice(i, stop);
      if (/^\/\/[/!]/.test(body) && !body.startsWith('////')) docs.push({ line, text: body.slice(3) });
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          if (text[i] === '\n') line += 1;
          i += 1;
        }
      }
    } else if (c === '"' || ((c === 'b' || c === 'c') && text[i + 1] === '"')) {
      i += c === '"' ? 1 : 2;
      let value = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') {
          value += text[i] + text[i + 1];
          if (text[i + 1] === '\n') line += 1;
          i += 2;
        } else {
          if (text[i] === '\n') line += 1;
          value += text[i++];
        }
      }
      i += 1;
      push('str', value);
    } else if (
      (c === 'r' || ((c === 'b' || c === 'c') && text[i + 1] === 'r')) &&
      /^(?:b|c)?r#*"/.test(text.slice(i, i + 12))
    ) {
      const head = /^(?:b|c)?r(#*)"/.exec(text.slice(i, i + 12));
      const close = `"${head[1]}`;
      const start = i + head[0].length;
      const end = text.indexOf(close, start);
      if (end < 0) throw new Error('unterminated raw string');
      const value = text.slice(start, end);
      for (const ch of value) if (ch === '\n') line += 1;
      push('str', value);
      i = end + close.length;
    } else if (c === "'") {
      // a lifetime ('a) or a char literal ('a', '\n', '\u{..}')
      if (text[i + 1] === '\\') {
        const end = text.indexOf("'", i + 2);
        i = end + 1;
        push('char', '');
      } else if (text[i + 2] === "'") {
        i += 3;
        push('char', '');
      } else {
        const word = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
        if (word) {
          i += word.length;
          push('life', word);
        } else {
          i += 1;
          push('p', "'");
        }
      }
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      let word = text.slice(i, j);
      if (word === 'r' && text[j] === '#' && /[A-Za-z_]/.test(text[j + 1] ?? '')) {
        let k = j + 1;
        while (k < n && /[A-Za-z0-9_]/.test(text[k])) k += 1;
        word = text.slice(j + 1, k);
        j = k;
      }
      push('id', word);
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j]) && !(text[j] === '.' && !/[0-9]/.test(text[j + 1] ?? ''))) j += 1;
      push('num', text.slice(i, j));
      i = j;
    } else {
      push('p', c);
      i += 1;
    }
  }
  return { tokens, docs };
}

function matching(tokens, at) {
  const open = tokens[at].v;
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;
  for (let i = at; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t !== 'p') continue;
    if (token.v === open) depth += 1;
    else if (token.v === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open} at line ${tokens[at].line}`);
}


function readAttribute(tokens, at) {
  // tokens[at] is '#'
  let i = at + 1;
  const inner = tokens[i]?.v === '!';
  if (inner) i += 1;
  const end = matching(tokens, i);
  const body = tokens.slice(i + 1, end);
  const path = [];
  let k = 0;
  while (k < body.length && (body[k].t === 'id' || (body[k].t === 'p' && body[k].v === ':'))) {
    if (body[k].t === 'id') path.push(body[k].v);
    k += 1;
  }
  return { inner, path, args: body.slice(k), line: tokens[at].line, next: end + 1 };
}

/** The `mod` item at `i`: an inline one is parsed in place, a file one is visited. Returns the index after it. */
function parseMod(tokens, i, attrs, ctx, out) {
  const token = tokens[i];
  const name = tokens[i + 1].v;
  const pathAttr = attrs.find((attr) => attr.path.join('::') === 'path');
  if (tokens[i + 2]?.v === '{') {
    const end = matching(tokens, i + 2);
    const dir = pathAttr ? posix.join(ctx.dir, str(pathAttr)) : posix.join(ctx.dir, name);
    parseItems(tokens, i + 3, end, { ...ctx, modPath: [...ctx.modPath, name], dir, inline: true }, out);
    return end + 1;
  }
  // a #[path] below an inline module is relative to the directory of that module, a file's own otherwise
  const wanted = pathAttr
    ? [posix.join(ctx.inline ? ctx.dir : posix.dirname(ctx.file), str(pathAttr))]
    : [posix.join(ctx.dir, `${name}.rs`), posix.join(ctx.dir, name, 'mod.rs')];
  const found = wanted.filter((candidate) => ctx.files.has(candidate));
  if (found.length !== 1)
    out.errors.push({
      code: 'unresolved-mod',
      path: ctx.file,
      line: token.line,
      message: `mod ${name} resolves to ${found.length} files among ${wanted.join(', ')}`,
    });
  else {
    const file = found[0];
    const isModRs = posix.basename(file) === 'mod.rs' || Boolean(pathAttr);
    out.visit(file, {
      ...ctx,
      modPath: [...ctx.modPath, name],
      dir: isModRs ? posix.dirname(file) : posix.join(posix.dirname(file), posix.basename(file, '.rs')),
      inline: false,
    });
  }
  return i + 3;
}

/** The index of the last token of the `fn` item at `i`: its signature and body are skipped, as nothing in them declares an item. */
function skipFn(tokens, i, to) {
  let j = i + 2;
  let depth = 0;
  while (j < to) {
    const t = tokens[j];
    if (t.t === 'p' && '([<'.includes(t.v)) {
      if (t.v === '<') depth += 1;
      else j = matching(tokens, j);
    } else if (t.t === 'p' && t.v === '>') depth = Math.max(0, depth - 1);
    else if (t.t === 'p' && t.v === '{' && depth === 0) {
      j = matching(tokens, j);
      break;
    } else if (t.t === 'p' && t.v === ';' && depth === 0) break;
    j += 1;
  }
  return j;
}

/** The index of the last token of the ITEM_SKIP_TO_END item at `i`. */
function skipItem(tokens, i, to) {
  let j = i + 1;
  while (j < to) {
    const t = tokens[j];
    if (t.t === 'p' && '([{'.includes(t.v)) {
      const end = matching(tokens, j);
      if (t.v === '{') {
        j = end;
        break;
      }
      j = end;
    } else if (t.t === 'p' && t.v === ';') break;
    j += 1;
  }
  return j;
}

/** Parse the items of one token range, appending declarations to `out`. */
function parseItems(tokens, from, to, ctx, out) {
  let i = from;
  let attrs = [];
  while (i < to) {
    const token = tokens[i];
    if (token.t === 'p' && token.v === '#') {
      const attr = readAttribute(tokens, i);
      if (!attr.inner) attrs.push(attr);
      i = attr.next;
      continue;
    }
    if (token.t === 'p' && token.v === ';') {
      i += 1;
      attrs = [];
      continue;
    }
    // visibility and qualifiers
    if (token.t === 'id' && token.v === 'pub') {
      i += 1;
      if (tokens[i]?.v === '(') i = matching(tokens, i) + 1;
      continue;
    }
    if (
      token.t === 'id' &&
      (token.v === 'unsafe' || token.v === 'async' || token.v === 'default') &&
      ['fn', 'mod', 'impl', 'trait', 'extern', 'unsafe', 'async'].includes(tokens[i + 1]?.v)
    ) {
      i += 1;
      continue;
    }
    if (token.t === 'id' && token.v === 'const' && ['fn', 'unsafe', 'async'].includes(tokens[i + 1]?.v)) {
      i += 1;
      continue;
    }
    if (
      token.t === 'id' &&
      token.v === 'extern' &&
      tokens[i + 1]?.t === 'str' &&
      ['fn', 'unsafe'].includes(tokens[i + 2]?.v)
    ) {
      i += 2;
      continue;
    }
    if (token.t === 'id' && token.v === 'mod' && tokens[i + 1]?.t === 'id') {
      i = parseMod(tokens, i, attrs, ctx, out);
      attrs = [];
      continue;
    }
    if (token.t === 'id' && token.v === 'fn' && tokens[i + 1]?.t === 'id') {
      i = skipFn(tokens, i, to) + 1;
      attrs = [];
      continue;
    }
    if (token.t === 'id' && token.v === 'macro_rules' && tokens[i + 1]?.v === '!') {
      i = matching(tokens, i + 3) + 1;
      attrs = [];
      continue;
    }
    if (token.t === 'id' && tokens[i + 1]?.v === '!' && ['(', '[', '{'].includes(tokens[i + 2]?.v)) {
      const end = matching(tokens, i + 2);
      const body = tokens.slice(i + 3, end);
      if (token.v === 'include' && body[0]?.t === 'str') {
        const file = posix.join(posix.dirname(ctx.file), body[0].v);
        if (ctx.files.has(file)) out.visit(file, { ...ctx, dir: ctx.dir, include: true, inline: false });
        else
          out.errors.push({
            code: 'unresolved-include',
            path: ctx.file,
            line: token.line,
            message: `include!(${body[0].v}) names no tracked file`,
          });
      }
      i = end + 1;
      attrs = [];
      continue;
    }
    if (token.t === 'id' && ITEM_SKIP_TO_END.has(token.v)) {
      i = skipItem(tokens, i, to) + 1;
      attrs = [];
      continue;
    }
    // anything else (an unexpected token at item level): step over it
    i += 1;
    attrs = [];
  }
}

const str = (attr) => attr.args.find((arg) => arg.t === 'str')?.v ?? '';

/** Reads one `.rs` file and everything its `mod` declarations reach. */
export function scanCrateRoot(root, files, read) {
  const out = { errors: [], docTests: [], visited: new Set() };
  out.visit = (file, ctx) => {
    if (out.visited.has(`${file}\u0000${ctx.include ? 'i' : ''}${ctx.modPath.join('::')}`)) {
      out.errors.push({
        code: 'module-reached-twice',
        path: file,
        line: 0,
        message: `${file} is reached by more than one mod declaration`,
      });
      return;
    }
    out.visited.add(`${file}\u0000${ctx.include ? 'i' : ''}${ctx.modPath.join('::')}`);
    let tokens;
    try {
      const lexed = tokenize(read(file));
      tokens = lexed.tokens;
      out.docTests.push(...doctestsOf(file, lexed.docs));
    } catch (error) {
      out.errors.push({ code: 'rust-parse-error', path: file, line: 0, message: error.message });
      return;
    }
    try {
      parseItems(tokens, 0, tokens.length, { ...ctx, file, files }, out);
    } catch (error) {
      out.errors.push({ code: 'rust-parse-error', path: file, line: 0, message: error.message });
    }
  };
  const dir = posix.dirname(root);
  out.visit(root, { modPath: [], dir, inline: false });
  return out;
}

// A fenced block of a doc comment that rustdoc compiles (no language, rust, or a rustdoc attribute) is a doctest; nextest does not run it.
function doctestsOf(file, docs) {
  const found = [];
  let open = null;
  for (const doc of docs) {
    const fence = /^\s*(`{3,}|~{3,})\s*([^`]*)$/.exec(doc.text);
    if (!fence) continue;
    if (open) {
      open = null;
      continue;
    }
    const tags = fence[2].split(/[\s,]+/).filter(Boolean);
    const foreign = tags.some((tag) =>
      /^(text|txt|toml|json|sh|bash|shell|console|yaml|yml|ini|c|cpp|js|javascript|ts|typescript|python|py|diff|html|xml|markdown|md|ignore|powershell|ps1|plain|plaintext|sql|csv|log|ebnf|asm)$/.test(
        tag
      )
    );
    open = { line: doc.line };
    if (!foreign) found.push({ file, line: doc.line, info: fence[2].trim() });
  }
  return found;
}

/**
 * Packages and their test targets from tracked manifests.
 * @param {string[]} tracked tracked paths
 * @param {(path: string) => string} read
 */
export function readPackages(tracked, read) {
  const set = new Set(tracked);
  const packages = [];
  const errors = [];
  for (const path of tracked.filter((file) => posix.basename(file) === 'Cargo.toml')) {
    let toml;
    try {
      toml = parseToml(read(path));
    } catch (error) {
      errors.push({ code: 'manifest-parse-error', path, line: 0, message: error.message });
      continue;
    }
    if (!toml.package) continue;
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const rel = (file) => (dir ? posix.join(dir, file) : file);
    const name = toml.package.name;
    const targets = [];
    const lib = toml.lib ?? {};
    const libPath = rel(lib.path ?? 'src/lib.rs');
    if (set.has(libPath) && lib.test !== false) {
      targets.push({
        kind: 'lib',
        name: lib.name ?? name.replaceAll('-', '_'),
        root: libPath,
        doctest: lib.doctest !== false,
      });
    }
    const declared = new Set();
    for (const bin of toml.bin ?? []) {
      const root = rel(
        bin.path ?? (bin.name === name && set.has(rel('src/main.rs')) ? 'src/main.rs' : `src/bin/${bin.name}.rs`)
      );
      declared.add(root);
      if (bin.test !== false) targets.push({ kind: 'bin', name: bin.name, root });
    }
    if (toml.package.autobins !== false) {
      if (
        set.has(rel('src/main.rs')) &&
        !declared.has(rel('src/main.rs')) &&
        !(toml.bin ?? []).some((bin) => bin.name === name)
      )
        targets.push({ kind: 'bin', name, root: rel('src/main.rs') });
      for (const file of tracked) {
        const hit =
          new RegExp(`^${escape(rel('src/bin/'))}([^/]+)\\.rs$`).exec(file) ??
          new RegExp(`^${escape(rel('src/bin/'))}([^/]+)/main\\.rs$`).exec(file);
        if (hit && !declared.has(file)) targets.push({ kind: 'bin', name: hit[1], root: file });
      }
    }
    for (const test of toml.test ?? []) {
      const root = rel(test.path ?? `tests/${test.name}.rs`);
      declared.add(root);
      if (test.test !== false) targets.push({ kind: 'test', name: test.name, root });
    }
    if (toml.package.autotests !== false) {
      for (const file of tracked) {
        const hit =
          new RegExp(`^${escape(rel('tests/'))}([^/]+)\\.rs$`).exec(file) ??
          new RegExp(`^${escape(rel('tests/'))}([^/]+)/main\\.rs$`).exec(file);
        if (hit && !declared.has(file)) targets.push({ kind: 'test', name: hit[1], root: file });
      }
    }
    // examples and benches: compiled by `cargo test` but their tests do not run (test = false) unless a manifest entry says so
    const nonTest = [...(toml.example ?? []), ...(toml.bench ?? [])].filter((entry) => entry.test === true);
    for (const entry of nonTest)
      errors.push({
        code: 'example-or-bench-tests',
        path,
        line: 0,
        message: `${entry.name} sets test = true: no adapter runs it`,
      });
    packages.push({ name, manifest: path, dir, targets, features: toml.features ?? {}, toml });
  }
  return { packages, errors };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Packages, the doctest blocks of their lib targets, and the problems of the walk (orphan sources, unresolvable modules). */
export function scanRust(tracked, read) {
  const { packages, errors } = readPackages(tracked, read);
  const files = new Set(tracked.filter((file) => file.endsWith('.rs')));
  const doctests = [];
  const reached = new Set();
  const names = new Set();
  for (const pkg of packages) {
    for (const target of pkg.targets) {
      const key = `${pkg.manifest}\u0000${target.kind}\u0000${target.name}`;
      if (names.has(key)) {
        errors.push({
          code: 'duplicate-target',
          path: pkg.manifest,
          line: 0,
          message: `${target.kind} ${target.name} is declared twice`,
        });
        continue;
      }
      names.add(key);
      const out = scanCrateRoot(target.root, files, read);
      for (const file of out.visited) reached.add(file.split('\u0000')[0]);
      errors.push(...out.errors);
      if (target.doctest)
        doctests.push(
          ...out.docTests.map((doc) => ({ ...doc, manifest: pkg.manifest, target: target.name, dir: pkg.dir }))
        );
    }
  }
  // a `.rs` file under a package that no target reaches
  const roots = packages.map((pkg) => pkg.dir);
  for (const file of files) {
    if (reached.has(file)) continue;
    const owner = roots
      .filter((dir) => dir === '' || file.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
    // build scripts, examples and benches are compiled but never run as tests (their targets have test = false)
    if (owner === undefined || /(^|\/)build\.rs$|\/(examples|benches)\//.test(file)) continue;
    errors.push({
      code: 'orphan-rust-source',
      path: file,
      line: 0,
      message: 'no tested target of any package reaches this file',
    });
  }
  return { packages, doctests, errors };
}
