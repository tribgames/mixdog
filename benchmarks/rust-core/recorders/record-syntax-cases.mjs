// Records what V8 answers for `new vm.Script(source)` over a corpus of sources (the classic-script check of
// mixdog-jssyntax): {ok, message} per source. The corpus is the 13 sources of the extension host's
// syntax.e2e.test.mjs, the 3 of mixdog-core's tests/it/script_syntax.rs, every `node -e` body of
// exec-cases/golden.json wrapped as the shell tool's hoist wraps it, and generated positive and negative cases
// for every rule of the early-error pass, each recorded bare, wrapped like a hoisted body, and (for the
// strict-sensitive ones) behind a 'use strict' directive.
//
//   node benchmarks/rust-core/recorders/record-syntax-cases.mjs [--tree <dir>] [--golden <golden.json>]
//
// `--tree` names the product tree whose identity the set manifest records (as every recorder does); without
// it the cases are written and the manifest is left to a run that has a tree. The only code run is
// `new vm.Script` from node:vm: nothing from the product tree is loaded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { FIXTURES_ROOT, parseArgs, stableStringify, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const setDir = join(FIXTURES_ROOT, 'syntax-cases');
const goldenPath = args.get('golden') ?? join(FIXTURES_ROOT, 'exec-cases', 'golden.json');

/** The wrapper of mixdog-tools exec/hoist.rs `ExtSyntax::compiles_as_commonjs`. */
const wrap = (body) => `(function (exports, require, module, __filename, __dirname) {${body}\n})`;

