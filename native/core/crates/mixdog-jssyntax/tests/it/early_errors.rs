//! `check_commonjs_script` accepts exactly the sources a CommonJS script body may contain (ECMAScript Script goal, sloppy
//! mode unless a directive says otherwise) and rejects the ones the specification's early-error rules forbid.
//! The shell tool hoists a script only on `Ok`, so a wrongly accepted source is the dangerous direction.

use mixdog_jssyntax::check_commonjs_script;

fn accepts(sources: &[&str]) {
    for source in sources {
        let answer = check_commonjs_script(source);
        assert!(answer.is_ok(), "{source:?} is valid script code, got {answer:?}");
    }
}

fn rejects(sources: &[&str]) {
    for source in sources {
        assert!(check_commonjs_script(source).is_err(), "{source:?} must be rejected");
    }
}

#[test]
fn only_references_can_be_assigned_to_or_incremented() {
    accepts(&["a = 1", "a.b = 1", "(a) = 1", "a() += 1", "a++", "--a", "(a)++", "a ||= 1", "a ??= 1", "a **= 2"]);
    rejects(&["1 = 2", "a + b = 1", "(a + b) = 1", "this = 1", "1++", "++1", "(a + b)++", "[a] += 1"]);
}

#[test]
fn optional_chains_are_not_assignment_targets() {
    rejects(&["a?.b = 1", "a?.[0] = 1", "(a?.b) = 1", "a?.b += 1", "a?.b ||= 1", "a?.b++", "++a?.b", "for (a?.b of c) {}"]);
}

#[test]
fn destructuring_patterns_follow_the_assignment_pattern_grammar() {
    accepts(&["[a, b] = [1, 2]", "[a.b] = [1]", "({a: b.c} = {})", "({a = 1} = {})", "({...a} = {})", "[...a] = []", "[a = 1] = []"]);
    rejects(&["[...a, b] = []", "[a + 1] = []", "({a: 1} = {})", "({a = 1})", "([a]) = [1]", "({a}) = {}"]);
}

#[test]
fn for_in_and_for_of_heads_restrict_initialisers_and_targets() {
    accepts(&["for (a of b) {}", "for ([a] of c) {}", "for (var a = 1 in b) {}", "for (let of of c) {}", "for (const a in b) {}"]);
    rejects(&["for (1 of c) {}", "for (var a = 1 of b) {}", "for (let a = 1 in b) {}", "for (var [a] = 1 in b) {}"]);
}

#[test]
fn await_is_an_identifier_outside_async_code_and_an_operator_inside_it() {
    accepts(&[
        "await(1)", "await + 1", "let await = 1", "function await() {}", "var o = { await: 1 }", "o.await",
        "async function f() { await 1 }", "async () => await 1", "var o = { async m() { await 1 } }",
        "async function f() { function g() { await(1) } }", "async function f() { for await (const x of y) {} }",
        "async function f() { (await 1) ** 2 }",
    ]);
    rejects(&[
        "await x", "await foo()", "function f() { await 1 }", "async function f() { let await }",
        "async function f() { function g() { await 1 } }", "async function f() { () => await 1 }",
        "async function f(a = await 1) {}", "class A { static { await 1 } }", "class A { x = await 1 }",
        "for await (const x of y) {}", "async function f() { for await (x in y) {} }", "async function f() { await 1 ** 2 }",
    ]);
}

#[test]
fn yield_is_an_identifier_outside_generators_and_an_operator_inside_them() {
    accepts(&["yield", "yield * 1", "var yield = 1", "function* g() { yield }", "function* g() { yield* h() }", "async function* g() { yield 1 }"]);
    rejects(&["yield 1", "function g() { yield 1 }", "function* g(a = yield) {}", "function* g() { () => yield 1 }", "function* g() { var yield }"]);
}

