//! marked 14.1.4's lexer (`marked.lexer(text)`) for the options the TUI runs it with (gfm on, no breaks, not pedantic) and
//! the pair-only `~~strike~~` tokenizer `render-ansi.mjs` installs over marked's `del`. The block tokenizers are in
//! `block`, the inline ones in `inline`; the lexer follows marked's: a block pass that queues the text of every heading,
//! paragraph, block text and table cell, then an inline pass over the queue once the reference definitions are known.
//!
//! Offsets are byte offsets (marked's are UTF-16 indices): a length marked takes from a match or a prefix is the same
//! length here, and where marked counts characters (`[...text].length`) so does this.

macro_rules! lazy_re {
    ($name:ident, $source:expr) => {
        lazy_re!($name, $source, "");
    };
    ($name:ident, $source:expr, $flags:expr) => {
        static $name: std::sync::LazyLock<$crate::lexer::rules::Re> =
            std::sync::LazyLock::new(|| $crate::lexer::rules::Re::new($source, $flags));
    };
}

mod block;
mod inline;
pub(crate) mod rules;
mod strike;
mod token;

use std::collections::{BTreeMap, HashMap};

pub use rules::{BLOCK, INLINE};
pub use token::{Align, Link, ListStart, TableCell, Token, TokenKind};

use rules::{RULES, Rules};

/// What `marked.lexer(text)` returns: the tokens, and the `links` table its `tokens.links` carries.
#[derive(Clone, Debug, PartialEq)]
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub links: BTreeMap<String, Link>,
}

/// `lexer.state`.
struct State {
    in_link: bool,
    in_raw_block: bool,
    top: bool,
}

/// An entry of `lexer.inlineQueue`: the text whose inline tokens fill the token (or table cell) `id` names.
struct Queued {
    id: usize,
    src: String,
}

pub(crate) struct Lexer {
    rules: &'static Rules,
    links: BTreeMap<String, Link>,
    state: State,
    queue: Vec<Queued>,
    next_id: usize,
}

/// `marked.lexer(text)`.
pub fn lex(text: &str) -> Lexed {
    let mut lexer = Lexer::new();
    let src = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut tokens = Vec::new();
    lexer.block_tokens(&src, &mut tokens, false);
    let queue = std::mem::take(&mut lexer.queue);
    let mut filled: HashMap<usize, Vec<Token>> = HashMap::with_capacity(queue.len());
    for entry in &queue {
        let inline = lexer.inline_tokens(&entry.src);
        filled.insert(entry.id, inline);
    }
    fill_inline(&mut tokens, &mut filled);
    Lexed { tokens, links: lexer.links }
}

/// Gives every queued token its inline tokens: marked fills the arrays it handed out in place, here a token holds its
/// queue entry's id until this pass.
fn fill_inline(tokens: &mut [Token], filled: &mut HashMap<usize, Vec<Token>>) {
    for token in tokens {
        match token.kind {
            TokenKind::Heading | TokenKind::Paragraph | TokenKind::Text => {
                if let Some(id) = token.queued.take() {
                    token.tokens = Some(filled.remove(&id).unwrap_or_default());
                }
            }
            TokenKind::Blockquote | TokenKind::ListItem => {
                if let Some(children) = token.tokens.as_mut() {
                    fill_inline(children, filled);
                }
            }
            TokenKind::List => {
                if let Some(items) = token.items.as_mut() {
                    fill_inline(items, filled);
                }
            }
            TokenKind::Table => {
                let header = token.header.iter_mut().flatten();
                let rows = token.rows.iter_mut().flatten().flatten();
                for cell in header.chain(rows) {
                    if let Some(id) = cell.queued.take() {
                        cell.tokens = filled.remove(&id).unwrap_or_default();
                    }
                }
            }
            _ => {}
        }
    }
}

impl Lexer {
    fn new() -> Self {
        Self {
            rules: &RULES,
            links: BTreeMap::new(),
            state: State { in_link: false, in_raw_block: false, top: true },
            queue: Vec::new(),
            next_id: 0,
        }
    }

    /// `lexer.inline(src)`: queues `src` and returns the id its tokens are filled in under.
    fn inline(&mut self, src: &str) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        self.queue.push(Queued { id, src: src.to_owned() });
        id
    }

    /// `inlineQueue[inlineQueue.length - 1].src = text`.
    fn requeue_last(&mut self, text: &str) {
        if let Some(entry) = self.queue.last_mut() {
            entry.src = text.to_owned();
        }
    }
}

