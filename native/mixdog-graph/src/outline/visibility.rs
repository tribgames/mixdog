// `exported`: is this declaration visible outside the file/module it lives in?
//
// Each language answers in its own terms — a modifier in the declaration head,
// the name itself, or a statement the FILE makes (a TS export clause, a Ruby
// section marker, a Haskell export list), which `FileVisibility` reads once per
// file instead of once per declaration.

use std::collections::HashSet;

use super::signature::{has_any_modifier, has_modifier, is_word_byte, skip_spaces, starts_word_at};
use super::symbols::Candidate;

/// File-level visibility state some languages need and a declaration node
/// does not carry: a TS/JS `export { … }` clause, Ruby's section markers and
/// Haskell's module export list. Every other language answers from the
/// declaration itself.
pub(super) enum FileVisibility {
    None,
    /// Names an `export { a, b as c }` clause or an `export default a`
    /// statement makes visible, none of which touch the declaration itself.
    Script(HashSet<String>),
    /// `(byte offset, hides what follows)` for each bare `private` /
    /// `protected` / `public` line and each marker RESET (a class/module body
    /// opening, a dedented `end`).
    Ruby(Vec<(usize, bool)>),
    /// `Some(names)` = the module header has an export list and only those
    /// names leave the module; `None` = no export list, so everything does.
    Haskell(Option<HashSet<String>>),
}

impl FileVisibility {
    pub(super) fn of(graph_lang: &str, text: &str) -> Self {
        match graph_lang {
            "typescript" | "javascript" => Self::Script(export_clause_names(text)),
            "ruby" => Self::Ruby(ruby_sections(text)),
            "haskell" => Self::Haskell(haskell_export_list(text)),
            _ => Self::None,
        }
    }

    /// The file states that `name` leaves the module, without saying so on
    /// the declaration.
    fn names(&self, name: &str) -> bool {
        match self {
            Self::Script(names) => names.contains(name),
            _ => false,
        }
    }
}

