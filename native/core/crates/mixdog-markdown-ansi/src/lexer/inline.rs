//! marked's inline tokenizers and `Lexer.inlineTokens`.

use mixdog_js::{js_to_lowercase, js_trim};

use super::block::unescape_punctuation;
use super::token::{Token, TokenKind};
use super::{Lexer, advance, escape_html, find_closing_bracket, prefix, rtrim_char, trim_ends};

lazy_re!(TAG_ANCHOR_OPEN, r"^<a ", "i");
lazy_re!(TAG_ANCHOR_CLOSE, r"^<\/a>", "i");
lazy_re!(TAG_RAW_OPEN, r"^<(pre|code|kbd|script)(\s|>)", "i");
lazy_re!(TAG_RAW_CLOSE, r"^<\/(pre|code|kbd|script)(\s|>)", "i");
lazy_re!(BRACKET_ESCAPE, r"\\([\[\]])", "g");
lazy_re!(WHITESPACE_RUN, r"\s+", "g");
lazy_re!(LETTER_OR_NUMBER, r"[\p{L}\p{N}]", "u");

/// `prevChar` of marked's `inlineTokens`: the last UTF-16 unit of the text before the one being read. A character
/// outside the BMP ends in a lone low surrogate there, which is neither punctuation nor a letter: it is U+FFFF here.
fn last_unit(raw: &str) -> Option<char> {
    raw.chars().next_back().map(|c| if c.len_utf16() == 2 { '\u{FFFF}' } else { c })
}

