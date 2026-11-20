//! cli-highlight 2.1.11's `colorize` (`dist/index.js`): the HTML highlight.js produces, re-read the way
//! `parse5.parseFragment` reads it, and each node styled the way chalk 5 styles it.
//!
//! The token of a tag is the first word after `hljs-` in its class (`hljs-meta-keyword` is `meta`,
//! `hljs-builtin-name` is `builtin`); its style is the theme's entry or nothing, so a class the theme does not
//! name gets no escape. Text outside every `hljs-` span (the top level, and the inside of a span such as a
//! sub-language wrapper whose class is not `hljs-`) gets the theme's default style; text inside an `hljs-`
//! span is handed to that span's style raw, so a nested span's close code is followed by the outer style's
//! open code (chalk's re-opening) and the bytes equal Node's.
//!
//! cli-highlight falls back to its own `DEFAULT_THEME` (chalk 4, a level detected from the terminal) when the
//! theme lacks a token. The theme the markdown formatter passes names every token of that table that a class
//! can produce, so the fallback is never reached and is not carried.

use std::collections::HashMap;

/// An SGR open code and the code that closes it (chalk's `styler.open` / `styler.close`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SgrPair {
    pub open: String,
    pub close: String,
}

/// A chalk style: the layers of a chain in the order they were chained (`chalk.bold.rgb(1, 2, 3)` is two).
/// No layers is the identity function (a theme entry that did not parse as a colour).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SgrStyle {
    layers: Vec<SgrPair>,
}

impl SgrStyle {
    /// The style that leaves its text as it is.
    pub fn identity() -> Self {
        Self::default()
    }

    pub fn from_layers(layers: Vec<SgrPair>) -> Self {
        Self { layers }
    }

    /// `chalk.rgb(r, g, b)` at truecolor level: `ESC[38;2;r;g;bm` closed by `ESC[39m`.
    pub fn foreground_rgb(r: u8, g: u8, b: u8) -> Self {
        Self::from_layers(vec![SgrPair { open: format!("\u{1b}[38;2;{r};{g};{b}m"), close: "\u{1b}[39m".to_string() }])
    }

    /// chalk 5's `applyStyle` at a colour level above 0.
    pub fn apply(&self, text: &str) -> String {
        if text.is_empty() || self.layers.is_empty() {
            return text.to_string();
        }
        let open_all: String = self.layers.iter().map(|l| l.open.as_str()).collect();
        let close_all: String = self.layers.iter().rev().map(|l| l.close.as_str()).collect();
        let mut text = text.to_string();
        if text.contains('\u{1b}') {
            // Re-open the style after every close code already in the text, innermost layer first.
            for layer in self.layers.iter().rev() {
                text = replace_all_with_reopen(&text, &layer.close, &layer.open);
            }
        }
        if text.contains('\n') {
            text = encase_line_breaks(&text, &close_all, &open_all);
        }
        format!("{open_all}{text}{close_all}")
    }
}

/// chalk's `stringReplaceAll(string, close, open)`: every `close` becomes `close` followed by `open`.
fn replace_all_with_reopen(text: &str, close: &str, open: &str) -> String {
    if close.is_empty() || !text.contains(close) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + open.len());
    let mut end = 0;
    while let Some(found) = text[end..].find(close) {
        let at = end + found;
        out.push_str(&text[end..at]);
        out.push_str(close);
        out.push_str(open);
        end = at + close.len();
    }
    out.push_str(&text[end..]);
    out
}

/// chalk's `stringEncaseCRLFWithFirstIndex`: close the style before each line break and open it after, so the
/// style does not bleed across lines.
fn encase_line_breaks(text: &str, close_all: &str, open_all: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut end = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find('\n') {
        let index = from + found;
        let got_cr = index > 0 && text.as_bytes()[index - 1] == b'\r';
        out.push_str(&text[end..if got_cr { index - 1 } else { index }]);
        out.push_str(close_all);
        out.push_str(if got_cr { "\r\n" } else { "\n" });
        out.push_str(open_all);
        end = index + 1;
        from = end;
    }
    out.push_str(&text[end..]);
    out
}

/// The theme `colorize` takes: a style per token (the first word after `hljs-`) and the style of plain text.
#[derive(Debug, Clone, Default)]
pub struct HighlightTheme {
    pub classes: HashMap<String, SgrStyle>,
    pub default: SgrStyle,
}