/// Is this declaration visible outside the file/module it lives in?
///
/// One rule per language, each the language's OWN notion of visibility:
///
/// | language | exported when |
/// |---|---|
/// | typescript, javascript | the declaration is inside an `export` (the rule's `isExported`) or an `export { … }` clause names it; a `method` never is |
/// | rust | the declaration head starts with `pub` (`pub`, `pub(crate)`, …), or a `macro_rules!` carries `#[macro_export]` |
/// | zig | the head carries `pub` |
/// | go | the name starts with an upper-case letter |
/// | python | module level (no parent) and the name has no `_` prefix |
/// | java, csharp | an explicit `public` modifier (both default to narrower) |
/// | kotlin, scala, swift | no `private`/`protected`/`internal`/`fileprivate` modifier (all default to visible) |
/// | php | no `private`/`protected` modifier (members default to public) |
/// | ruby | no enclosing `private`/`protected` section and no `private def` prefix |
/// | elixir | the defining form does not end in `p` (`def`/`defmacro` yes, `defp`/`defmacrop` no) |
/// | haskell | named in the module export list, or the module has no export list; the module header and every `instance` always |
/// | solidity | functions: `public`/`external`, or a FILE-LEVEL free function (which cannot carry a visibility modifier and is importable); every other declaration is part of the contract's surface |
/// | c, cpp, objc | no `static` storage class (a static declaration is file-local) |
/// | dart | the name has no `_` prefix (Dart privacy is name-based) |
/// | lua | not declared `local` |
/// | bash, r, hcl | always — these languages have no visibility at all |
///
/// Above all of them: a declaration INSIDE A FUNCTION BODY (`local`) is never
/// exported, in any language. A `pub fn` in a Rust function, a Kotlin local
/// `fun`, a C# local function and a Java local class are reachable from their
/// body and nowhere else, so no modifier and no export clause can lift them.
///
/// Only TypeScript/JavaScript read the rule's own flag, and only because
/// their rule files spell it out: an outline item rule that OMITS
/// `isExported` defaults to TRUE upstream, so the flag says nothing unless a
/// rule declares it. Every other language answers from the declaration head,
/// the name, or the file (`FileVisibility`).
///
/// Approximations, on purpose:
///   * CommonJS is not read: `module.exports = …` / `exports.x = …` are
///     ASSIGNMENTS, not declarations, so they are no symbols of their own and
///     they do not export the declaration they name either. Only the ES
///     module statements above do.
///   * java/csharp read the PUBLIC API surface, not file scope: package-private
///     and `internal` are visible to other files of the same package/assembly,
///     and are still reported as not exported.
///   * go reads the NAME, which is the language's own rule, so `Read` on an
///     unexported receiver (`func (s *store) Read()`) counts as exported.
///   * python ignores `__all__`: the `_` prefix convention is the declaration's
///     own statement, `__all__` is a separate runtime value.
///   * ruby matches the nearest preceding section marker, with class/module
///     bodies and dedented `end`s resetting it, not a full scope parse.
///   * a C++ in-class `private:` label is not read (only `static` is).
pub(super) fn is_exported(
    graph_lang: &str,
    candidate: &Candidate,
    head: &str,
    top_level: bool,
    local: bool,
    text: &str,
    visibility: &FileVisibility,
) -> bool {
    let name = candidate.name.as_str();
    if local {
        return false;
    }
    match graph_lang {
        // Only a module-level `export` exports anything here. A METHOD never
        // is, whatever its `isPublic` flag says and whoever matched it: a
        // class member, an object-literal property, an interface signature —
        // none of them can carry an `export`, and an `export { name }` clause
        // of the same word names the module-level declaration, not the method.
        "typescript" | "javascript" => {
            !candidate.member
                && candidate.kind != "method"
                && (candidate.rule_exported || visibility.names(name))
        }
        // `#[macro_export]` is an attribute item ABOVE the declaration, so it
        // is the one export marker that is not in the head.
        "rust" => {
            has_modifier(head, "pub")
                || (candidate.kind == "macro" && macro_exported(text, candidate.start_byte))
        }
        "zig" => has_modifier(head, "pub"),
        "go" => name.starts_with(|ch: char| ch.is_uppercase()),
        "python" => top_level && !name.starts_with('_'),
        "java" | "csharp" => has_modifier(head, "public"),
        "kotlin" | "scala" | "swift" => {
            !has_any_modifier(head, &["private", "protected", "internal", "fileprivate"])
        }
        "php" => !has_any_modifier(head, &["private", "protected"]),
        "ruby" => match visibility {
            FileVisibility::Ruby(sections) => ruby_exported(text, sections, candidate.start_byte),
            _ => true,
        },
        // Elixir marks a private definition with a trailing `p` on the
        // defining form: `defp` / `defmacrop` / `defguardp` are private,
        // `def` / `defmacro` / `defmodule` / `defprotocol` are not.
        "elixir" => !head
            .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
            .next()
            .is_some_and(|form| form.ends_with('p')),
        // The module header IS the file's identity and an instance is global
        // in Haskell: neither one is ever named in an export list.
        "haskell" => match (candidate.kind, visibility) {
            ("module" | "instance", _) => true,
            (_, FileVisibility::Haskell(Some(names))) => names.contains(name),
            _ => true,
        },
        // A contract function states its visibility; a FILE-LEVEL free
        // function may not carry one at all and is importable by any file.
        "solidity" => match candidate.kind {
            "function" => top_level || has_any_modifier(head, &["public", "external"]),
            _ => true,
        },
        "c" | "cpp" | "objc" => !has_modifier(head, "static"),
        "dart" => !name.starts_with('_'),
        // `local function helper()` is exactly Lua's file-private form.
        "lua" => !has_modifier(head, "local"),
        "bash" | "r" | "hcl" => true,
        _ => candidate.rule_exported,
    }
}