#[test]
fn module_only_syntax_is_rejected_but_dynamic_import_is_allowed() {
    rejects(&["import \"x\"", "import * as a from \"x\"", "import { a } from \"x\"", "export default 1", "export { a }", "export * from \"x\"", "import.meta", "import()"]);
    accepts(&["import(\"x\")", "import(\"x\").then(f)", "var o = { import: 1, export: 2 }", "o.import", "class A { import() {} static export() {} }"]);
}

#[test]
fn new_target_needs_a_function_and_super_needs_a_method() {
    accepts(&["function f() { return new.target }", "function f() { return () => new.target }", "class A { static { new.target } }"]);
    rejects(&["new.target", "() => new.target", "new.target.x", "new new.target"]);
    accepts(&[
        "var o = { m() { return super.m() } }", "class A { m() { return super.m } }", "class A extends B { constructor() { super() } }",
        "class A extends B { static { super.x } }", "class A { get x() { return super.x } }",
    ]);
    rejects(&[
        "super.x", "super()", "function f() { super.x }", "var o = { m: function () { return super.m() } }",
        "class A { constructor() { super() } }", "class A extends B { m() { super() } }", "class A extends B { x = super() }",
        "class A extends B { constructor() { super?.x } }", "class A extends B { constructor() { new super() } }",
    ]);
}

#[test]
fn exponentiation_forbids_an_unparenthesised_unary_base() {
    accepts(&["(-a) ** 2", "-(a ** 2)", "a ** -b", "a ** b ** c", "a++ ** 2", "++a ** 2", "async function f() { await (a ** 2) }"]);
    rejects(&["-a ** 2", "+a ** 2", "!a ** 2", "typeof a ** 2", "delete a.b ** 2", "-1 ** 2"]);
}

#[test]
fn nullish_coalescing_cannot_mix_with_logical_operators_without_parentheses() {
    accepts(&["a ?? b ?? c", "(a ?? b) || c", "a ?? (b || c)", "a || (b ?? c)"]);
    rejects(&["a ?? b || c", "a || b ?? c", "a && b ?? c", "a ?? b && c"]);
}

#[test]
fn optional_chains_cannot_feed_templates_or_new() {
    accepts(&["a?.b", "a?.[0]", "a?.()", "a?.5 : 1", "a ?.5 : 1", "new (a?.b)()", "(a?.b)`x`", "a`x`"]);
    rejects(&["a?.b`x`", "a?.`x`", "new a?.b()", "new a?.()", "a?.b?.c`x`"]);
}

#[test]
fn class_member_names_constructor_and_prototype_rules() {
    accepts(&["class A { constructor() {} }", "class A { static constructor() {} }", "class A { prototype() {} }", "class A { [\"constructor\"]() {} [\"constructor\"]() {} }"]);
    rejects(&[
        "class A { constructor() {} constructor() {} }", "class A { get constructor() {} }", "class A { *constructor() {} }",
        "class A { async constructor() {} }", "class A { constructor = 1 }", "class A { static prototype() {} }", "class A { static prototype = 1 }",
    ]);
}

#[test]
fn class_field_initialisers_and_static_blocks_cannot_use_arguments_or_return() {
    accepts(&["class A { x = function () { return arguments } }", "class A { m() { return arguments } }", "class A { static { while (1) break } }"]);
    rejects(&["class A { x = arguments }", "class A { x = () => arguments }", "class A { static { arguments } }", "class A { static { return } }", "class A { static { break } }"]);
}

#[test]
fn accessor_parameter_counts_are_fixed() {
    accepts(&["class A { get a() {} set a(b) {} }", "class A { set a(b = 1) {} }", "({ get a() { return 1 }, set a(v) {} })"]);
    rejects(&["class A { get a(b) {} }", "class A { set a() {} }", "class A { set a(...b) {} }", "({ get a(b) { return 1 } })", "({ set a() {} })", "({ set a(...b) {} })"]);
}