/// A node of the re-read HTML.
enum Node {
    Text(String),
    Tag { class: Option<String>, children: Vec<Node> },
}

/// `parse5.parseFragment` of the markup highlight.js writes: `<span class="...">`, `</span>` and the five
/// entities `escapeHTML` produces. Line breaks are normalised (CR LF and CR become LF) and U+0000 is dropped,
/// as the HTML input stream and the body insertion mode do.
fn parse_fragment(html: &str) -> Vec<Node> {
    const OPEN: &str = "<span class=\"";
    const CLOSE: &str = "</span>";
    const ENTITIES: [(&str, char); 5] = [("&amp;", '&'), ("&lt;", '<'), ("&gt;", '>'), ("&quot;", '"'), ("&#x27;", '\'')];

    let mut stack: Vec<(Option<String>, Vec<Node>)> = vec![(None, Vec::new())];
    let mut text = String::new();
    let flush = |text: &mut String, stack: &mut Vec<(Option<String>, Vec<Node>)>| {
        if !text.is_empty()
            && let Some(top) = stack.last_mut()
        {
            top.1.push(Node::Text(std::mem::take(text)));
        }
    };
    let mut i = 0;
    while i < html.len() {
        let rest = &html[i..];
        if let Some(after) = rest.strip_prefix(OPEN)
            && let Some(end) = after.find("\">")
        {
            flush(&mut text, &mut stack);
            stack.push((Some(after[..end].to_string()), Vec::new()));
            i += OPEN.len() + end + 2;
            continue;
        }
        if rest.starts_with(CLOSE) {
            flush(&mut text, &mut stack);
            if stack.len() > 1
                && let Some((class, children)) = stack.pop()
                && let Some(parent) = stack.last_mut()
            {
                parent.1.push(Node::Tag { class, children });
            }
            i += CLOSE.len();
            continue;
        }
        if rest.starts_with('&')
            && let Some((name, decoded)) = ENTITIES.iter().find(|(name, _)| rest.starts_with(name))
        {
            text.push(*decoded);
            i += name.len();
            continue;
        }
        let Some(c) = rest.chars().next() else { break };
        match c {
            '\r' => {
                text.push('\n');
                if rest[1..].starts_with('\n') {
                    i += 1;
                }
            }
            '\0' => {}
            other => text.push(other),
        }
        i += c.len_utf8();
    }
    flush(&mut text, &mut stack);
    // Tags left open at the end close with the document.
    while stack.len() > 1 {
        if let Some((class, children)) = stack.pop()
            && let Some(parent) = stack.last_mut()
        {
            parent.1.push(Node::Tag { class, children });
        }
    }
    stack.pop().map(|(_, children)| children).unwrap_or_default()
}

/// `/hljs-(\w+)/.exec(class)[1]`: the word after the first `hljs-` that has one.
fn hljs_token(class: &str) -> Option<&str> {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(found) = class[from..].find("hljs-") {
        let start = from + found + "hljs-".len();
        let word_len = class[start..].find(|c: char| !is_word(c)).unwrap_or(class.len() - start);
        if word_len > 0 {
            return Some(&class[start..start + word_len]);
        }
        from = start;
    }
    None
}

fn colorize_node(node: &Node, theme: &HighlightTheme, in_token: bool) -> String {
    match node {
        Node::Text(text) => {
            if in_token {
                text.clone()
            } else {
                theme.default.apply(text)
            }
        }
        Node::Tag { class, children } => match class.as_deref().and_then(hljs_token) {
            Some(token) => {
                let data: String = children.iter().map(|child| colorize_node(child, theme, true)).collect();
                match theme.classes.get(token) {
                    Some(style) => style.apply(&data),
                    None => data,
                }
            }
            // A class that is not highlight.js's (a sub-language wrapper): its children are read afresh.
            None => children.iter().map(|child| colorize_node(child, theme, false)).collect(),
        },
    }
}