/// Local names a TS/JS file exports without touching their declarations:
/// `export { a, b as c }`, `export type { T }` and `export default a`.
///
/// `export { x } from './other'` is skipped — those names come from another
/// module and say nothing about a declaration of the same name here.
fn export_clause_names(text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let bytes = text.as_bytes();
    for (start, _) in text.match_indices("export") {
        if !starts_word_at(text, start, "export")
            || start
                .checked_sub(1)
                .is_some_and(|before| is_word_byte(bytes[before]))
        {
            continue;
        }
        let mut at = skip_spaces(bytes, start + "export".len());
        if starts_word_at(text, at, "default") {
            // `export default expression;` exports a declaration only when
            // the expression IS one name (`export default Panel;`).
            let value_start = skip_spaces(bytes, at + "default".len());
            let value_end = text[value_start..]
                .find(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '$'))
                .map_or(text.len(), |offset| value_start + offset);
            let rest = text[value_end..].trim_start_matches([' ', '\t', '\r']);
            if value_end > value_start && (rest.starts_with(';') || rest.starts_with('\n')) {
                names.insert(text[value_start..value_end].to_string());
            }
            continue;
        }
        if starts_word_at(text, at, "type") {
            at = skip_spaces(bytes, at + "type".len());
        }
        if bytes.get(at) != Some(&b'{') {
            continue;
        }
        let Some(close) = text[at..].find('}').map(|offset| at + offset) else {
            continue;
        };
        // `export { … } from '…'` re-exports another module's names.
        if text[close + 1..].trim_start().starts_with("from") {
            continue;
        }
        for entry in text[at + 1..close].split(',') {
            let entry = entry.trim();
            let entry = entry.strip_prefix("type ").unwrap_or(entry).trim();
            let local = entry.split_whitespace().next().unwrap_or_default();
            if !local.is_empty() && local != "default" {
                names.insert(local.to_string());
            }
        }
    }
    names
}

/// The declaration at `start` is preceded by a `#[macro_export]` attribute.
fn macro_exported(text: &str, start: usize) -> bool {
    text[..start]
        .trim_end()
        .rsplit('\n')
        .next()
        .is_some_and(|line| line.trim_start().starts_with("#[macro_export]"))
}

/// Ruby's bare visibility markers as `(byte offset, hides what follows)`, in
/// source order, plus the RESETS that end a marker's reach: a marker belongs
/// to the class or module body it stands in, so opening another body
/// (`class Second`, `module M`, a reopened class) and closing the body it
/// lives in (an `end` indented LESS than the marker) both restore the
/// default, public visibility.
fn ruby_sections(text: &str) -> Vec<(usize, bool)> {
    let mut sections = Vec::new();
    let mut marker_indent: Option<usize> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let indent = line.len() - line.trim_start().len();
        match trimmed {
            "private" | "protected" => {
                sections.push((offset, true));
                marker_indent = Some(indent);
            }
            "public" => {
                sections.push((offset, false));
                marker_indent = Some(indent);
            }
            _ => {
                let opens_body = ["class", "module"]
                    .iter()
                    .any(|keyword| starts_word_at(trimmed, 0, keyword));
                let closes_body =
                    trimmed == "end" && marker_indent.is_some_and(|marker| indent < marker);
                if opens_body || closes_body {
                    sections.push((offset, false));
                    marker_indent = None;
                }
            }
        }
        offset += line.len();
    }
    sections
}

/// A Ruby method is private when the nearest preceding section marker hides
/// it, or when its own line starts with `private`/`protected` (`private def
/// helper`).
fn ruby_exported(text: &str, sections: &[(usize, bool)], start: usize) -> bool {
    let line_start = text[..start].rfind('\n').map_or(0, |index| index + 1);
    let prefix = text[line_start..start].trim_end();
    if prefix.ends_with("private") || prefix.ends_with("protected") {
        return false;
    }
    // `<=`, not `<`: a reset sits at the START of the `class`/`module` line
    // that the declaration itself opens, so it has to count for that
    // declaration too.
    match sections.partition_point(|(offset, _)| *offset <= start) {
        0 => true,
        count => !sections[count - 1].1,
    }
}