#[test]
fn private_names_must_be_declared_once_in_an_enclosing_class() {
    accepts(&[
        "class A { #a = 1; m() { return this.#a } }", "class A { get #a() {} set #a(v) {} }", "class A { #a = 1; m() { return #a in this } }",
        "class A { #a; m() { class B { m() { return this.#a } } } }", "class A { #a = this.#b; #b = 1 }", "class A { static #s = 1; static f() { return A.#s } }",
    ]);
    rejects(&[
        "class A { m() { return this.#a } }", "class A { #a; #a }", "class A { #a; m() { #a } }", "class A { get #a() {} get #a() {} }",
        "class A { #a; get #a() {} }", "class A { #a = 1; m() { delete this.#a } }", "class A { #a = 1; m() { delete this?.#a } }",
        "class A { #constructor }", "class A { m() { class B { #a } return this.#a } }", "this.#a", "#a in b",
    ]);
}

#[test]
fn lexical_declarations_conflict_with_other_declarations_in_the_same_scope() {
    rejects(&[
        "let a; let a", "const a = 1; const a = 2", "class A {} class A {}", "let a; var a", "var a; let a", "let a; function a() {}",
        "{ let a; let a }", "{ var a } let a", "let a; { var a }", "{ function a() {} let a }", "{ function a() {} var a }",
        "function f(a) { let a }", "(a, a) => 1", "function f(a, a = 1) {}", "var o = { m(a, a) {} }", "let let = 1", "let a, a", "const [a, a] = []",
        "try {} catch (e) { let e }", "try {} catch ([e]) { var e }", "for (let i;;) { var i; break }", "for (const x of y) { var x }",
        "switch (a) { case 1: let b; break; case 2: let b }",
    ]);
    accepts(&[
        "var a; var a", "var a; function a() {}", "function a() {} function a() {}", "let a; { let a }", "{ let a } { let a }",
        "{ function a() {} function a() {} }", "function f(a) { var a }", "function f(a, a) {}", "try {} catch (e) { var e }",
        "for (let i;;) { let i; break }", "var [a, a] = []", "var let = 1",
    ]);
}

#[test]
fn labels_and_jumps_must_target_an_enclosing_statement() {
    accepts(&["while (1) { break }", "switch (a) { case 1: break }", "while (1) { switch (a) { case 1: continue } }", "a: { break a }", "a: b: while (1) { continue a }", "a: 1; a: 2"]);
    rejects(&[
        "break", "continue", "return", "switch (a) { case 1: continue }", "a: { continue a }", "a: a: 1", "a: { a: 1 }", "break a",
        "a: while (1) { break b }", "a: while (1) { function f() { break a } }", "while (1) { () => { continue } }", "break\na", "continue\na",
    ]);
}

#[test]
fn statement_position_forbids_declarations() {
    accepts(&["if (a) function f() {}", "a: function f() {}"]);
    rejects(&["if (a) let b", "if (a) const b = 1", "if (a) class B {}", "while (a) function f() {}", "for (;;) let x", "if (a) function* g() {}", "if (a) async function g() {}"]);
}

#[test]
fn declarations_need_initialisers_where_the_grammar_demands_them() {
    accepts(&["let a", "var a", "let {a} = {}", "const [a] = []", "for (const a of b) {}"]);
    rejects(&["const a", "const a, b = 1", "let [a]", "var {a}", "for (const a;;) break", "for (let [a];;) break"]);
}

#[test]
fn rest_parameters_and_arrow_heads_follow_the_function_grammar() {
    accepts(&["function f({a}, [b], ...c) {}", "function f(a,) {}", "(a, ...b) => 1", "async (a, b) => 1", "a => ({})", "(a => 1)(2)"]);
    rejects(&["function f(...a, b) {}", "(...a,) => 1", "a\n=> 1", "(a)\n=> 1", "async\n(a) => 1", "a => {} + 1"]);
}

#[test]
fn reserved_words_cannot_name_bindings_but_can_name_properties() {
    rejects(&["enum", "var enum", "var null", "var true", "var this", "var new", "var class", "var \\u0076ar"]);
    accepts(&["var o = { enum: 1, if: 1, class: 2 }", "o.enum", "var \\u0061", "var \\u{61}", "var a\\u0062"]);
}

