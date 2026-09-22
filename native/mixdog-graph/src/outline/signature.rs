// The declaration head (`sig`) and the byte scans it is built from.
//
// Everything here reads the SOURCE TEXT of a declaration node, never the parse
// tree: the head is the source between the declaration start and its body, and
// the same word scans answer where the declared name sits (`name_line`) and
// which modifier keywords a language's visibility rule can see.

/// Bytes of a declaration node scanned for its head. A head longer than this
/// is cut here; `SIG_MAX_CHARS` cuts it again after whitespace collapsing.
const HEAD_SCAN_BYTES: usize = 1024;
/// `sig` length cap in CHARACTERS, before the `…` marker.
const SIG_MAX_CHARS: usize = 160;

/// The declaration head of a symbol as one line: the source from the start of
/// the declaration node up to — and excluding — its body, with every
/// whitespace run (indentation and the newlines of a multi-line signature)
/// collapsed to a single space, cut to `SIG_MAX_CHARS` characters plus `…`.
///
/// The head ends at the first, at bracket depth zero, of
///   * `{` — a braced body (`fn f() {`, `class C {`, `resource "x" "y" {`),
///   * `=` — an initializer or an expression body (`def m(): Int = 1`,
///     `const x: Foo = 1`, which keeps the type annotation the value hides).
///     Two `=` do NOT end the head: one inside a type argument list
///     (`fn gen<T = u8>()`, a generic default) and one that is part of the
///     declared name (Ruby's `def name=(value)`). A FUNCTION-VALUED
///     initializer does not end it either — see `initializer_head_end`,
///   * `;` — the end of a bodyless declaration (`def m; end`),
///   * `:` that ends its line — a Python/Ruby-style block opener. A `:` with
///     more on the line is a type annotation (`function f(a: number): void`),
///   * a newline AFTER the name has appeared — the body of a keyword-delimited
///     language (`function f(a)\n … end`). Before the name it is part of the
///     signature (`static void\nlate_name(void)`), so it does not cut.
pub(super) fn declaration_head(text: &str, start: usize, end: usize, name: &str) -> String {
    if start >= text.len() {
        return String::new();
    }
    let mut limit = end.min(text.len()).min(start + HEAD_SCAN_BYTES);
    while limit > start && !text.is_char_boundary(limit) {
        limit -= 1;
    }
    let window = &text[start..limit];
    let name_end = word_index(window, name).map(|at| at + name.len());
    let bytes = window.as_bytes();
    let mut depth: i32 = 0;
    // Type argument lists nest like brackets but `<` is also a comparison, so
    // only a `<` DIRECTLY after a name opens one (`Vec<T>`, `gen<T = u8>`);
    // `class Foo < Bar` and `a < b` never do. `=>` / `->` do not close one.
    let mut angle: i32 = 0;
    let mut cut = window.len();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'<' if index > 0 && is_word_byte(bytes[index - 1]) => angle += 1,
            b'>' if angle > 0 && !matches!(bytes[index - 1], b'=' | b'-') => angle -= 1,
            b'{' if depth <= 0 => {
                cut = index;
                break;
            }
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b';' if depth <= 0 => {
                cut = index;
                break;
            }
            // `=` opens an initializer or an expression body (`def m = 1`,
            // `int X => x`), but `==` / `!=` / `<=` / `>=` are part of the
            // declaration itself (`bool operator ==(Object other)`), a `=`
            // inside a type argument list is a generic default, and a `=` the
            // name itself ends in is Ruby's setter syntax.
            b'=' if depth <= 0
                && angle <= 0
                && !is_comparison(bytes, index)
                && name_end.is_none_or(|at| index >= at) =>
            {
                cut = initializer_head_end(window, index).unwrap_or(index);
                break;
            }
            b':' if depth <= 0 && rest_of_line_is_empty(bytes, index + 1) => {
                cut = index;
                break;
            }
            b'\n' if depth <= 0 && name_end.is_some_and(|at| index >= at) => {
                cut = index;
                break;
            }
            _ => {}
        }
        index += 1;
    }
    collapse_head(&window[..cut])
}