/// `src.substring(n)`: the rest of `src` after `n` bytes (past the end is empty; inside a character, after it).
pub(crate) fn advance(src: &str, n: usize) -> &str {
    let mut at = n.min(src.len());
    while !src.is_char_boundary(at) {
        at += 1;
    }
    &src[at..]
}

/// `src.slice(0, n)` for a length counted in bytes (inside a character, before it).
pub(crate) fn prefix(src: &str, n: usize) -> &str {
    let mut at = n.min(src.len());
    while !src.is_char_boundary(at) {
        at -= 1;
    }
    &src[..at]
}

/// `src.slice(0, n)` for a count of UTF-16 units. A cut inside a surrogate pair takes the whole pair (a Rust string
/// cannot end in half of one).
pub(crate) fn prefix_units(src: &str, n: usize) -> &str {
    let mut units = 0;
    for (at, c) in src.char_indices() {
        if units >= n {
            return &src[..at];
        }
        units += c.len_utf16();
    }
    src
}

/// `src.slice(n)` for a count of characters.
pub(crate) fn skip_chars(src: &str, n: usize) -> &str {
    match src.char_indices().nth(n) {
        Some((at, _)) => &src[at..],
        None => "",
    }
}

/// `src.slice(n)` for a count of UTF-16 units. A cut inside a surrogate pair leaves the pair's low half, which no rule
/// reads as a space or a marker: it is U+FFFF here (as in `last_unit` of the inline lexer).
pub(crate) fn skip_units(src: &str, n: usize) -> String {
    let mut units = 0;
    for (at, c) in src.char_indices() {
        if units >= n {
            return src[at..].to_owned();
        }
        units += c.len_utf16();
        if units > n {
            return format!("\u{FFFF}{}", &src[at + c.len_utf8()..]);
        }
    }
    String::new()
}

/// `src.slice(n, -n)`: without `n` characters at each end.
pub(crate) fn trim_ends(src: &str, n: usize) -> &str {
    let total = src.chars().count();
    if total <= 2 * n {
        return "";
    }
    let inner = skip_chars(src, n);
    let keep = total - 2 * n;
    match inner.char_indices().nth(keep) {
        Some((at, _)) => &inner[..at],
        None => inner,
    }
}

/// The length of `text` in UTF-16 units.
pub(crate) fn utf16_len(text: &str) -> usize {
    if text.is_ascii() { text.len() } else { text.encode_utf16().count() }
}

/// `src.slice(n)` for a count of UTF-16 units, borrowed unless the cut is inside a surrogate pair (see `skip_units`).
pub(crate) fn skip_units_borrowed(src: &str, n: usize) -> std::borrow::Cow<'_, str> {
    if src.is_ascii() {
        return std::borrow::Cow::Borrowed(src.get(n.min(src.len())..).unwrap_or(""));
    }
    let mut units = 0;
    for (at, c) in src.char_indices() {
        if units >= n {
            return std::borrow::Cow::Borrowed(&src[at..]);
        }
        units += c.len_utf16();
        if units > n {
            return std::borrow::Cow::Owned(format!("\u{FFFF}{}", &src[at + c.len_utf8()..]));
        }
    }
    std::borrow::Cow::Borrowed("")
}

/// `src.slice(n, -n)` for a count of UTF-16 units. A cut inside a surrogate pair drops the whole pair (a Rust string
/// cannot start or end in half of one).
pub(crate) fn trim_ends_units(src: &str, n: usize) -> &str {
    let total = src.encode_utf16().count();
    if total <= 2 * n {
        return "";
    }
    let mut start = src.len();
    let mut end = 0;
    let mut units = 0;
    for (at, c) in src.char_indices() {
        if units >= n && start == src.len() {
            start = at;
        }
        units += c.len_utf16();
        if units <= total - n {
            end = at + c.len_utf8();
        }
    }
    src.get(start..end.max(start)).unwrap_or("")
}

/// marked's `rtrim(str, c)`.
pub(crate) fn rtrim_char(src: &str, c: char) -> &str {
    src.trim_end_matches(c)
}

/// The index of the first character that is not a space (`str.search(/[^ ]/)`).
pub(crate) fn first_non_space(src: &str) -> Option<usize> {
    src.find(|c: char| c != ' ')
}