#[test]
fn identifiers_follow_the_unicode_id_start_and_id_continue_sets() {
    accepts(&["var ü", "var 𠮷", "var _$", "var $_", "var 𝒳", "var a\u{200d}", "var a\u{b7}"]);
    rejects(&["var €", "var a€", "var \u{200d}a", "€"]);
}

#[test]
fn numeric_separators_may_only_sit_between_digits() {
    accepts(&["1_000", "0x1_0", "0b1_0", "0o7_7", "1.5_5", "1e1_0", "0.0_1", "1_0n"]);
    rejects(&["1__0", "1_", "0_1", "0x_1", "0x1_", "1_.5", "1._5", "1e_1", "1_e1", "0_", "0b1__0"]);
}

#[test]
fn numeric_literals_must_not_run_into_identifiers_and_must_be_complete() {
    accepts(&["5..toString()", "5 .toString()", "5.0.toString()", "5.", ".5", "3 in []", "0B11", "0O17", "0X1f", "1E3"]);
    rejects(&["5.toString()", "3in []", "3instanceof Object", "1a", "1$", "1\\u0061", "1e", "1e+", "0x", "0xg", "0b2", "0o8", "."]);
}

#[test]
fn bigint_literals_are_integers_without_a_leading_zero() {
    accepts(&["1n", "0n", "0x1n", "0xffn", "9007199254740993n"]);
    rejects(&["1.5n", "1e5n", "01n", "010n", "08n"]);
}

#[test]
fn legacy_octal_and_non_octal_decimal_literals_are_sloppy_only() {
    accepts(&["010", "08", "09.5", "00", "09e1", "\"\\01\"", "\"\\8\"", "'use strict'.length; 010"]);
    rejects(&["010.5", "010e1", "'use strict'; 010", "'use strict'; '\\01'", "'use strict'; '\\8'"]);
}

#[test]
fn template_escapes_are_checked_unless_the_template_is_tagged() {
    accepts(&["`\\0`", "f`\\01`", "f`\\u`", "f`\\x`", "f`\\unicode`"]);
    rejects(&["`\\01`", "`\\u`", "`\\x`", "`\\unicode`", "`a", "`${", "`${a`"]);
}

#[test]
fn string_escapes_must_be_well_formed() {
    accepts(&["'\\u{1F600}'", "'\\x41'", "'\\u0041'", "'\\z'", "'a\\\\nb'"]);
    rejects(&["'\\u{110000}'", "'\\u{}'", "'\\u12'", "'\\x1'", "\"a\nb\"", "\"unterminated"]);
}

#[test]
fn strict_mode_directive_prologue_changes_what_is_allowed() {
    accepts(&["with (a) {}", "delete a", "var public", "eval = 1", "\"use\\x20strict\"; with (a) {}", "(\"use strict\"); with (a) {}", "\"use strict\".length; with (a) {}"]);
    rejects(&[
        "\"use strict\"; with (a) {}", "'use strict'; with (a) {}", "\"a\"; \"use strict\"; with (a) {}", "function f() { \"use strict\"; with (a) {} }",
        "function f() { \"use strict\"; 010 }", "function f(a = 1) { \"use strict\" }", "function eval() { \"use strict\" }", "function f(a, a) { \"use strict\" }",
        "'use strict'; delete x", "'use strict'; delete (a)", "'use strict'; eval = 1", "'use strict'; var public", "'use strict'; let static",
    ]);
}

#[test]
fn class_bodies_are_always_strict() {
    rejects(&["class A { m() { with (a) {} } }", "class A { m() { return 010 } }", "class A { m() { var public } }", "class let {}", "class A { m(a, a) {} }"]);
    accepts(&["class A { [010]() {} }", "class A { m() { return arguments } }"]);
}

#[test]
fn duplicate_proto_keys_are_an_error_only_in_object_literal_expressions() {
    rejects(&["({ __proto__: 1, __proto__: 2 })", "({ __proto__: 1, \"__proto__\": 2 })", "({ __proto__: 1, a: 2, __proto__: 3 })"]);
    accepts(&["({ __proto__: 1, [\"__proto__\"]: 2 })", "({ __proto__: 1, __proto__() {} })", "({ __proto__, __proto__ })", "({ __proto__: a, __proto__: b } = {})", "({ a: 1, a: 2 })"]);
}