/// End of a FUNCTION-VALUED initializer's head, measured from the `=` at
/// `eq`, or `None` when the initializer is a plain value.
///
/// `const f = (a, b) => a + b`, `add = function(a, b) { … }` and
/// `handler = async (event) => …` declare a callable whose parameter list is
/// exactly the signature a reader wants, but the declaration node starts at
/// the BINDING, so cutting at the `=` would leave `f` — the name again, i.e.
/// no `sig` at all. The head therefore runs
///   * through the `=>` of an arrow (`f = (a, b) =>`), or
///   * up to the body of a function expression (`add = function(a, b)`).
///
/// Anything else — an object, a call, a conditional, a class expression — is
/// a VALUE and the head still ends at the `=`, which keeps
/// `const x: Foo = make()` reporting its type annotation.
fn initializer_head_end(window: &str, eq: usize) -> Option<usize> {
    let bytes = window.as_bytes();
    let mut index = skip_spaces(bytes, eq + 1);
    if starts_word_at(window, index, "async") {
        index = skip_spaces(bytes, index + "async".len());
    }
    let function_expression = starts_word_at(window, index, "function");
    let mut depth: i32 = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            // The arrow itself ends the head, parameters and all.
            b'=' if depth <= 0 && bytes.get(index + 1) == Some(&b'>') => {
                return Some(index + 2);
            }
            // A body opens: a function expression's head is everything before
            // it, any other `{` at this depth is an object/class value.
            b'{' if depth <= 0 => return function_expression.then_some(index),
            b'{' => depth += 1,
            b'}' => depth -= 1,
            // The initializer ended without a parameter list in it.
            b';' | b',' | b'\n' if depth <= 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn skip_spaces(bytes: &[u8], from: usize) -> usize {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

/// `text[at..]` starts with `word` as a whole word.
pub(super) fn starts_word_at(text: &str, at: usize, word: &str) -> bool {
    text.get(at..).is_some_and(|rest| {
        rest.starts_with(word)
            && !rest
                .as_bytes()
                .get(word.len())
                .copied()
                .is_some_and(is_word_byte)
    })
}

/// The `=` at `index` belongs to a comparison operator, not to an assignment.
fn is_comparison(bytes: &[u8], index: usize) -> bool {
    let previous = index
        .checked_sub(1)
        .map(|at| bytes[at])
        .is_some_and(|byte| matches!(byte, b'=' | b'!' | b'<' | b'>'));
    previous || bytes.get(index + 1) == Some(&b'=')
}

/// Nothing but spaces (or a trailing comment) between `from` and the line end.
fn rest_of_line_is_empty(bytes: &[u8], from: usize) -> bool {
    let mut index = from;
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t' | b'\r') {
        index += 1;
    }
    index >= bytes.len() || matches!(bytes[index], b'\n' | b'#')
}

/// Whitespace-collapsed head, cut at a CHARACTER boundary: `SIG_MAX_CHARS`
/// characters plus `…`, never a byte slice through a multi-byte character.
fn collapse_head(head: &str) -> String {
    let mut out = String::with_capacity(head.len());
    let mut pending_space = false;
    for ch in head.trim().chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    if out.chars().count() <= SIG_MAX_CHARS {
        return out;
    }
    let mut cut: String = out.chars().take(SIG_MAX_CHARS).collect();
    cut.push('…');
    cut
}

/// Line the declared name sits on. Identical to the declaration start line
/// except for signatures that put the name on a later line (`static void\nf()`).
/// Only the head of the declaration is scanned: a name that is not in it is
/// reported at the declaration start.
pub(super) fn name_line(text: &str, start: usize, end: usize, start_line: u32, name: &str) -> u32 {
    const HEAD_BYTES: usize = 2048;
    if name.is_empty() || start >= text.len() {
        return start_line;
    }
    let mut head_end = end.min(text.len()).min(start + HEAD_BYTES);
    while head_end > start && !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let head = &text[start..head_end];
    match word_index(head, name) {
        Some(index) => start_line + head[..index].matches('\n').count() as u32,
        None => start_line,
    }
}

/// Byte index of `needle` in `haystack` as a whole word, or `None`.
fn word_index(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let bytes = haystack.as_bytes();
    haystack.match_indices(needle).find_map(|(index, _)| {
        let before_ok = index == 0 || !is_word_byte(bytes[index - 1]);
        let after = index + needle.len();
        let after_ok = after >= bytes.len() || !is_word_byte(bytes[after]);
        (before_ok && after_ok).then_some(index)
    })
}

pub(super) fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// A modifier keyword stands in the declaration head as its own word.
pub(super) fn has_modifier(head: &str, word: &str) -> bool {
    word_index(head, word).is_some()
}

pub(super) fn has_any_modifier(head: &str, words: &[&str]) -> bool {
    words.iter().any(|word| has_modifier(head, word))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::symbols::extract;
    use crate::outline::test_support::{record, records};
    use crate::scan_lang::scan_lang_for_ext;

    /// The name line is no longer a record field (v2 dropped it), but it is
    /// still the key that deduplicates two rules matching one declaration, so
    /// a name on a later line than the declaration start must still resolve.
    #[test]
    fn name_line_follows_a_multiline_signature() {
        let source = "static void\nlate_name(void) {\n}\n";
        assert_eq!(name_line(source, 0, source.len(), 1, "late_name"), 2);
        let extracted = extract(source, "c", scan_lang_for_ext("c").unwrap());
        let symbol = &extracted.symbols[0];
        assert_eq!((symbol.name.as_str(), symbol.start_line), ("late_name", 1));
    }

    #[test]
    fn sig_keeps_generic_defaults_and_function_initializers() {
        let ts = records(
            "typescript",
            "ts",
            "export function gen<T = string, U extends keyof T = keyof T>(v: T): U | undefined {\n  return undefined;\n}\nexport type Alias<T = number> = { a: T };\nexport const arrow = (a: string, b: number): boolean => a.length > b;\nexport const wrapped = async (x: number) => x + 1;\nexport const made = function named(a: number) { return a; };\nexport const value = { a: 1 };\n",
        );
        // A generic default is part of the signature, not an initializer.
        assert_eq!(
            record(&ts, "gen").sig,
            "function gen<T = string, U extends keyof T = keyof T>(v: T): U | undefined"
        );
        assert_eq!(record(&ts, "Alias").sig, "type Alias<T = number>");
        // A function-valued binding reports the callable it declares …
        assert_eq!(
            record(&ts, "arrow").sig,
            "arrow = (a: string, b: number): boolean =>"
        );
        assert_eq!(record(&ts, "wrapped").sig, "wrapped = async (x: number) =>");
        assert_eq!(record(&ts, "made").sig, "made = function named(a: number)");
        // … while a value initializer still ends the head at the `=`, which
        // leaves the bare name, i.e. no signature at all.
        assert_eq!(record(&ts, "value").sig, "");

        let rust = records(
            "rust",
            "rs",
            "pub struct Wrapper<T = String> { inner: T }\n",
        );
        assert_eq!(
            record(&rust, "Wrapper").sig,
            "pub struct Wrapper<T = String>"
        );

        // The `=` of a Ruby setter is part of the NAME, so it cannot cut …
        let ruby = records(
            "ruby",
            "rb",
            "class Store\n  def name=(value); @name = value; end\nend\n",
        );
        assert_eq!(record(&ruby, "name=").sig, "def name=(value)");
        // … and `class Child < Parent` is a superclass, not a type argument
        // list that would swallow the rest of the head.
        let ruby_super = records("ruby", "rb", "class Child < Parent\n  def go; end\nend\n");
        assert_eq!(record(&ruby_super, "Child").sig, "class Child < Parent");

        // Kotlin's `=` opens an expression BODY: cutting there is right.
        let kotlin = records(
            "kotlin",
            "kt",
            "fun expressionBody(a: Int, b: Int) = a + b\n",
        );
        assert_eq!(
            record(&kotlin, "expressionBody").sig,
            "fun expressionBody(a: Int, b: Int)"
        );
        // R assigns its functions with `<-` or `=`; both keep the parameters.
        let r = records("r", "r", "add = function(a, b) {\n  a + b\n}\n");
        assert_eq!(record(&r, "add").sig, "add = function(a, b)");
    }

    #[test]
    fn sig_is_the_declaration_head_on_one_line() {
        let ts = records(
            "typescript",
            "ts",
            "export function resolve(\n  input: string,\n  base: string,\n): string {\n  return input;\n}\nexport const limit: number = 4;\nexport const plain = 5;\n",
        );
        // The multi-line signature collapses; the body is not part of it.
        assert_eq!(
            record(&ts, "resolve").sig,
            "function resolve( input: string, base: string, ): string"
        );
        // A binding keeps its type annotation and drops the value …
        assert_eq!(record(&ts, "limit").sig, "limit: number");
        // … and a binding with neither is just its name, so there is no sig.
        assert_eq!(record(&ts, "plain").sig, "");

        // Python cuts at the `:` that opens the block, not at an annotation.
        let python = records(
            "python",
            "py",
            "def read(path: str) -> bytes:\n    return b''\n\nclass Store:\n    pass\n",
        );
        assert_eq!(record(&python, "read").sig, "def read(path: str) -> bytes");
        assert_eq!(record(&python, "Store").sig, "class Store");

        // Rust keeps the whole head including generics and the return type.
        let rust = records("rust", "rs", "pub fn run<R: Read>(input: &mut R) -> Result<()> {\n    Ok(())\n}\npub const LIMIT: usize = 1;\n");
        assert_eq!(
            record(&rust, "run").sig,
            "pub fn run<R: Read>(input: &mut R) -> Result<()>"
        );
        assert_eq!(record(&rust, "LIMIT").sig, "pub const LIMIT: usize");

        // A keyword-delimited body ends the head at the newline after the name.
        let lua = records("lua", "lua", "function greet(name)\n  return name\nend\n");
        assert_eq!(record(&lua, "greet").sig, "function greet(name)");

        // Go's type spec head is the spec, not the body.
        let go = records(
            "go",
            "go",
            "package p\n\ntype Store struct {\n\tname string\n}\n",
        );
        assert_eq!(record(&go, "Store").sig, "Store struct");
    }

    #[test]
    fn sig_truncates_at_a_character_boundary() {
        // 200 multi-byte characters in the parameter name: the cut must land
        // on a character, never inside one of the 3-byte sequences.
        let wide = "각".repeat(200);
        let source = format!("function run(\n  {wide}: string,\n) {{\n  return 1;\n}}\n");
        let symbols = records("typescript", "ts", &source);
        let sig = &record(&symbols, "run").sig;
        assert!(sig.ends_with('…'), "{sig}");
        assert_eq!(sig.chars().count(), SIG_MAX_CHARS + 1);
        assert!(sig.starts_with("function run( 각각각"));

        // A head exactly at the cap keeps every character and no marker.
        let name = "a".repeat(SIG_MAX_CHARS - "function ()".len());
        let exact = format!("function {name}() {{}}\n");
        let symbols = records("typescript", "ts", &exact);
        let sig = &record(&symbols, &name).sig;
        assert_eq!(sig.chars().count(), SIG_MAX_CHARS);
        assert!(!sig.ends_with('…'));
    }
}