/// marked's `findClosingBracket(str, b)` for `b` = `open` + `close`.
pub(crate) fn find_closing_bracket(src: &str, open: char, close: char) -> Option<usize> {
    if !src.contains(close) {
        return None;
    }
    let mut level = 0i32;
    let mut chars = src.char_indices();
    while let Some((at, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == open {
            level += 1;
        } else if c == close {
            level -= 1;
            if level < 0 {
                return Some(at);
            }
        }
    }
    None
}

/// marked's `escape(html, encode)`: `&`, `<`, `>`, `"` and `'` as entities; without `encode` an `&` that already starts
/// an entity (`&amp;`, `&#38;`, `&#x26;`) stays.
pub(crate) fn escape_html(text: &str, encode: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for (at, c) in text.char_indices() {
        match c {
            '&' if encode || !starts_entity(&text[at + 1..]) => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// What the lookahead of `/&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/` accepts after an `&`: `#12;`, `#x1F;` or `name;`.
fn starts_entity(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    let run = |from: usize, accept: fn(u8) -> bool| bytes.get(from..).map_or(0, |tail| tail.iter().take_while(|b| accept(**b)).count());
    let semicolon = |at: usize| bytes.get(at) == Some(&b';');
    if bytes.first() == Some(&b'#') {
        let digits = run(1, |b| b.is_ascii_digit());
        if (1..=7).contains(&digits) && semicolon(1 + digits) {
            return true;
        }
        if matches!(bytes.get(1), Some(b'x' | b'X')) {
            let hex = run(2, |b| b.is_ascii_hexdigit());
            return (1..=6).contains(&hex) && semicolon(2 + hex);
        }
        return false;
    }
    let word = run(0, |b| b.is_ascii_alphanumeric() || b == b'_');
    word >= 1 && semicolon(word)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_keeps_an_entity_unless_everything_is_encoded() {
        assert_eq!(escape_html("a & b <c> \"d\" 'e'", false), "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;");
        assert_eq!(
            escape_html("&amp; &#38; &#x26; &copy; &#12345678; &x;y &", false),
            "&amp; &#38; &#x26; &copy; &amp;#12345678; &x;y &amp;"
        );
        assert_eq!(escape_html("&amp;", true), "&amp;amp;");
        assert_eq!(escape_html("&#x1234567;", false), "&amp;#x1234567;");
    }

    #[test]
    fn helpers_follow_javascript_slices() {
        assert_eq!(trim_ends("*ab*", 1), "ab");
        assert_eq!(trim_ends("**", 1), "");
        assert_eq!(trim_ends("가나다", 1), "나");
        assert_eq!(skip_chars("가나다", 1), "나다");
        assert_eq!(skip_chars("a", 3), "");
        assert_eq!(advance("abc", 1), "bc");
        assert_eq!(advance("abc", 9), "");
        assert_eq!(find_closing_bracket("a(b)c)d", '(', ')'), Some(5));
        assert_eq!(find_closing_bracket("a\\)b)", '(', ')'), Some(4));
        assert_eq!(find_closing_bracket("abc", '(', ')'), None);
        assert_eq!(skip_units("ab", 1), "b");
        assert_eq!(skip_units("😀x", 2), "x");
        assert_eq!(skip_units("😀x", 1), "\u{FFFF}x");
        assert_eq!(skip_units("a", 3), "");
    }

    #[test]
    fn a_paragraph_with_emphasis_and_a_link() {
        let lexed = lex("a *b* [c](http://x \"t\")\n");
        assert_eq!(lexed.tokens.len(), 1);
        let kinds: Vec<_> = lexed.tokens[0].children().iter().map(|t| t.kind).collect();
        assert_eq!(kinds, [TokenKind::Text, TokenKind::Em, TokenKind::Text, TokenKind::Link]);
        let link = &lexed.tokens[0].children()[3];
        assert_eq!(link.href.as_deref(), Some("http://x"));
        assert_eq!(link.title.as_deref(), Some("t"));
    }

    #[test]
    fn a_reference_definition_is_collected_and_resolved() {
        let lexed = lex("[x]: http://y\n\nsee [x]\n");
        assert_eq!(lexed.links.get("x").map(|l| l.href.as_str()), Some("http://y"));
        let paragraph = lexed.tokens.iter().find(|t| t.kind == TokenKind::Paragraph).map(|t| t.children().len());
        assert_eq!(paragraph, Some(2));
    }
}