/// Names in a Haskell module's export list, or `None` when the header has no
/// export list (which exports everything). Every identifier inside the list is
/// collected, so `Class(method)` and `Type(..)` export their members too.
fn haskell_export_list(text: &str) -> Option<HashSet<String>> {
    let mut offset = 0usize;
    let mut header_start = None;
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with("module ") {
            header_start = Some(offset + (line.len() - line.trim_start().len()));
            break;
        }
        offset += line.len();
    }
    let rest = &text[header_start?..];
    let bytes = rest.as_bytes();
    let mut depth = 0usize;
    let mut list_start = None;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' => {
                depth += 1;
                if depth == 1 {
                    list_start = Some(index + 1);
                }
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let start = list_start?;
                    return Some(haskell_export_names(&rest[start..index]));
                }
            }
            _ => {
                // `where` before any parenthesis: no export list at all.
                if depth == 0 && rest[index..].starts_with("where") && index > 0 {
                    return None;
                }
            }
        }
    }
    None
}

fn haskell_export_names(list: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut current = String::new();
    for ch in list.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '\'' {
            current.push(ch);
            continue;
        }
        if !current.is_empty() {
            names.insert(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        names.insert(current);
    }
    names
}

#[cfg(test)]
mod tests {
    use crate::outline::test_support::{record, records};

    #[test]
    fn exported_follows_each_language_visibility_rule() {
        let ts = records(
            "typescript",
            "ts",
            "export function shown(): void {}\nfunction hidden(): void {}\nexport class Panel { method(): void {} }\nconst local = 1;\nexport const shared = 2;\n",
        );
        assert!(record(&ts, "shown").exported);
        assert!(!record(&ts, "hidden").exported);
        assert!(record(&ts, "Panel").exported);
        // a class member is not an export of its own
        assert!(!record(&ts, "method").exported);
        assert!(!record(&ts, "local").exported);
        assert!(record(&ts, "shared").exported);

        let python = records(
            "python",
            "py",
            "def public_one():\n    pass\n\ndef _private():\n    pass\n\nclass Service:\n    def method(self):\n        pass\n",
        );
        assert!(record(&python, "public_one").exported);
        assert!(!record(&python, "_private").exported);
        assert!(record(&python, "Service").exported);
        // module level only: a method is not a module export
        assert!(!record(&python, "method").exported);

        let rust = records(
            "rust",
            "rs",
            "pub fn shown() {}\nfn hidden() {}\npub(crate) struct Crated;\nconst LOCAL: u8 = 1;\npub const SHARED: u8 = 2;\n",
        );
        assert!(record(&rust, "shown").exported);
        assert!(!record(&rust, "hidden").exported);
        assert!(record(&rust, "Crated").exported);
        assert!(!record(&rust, "LOCAL").exported);
        assert!(record(&rust, "SHARED").exported);

        let go = records(
            "go",
            "go",
            "package p\n\nfunc Exported() {}\n\nfunc unexported() {}\n\ntype Public struct{}\n\ntype private struct{}\n",
        );
        assert!(record(&go, "Exported").exported);
        assert!(!record(&go, "unexported").exported);
        assert!(record(&go, "Public").exported);
        assert!(!record(&go, "private").exported);

        // Languages without any visibility syntax report every symbol.
        let bash = records("bash", "sh", "helper() { :; }\n");
        assert!(record(&bash, "helper").exported);

        // Ruby's `private` section hides what follows it, inside the class.
        let ruby = records(
            "ruby",
            "rb",
            "class Store\n  def open; end\n\n  private\n\n  def secret; end\nend\n",
        );
        assert!(record(&ruby, "open").exported);
        assert!(!record(&ruby, "secret").exported);

        // Haskell: the export list decides, and the header itself always goes.
        let haskell = records(
            "haskell",
            "hs",
            "module Demo (shown) where\n\nshown :: Int\nshown = 1\n\nhidden :: Int\nhidden = 2\n",
        );
        assert!(record(&haskell, "Demo").exported);
        assert!(record(&haskell, "shown").exported);
        assert!(!record(&haskell, "hidden").exported);
        let open = records(
            "haskell",
            "hs",
            "module Demo where\n\nshown :: Int\nshown = 1\n",
        );
        assert!(record(&open, "shown").exported);

        // C: a `static` function is file-local.
        let c = records(
            "c",
            "c",
            "int shared(void) { return 0; }\nstatic int local(void) { return 0; }\n",
        );
        assert!(record(&c, "shared").exported);
        assert!(!record(&c, "local").exported);

        // Elixir: `defp` is private, `def` is not.
        let elixir = records(
            "elixir",
            "ex",
            "defmodule M do\n  def shown(a), do: a\n  defp hidden(a), do: a\n  defmacrop quiet(a), do: a\nend\n",
        );
        assert!(record(&elixir, "shown").exported);
        assert!(!record(&elixir, "hidden").exported);
        assert!(!record(&elixir, "quiet").exported);

        // Solidity: a function needs `public`/`external`.
        let solidity = records(
            "solidity",
            "sol",
            "contract C {\n  function open() external {}\n  function shut() private {}\n}\n",
        );
        assert!(record(&solidity, "C").exported);
        assert!(record(&solidity, "open").exported);
        assert!(!record(&solidity, "shut").exported);
    }

    /// The statements a FILE makes about a declaration — a TS export clause,
    /// a Ruby section, a Rust attribute — and the one thing no statement can
    /// lift: a declaration that lives inside a function body.
    #[test]
    fn exported_reads_file_level_statements_and_never_lifts_a_local() {
        let clause = records(
            "typescript",
            "ts",
            "const alpha = 1;\nfunction beta() {}\nclass Panel {}\ntype Shape = { a: number };\nconst hidden = 2;\nexport { alpha, beta as bee, type Shape };\nexport default Panel;\nexport { elsewhere } from \"./other.js\";\n",
        );
        assert!(record(&clause, "alpha").exported);
        assert!(
            record(&clause, "beta").exported,
            "`beta as bee` exports beta"
        );
        assert!(record(&clause, "Shape").exported);
        assert!(
            record(&clause, "Panel").exported,
            "`export default X` exports X"
        );
        assert!(!record(&clause, "hidden").exported);

        // A declaration inside a function body is local, whatever it says.
        let kotlin = records(
            "kotlin",
            "kt",
            "class Holder {\n    fun visible(): Int {\n        fun localHelper(y: Int) = y\n        return localHelper(1)\n    }\n}\n",
        );
        assert!(record(&kotlin, "visible").exported);
        assert!(!record(&kotlin, "localHelper").exported);
        let rust = records(
            "rust",
            "rs",
            "pub fn outer() {\n    pub fn nested() {}\n}\n#[macro_export]\nmacro_rules! shout { () => {}; }\nmacro_rules! quiet { () => {}; }\n",
        );
        assert!(record(&rust, "outer").exported);
        assert!(
            !record(&rust, "nested").exported,
            "a `pub fn` in a body is unreachable"
        );
        assert!(record(&rust, "shout").exported, "#[macro_export]");
        assert!(!record(&rust, "quiet").exported);

        // A Ruby section belongs to the body it stands in: reopening a class
        // and leaving the class body both end its reach.
        let ruby = records(
            "ruby",
            "rb",
            "class First\n  private\n\n  def hidden; end\nend\n\nclass Second\n  def visible; end\n\n  class Nested\n    def deep; end\n  end\nend\n\ndef top_level; end\n",
        );
        assert!(!record(&ruby, "hidden").exported);
        assert!(record(&ruby, "Second").exported);
        assert!(record(&ruby, "visible").exported);
        assert!(record(&ruby, "deep").exported);
        assert!(record(&ruby, "top_level").exported);

        // A Solidity free function carries no visibility modifier at all and
        // is importable; Lua's `local function` is its file-private form.
        let solidity = records(
            "solidity",
            "sol",
            "contract C {\n  function shut() private {}\n}\nfunction free(uint256 a) pure returns (uint256) { return a; }\n",
        );
        assert!(record(&solidity, "free").exported);
        assert!(!record(&solidity, "shut").exported);
        let lua = records(
            "lua",
            "lua",
            "function open(a)\n  return a\nend\n\nlocal function shut(a)\n  return a\nend\n",
        );
        assert!(record(&lua, "open").exported);
        assert!(!record(&lua, "shut").exported);
    }
}
