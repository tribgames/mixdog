// The per-language (Stage-2) kind of one outline entry.
//
// This is the layer a rule WITHOUT a `# mixdog-kind:` marker resolves through:
// ast-grep's default rules and our `parity.yml`. The answer is still the
// language's own vocabulary; `kind_map` maps it into the unified one.

use ast_grep_outline::model::SymbolType;

/// Graph `kind` for one outline entry: the node kind decides first (it is the
/// most specific signal and survives rules that share a symbolType), then the
/// LSP symbol type. `None` drops the entry — the pre-Stage-2 queries never
/// emitted fields, properties, enum members or import statements as symbols.
pub fn symbol_kind(lang: &str, ast_kind: &str, symbol_type: SymbolType) -> Option<&'static str> {
    if let Some(kind) = kind_by_ast_kind(lang, ast_kind) {
        return kind;
    }
    kind_by_symbol_type(lang, symbol_type)
}

/// `Some(None)` = this node kind is never a symbol, `None` = no opinion.
pub(super) fn kind_by_ast_kind(lang: &str, ast_kind: &str) -> Option<Option<&'static str>> {
    // Import/dependency statements are never symbols in any language.
    match ast_kind {
        "import_statement"
        | "import_from_statement"
        | "import_declaration"
        | "import_header"
        | "import_list"
        | "dotted_name"
        | "aliased_import"
        | "using_directive"
        | "use_declaration"
        | "namespace_use_declaration"
        | "preproc_include"
        | "preproc_import"
        | "module_import"
        | "require_expression"
        | "require_once_expression"
        | "include_expression"
        | "include_once_expression"
        | "import_or_export"
        | "part_directive"
        | "import_specification"
        | "builtin_function"
        | "function_call"
        | "command"
        | "call_expression" => return Some(None),
        _ => {}
    }
    let kind = match (lang, ast_kind) {
        ("typescript" | "javascript", "variable_declarator") => Some("binding"),
        ("typescript" | "javascript", "method_definition") => Some("method"),
        ("typescript" | "javascript", "class" | "class_declaration") => Some("class"),
        ("typescript", "abstract_class_declaration") => Some("class"),
        ("typescript", "type_alias_declaration") => Some("type"),
        ("typescript", "internal_module" | "module") => Some("namespace"),
        // `declare module 'pkg'` names a package, not a declared symbol; a
        // `declare namespace X` still reports the inner `internal_module`.
        ("typescript", "ambient_declaration") => None,
        ("typescript", "interface_declaration") => Some("interface"),
        ("typescript", "enum_declaration") => Some("enum"),
        (
            "typescript" | "javascript",
            "function_declaration"
            | "function_expression"
            | "generator_function"
            | "function_signature",
        ) => Some("function"),
        // A METHOD SIGNATURE — of an interface, of a type literal, or the
        // `abstract` form in a class — declares a method with no body, and is
        // the only declaration of that name. A PROPERTY signature is a data
        // field and stays a non-symbol.
        ("typescript", "method_signature" | "abstract_method_signature") => Some("method"),
        // A `pair` reaches this table only through the object-literal rule,
        // which matches function-valued properties alone.
        ("typescript" | "javascript", "pair") => Some("method"),
        // Enum bodies, class fields and interface data fields are no symbols.
        // A class field holds a VALUE, even when that value is a function
        // (`handle = () => {}`, `boundArrow: (a: number) => number = (a) =>
        // a + 1`): the object-literal rule above reads `pair` nodes, and a
        // class body has none. Reporting the field would need its own rule and
        // would put a second `method` on lines a class member rule already
        // owns, so an arrow-valued field stays what it is — a field.
        (
            "typescript" | "javascript",
            "public_field_definition"
            | "field_definition"
            | "property_signature"
            | "method_signature"
            | "property_identifier"
            | "enum_assignment",
        ) => None,
        ("python", "assignment") => None,
        ("go", "type_spec") => Some("type"),
        // An interface method element is a bodyless method declaration.
        ("go", "method_elem") => Some("method"),
        ("go", "type_declaration" | "const_spec" | "var_spec") => None,
        ("rust", "type_item") => Some("type"),
        ("rust", "macro_definition") => Some("macro"),
        ("rust", "const_item") => Some("const"),
        ("rust", "static_item") => Some("static"),
        ("rust", "mod_item") => Some("module"),
        ("rust", "function_item") => Some("function"),
        ("rust", "struct_item") => Some("struct"),
        ("rust", "enum_item") => Some("enum"),
        ("rust", "trait_item") => Some("trait"),
        // A trait method signature is a declaration with no body; Rust reports
        // every `fn` as `function`, in a trait as much as anywhere else.
        ("rust", "function_signature_item") => Some("function"),
        // `impl` blocks, fields and variants are not graph symbols.
        ("rust", "impl_item" | "field_declaration" | "enum_variant") => None,
        ("java", "record_declaration") => Some("record"),
        ("java", "field_declaration") => None,
        ("kotlin", "companion_object" | "secondary_constructor" | "property_declaration") => None,
        ("csharp", "record_declaration") => Some("record"),
        ("csharp", "local_function_statement") => Some("local-function"),
        (
            "csharp",
            "delegate_declaration"
            | "property_declaration"
            | "field_declaration"
            | "enum_member_declaration"
            | "variable_declarator",
        ) => None,
        ("c", "union_specifier" | "declaration" | "field_declaration" | "enumerator") => None,
        (
            "cpp",
            "union_specifier" | "declaration" | "field_declaration" | "enumerator"
            | "concept_definition",
        ) => None,
        // `require 'x'` is a plain method call, never a symbol.
        ("ruby", "assignment" | "call" | "command") => None,
        ("php", "trait_declaration") => Some("trait"),
        ("php", "property_declaration" | "enum_case") => None,
        ("swift", "init_declaration") => None,
        // A protocol requirement is a bodyless `func`, which Swift reports as
        // `function` like every other one.
        ("swift", "protocol_function_declaration") => Some("function"),
        ("dart", "mixin_declaration") => Some("mixin"),
        ("dart", "extension_declaration") => Some("extension"),
        _ => return None,
    };
    Some(kind)
}