function verdict(source) {
  try {
    new Script(source);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

const cases = [];
const seen = new Set();
function add(tag, source) {
  if (seen.has(source)) return;
  seen.add(source);
  cases.push({ tag, source, ...verdict(source) });
}
/** A snippet bare, as a hoisted body, and (when `strict`) behind a strict directive, bare and hoisted. */
function rule(tag, snippets, { strict = false } = {}) {
  for (const snippet of snippets) {
    add(tag, snippet);
    add(`${tag}:hoisted`, wrap(snippet));
    if (strict) {
      add(`${tag}:strict`, `'use strict'; ${snippet}`);
      add(`${tag}:strict-hoisted`, wrap(`'use strict'; ${snippet}`));
    }
  }
}

// The sources of syntax.e2e.test.mjs.
for (const source of [
  'const a = 1; a + 1',
  '',
  'await 1',
  'import fs from "node:fs"',
  'export const x = 1',
  'return 5',
  'let a = 1; let a = 2;',
  'function (',
  '"unterminated',
  'const f = async () => { await 1 }; f()',
  'class A { #p = 1; static m() { return new A().#p } }',
  'a ?? b',
  '#!/usr/bin/env node\nconsole.log(1)',
]) add('e2e', source);
// The bodies of mixdog-core tests/it/script_syntax.rs, sent the way ExtSyntax sends them.
for (const body of ['await 1', '(async()=>{await 1})()', 'const a = 1']) add('script_syntax', wrap(body));

// Every `node -e` body of the exec-cases golden, wrapped as the hoist wraps it.
if (existsSync(goldenPath)) {
  const bodies = new Set();
  const pattern = /\bnode\s+(?:-e|--eval)\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')/g;
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(pattern)) {
        bodies.add(match[1] !== undefined ? match[1].replace(/\\(["\\$`])/g, '$1') : match[2]);
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(JSON.parse(readFileSync(goldenPath, 'utf8')));
  for (const body of bodies) add('golden-node-e', wrap(body));
}

rule('import-export', [
  'import fs from "node:fs"', 'import "x"', 'import * as a from "x"', 'import { a } from "x"', 'export default 1',
  'export function f() {}', 'export { a }', 'export * from "x"', 'var o = { import: 1 }', 'var o = { export: 1, default: 2 }',
  'o.import', 'o.export = 1', 'import("x")', 'import("x").then(f)', 'var f = () => import("x")', 'import()', 'import(a, b)',
  'import.meta', 'import.meta.url', 'new.target', 'function f() { return new.target }', 'function f() { return () => new.target }',
  'class A { constructor() { new.target } }', 'var o = { import() {}, export() {} }', 'class A { import() {} static export() {} }',
]);
rule('await', [
  'await 1', 'await(1)', 'await (1)', 'await[0]', 'await + 1', 'await - 1', 'await\n(1)', 'await `x`', 'await x', 'await foo()',
  'let await = 1', 'var await = 2; await', 'function await() {}', 'var o = { await: 1 }', 'o.await', 'await: 1',
  'async function f() { await 1 }', 'async function f() { await(1) }', 'async function f() { let await }',
  'async function f() { var await }', 'async function f() { await: 1 }', 'async () => await 1', 'async x => await x',
  '(async function () { await 1 })()', 'function f() { await 1 }', 'function f() { return await(1) }',
  'async function f() { function g() { await 1 } }', 'async function f() { function g() { await(1) } }',
  'async function f() { () => await 1 }', 'async function f() { async () => await 1 }', 'async function f(a = await 1) {}',
  'class A { static { await 1 } }', 'class A { static { var await } }', 'class A { x = await 1 }',
  'for await (const x of y) {}', 'async function f() { for await (const x of y) {} }', 'async function f() { for await (x in y) {} }',
  'async function f() { await 1 ** 2 }', 'async function f() { (await 1) ** 2 }', 'async function* g() { await 1; yield 2 }',
  'var f = async function () { await new Promise(r => r()) }', 'var o = { async m() { await 1 } }',
  'class A { async m() { await 1 } }', 'class A { m() { await 1 } }',
]);
rule('yield', [
  'yield', 'yield 1', 'yield * 1', 'function* g() { yield 1 }', 'function* g() { yield }', 'function* g() { yield* h() }',
  'function g() { yield 1 }', 'function* g(a = yield) {}', 'function* g() { () => yield 1 }', 'function* g() { var yield }',
  'var o = { *g() { yield 1 } }', 'class A { *g() { yield 1 } }', 'var yield = 1', 'var o = { yield: 1 }',
  'function* g() { function h() { yield 1 } }', 'async function* g() { yield 1 }',
], { strict: true });
rule('redeclaration', [
  'let a; let a', 'const a = 1; const a = 2', 'class A {} class A {}', 'let a; var a', 'var a; let a', 'let a; function a() {}',
  'function a() {} let a', 'var a; var a', 'var a; function a() {}', 'function a() {} function a() {}', 'let a; { let a }',
  '{ let a; let a }', '{ let a } { let a }', '{ var a } let a', 'let a; { var a }', '{ function a() {} function a() {} }',
  '{ function a() {} let a }', '{ let a; function a() {} }', '{ function a() {} var a }', '{ var a; function a() {} }',
  'function f(a) { let a }', 'function f(a) { var a }', 'function f(a) { function a() {} }', 'function f(a, a) {}',
  '(a, a) => 1', '(a, b = 1, a) => 1', 'function f(a, a = 1) {}', 'var o = { m(a, a) {} }',
  'try {} catch (e) { let e }', 'try {} catch (e) { var e }', 'try {} catch ([e]) { var e }', 'try {} catch (e) { function e() {} }',
  'try {} catch ([e, e]) {}', 'for (let i;;) { let i; break }', 'for (let i;;) { var i; break }', 'for (let i, i;;) break',
  'for (var i;;) { let i; break }', 'for (const x of y) { let x }', 'for (const x of y) { var x }',
  'switch (a) { case 1: let b; break; case 2: let b }', 'switch (a) { case 1: let b; break; default: var b }',
  'let a, a', 'const [a, a] = []', 'let {a, b: a} = {}', 'var [a, a] = []', 'class A {} var A', 'var A; class A {}',
  'let let = 1', 'const let = 1', 'var let = 1', 'function f() { let a; { var a } }', 'function f() { var a; { let a } }',
  'function f() { let a; function a() {} }', 'if (a) { let b } else { let b }', 'let a; if (x) function a() {}',
], { strict: true });
rule('control-flow', [
  'break', 'continue', 'return', 'return 1', 'function f() { return }', '() => { return 1 }', '() => return 1',
  'while (1) { break }', 'while (1) { continue }', 'do { break } while (0)', 'for (;;) { break }', 'for (;;) { continue }',
  'for (x of y) { break }', 'for (x in y) { continue }', 'switch (a) { case 1: break }', 'switch (a) { case 1: continue }',
  'while (1) { switch (a) { case 1: continue } }', 'a: while (1) { break a }', 'a: while (1) { continue a }',
  'a: { break a }', 'a: { continue a }', 'a: b: while (1) { continue a }', 'a: b: while (1) { continue b }',
  'a: a: 1', 'a: { a: 1 }', 'a: 1; a: 2', 'a: { b: { break a } }', 'break a', 'continue a', 'a: while (1) { break b }',
  'a: while (1) { function f() { break a } }', 'while (1) { function f() { break } }', 'while (1) { () => { continue } }',
  'a: for (;;) { (function () { a: for (;;) { break a } })(); break a }', 'a: if (x) break a',
  'if (a) function f() {}', 'if (a) let b', 'if (a) const b = 1', 'if (a) class B {}', 'while (a) function f() {}',
  'a: function f() {}', 'for (;;) let x', 'for (;;) function f() {}', 'if (a) function* g() {}', 'if (a) async function g() {}',
  'class A { static { return } }', 'class A { static { break } }', 'class A { static { while (1) break } }',
  'throw 1', 'throw\n1', 'throw 1\n', 'try { throw 1 } catch {}', 'try { } finally { }', 'try { }',
], { strict: true });
rule('super-new-target', [
  'super.x', 'super()', 'super[0]', 'function f() { super.x }', 'function f() { super() }', '() => super.x',
  'var o = { m() { return super.m() } }', 'var o = { m: function () { return super.m() } }', 'var o = { m() { return () => super.m } }',
  'class A { m() { return super.m } }', 'class A { constructor() { super() } }', 'class A extends B { constructor() { super() } }',
  'class A extends B { constructor() { return () => super() } }', 'class A extends B { m() { super() } }',
  'class A extends B { static m() { return super.m } }', 'class A extends B { x = super.y }', 'class A extends B { x = super() }',
  'class A extends B { static { super.x } }', 'class A extends B { static { super() } }', 'class A { get x() { return super.x } }',
  'class A extends B { constructor() { super?.x } }', 'class A extends B { constructor() { new super() } }',
  'class A extends B { constructor() { super.#x } #x = 1 }', 'class A extends B { constructor() { function f() { super() } } }',
  'class A { m() { new.target } }', 'class A { x = new.target }', 'class A { static { new.target } }',
  'function f() { new.target }', 'function f() { () => new.target }', '() => new.target', 'new.target', 'new.target.x',
  'new new.target', 'function f() { function g() { new.target } }',
]);
rule('assignment-targets', [
  'a = 1', 'a.b = 1', 'a[0] = 1', '(a) = 1', '((a)) = 1', '(a.b) = 1', '(a + b) = 1', 'a + b = 1', '1 = 2', '"x" = 1',
  'a() = 1', 'this = 1', 'a?.b = 1', 'a?.[0] = 1', '(a?.b) = 1', '[a] = [1]', '[a, b] = [1, 2]', '[a.b] = [1]', '[(a)] = [1]',
  '([a]) = [1]', '({a}) = {}', '({a} = {})', '({a: b} = {})', '({a: b.c} = {})', '({a = 1} = {})', '({...a} = {})', '[...a] = []',
  '[...a, b] = []', '[a + 1] = []', '({a: 1} = {})', '({a: (b)} = {})', '({a: [b]} = {})', '[[a]] = [[1]]', '[a = 1] = []',
  'a += 1', 'a.b += 1', '(a) += 1', 'a?.b += 1', '1 += 1', 'a() += 1', '[a] += 1', 'a **= 2', 'a ||= 1', 'a ??= 1', 'a &&= 1',
  'a?.b ||= 1', 'a++', '++a', 'a--', '--a', 'a.b++', '(a)++', '1++', '++1', 'a()++', 'a?.b++', '++a?.b', '(a + b)++',
  'a\n++\nb', 'a\n++b', 'a ++\n', 'for (a of b) {}', 'for (a.b of c) {}', 'for ((a) of c) {}', 'for ([a] of c) {}', 'for ({a} of c) {}',
  'for (1 of c) {}', 'for (a() of c) {}', 'for (a?.b of c) {}', 'for (a in b) {}', 'for (var a in b) {}', 'for (var a = 1 in b) {}',
  'for (var a = 1 of b) {}', 'for (let a = 1 in b) {}', 'for (var [a] = 1 in b) {}', 'for (var a of b) {}', 'for (let [a, b] of c) {}',
  'for (const {a} of c) {}', 'for (let of of c) {}',
], { strict: true });
rule('strict-mode', [
  'with (a) {}', 'with (a) b', 'var o; with (o) { x }', '010', '08', '09.5', '0o10', '"\\01"', '"\\0"', '"\\08"', '"\\8"', '"\\1a"',
  '"\\x41"', '"\\u0041"', '`\\01`', '`\\0`', 'f`\\01`', 'f`\\u`', '`\\u`', '`\\x`', 'f`\\x`', '`\\unicode`', 'f`\\unicode`',
  'delete a', 'delete a.b', 'delete (a)', 'delete ((a))', 'delete a[0]', 'delete (a, b)', 'eval = 1', 'arguments = 1', 'eval++',
  'var eval', 'var arguments', 'function eval() {}', 'function f(eval) {}', 'function f(arguments) {}', '(eval) => 1',
  'let static', 'var static', 'var public', 'var interface', 'var implements', 'var package', 'var private', 'var protected',
  'var let', 'function f(static) {}', 'function static() {}', 'a.static', 'var o = { static: 1, let: 2 }', 'var o = { public }',
  'function f(a, a) {}', 'function f() { "use strict"; var a; with (a) {} }', 'function f(a = 1) { "use strict" }',
  'function f() { "use strict"; 010 }', 'function f() { "use strict" } with (a) {}', '"use strict"; with (a) {}',
  '"use strict"\nwith (a) {}', "'use strict'; with (a) {}", '"use\\x20strict"; with (a) {}', '("use strict"); with (a) {}',
  '"a"; "use strict"; with (a) {}', '"use strict".length; with (a) {}', 'class A { m() { with (a) {} } }',
  'class A { m() { return 010 } }', 'class A { m() { var public } }', 'class A { [010]() {} }', 'class let {}', 'class A { m(a, a) {} }',
  'function f() { "use strict"; function eval() {} }', 'function eval() { "use strict" }', 'function f(a, a) { "use strict" }',
]);
rule('object-literals', [
  '({ __proto__: 1, __proto__: 2 })', '({ __proto__: 1, "__proto__": 2 })', '({ "__proto__": 1, "__proto__": 2 })',
  '({ __proto__: 1, ["__proto__"]: 2 })', '({ __proto__: 1, __proto__() {} })', '({ __proto__: 1, __proto__ })',
  '({ __proto__, __proto__ })', '({ __proto__: 1 })', '({ __proto__: 1, a: 2, __proto__: 3 })',
  '({ __proto__: a, __proto__: b } = {})', '[{ __proto__: a, __proto__: b }] = []', '({ a: 1, a: 2 })',
  '({ get a() { return 1 }, set a(v) {} })', '({ get a(b) { return 1 } })', '({ set a() {} })', '({ set a(...b) {} })',
  '({ get a() { return 1 }, get a() { return 2 } })', '({ a, b })', '({ a = 1 })', '({ async a() {}, *b() {}, async *c() {} })',
  '({ get: 1, set: 2, async: 3, static: 4 })', '({ get() {}, set() {}, async() {} })', '({ import: 1 })', '({ if: 1, class: 2 })',
  '({ 1: 1, "a": 2, [3]: 3 })', '({ #a: 1 })', '({ this })', '({ yield })', '({ await })', '({ eval })', '({ enum: 1 })',
]);
rule('regex', [
  '/a/', '/a/g', '/a/gg', '/a/gimsuyd', '/a/gimsuyvd', '/a/uv', '/(/', '/)/', '/[/', '/[a-/', '/a{2,1}/', '/a{1}/', '/{/', '/}/',
  '/(?<a>.)(?<a>.)/', '/(?<a>.)\\k<a>/', '/\\k<a>/', '/\\k<a>/u', '/(?<=a)b/', '/(?<!a)b/', '/(?:a)/', '/(?=a)/', '/(?i:a)/',
  '/\\p{L}/u', '/\\p{L}/', '/\\p{Foo}/u', '/\\u{41}/u', '/\\u{110000}/u', '/\\u{41}/', '/[\\d-a]/u', '/[\\d-a]/', '/\\1/', '/\\1(a)/',
  '/\\/(/', '/a/.test("a")', 'x = /a/g', 'a / b / c', 'a /b/ c', '1 / 2 / 3', '/[/]/', '/a+?/', '/a**/', '/*/', '/+/', '/?/', '/\\c/',
  '/\\c1/', '/\\x4/', '/\\u12/', '/\\_/', '/\\-/', '/[\\-]/u', '/\\-/u', '/(?<a>x)/u', '/[a&&b]/v', '/[a--b]/v', '/[[a]--[b]]/v', '/\\p{RGI_Emoji}/v',
  '/a/y', '/a/s', '/a/d', '/a/m', '/a/i', '/a/z',
]);
rule('numbers', [
  '1_000', '1__0', '1_', '_1', '0_1', '0x_1', '0x1_', '0x1_0', '0b1_0', '0b1__0', '0o7_7', '1_.5', '1._5', '1.5_5', '1e1_0', '1e_1', '1_e1',
  '.5', '5.', '5..toString()', '5.toString()', '5 .toString()', '5.0.toString()', '0.5', '0e1', '0E1', '1e+5', '1e-5', '1e', '1e+',
  '0x', '0xg', '0b2', '0o8', '0b', '0o', '1n', '0n', '1_0n', '1.5n', '1e5n', '01n', '010n', '0x1n', '08n', '1a', '1_a', '3in []', '3 in []',
  '3instanceof Object', '3if', '0x1g', '1$', '1\\u0061', '0.0_1', '00', '007', '0_', '09', '08.5', '09e1', '010.5', '010e1', '0.', '.',
  '9007199254740993n', '0xffn', '5e3', '0B11', '0O17', '0X1f', '1E3', '1e1.5',
], { strict: true });
rule('private-names', [
  'class A { #a = 1; m() { return this.#a } }', 'class A { m() { return this.#a } }', 'class A { #a; #a }', 'class A { #a; m() { #a } }',
  'class A { get #a() {} set #a(v) {} }', 'class A { get #a() {} get #a() {} }', 'class A { static get #a() {} set #a(v) {} }',
  'class A { #a; get #a() {} }', 'class A { #a = 1; m() { delete this.#a } }', 'class A { #a = 1; m() { delete (this.#a) } }',
  'class A { #a = 1; m() { delete this?.#a } }', 'class A { #a = 1; m() { return #a in this } }', 'class A { m() { return #a in this } }',
  'class A { #a = 1; m() { return this?.#a } }', 'class A { #constructor }', 'class A { #a; static m(o) { return o.#a } }',
  'class A { #a; m() { class B { m() { return this.#a } } } }', 'class A { m() { class B { #a } return this.#a } }',
  'class A { #a = this.#b; #b = 1 }', 'class A extends (class { #z }) { m() { return this.#z } }', '({ a: this.#a })', 'this.#a',
  'class A { #a; m() { return this.#a.#a } }', 'class A { #m() {} n() { this.#m() } }', 'class A { static #s = 1; static f() { return A.#s } }',
]);
rule('classes', [
  'class A { constructor() {} constructor() {} }', 'class A { constructor() {} }', 'class A { get constructor() {} }',
  'class A { set constructor(v) {} }', 'class A { *constructor() {} }', 'class A { async constructor() {} }', 'class A { static constructor() {} }',
  'class A { constructor = 1 }', 'class A { "constructor" = 1 }', 'class A { static constructor = 1 }', 'class A { static prototype() {} }',
  'class A { static prototype = 1 }', 'class A { prototype() {} }', 'class A { static "prototype"() {} }', 'class A { ["constructor"]() {} ["constructor"]() {} }',
  'class A { x = arguments }', 'class A { x = () => arguments }', 'class A { x = function () { return arguments } }', 'class A { static { arguments } }',
  'class A { m() { return arguments } }', 'class A { x = 1; y = 2; static z = 3; static { this.z = 4 } }', 'class A { static async *[Symbol.iterator]() {} }',
  'class A extends B {}', 'class A extends (B, C) {}', 'class A extends null {}', 'class A extends B.C {}', 'class A extends f() {}',
  '(class {})', '(class A {})', '(class A extends B {})', 'class A { ; ; }', 'class A { static async m() {} static get x() {} static set x(v) {} }',
  'class A { get a() {} set a(v) {} }', 'class A { get a(b) {} }', 'class A { set a() {} }', 'class A { set a(...b) {} }', 'class A { set a(b = 1) {} }',
  '@dec class A {}', 'class A { @dec m() {} }', 'class A { static static() {} }', 'class A { static get() {} }', 'class A { get() {} set() {} async() {} }',
  'class A { async *m() {} }', 'class A { async\nm() {} }', 'class A { get\nm() {} }', 'class A { x\ny }', 'class A { x = 1\n*m() {} }',
]);
rule('declarations', [
  'const a', 'const a;', 'const a, b = 1', 'let a', 'var a', 'let [a]', 'var [a]', 'var {a}', 'let {a} = {}', 'const [a] = []',
  'for (const a;;) break', 'for (let [a];;) break', 'for (var [a];;) break', 'for (const a of b) {}', 'for (const a in b) {}',
  'let a = 1, b = 2', 'var a = 1, a = 2', 'let x = 1; { let x = 2; { let x = 3 } }', 'var undefined', 'let undefined', 'var NaN',
  'function f({a}, [b], ...c) {}', 'function f(...a, b) {}', 'function f(a,) {}', '(a,) => 1', '(...a,) => 1', '(a, ...b) => 1', 'async (a, b) => 1',
  'async\n(a) => 1', 'a\n=> 1', '(a)\n=> 1', 'async a\n=> 1', 'async (a)\n=> 1', 'a => { }', 'a => ({})', 'a => {} + 1', '(a => 1)(2)',
  'enum', 'var enum', 'enum = 1', 'var o = { enum: 1 }', 'o.enum', 'var null', 'var true', 'var this', 'var new', 'var class',
  'var \\u0061', 'var \\u{61}', 'var a\\u0062', 'var \\u0076ar', 'var €', 'var a€', 'var ü', 'var 𠮷', 'var a\u200d', 'var \u200da', 'var a\u00b7',
  'var _$', 'var $_', 'var ℮', 'var ゛', 'var 𝒳', '€', '\u00a0', '\ufeff1', 'a\u2028b', 'a\u2029b', '"\u2028"', '`\u2028`',
]);
rule('operators', [
  '-a ** 2', '(-a) ** 2', '-(a ** 2)', 'a ** -b', 'a ** b ** c', '+a ** 2', '!a ** 2', '~a ** 2', 'typeof a ** 2', 'void a ** 2', 'delete a.b ** 2',
  '-1 ** 2', '(-1) ** 2', 'a++ ** 2', '++a ** 2', 'a ** ++b', 'a ?? b', 'a ?? b ?? c', 'a ?? b || c', 'a || b ?? c', 'a && b ?? c', 'a ?? b && c',
  '(a ?? b) || c', 'a ?? (b || c)', 'a || (b ?? c)', 'a ?. b', 'a?.b', 'a?.[0]', 'a?.()', 'a?.b.c', 'a?.b()', 'a?.b`x`', 'a?.`x`', 'a`x`', 'a.b`x`',
  'new a?.b()', 'new a?.()', 'new (a?.b)()', 'new a.b()', 'new a', 'new a()', 'new new a()()', 'new a`x`', 'a?.b\n`x`', '(a?.b)`x`', 'a?.b?.c`x`',
  'a ? b : c', 'a ? b : c ? d : e', 'a ?.5 : 1', 'a ? .5 : 1', 'a?.5:1', 'a , b', 'a in b', '#a in b', 'a instanceof b', 'a = b = c',
  'typeof typeof a', 'void void a', '- -a', '- - a', '+ +a', 'a+++b', 'a---b', 'a+ ++b', 'a++b', 'a +++ b',
  'async function f() { await a ** 2 }', 'async function f() { await (a ** 2) }', 'async function f() { -await a ** 2 }',
]);
rule('substatements-and-misc', [
  'debugger', ';', ';;', '{}', '{ }', 'if (a) ; else ;', 'if (a) b; else if (c) d; else e', 'if (a) {} else {}', 'do ; while (0)', 'do {} while (0) a',
  'do a; while (0) b', 'for (;;) ;', 'for (a;;) break', 'for (;a;) break', 'for (;;a) break', 'for (var i = 0, j; i < 1; i++) {}',
  'for (let i = 0; i < 1; i++) { setTimeout(() => i) }', 'while (0) ;', 'switch (a) {}', 'switch (a) { default: }', 'switch (a) { default: default: }',
  'switch (a) { case 1: case 2: break; default: break }', 'try {} catch {}', 'try {} catch (e) {} finally {}', 'try {} catch (e, f) {}',
  'try {} catch (e = 1) {}', 'try {} catch ({a}) {}', 'try {} finally', 'label: { }', 'a: b: c: ;', 'x = function () {}', 'x = function f() {}',
  'x = function* () {}', 'x = async function () {}', 'x = async function* () {}', 'function f() {} function* g() {} async function h() {} async function* i() {}',
  '(function () {})()', '(function () {}())', '!function () {}()', '(() => {})()', '(async () => {})()', 'new Function("a", "return a")',
  '`a${b}c`', '`a${`b${c}`}d`', '`${a}`', '`a', '`${', '`${a`', "'a\\\nb'", '"a\nb"', "'\\u{1F600}'", "'\\u{110000}'", "'\\u{}'", "'\\u12'", "'\\x1'",
  "'\\x41'", "'\\u0041'", "'\\z'", "'\\\u2028'", '/* c */ 1', '// c\n1', '/* unterminated', '<!-- c\n1', '1\n--> c', '1 --> c', '<!-- c', 'a <!-- b',
  '#!shebang', '#!shebang\n1', ' #!shebang', '\n#!shebang', '1\n#!shebang', '#!', '#', '#a', '@', 'a @ b', '\\', 'a\\b',
  '<a/>', '<a></a>', '<></>', 'a < b > c', 'a<b>(c)', 'var a: number', 'type A = B', 'interface A {}', 'enum A {}', 'a as b', 'a!', 'a satisfies b',
  'let\nx', 'let\n[a] = [1]', 'let [a] = [1]', 'async\nfunction f() {}', 'async function f() {}', 'var async; async\n(1)', 'async(1)', 'async', 'of', 'let', 'static',
  'using a = b', 'await using a = b', 'async function f() { await using a = b }', 'for (using a of b) {}', 'accessor', 'a.#b', 'out', 'get', 'set',
  'o = { get a() {}, set a(v) {} }', 'o = { get: 1 }', 'a = b\n(c)', 'a = b\n[c]', 'a\n`x`', 'a\n/b/g', 'return\n1', 'function f() { return\n1 }',
  'function f() { return 1\n2 }', 'x = { a: 1 }\n[1]', 'continue\na', 'while (1) { continue\na }', 'break\na', 'a: while (1) { break\na }', 'throw\na',
  'a: while (1) { throw 1 }', 'yield\n1', 'function* g() { yield\n1 }', 'function* g() { yield /a/ }', 'function* g() { yield\n/a/ }', 'x = yield',
]);

// Deeply nested sources (the check answers "invalid" past a limit, so only moderate depths are compared).
add('nesting', wrap(`${'['.repeat(40)}1${']'.repeat(40)}`));
add('nesting', wrap(`${'a('.repeat(40)}1${')'.repeat(40)}`));
add('nesting', wrap(`${'{'.repeat(40)}${'}'.repeat(40)}`));
add('nesting', wrap(`x = ${'('.repeat(40)}1${')'.repeat(40)}`));
add('nesting', wrap(`${'a.b.'.repeat(30)}c`));
add('nesting', wrap(`${'1 + '.repeat(60)}1`));

if (cases.length < 500) throw new Error(`only ${cases.length} cases recorded, the corpus needs at least 500`);

mkdirSync(setDir, { recursive: true });
writeFileSync(
  join(setDir, 'cases.json'),
  stableStringify({
    note: 'new vm.Script(source) on each source: ok, and V8\'s message when it does not compile. Tags name the rule a case probes; ":hoisted" is the source inside the shell tool\'s CommonJS wrapper, ":strict" behind a use-strict directive.',
    node: process.version,
    v8: process.versions.v8,
    cases,
  })
);
if (args.has('tree')) {
  const { resolveTree } = await import('./lib/common.mjs');
  writeSetManifest(setDir, {
    set: 'syntax-cases',
    recorder: 'benchmarks/rust-core/recorders/record-syntax-cases.mjs',
    command: 'node benchmarks/rust-core/recorders/record-syntax-cases.mjs --tree <tree>',
    identityTree: resolveTree(args),
  });
}
const okCount = cases.filter((c) => c.ok).length;
console.log(`${cases.length} cases (${okCount} compile, ${cases.length - okCount} do not), node ${process.version}`);
