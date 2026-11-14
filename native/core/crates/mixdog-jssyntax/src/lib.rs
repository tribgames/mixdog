//! Whether a source is a classic JavaScript script, the answer Node gives with `new vm.Script(source)`, without
//! a JavaScript engine: tree-sitter parses it and an early-error pass (`early.rs`) rejects what V8 rejects
//! that the grammar accepts. The only decision made from the answer is whether a `node -e` body may be hoisted
//! into a CommonJS file, so every construct the pass does not model is answered "invalid".

mod early;
mod message;
mod scope;

use tree_sitter::Parser;

/// Why a source is not a classic script: V8's text for the classes the check detects (best effort).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Rejection {
    pub message: String,
}

fn rejection(reason: &message::Reason) -> Rejection {
    Rejection { message: reason.text() }
}

/// `Ok` when `new vm.Script(source)` compiles, the rejection when it does not.
pub fn check_commonjs_script(source: &str) -> Result<(), Rejection> {
    let invalid = || Rejection { message: message::INVALID_TOKEN.to_owned() };
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_javascript::LANGUAGE.into()).map_err(|_| invalid())?;
    let tree = parser.parse(source, None).ok_or_else(invalid)?;
    let root = tree.root_node();
    if root.has_error() {
        return Err(rejection(&message::grammar(root, source)));
    }
    early::check(root, source).map_err(|reason| rejection(&reason))
}

#[cfg(test)]
mod tests {
    use super::check_commonjs_script;

    fn ok(source: &str) {
        let answer = check_commonjs_script(source);
        assert!(answer.is_ok(), "{source:?} should compile, got {answer:?}");
    }

    fn bad(source: &str) -> String {
        match check_commonjs_script(source) {
            Ok(()) => panic!("{source:?} should be rejected"),
            Err(rejection) => rejection.message,
        }
    }

    #[test]
    fn plain_code_compiles() {
        for source in [
            "",
            "const a = 1; a + 1",
            "const f = async () => { await 1 }; f()",
            "class A { #p = 1; static m() { return new A().#p } }",
            "a ?? b",
            "#!/usr/bin/env node\nconsole.log(1)",
            "(function (exports, require, module, __filename, __dirname) {return 5\n})",
            "await(1)",
            "let await = 1",
            "var o = { import: 1, export: 2 }",
            "o.import(1)",
            "for (const x of [1]) { if (x) continue; break }",
            "a: for (;;) { for (;;) { continue a } }",
            "try { } catch (e) { var e = 1 }",
            "var a; var a; function f() {} function f() {}",
            "0x1_0, 1_000, 0.5, .5, 5e3, 10n, 010, 08",
            "/[a-z]+/giu.test('x')",
        ] {
            ok(source);
        }
    }

    #[test]
    fn module_syntax_and_top_level_await_are_rejected() {
        assert_eq!(bad("import fs from 'node:fs'"), "Cannot use import statement outside a module");
        assert_eq!(bad("export const x = 1"), "Unexpected token 'export'");
        assert_eq!(bad("await 1"), "await is only valid in async functions and the top level bodies of modules");
        assert_eq!(bad("import.meta.url"), "Cannot use 'import.meta' outside a module");
        assert_eq!(bad("return 5"), "Illegal return statement");
    }

    #[test]
    fn redeclarations_are_rejected() {
        assert_eq!(bad("let a = 1; let a = 2;"), "Identifier 'a' has already been declared");
        bad("var a; let a");
        bad("let a; { var a }");
        bad("function f(a) { let a }");
        bad("{ function f() {} let f }");
        ok("let a; { let a }");
        ok("{ let a } { let a }");
    }

    #[test]
    fn grammar_errors_are_rejected() {
        bad("function (");
        bad("\"unterminated");
        bad("a +");
    }

    #[test]
    fn control_flow_rules() {
        bad("break");
        bad("continue");
        bad("a: a: 1");
        bad("break nowhere");
        bad("a: { continue a }");
        bad("function f() { return } return");
    }

    #[test]
    fn strict_code_rules() {
        bad("'use strict'; with (a) {}");
        bad("'use strict'; 010");
        bad("'use strict'; '\\01'");
        bad("function f() { 'use strict'; with (a) {} }");
        bad("'use strict'; delete x");
        ok("with (a) {}");
        ok("010");
    }

    #[test]
    fn literal_rules() {
        bad("1__0");
        bad("3in []");
        bad("/(/");
        bad("/a/gg");
        bad("({ __proto__: 1, __proto__: 2 })");
        ok("({ __proto__: 1, ['__proto__']: 2 })");
    }

    #[test]
    fn class_rules() {
        bad("class A { m() { return this.#x } }");
        bad("class A { #x = 1; m() { delete this.#x } }");
        bad("super.x");
        bad("function f() { super.x }");
        ok("class A extends B { constructor() { super() } m() { return super.m() } }");
        bad("class A { constructor() { super() } }");
    }
}