pub(super) fn kind_by_symbol_type(lang: &str, symbol_type: SymbolType) -> Option<&'static str> {
    use SymbolType as S;
    match lang {
        "typescript" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            // ast-grep types a TS `type X = ...` alias as a struct.
            S::Struct => Some("type"),
            S::Method | S::Constructor => Some("method"),
            S::Constant | S::Variable => Some("binding"),
            S::Namespace => Some("namespace"),
            _ => None,
        },
        "javascript" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Method | S::Constructor => Some("method"),
            S::Constant | S::Variable => Some("binding"),
            _ => None,
        },
        // Python class methods were plain functions before Stage 2.
        "python" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            _ => None,
        },
        "go" => match symbol_type {
            S::Function => Some("function"),
            S::Method => Some("method"),
            S::Struct | S::Interface | S::TypeParameter => Some("type"),
            _ => None,
        },
        "rust" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Interface => Some("trait"),
            S::Module => Some("module"),
            S::Constant => Some("const"),
            S::Variable => Some("static"),
            _ => None,
        },
        "java" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            S::Method => Some("method"),
            S::Constructor => Some("constructor"),
            _ => None,
        },
        // The Kotlin grammar files a class, an interface and an enum under the
        // same declaration node, which the old query reported as `class`.
        "kotlin" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class | S::Interface | S::Enum => Some("class"),
            S::Object => Some("object"),
            _ => None,
        },
        "csharp" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Method => Some("method"),
            S::Constructor => Some("constructor"),
            _ => None,
        },
        "c" => match symbol_type {
            S::Function => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            _ => None,
        },
        "cpp" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Struct => Some("struct"),
            S::Method => Some("method"),
            _ => None,
        },
        "ruby" => match symbol_type {
            S::Function | S::Method => Some("method"),
            S::Class => Some("class"),
            S::Module => Some("module"),
            _ => None,
        },
        "php" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Method => Some("method"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            _ => None,
        },
        "swift" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Object => Some("actor"),
            S::Interface => Some("protocol"),
            _ => None,
        },
        "scala" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            S::Object => Some("object"),
            S::Interface => Some("trait"),
            _ => None,
        },
        "bash" | "lua" | "r" => match symbol_type {
            S::Function | S::Method => Some("function"),
            _ => None,
        },
        "dart" => match symbol_type {
            S::Class => Some("class"),
            S::Enum => Some("enum"),
            S::Function => Some("function"),
            S::Method => Some("method"),
            _ => None,
        },
        "objc" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("protocol"),
            S::Method => Some("method"),
            S::Function => Some("function"),
            _ => None,
        },
        // Elixir def/defp are functions and defmacro/defmacrop are macros;
        // both are plain `call` nodes, so the rule tags the macro form with
        // the LSP `operator` category.
        "elixir" => match symbol_type {
            S::Module => Some("module"),
            S::Function => Some("function"),
            S::Operator => Some("macro"),
            _ => None,
        },
        // Zig container types share one declaration node; `object` is the
        // rule-level tag for a union.
        "zig" => match symbol_type {
            S::Function => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Object => Some("union"),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use crate::outline::rules::intern_kind;
    use crate::outline::test_support::{kinds, named, record, records};

    #[test]
    fn typescript_kinds_match_the_graph_vocabulary() {
        let source = r#"
export function run(): void {}
export class Store { read(): void {} }
export interface Options { flag: boolean }
export type Handler = () => void;
export enum Mode { Fast }
export const LIMIT = 1;
let counter = 0;
var legacy = 2;
export namespace Shapes { }
declare function ambient(): void;
export abstract class Base { abstract run(): void }
const expr = function named() {};
function* gen() {}
"#;
        assert_eq!(
            kinds("typescript", "ts", source),
            named(&[
                ("function", "run"),
                ("class", "Store"),
                ("method", "read"),
                ("interface", "Options"),
                ("type", "Handler"),
                ("enum", "Mode"),
                ("variable", "LIMIT"),
                ("variable", "counter"),
                ("variable", "legacy"),
                ("namespace", "Shapes"),
                ("function", "ambient"),
                ("class", "Base"),
                // `abstract run(): void` is a bodyless method DECLARATION.
                ("method", "run"),
                ("variable", "expr"),
                // A named function EXPRESSION is a symbol; `function* gen()`
                // is a `generator_function_declaration`, which the pre-Stage-2
                // query did not match either.
                ("function", "named"),
            ])
        );
    }

    #[test]
    fn javascript_reports_nested_declarations() {
        let source = r#"
export function outer() {
  function inner() {}
  class Nested { run() {} }
  return new Nested();
}
const store = { method() {} };
"#;
        assert_eq!(
            kinds("javascript", "js", source),
            named(&[
                ("function", "outer"),
                ("function", "inner"),
                ("class", "Nested"),
                ("method", "run"),
                ("variable", "store"),
                ("method", "method"),
            ])
        );
    }

    #[test]
    fn python_methods_are_functions() {
        let source = "class Store:\n    def read(self):\n        def inner():\n            pass\n        return inner\n\ndef top():\n    pass\n";
        assert_eq!(
            kinds("python", "py", source),
            named(&[
                ("class", "Store"),
                ("function", "read"),
                ("function", "inner"),
                ("function", "top"),
            ])
        );
    }

    #[test]
    fn go_reports_one_symbol_per_type_spec() {
        let source = "package p\n\ntype (\n\tA struct{}\n\tB int\n)\n\ntype C interface{}\n\nfunc F() {}\n\nfunc (a A) M() {}\n";
        assert_eq!(
            kinds("go", "go", source),
            named(&[
                ("type", "A"),
                ("type", "B"),
                ("type", "C"),
                ("function", "F"),
                ("method", "M"),
            ])
        );
    }

    #[test]
    fn rust_keeps_the_full_declaration_vocabulary() {
        let source = r#"
pub const LIMIT: usize = 1;
static REG: u8 = 0;
pub type Pairs = u8;
pub struct S { f: u8 }
pub enum E { A }
pub trait T { fn t(&self); }
impl S { pub fn new() -> Self { fn helper() {} helper(); Self { f: 0 } } }
mod inner { pub fn nested() {} }
macro_rules! shout { () => {} }
"#;
        assert_eq!(
            kinds("rust", "rs", source),
            named(&[
                ("constant", "LIMIT"),
                ("variable", "REG"),
                ("type", "Pairs"),
                ("struct", "S"),
                ("enum", "E"),
                ("trait", "T"),
                // A trait method signature is a `function`, like a trait
                // method WITH a body.
                ("function", "t"),
                ("function", "new"),
                ("function", "helper"),
                ("module", "inner"),
                ("function", "nested"),
                ("macro", "shout"),
            ])
        );
    }

    #[test]
    fn jvm_and_dotnet_kinds() {
        let java = "package p;\npublic class C {\n  C() {}\n  void m() {}\n  interface I { void i(); }\n  enum E { A }\n  record R(int a) { int r() { return a; } }\n}\n";
        assert_eq!(
            kinds("java", "java", java),
            named(&[
                ("class", "C"),
                ("constructor", "C"),
                ("method", "m"),
                ("interface", "I"),
                ("method", "i"),
                ("enum", "E"),
                // a java record IS a class
                ("class", "R"),
                ("method", "r"),
            ])
        );

        let kotlin =
            "class C {\n  fun m() {}\n}\ninterface I\nenum class E { A }\nobject O\nfun top() {}\n";
        assert_eq!(
            kinds("kotlin", "kt", kotlin),
            named(&[
                ("class", "C"),
                ("function", "m"),
                ("class", "I"),
                ("class", "E"),
                // a kotlin `object` declares a type with members
                ("class", "O"),
                ("function", "top"),
            ])
        );

        let csharp = "class C {\n  C() {}\n  void M() { void Local() {} Local(); }\n}\ninterface I {}\nstruct S {}\nenum E { A }\nrecord R(int A);\n";
        assert_eq!(
            kinds("csharp", "cs", csharp),
            named(&[
                ("class", "C"),
                ("constructor", "C"),
                ("method", "M"),
                ("function", "Local"),
                ("interface", "I"),
                ("struct", "S"),
                ("enum", "E"),
                ("class", "R"),
            ])
        );
    }

    #[test]
    fn c_family_kinds() {
        let c = "struct S { int a; };\nenum E { A };\nint f(void) { return 0; }\nchar *g(void) { return 0; }\n";
        assert_eq!(
            kinds("c", "c", c),
            named(&[
                ("struct", "S"),
                ("enum", "E"),
                ("function", "f"),
                ("function", "g"),
            ])
        );

        let cpp = "class C { public: void m() {} };\nstruct S {};\nvoid C::out() {}\nint *p() { return 0; }\n";
        assert_eq!(
            kinds("cpp", "cpp", cpp),
            named(&[
                ("class", "C"),
                ("method", "m"),
                ("struct", "S"),
                ("function", "out"),
                ("function", "p"),
            ])
        );

        let objc = "@protocol P\n- (void)p;\n@end\n@interface A : NSObject\n- (void)a;\n@end\n@implementation A\n- (void)a {}\n@end\nint f(void) { return 0; }\n";
        assert_eq!(
            kinds("objc", "m", objc),
            named(&[
                ("protocol", "P"),
                ("method", "p"),
                ("class", "A"),
                // declaration in @interface, definition in @implementation
                ("method", "a"),
                ("class", "A"),
                ("method", "a"),
                ("function", "f"),
            ])
        );
    }

    #[test]
    fn script_and_functional_kinds() {
        assert_eq!(
            kinds("ruby", "rb", "module M\n  class C\n    def m; end\n    def self.s; end\n  end\nend\ndef top; end\n"),
            named(&[
                ("module", "M"),
                ("class", "C"),
                ("method", "m"),
                ("method", "s"),
                ("method", "top"),
            ])
        );

        assert_eq!(
            kinds("php", "php", "<?php\ninterface I {}\ntrait T {}\nenum E { case A; public function l(): string { return 'a'; } }\nclass C { public function m() {} }\nfunction f() {}\n"),
            named(&[
                ("interface", "I"),
                ("trait", "T"),
                ("enum", "E"),
                ("method", "l"),
                ("class", "C"),
                ("method", "m"),
                ("function", "f"),
            ])
        );

        assert_eq!(
            kinds("swift", "swift", "protocol P {}\nstruct S {}\nenum E {}\nclass C { func m() {} }\nactor A {}\nfunc top() {}\n"),
            named(&[
                ("protocol", "P"),
                ("struct", "S"),
                ("enum", "E"),
                ("class", "C"),
                ("function", "m"),
                // a swift actor is a reference type with methods
                ("class", "A"),
                ("function", "top"),
            ])
        );

        assert_eq!(
            kinds(
                "scala",
                "scala",
                "trait T\nclass C { def m(): Int = 1 }\nobject O { def o(): Int = 2 }\n"
            ),
            named(&[
                ("trait", "T"),
                ("class", "C"),
                ("function", "m"),
                ("class", "O"),
                ("function", "o"),
            ])
        );

        assert_eq!(
            kinds("bash", "sh", "f() { :; }\nfunction g() { :; }\n"),
            named(&[("function", "f"), ("function", "g")])
        );

        assert_eq!(
            kinds(
                "lua",
                "lua",
                "function f() end\nfunction M.g() end\nfunction M:h() end\n"
            ),
            named(&[("function", "f"), ("function", "g"), ("function", "h"),])
        );

        assert_eq!(
            kinds("r", "r", "f <- function(x) x\ng = function(x) x\n"),
            named(&[("function", "f"), ("function", "g")])
        );

        assert_eq!(
            kinds("dart", "dart", "class C { void m() {} }\nmixin M {}\nenum E { a }\nextension X on C {}\nvoid top() {}\n"),
            named(&[
                ("class", "C"),
                ("method", "m"),
                // dart: a mixin is a trait, an extension is an impl block
                ("trait", "M"),
                ("enum", "E"),
                ("impl", "X"),
                ("function", "top"),
            ])
        );

        assert_eq!(
            kinds("elixir", "ex", "defmodule M do\n  def f(a), do: a\n  defp g(a), do: a\n  defmacro h(a), do: a\nend\n"),
            named(&[
                ("module", "M"),
                ("function", "f"),
                ("function", "g"),
                ("macro", "h"),
            ])
        );

        assert_eq!(
            kinds("zig", "zig", "pub const S = struct { pub fn f() void {} };\nconst E = enum { a };\nconst U = union { a: u8 };\npub fn top() void {}\n"),
            named(&[
                ("struct", "S"),
                ("function", "f"),
                ("enum", "E"),
                // zig union: a container type with declared fields
                ("struct", "U"),
                ("function", "top"),
            ])
        );
    }

    /// Every language that can declare a method WITHOUT a body reports it:
    /// an interface/protocol/trait requirement is the only declaration of that
    /// name, and it keeps the kind that language gives a method with a body.
    #[test]
    fn bodyless_method_declarations_are_symbols() {
        let ts = records(
            "typescript",
            "ts",
            "export interface Host {\n  preflightSteps?(cmd: string): Promise<void>;\n  flag: boolean;\n}\ntype Lit = { onTick(n: number): void; value: number };\nabstract class Base { abstract doIt(): void; }\n",
        );
        assert_eq!(
            ts.iter()
                .map(|symbol| (symbol.kind, symbol.name.as_str(), symbol.parent.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("interface", "Host", ""),
                ("method", "preflightSteps", "Host"),
                ("type", "Lit", ""),
                ("method", "onTick", "Lit"),
                ("class", "Base", ""),
                ("method", "doIt", "Base"),
            ]
        );
        assert_eq!(
            record(&ts, "preflightSteps").sig,
            "preflightSteps?(cmd: string): Promise<void>"
        );

        // A signature declared in one language keeps that language's own kind
        // for methods: go/dart/objc/java/csharp/php `method`, rust/scala/
        // swift/kotlin/haskell/solidity `function`.
        let cases: &[(&str, &str, &str, &str, &str)] = &[
            (
                "go",
                "go",
                "package p\ntype Reader interface {\n\tRead(p []byte) (int, error)\n}\n",
                "method",
                "Read",
            ),
            (
                "rust",
                "rs",
                "pub trait Handler {\n    fn handle(&self) -> bool;\n}\n",
                "function",
                "handle",
            ),
            (
                "swift",
                "swift",
                "protocol Service {\n    func start()\n}\n",
                "function",
                "start",
            ),
            (
                "dart",
                "dart",
                "abstract class Service {\n  void start();\n}\n",
                "method",
                "start",
            ),
            (
                "scala",
                "scala",
                "trait Service {\n  def start(): Unit\n}\n",
                "function",
                "start",
            ),
            (
                "java",
                "java",
                "public interface Service {\n  void start();\n}\n",
                "method",
                "start",
            ),
            (
                "csharp",
                "cs",
                "public interface IService {\n  void Start();\n}\n",
                "method",
                "Start",
            ),
            (
                "kotlin",
                "kt",
                "interface Service {\n    fun start()\n}\n",
                "function",
                "start",
            ),
            (
                "php",
                "php",
                "<?php\ninterface Service {\n  public function start();\n}\n",
                "method",
                "start",
            ),
            (
                "objc",
                "m",
                "@protocol Service <NSObject>\n- (void)start;\n@end\n",
                "method",
                "start",
            ),
            (
                "solidity",
                "sol",
                "interface IService {\n    function start() external;\n}\n",
                "function",
                "start",
            ),
            (
                "haskell",
                "hs",
                "module M where\nclass Service a where\n  start :: a -> IO ()\n",
                "function",
                "start",
            ),
        ];
        for (graph_lang, ext, source, kind, name) in cases {
            let symbols = records(graph_lang, ext, source);
            let found = record(&symbols, name);
            assert_eq!(found.kind, intern_kind(kind), "{graph_lang}: {symbols:?}");
            assert!(!found.parent.is_empty(), "{graph_lang}: {symbols:?}");
            assert!(!found.sig.is_empty(), "{graph_lang}: {symbols:?}");
        }

        // A bodied declaration of the same language keeps its span and kind:
        // the signature rules add symbols, they do not take one over.
        let dart = records(
            "dart",
            "dart",
            "abstract class Service {\n  void start();\n  void stop() {}\n}\n",
        );
        let stop = record(&dart, "stop");
        assert_eq!(
            (stop.kind, stop.start_line, stop.end_line),
            ("method", 3, 3)
        );
    }
}