#[test]
fn object_literal_shorthand_and_computed_forms() {
    accepts(&["({ a, b })", "({ async a() {}, *b() {}, async *c() {} })", "({ get: 1, set: 2, async: 3, static: 4 })", "({ 1: 1, \"a\": 2, [3]: 3 })", "({ yield })", "({ await })"]);
    rejects(&["({ #a: 1 })", "({ this })", "({ a = 1 })"]);
}

#[test]
fn regular_expression_literals_are_validated_at_compile_time() {
    accepts(&["/a/gimsuyd", "/[/]/", "/{/", "/(?<a>.)\\k<a>/", "/\\k<a>/", "/(?<=a)b/", "/\\p{L}/u", "/\\u{41}/u", "/[\\d-a]/", "/\\1(a)/", "/[a&&b]/v", "a / b / c", "1 / 2 / 3"]);
    rejects(&[
        "/a/gg", "/a/uv", "/a/z", "/(/", "/)/", "/[/", "/[a-/", "/a{2,1}/", "/(?<a>.)(?<a>.)/", "/\\k<a>/u", "/(?i:a)/", "/\\p{Foo}/u",
        "/\\u{110000}/u", "/[\\d-a]/u", "/a**/", "/+/", "/?/", "/\\-/u",
    ]);
}

#[test]
fn automatic_semicolon_insertion_and_restricted_productions() {
    accepts(&["a\n++\nb", "do {} while (0) a", "throw 1\n", "function f() { return\n1 }", "while (1) { continue\na }", "a = b\n(c)", "let\nx", "async\nfunction f() {}", "var async; async\n(1)"]);
    rejects(&["return\n1", "throw\n1", "throw\na", "1 --> c", "async a\n=> 1"]);
}

#[test]
fn html_like_comments_and_hashbang_are_script_only_syntax() {
    accepts(&["<!-- c\n1", "1\n--> c", "a <!-- b", "#!shebang", "#!shebang\n1", "#!"]);
    rejects(&[" #!shebang", "\n#!shebang", "1\n#!shebang", "#", "#a", "@", "\\", "/* unterminated"]);
}

#[test]
fn typescript_jsx_and_decorator_syntax_are_not_javascript() {
    rejects(&["var a: number", "type A = B", "interface A {}", "enum A {}", "a as b", "a!", "a satisfies b", "<a/>", "<a></a>", "<></>", "@dec class A {}", "class A { @dec m() {} }"]);
}

#[test]
fn try_switch_and_catch_clause_shapes() {
    accepts(&["try {} catch {}", "try {} catch ({a}) {}", "switch (a) { case 1: case 2: break; default: break }", "try { throw 1 } catch {}"]);
    rejects(&["try { }", "try {} finally", "try {} catch (e, f) {}", "try {} catch (e = 1) {}", "switch (a) { default: default: }"]);
}

#[test]
fn a_script_wrapped_in_the_commonjs_function_is_checked_as_function_body_code() {
    // The wrapper makes `return` legal, while module syntax and top-level await stay illegal inside it.
    let wrap = |body: &str| format!("(function (exports, require, module, __filename, __dirname) {{{body}\n}})");
    accepts(&[&wrap("const a = 1"), &wrap("(async()=>{await 1})()"), &wrap("console.log(1)"), &wrap("return 5"), &wrap("[[[[[[[[[[1]]]]]]]]]]")]);
    rejects(&[&wrap("await 1"), &wrap("import fs from \"node:fs\""), &wrap("export const x = 1")]);
}

#[test]
fn a_long_block_comment_with_escaped_quotes_before_it_does_not_confuse_the_check() {
    let long = "x".repeat(20_000);
    accepts(&[&format!("const slash = \"\\\\\"; /*{long}*/ console.log(\"ok\")")]);
}