/// `colorize(code, theme)`: highlight.js HTML to ANSI.
pub fn colorize(html: &str, theme: &HighlightTheme) -> String {
    parse_fragment(html).iter().map(|node| colorize_node(node, theme, false)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red() -> SgrStyle {
        SgrStyle::foreground_rgb(255, 0, 0)
    }

    fn theme() -> HighlightTheme {
        let mut classes = HashMap::new();
        classes.insert("keyword".to_string(), red());
        classes.insert("string".to_string(), SgrStyle::foreground_rgb(0, 255, 0));
        classes.insert("meta".to_string(), SgrStyle::foreground_rgb(1, 2, 3));
        HighlightTheme { classes, default: SgrStyle::foreground_rgb(9, 9, 9) }
    }

    #[test]
    fn a_style_wraps_its_text_and_leaves_empty_text_alone() {
        assert_eq!(red().apply("if"), "\u{1b}[38;2;255;0;0mif\u{1b}[39m");
        assert_eq!(red().apply(""), "");
        assert_eq!(SgrStyle::identity().apply("if"), "if");
    }

    #[test]
    fn nested_styles_reopen_the_outer_one_after_the_inner_close() {
        let inner = SgrStyle::foreground_rgb(0, 255, 0).apply("b");
        let out = red().apply(&format!("a{inner}c"));
        assert_eq!(out, "\u{1b}[38;2;255;0;0ma\u{1b}[38;2;0;255;0mb\u{1b}[39m\u{1b}[38;2;255;0;0mc\u{1b}[39m");
    }

    #[test]
    fn line_breaks_close_and_reopen_the_style() {
        assert_eq!(red().apply("a\r\nb\nc"), "\u{1b}[38;2;255;0;0ma\u{1b}[39m\r\n\u{1b}[38;2;255;0;0mb\u{1b}[39m\n\u{1b}[38;2;255;0;0mc\u{1b}[39m");
    }

    #[test]
    fn layers_of_a_chain_close_in_reverse_order() {
        let bold_red = SgrStyle::from_layers(vec![
            SgrPair { open: "\u{1b}[1m".to_string(), close: "\u{1b}[22m".to_string() },
            SgrPair { open: "\u{1b}[31m".to_string(), close: "\u{1b}[39m".to_string() },
        ]);
        assert_eq!(bold_red.apply("x"), "\u{1b}[1m\u{1b}[31mx\u{1b}[39m\u{1b}[22m");
    }

    #[test]
    fn the_token_is_the_first_word_after_hljs() {
        assert_eq!(hljs_token("hljs-meta-keyword"), Some("meta"));
        assert_eq!(hljs_token("hljs-builtin-name"), Some("builtin"));
        assert_eq!(hljs_token("hljs-built_in"), Some("built_in"));
        assert_eq!(hljs_token("hljs-title class_"), Some("title"));
        assert_eq!(hljs_token("xml"), None);
        assert_eq!(hljs_token("hljs- hljs-x"), Some("x"));
    }

    #[test]
    fn top_level_text_takes_the_default_style_and_a_known_class_its_own() {
        let html = "a <span class=\"hljs-keyword\">if</span> &lt;b&gt;";
        assert_eq!(colorize(html, &theme()), "\u{1b}[38;2;9;9;9ma \u{1b}[39m\u{1b}[38;2;255;0;0mif\u{1b}[39m\u{1b}[38;2;9;9;9m <b>\u{1b}[39m");
    }

    #[test]
    fn an_unknown_class_gets_no_escape_and_its_text_is_raw() {
        let html = "<span class=\"hljs-nothing\">x</span>";
        assert_eq!(colorize(html, &theme()), "x");
    }

    #[test]
    fn a_wrapper_span_resets_the_context_to_default_text() {
        let html = "<span class=\"hljs-string\">'<span class=\"xml\">t</span>'</span>";
        assert_eq!(colorize(html, &theme()), "\u{1b}[38;2;0;255;0m'\u{1b}[38;2;9;9;9mt\u{1b}[39m\u{1b}[38;2;0;255;0m'\u{1b}[39m");
    }

    #[test]
    fn line_breaks_in_the_input_stream_are_normalised_and_nul_is_dropped() {
        let theme = HighlightTheme::default();
        assert_eq!(colorize("a\r\nb\rc\u{0}d", &theme), "a\nb\ncd");
    }

    #[test]
    fn entities_decode_once() {
        assert_eq!(colorize("&amp;lt; &quot;&#x27;", &HighlightTheme::default()), "&lt; \"'");
    }
}