impl Lexer {
    /// `Lexer.inlineTokens(src)`.
    pub(super) fn inline_tokens(&mut self, src: &str) -> Vec<Token> {
        let rules = self.rules;
        let mut tokens: Vec<Token> = Vec::new();
        // String with links masked to avoid interference with em and strong: every mask keeps the byte length, so an
        // offset in it is an offset in `src`.
        let mut masked = src.to_owned();
        // Mask out reflinks
        if !self.links.is_empty() {
            let mut at = 0;
            loop {
                let found = rules.inline.reflink_search.exec_from(&masked, at).map(|m| {
                    let whole = m.whole();
                    let label_from = whole.rfind('[').map_or(0, |i| i + 1);
                    let label = whole.get(label_from..whole.len().saturating_sub(1)).unwrap_or("");
                    (m.start(), m.end(), self.links.contains_key(label))
                });
                let Some((start, end, listed)) = found else { break };
                if listed {
                    masked = masked_span(&masked, start, end, 'a', true);
                }
                at = end;
            }
        }
        // Mask out other blocks
        let mut at = 0;
        while let Some((start, end)) = rules.inline.block_skip.exec_from(&masked, at).map(|m| (m.start(), m.end())) {
            masked = masked_span(&masked, start, end, 'a', true);
            at = end;
        }
        // Mask out escaped characters
        let mut at = 0;
        while let Some((start, end)) = rules.inline.any_punctuation.exec_from(&masked, at).map(|m| (m.start(), m.end())) {
            masked = masked_span(&masked, start, end, '+', false);
            at = end;
        }

        let mut src = src;
        let mut keep_prev_char = false;
        let mut prev_char: Option<char> = None;
        while !src.is_empty() {
            if !keep_prev_char {
                prev_char = None;
            }
            keep_prev_char = false;
            // escape
            if let Some(token) = self.escape(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // tag
            if let Some(token) = self.tag(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // link
            if let Some(token) = self.link(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // reflink, nolink
            if let Some(token) = self.reflink(src) {
                src = advance(src, token.raw.len());
                match tokens.last_mut() {
                    Some(last) if token.kind == TokenKind::Text && last.kind == TokenKind::Text => append_text(last, &token),
                    _ => tokens.push(token),
                }
                continue;
            }
            // em & strong
            if let Some(token) = self.em_strong(src, &masked, prev_char) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // code
            if let Some(token) = self.codespan(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // br
            if let Some(token) = self.br(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // del (gfm)
            if let Some(token) = self.del(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // autolink
            if let Some(token) = self.autolink(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // url (gfm)
            let url = if self.state.in_link { None } else { self.url(src) };
            if let Some(token) = url {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // text
            if let Some(token) = self.inline_text(src) {
                src = advance(src, token.raw.len());
                // Track prevChar before string of ____ started
                if !token.raw.ends_with('_') {
                    prev_char = last_unit(&token.raw);
                }
                keep_prev_char = true;
                match tokens.last_mut() {
                    Some(last) if last.kind == TokenKind::Text => append_text(last, &token),
                    _ => tokens.push(token),
                }
                continue;
            }
            // marked throws here ("Infinite loop on byte"); the text rule matches every character, so this is not reached.
            break;
        }
        tokens
    }

    fn escape(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.escape.exec(src)?;
        Some(Token::with_text(TokenKind::Escape, cap.whole(), escape_html(cap.get(1).unwrap_or(""), false)))
    }

    fn tag(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.tag.exec(src)?;
        let whole = cap.whole();
        if !self.state.in_link && TAG_ANCHOR_OPEN.test(whole) {
            self.state.in_link = true;
        } else if self.state.in_link && TAG_ANCHOR_CLOSE.test(whole) {
            self.state.in_link = false;
        }
        if !self.state.in_raw_block && TAG_RAW_OPEN.test(whole) {
            self.state.in_raw_block = true;
        } else if self.state.in_raw_block && TAG_RAW_CLOSE.test(whole) {
            self.state.in_raw_block = false;
        }
        let mut token = Token::with_text(TokenKind::Html, whole, whole);
        token.in_link = Some(self.state.in_link);
        token.in_raw_block = Some(self.state.in_raw_block);
        token.block = Some(false);
        Some(token)
    }

    /// marked's `outputLink(cap, link, raw, lexer)`: a link, or an image when the match starts with `!`.
    fn output_link(&mut self, label: &str, bang: bool, href: String, title: Option<&str>, raw: &str) -> Token {
        let title = title.filter(|t| !t.is_empty()).map(|t| escape_html(t, false));
        let text = BRACKET_ESCAPE.replace_all(label, |caps| caps.get(1).unwrap_or("").to_owned());
        if bang {
            let mut token = Token::with_text(TokenKind::Image, raw, escape_html(&text, false));
            token.href = Some(href);
            token.title = title;
            return token;
        }
        self.state.in_link = true;
        let children = self.inline_tokens(&text);
        let mut token = Token::with_text(TokenKind::Link, raw, text);
        token.href = Some(href);
        token.title = title;
        token.tokens = Some(children);
        self.state.in_link = false;
        token
    }

    fn link(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.link.exec(src)?;
        let label = cap.get(1).unwrap_or("");
        let mut target = cap.get(2).unwrap_or("");
        let mut raw = cap.whole().to_owned();
        let mut title_part = cap.get(3).unwrap_or("");
        let trimmed_url = js_trim(target);
        if trimmed_url.starts_with('<') {
            // commonmark requires matching angle brackets
            if !trimmed_url.ends_with('>') {
                return None;
            }
            // ending angle bracket cannot be escaped
            let without_bracket = prefix(trimmed_url, trimmed_url.len() - 1);
            let rtrim_slash = rtrim_char(without_bracket, '\\');
            if (trimmed_url.len() - rtrim_slash.len()) % 2 == 0 {
                return None;
            }
        } else if let Some(last_paren) = find_closing_bracket(target, '(', ')') {
            // find closing parenthesis
            let start = if raw.starts_with('!') { 5 } else { 4 };
            let link_len = start + label.len() + last_paren;
            target = prefix(target, last_paren);
            raw = js_trim(prefix(&raw, link_len)).to_owned();
            title_part = "";
        }
        let title = if title_part.is_empty() { "" } else { trim_ends(title_part, 1) };
        let mut href = js_trim(target);
        if href.starts_with('<') {
            href = trim_ends(href, 1);
        }
        let href = if href.is_empty() { String::new() } else { unescape_punctuation(&self.rules.inline.any_punctuation, href) };
        let title = if title.is_empty() { None } else { Some(unescape_punctuation(&self.rules.inline.any_punctuation, title)) };
        let bang = raw.starts_with('!');
        Some(self.output_link(label, bang, href, title.as_deref(), &raw))
    }

    fn reflink(&mut self, src: &str) -> Option<Token> {
        let rules = self.rules;
        let cap = rules.inline.reflink.exec(src).or_else(|| rules.inline.nolink.exec(src))?;
        let reference = cap.get(2).filter(|r| !r.is_empty()).or_else(|| cap.get(1)).unwrap_or("");
        let key = js_to_lowercase(&WHITESPACE_RUN.replace_all(reference, |_| " ".to_owned()));
        let Some(link) = self.links.get(&key).cloned() else {
            let text = &cap.whole()[..1];
            return Some(Token::with_text(TokenKind::Text, text, text));
        };
        let raw = cap.whole();
        Some(self.output_link(cap.get(1).unwrap_or(""), raw.starts_with('!'), link.href, link.title.as_deref(), raw))
    }

    fn em_strong(&mut self, src: &str, masked: &str, prev_char: Option<char>) -> Option<Token> {
        let rules = self.rules;
        let left = rules.inline.em_strong_l_delim.exec(src)?;
        // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
        if left.get(3).is_some() && prev_char.is_some_and(|c| LETTER_OR_NUMBER.test(c.encode_utf8(&mut [0; 4]))) {
            return None;
        }
        let next_char = left.get(1).filter(|s| !s.is_empty()).or_else(|| left.get(2)).unwrap_or("");
        let prev_is_punctuation = prev_char.is_some_and(|c| rules.inline.punctuation.test(c.encode_utf8(&mut [0; 4])));
        if !(next_char.is_empty() || prev_char.is_none() || prev_is_punctuation) {
            return None;
        }
        // unicode Regex counts emoji as 1 char: count characters
        let left_length = left.whole().chars().count() - 1;
        let end_rule = if left.whole().starts_with('*') { &rules.inline.em_strong_r_delim_ast } else { &rules.inline.em_strong_r_delim_und };
        let mut delim_total = i64::try_from(left_length).unwrap_or(0);
        let mut mid_delim_total = 0i64;
        let left_length_signed = delim_total;
        // Clip maskedSrc to same section of string as src
        let clip_from = (masked.len() + left_length).saturating_sub(src.len());
        let clipped = masked.get(clip_from..).unwrap_or("");
        let mut at = 0;
        while let Some(found) = end_rule.exec_from(clipped, at) {
            at = found.end();
            // skip single * in __abc*abc__
            let Some(right) = (1..=6).filter_map(|group| found.get(group)).find(|s| !s.is_empty()) else { continue };
            let mut right_length = i64::try_from(right.chars().count()).unwrap_or(0);
            if found.get(3).is_some() || found.get(4).is_some() {
                // found another Left Delim
                delim_total += right_length;
                continue;
            }
            if (found.get(5).is_some() || found.get(6).is_some()) && left_length_signed % 3 != 0 && (left_length_signed + right_length) % 3 == 0 {
                // either Left or Right Delim: CommonMark Emphasis Rules 9-10
                mid_delim_total += right_length;
                continue;
            }
            delim_total -= right_length;
            if delim_total > 0 {
                // Haven't found enough closing delimiters
                continue;
            }
            // Remove extra characters. *a*** -> *a*
            right_length = right_length.min(right_length + delim_total + mid_delim_total);
            // char length can be >1 for unicode characters
            let last_char_length = found.whole().chars().next().map_or(0, char::len_utf8);
            let raw_length = i64::try_from(left_length + found.start() + last_char_length).unwrap_or(0) + right_length;
            let raw = prefix(src, usize::try_from(raw_length).unwrap_or(0));
            if raw.is_empty() {
                // marked would return a token that consumes nothing and read the same text again for ever
                return None;
            }
            // Create `em` if smallest delimiter has odd char count. *a***
            let (kind, text) = if left_length_signed.min(right_length) % 2 != 0 {
                (TokenKind::Em, trim_ends(raw, 1))
            } else {
                // Create 'strong' if smallest delimiter has even char count. **a***
                (TokenKind::Strong, trim_ends(raw, 2))
            };
            let children = self.inline_tokens(text);
            let mut token = Token::with_text(kind, raw, text);
            token.tokens = Some(children);
            return Some(token);
        }
        None
    }

    fn codespan(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.code.exec(src)?;
        let mut text = cap.get(2).unwrap_or("").replace('\n', " ");
        let has_non_space_chars = text.chars().any(|c| c != ' ');
        let has_space_chars_on_both_ends = text.starts_with(' ') && text.ends_with(' ');
        if has_non_space_chars && has_space_chars_on_both_ends {
            text = trim_ends(&text, 1).to_owned();
        }
        Some(Token::with_text(TokenKind::Codespan, cap.whole(), escape_html(&text, true)))
    }

    fn br(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.br.exec(src)?;
        Some(Token::new(TokenKind::Br, cap.whole()))
    }

    fn autolink(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.autolink.exec(src)?;
        let text = escape_html(cap.get(1).unwrap_or(""), false);
        let href = if cap.get(2) == Some("@") { format!("mailto:{text}") } else { text.clone() };
        Some(link_of_text(cap.whole(), text, href))
    }

    fn url(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.url.exec(src)?;
        let (raw, text, href) = if cap.get(2) == Some("@") {
            let raw = cap.whole().to_owned();
            let text = escape_html(&raw, false);
            let href = format!("mailto:{text}");
            (raw, text, href)
        } else {
            // do extended autolink path validation
            let mut current = cap.whole().to_owned();
            loop {
                let next = self.rules.inline.backpedal.exec(&current).map(|m| m.whole().to_owned()).unwrap_or_default();
                if next == current {
                    break;
                }
                current = next;
            }
            if current.is_empty() {
                return None;
            }
            let text = escape_html(&current, false);
            let href = if cap.get(1) == Some("www.") { format!("http://{current}") } else { current.clone() };
            (current, text, href)
        };
        Some(link_of_text(&raw, text, href))
    }

    fn inline_text(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.inline.text.exec(src)?;
        let text = if self.state.in_raw_block { cap.whole().to_owned() } else { escape_html(cap.whole(), false) };
        Some(Token::with_text(TokenKind::Text, cap.whole(), text))
    }
}

/// `{ type: 'link', raw, text, href, tokens: [{ type: 'text', raw: text, text }] }` of an autolink.
fn link_of_text(raw: &str, text: String, href: String) -> Token {
    let child = Token::with_text(TokenKind::Text, text.as_str(), text.as_str());
    let mut token = Token::with_text(TokenKind::Link, raw, text);
    token.href = Some(href);
    token.tokens = Some(vec![child]);
    token
}

/// `lastToken.raw += token.raw; lastToken.text += token.text`.
fn append_text(last: &mut Token, token: &Token) {
    last.raw.push_str(&token.raw);
    last.text.get_or_insert_with(String::new).push_str(token.text_str());
}

/// `masked.slice(0, start) + '[' + 'a'.repeat(len - 2) + ']' + masked.slice(end)` (`bracketed`), or the span replaced by
/// its length in `fill`; the length in bytes stays.
fn masked_span(masked: &str, start: usize, end: usize, fill: char, bracketed: bool) -> String {
    let width = end - start;
    let mut out = String::with_capacity(masked.len());
    out.push_str(&masked[..start]);
    if bracketed {
        out.push('[');
        out.extend(std::iter::repeat_n(fill, width.saturating_sub(2)));
        out.push(']');
    } else {
        out.extend(std::iter::repeat_n(fill, width));
    }
    out.push_str(&masked[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;

    fn inline_of(text: &str) -> Vec<Token> {
        lex(text).tokens.into_iter().next().and_then(|paragraph| paragraph.tokens).unwrap_or_default()
    }

    fn kinds(text: &str) -> Vec<TokenKind> {
        inline_of(text).iter().map(|t| t.kind).collect()
    }

    #[test]
    fn emphasis_strong_and_code() {
        assert_eq!(kinds("*a* **b** `c`"), [TokenKind::Em, TokenKind::Text, TokenKind::Strong, TokenKind::Text, TokenKind::Codespan]);
        let tokens = inline_of("**a**");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Strong);
        assert_eq!(tokens[0].text.as_deref(), Some("a"));
    }

    #[test]
    fn underscores_inside_a_word_are_text() {
        assert_eq!(kinds("snake_case_word"), [TokenKind::Text]);
    }

    #[test]
    fn strike_needs_a_pair_of_tildes() {
        assert_eq!(kinds("~~gone~~"), [TokenKind::Del]);
        assert_eq!(kinds("~100 to ~200"), [TokenKind::Text]);
        assert_eq!(kinds("1~2"), [TokenKind::Text]);
    }

    #[test]
    fn bare_urls_and_autolinks() {
        let tokens = inline_of("see https://example.com/a?b=1. and <https://x.y>");
        let links: Vec<_> = tokens.iter().filter(|t| t.kind == TokenKind::Link).map(|t| t.href.clone().unwrap_or_default()).collect();
        assert_eq!(links, ["https://example.com/a?b=1", "https://x.y"]);
        let mail = inline_of("write a.b@c.de now");
        assert_eq!(mail[1].href.as_deref(), Some("mailto:a.b@c.de"));
    }

    #[test]
    fn html_and_escapes() {
        let tokens = inline_of("a <b>x</b> \\* &amp; <");
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Html && t.text.as_deref() == Some("<b>")));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Escape && t.text.as_deref() == Some("*")));
    }

    #[test]
    fn an_image_and_a_link_with_parentheses() {
        let image = inline_of("![alt](a.png \"t\")");
        assert_eq!(image[0].kind, TokenKind::Image);
        assert_eq!(image[0].text.as_deref(), Some("alt"));
        let link = inline_of("[x](http://a.b/(c))");
        assert_eq!(link[0].href.as_deref(), Some("http://a.b/(c)"));
    }

    #[test]
    fn emphasis_next_to_cjk_text() {
        assert_eq!(kinds("가**나**다"), [TokenKind::Text, TokenKind::Strong, TokenKind::Text]);
        assert_eq!(kinds("이것은 *강조* 입니다"), [TokenKind::Text, TokenKind::Em, TokenKind::Text]);
    }

    #[test]
    fn the_inline_masks_keep_their_length() {
        assert_eq!(masked_span("a[b](c)d", 1, 7, 'a', true), "a[aaaa]d");
        assert_eq!(masked_span("a\\*b", 1, 3, '+', false), "a++b");
        assert_eq!(last_unit("x🙂"), Some('\u{FFFF}'));
        assert_eq!(last_unit("x가"), Some('가'));
    }
}
